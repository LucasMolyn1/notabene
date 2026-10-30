import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { imageInfo } from '../src/lib/image-info.js';
import { hashPassword } from '../src/lib/password.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Violet-Tableau-2026-ok';

// En-têtes minimaux : suffisants pour ce que le serveur lit (type et dimensions), pas des images affichables.
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; b.writeUInt16BE(17, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
};
const webpLossless = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBPVP8L', 8, 'latin1'); b.writeUInt32LE(20, 16);
  b[20] = 0x2f; b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
};
const b64 = (b: Buffer) => b.toString('base64');

describe('lecture de l’en-tête des images', () => {
  it('reconnaît PNG, JPEG et WebP, avec leurs dimensions', () => {
    expect(imageInfo(png(256, 128))).toEqual({ mime: 'image/png', width: 256, height: 128 });
    expect(imageInfo(jpeg(300, 200))).toEqual({ mime: 'image/jpeg', width: 300, height: 200 });
    expect(imageInfo(webpLossless(256, 256))).toEqual({ mime: 'image/webp', width: 256, height: 256 });
  });
  it('refuse le reste : SVG, HTML, texte, fichier tronqué', () => {
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>', '<html><script>alert(1)</script></html>', 'GIF89a............................', '']) {
      expect(imageInfo(Buffer.from(bad))).toBeNull();
    }
    expect(imageInfo(png(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe('photo de profil', () => {
  let app: FastifyInstance;
  let db: DB;
  afterEach(async () => { await app.close(); db.close(); });

  async function boot() {
    db = openDb(':memory:');
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
    for (const [id, role] of [['adm', 'admin'], ['ed', 'editor'], ['ed2', 'editor']] as const) {
      db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, id, role, Date.now(), await hashPassword(PASS));
    }
  }
  async function login(id: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookies = { nb_session: res.cookies.find((c) => c.name === 'nb_session')!.value };
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies })).json();
    return { cookies, headers: { 'x-csrf-token': me.csrf as string } };
  }
  const put = (s: Awaited<ReturnType<typeof login>>, image: string) => app.inject({ method: 'PUT', url: '/api/v3/me/avatar', ...s, payload: { image } });

  it('se définit, se lit avec un en-tête sûr, se met en cache par ETag et se retire', async () => {
    await boot();
    const ed = await login('ed');
    const ok = await put(ed, b64(png(256, 256)));
    expect(ok.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: '/api/v3/users/ed/avatar', cookies: ed.cookies });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['cache-control']).toBe('private, no-cache');
    expect(got.rawPayload.equals(png(256, 256))).toBe(true);

    const cached = await app.inject({ method: 'GET', url: '/api/v3/users/ed/avatar', cookies: ed.cookies, headers: { 'if-none-match': got.headers.etag as string } });
    expect(cached.statusCode).toBe(304);

    expect((await app.inject({ method: 'GET', url: '/api/v3/users/avatars', cookies: ed.cookies })).json()).toHaveProperty('ed');
    expect((await app.inject({ method: 'DELETE', url: '/api/v3/me/avatar', ...ed })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v3/users/ed/avatar', cookies: ed.cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v3/users/avatars', cookies: ed.cookies })).json()).toEqual({});
  });

  it('refuse un anonyme, une requête sans jeton CSRF et tout ce qui n’est pas une petite image raster', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v3/users/ed/avatar' })).statusCode).toBe(401);
    const ed = await login('ed');
    expect((await app.inject({ method: 'PUT', url: '/api/v3/me/avatar', cookies: ed.cookies, payload: { image: b64(png(64, 64)) } })).statusCode).toBe(403);
    expect((await put(ed, b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')))).statusCode).toBe(400);
    expect((await put(ed, b64(png(8, 8)))).statusCode).toBe(400); // trop petite
    expect((await put(ed, b64(png(20_000, 20_000)))).statusCode).toBe(400); // légère en octets, énorme en pixels
    expect((await put(ed, b64(Buffer.concat([png(64, 64), randomBytes(300 * 1024)])))).statusCode).toBeGreaterThanOrEqual(400); // trop lourde
    expect((await put(ed, 'pas du base64 !')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v3/users/avatars', cookies: ed.cookies })).json()).toEqual({});
  });

  it('un administrateur peut retirer la photo d’un autre compte, pas un éditeur', async () => {
    await boot();
    const ed = await login('ed');
    const other = await login('ed2');
    const adm = await login('adm');
    await put(other, b64(jpeg(200, 200)));
    expect((await app.inject({ method: 'DELETE', url: '/api/v3/admin/users/ed2/avatar', ...ed })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/v3/admin/users/ed2/avatar', ...adm })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v3/users/ed2/avatar', cookies: ed.cookies })).statusCode).toBe(404);
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'profile.avatar%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['profile.avatar.set', 'profile.avatar.remove']);
  });

  it('la photo disparaît avec le compte', async () => {
    await boot();
    const ed = await login('ed');
    await put(ed, b64(webpLossless(128, 128)));
    db.prepare("DELETE FROM users WHERE id = 'ed'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_avatars').get()).toEqual({ n: 0 });
  });
});
