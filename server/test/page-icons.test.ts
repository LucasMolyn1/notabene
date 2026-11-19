// Icône de page importée : formats reconnus sur les octets (jamais de SVG), poids, droits d'import et de lecture, partages publics,
// remplacement, nettoyage, copie et duplication, exports, sauvegarde et migration.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { backupTo } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { cleanup, type DB, MIGRATIONS, openDb } from '../src/db.js';
import { HttpError } from '../src/lib/http.js';
import { checkIconImage, copyIconImage, iconImageId, pageIconSchema } from '../src/lib/page-icons.js';
import { hashPassword } from '../src/lib/password.js';
import { oldDb } from './migrations.js';

const PASS = 'Sup3r-secret-pass';
const doc = JSON.stringify({ type: 'doc', content: [] });

// Images minimales mais bien formées (blocs complets) : suffisantes pour ce que le serveur lit, découpe et revérifie.
const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC non vérifié par le serveur
};
const png = (w = 64, h = 64, idat = 16, extra: Buffer[] = []) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', randomBytes(idat)), chunk('IEND')]);
};
const seg = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};
const jpeg = (w = 64, h = 64, extra: Buffer[] = []) => {
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  const sos = Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), ...extra, seg(0xc0, sof), seg(0xda, sos), randomBytes(32).map((x) => x & 0x7f), Buffer.from([0xff, 0xd9])]);
};
const riff = (chunks: Buffer[]) => {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
};
const riffChunk = (fourcc: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
};
const vp8l = (w: number, h: number) => { const d = Buffer.alloc(20); d[0] = 0x2f; d.writeUInt32LE((w - 1) | ((h - 1) << 14), 1); return riffChunk('VP8L', d); };
const u24 = (b: Buffer, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff; b[at + 2] = (v >> 16) & 0xff; };
const vp8x = (w: number, h: number, flags: number) => { const d = Buffer.alloc(10); d[0] = flags; u24(d, 4, w - 1); u24(d, 7, h - 1); return riffChunk('VP8X', d); };
const anmf = (x: number, y: number, w: number, h: number) => { const d = Buffer.alloc(16); u24(d, 0, x / 2); u24(d, 3, y / 2); u24(d, 6, w - 1); u24(d, 9, h - 1); return riffChunk('ANMF', d); };
const webp = (w = 64, h = 64) => riff([vp8l(w, h)]);
const webpAnimated = (w: number, h: number, frames: Buffer[]) => riff([vp8x(w, h, 0x02), riffChunk('ANIM', Buffer.alloc(6)), ...frames]);
const frame = (left = 0, top = 0, w = 64, h = 64) => {
  const d = Buffer.alloc(10);
  d[0] = 0x2c; d.writeUInt16LE(left, 1); d.writeUInt16LE(top, 3); d.writeUInt16LE(w, 5); d.writeUInt16LE(h, 7);
  return Buffer.concat([d, Buffer.from([2, 2, 0x44, 0x01, 0])]); // taille de code LZW, un sous-bloc, terminateur
};
const gifExt = (label: number, ...subs: Buffer[]) => Buffer.concat([Buffer.from([0x21, label]), ...subs.map((x) => Buffer.concat([Buffer.from([x.length]), x])), Buffer.from([0])]);
const gif = (w = 64, h = 64, body: Buffer[] = [frame(0, 0, w, h)], trailer = true) => {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1'); head.writeUInt16LE(w, 6); head.writeUInt16LE(h, 8);
  return Buffer.concat([head, ...body, trailer ? Buffer.from([0x3b]) : Buffer.alloc(0)]);
};
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(document.cookie)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>fetch("/api/v3/me")</script></body></html>');
const b64 = (b: Buffer) => b.toString('base64');

describe('contrôle des octets', () => {
  it('accepte PNG, JPEG, WebP et GIF, d’après la signature', () => {
    for (const [img, mime] of [[png(), 'image/png'], [jpeg(), 'image/jpeg'], [webp(), 'image/webp'], [gif(), 'image/gif']] as const) {
      const got = checkIconImage(img);
      expect(got.mime).toBe(mime);
      expect(got.data.equals(img)).toBe(true); // sans métadonnées : inchangée
    }
  });
  it('refuse SVG, HTML, fausse signature, fichier tronqué ou vide', () => {
    const refused = (b: Buffer) => { try { checkIconImage(b); return null; } catch (err) { return (err as HttpError).statusCode; } };
    expect(refused(SVG)).toBe(400);
    expect(refused(HTML)).toBe(400);
    // Signature PNG sans en-tête IHDR, « GIF » sans version, RIFF qui n'est pas un WebP, JPEG sans segment de dimensions.
    expect(refused(Buffer.concat([png().subarray(0, 8), Buffer.from('<svg onload=alert(1)>............')]))).toBe(400);
    expect(refused(Buffer.from('GIF00a<script>alert(1)</script>'))).toBe(400);
    expect(refused(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), randomBytes(30)]))).toBe(400);
    expect(refused(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html>..............')]))).toBe(400);
    expect(refused(png().subarray(0, 12))).toBe(400);
    expect(refused(Buffer.alloc(0))).toBe(400);
  });
  it('borne le poids et les dimensions', () => {
    const refused = (b: Buffer) => { try { checkIconImage(b); return null; } catch (err) { return (err as HttpError).statusCode; } };
    expect(refused(Buffer.concat([png(), Buffer.alloc(512 * 1024)]))).toBe(413);
    expect(refused(Buffer.concat([png(), Buffer.alloc(512 * 1024 - png().length)]))).toBeNull();
    expect(refused(png(4, 4))).toBe(400);
    expect(refused(png(2048, 64))).toBe(400);
    expect(refused(gif(64, 5000))).toBe(400);
  });
  it('GIF : images dans l’écran logique, 300 au plus, blocs complets', () => {
    const refused = (b: Buffer) => { try { checkIconImage(b); return null; } catch (err) { return (err as HttpError).statusCode; } };
    expect(refused(gif(64, 64, [frame(0, 0, 32, 32), frame(32, 32, 32, 32)]))).toBeNull();
    expect(refused(gif(64, 64, [frame(10, 0, 60, 64)]))).toBe(400); // déborde à droite
    expect(refused(gif(64, 64, [frame(0, 1, 64, 64)]))).toBe(400); // déborde en bas
    expect(refused(gif(64, 64, [frame(0, 0, 4000, 4000)]))).toBe(400);
    expect(refused(gif(64, 64, Array.from({ length: 300 }, () => frame())))).toBeNull();
    expect(refused(gif(64, 64, Array.from({ length: 301 }, () => frame())))).toBe(400);
    expect(refused(gif(64, 64, []))).toBe(400); // aucune image
    expect(refused(gif(64, 64, [frame().subarray(0, 12)], false))).toBe(400); // sous-bloc tronqué
    expect(refused(gif(64, 64, [Buffer.from([0x99]), frame()]))).toBe(400); // bloc inconnu
    // Extensions sautées (sous-blocs), y compris avant la première image.
    expect(refused(gif(64, 64, [gifExt(0xf9, Buffer.alloc(4)), frame()]))).toBeNull();
  });
  it('WebP animé : chaque image (ANMF) dans le canevas, 300 au plus', () => {
    const refused = (b: Buffer) => { try { checkIconImage(b); return null; } catch (err) { return (err as HttpError).statusCode; } };
    expect(refused(webpAnimated(64, 64, [anmf(0, 0, 64, 64), anmf(32, 32, 32, 32)]))).toBeNull();
    expect(refused(webpAnimated(64, 64, [anmf(34, 0, 32, 32)]))).toBe(400);
    expect(refused(webpAnimated(64, 64, [anmf(0, 0, 64, 65)]))).toBe(400);
    expect(refused(webpAnimated(64, 64, Array.from({ length: 301 }, () => anmf(0, 0, 8, 8))))).toBe(400);
    expect(refused(webpAnimated(64, 64, []))).toBe(400);
    // Taille RIFF qui déborde du fichier.
    const bad = webpAnimated(64, 64, [anmf(0, 0, 8, 8)]);
    bad.writeUInt32LE(bad.length * 2, 4);
    expect(refused(bad)).toBe(400);
  });
  it('retire les métadonnées : JPEG (APP1 à APP15 sauf ICC et Adobe, commentaires)', () => {
    const exif = seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 48.8566', 'latin1'));
    const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1'));
    const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profil', 'latin1'));
    const adobe = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1'));
    const iptc = seg(0xed, Buffer.from('Photoshop 3.0\0auteur', 'latin1'));
    const com = seg(0xfe, Buffer.from('commentaire', 'latin1'));
    const app2other = seg(0xe2, Buffer.from('MPF\0donnees', 'latin1'));
    const raw = Buffer.concat([jpeg(64, 64, [exif, xmp, icc, adobe, iptc, com, app2other]), Buffer.from('<script>apres la fin</script>')]);
    const { data } = checkIconImage(raw);
    const text = data.toString('latin1');
    for (const gone of ['Exif', 'GPSLatitude', 'xmpmeta', 'Photoshop', 'commentaire', 'MPF', '<script>']) expect(text).not.toContain(gone);
    expect(text).toContain('ICC_PROFILE');
    expect(text).toContain('Adobe');
    expect(data.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    // Segment tronqué : refusé.
    expect(() => checkIconImage(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xc0, Buffer.alloc(15)).subarray(0, 12), Buffer.alloc(20)]))).toThrow();
  });
  it('retire les métadonnées : PNG (eXIf, tEXt, zTXt, iTXt) et ce qui suit IEND', () => {
    const meta = [chunk('eXIf', Buffer.from('MM\0*GPS', 'latin1')), chunk('tEXt', Buffer.from('Author\0Moi', 'latin1')), chunk('zTXt', Buffer.from('Comment\0\0x', 'latin1')), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1')), chunk('gAMA', Buffer.alloc(4))];
    const raw = Buffer.concat([png(64, 64, 16, meta), Buffer.from('<html>apres</html>')]);
    const { data } = checkIconImage(raw);
    const text = data.toString('latin1');
    for (const gone of ['eXIf', 'tEXt', 'zTXt', 'iTXt', 'GPS', 'Author', 'xmp', '<html>']) expect(text).not.toContain(gone);
    expect(text).toContain('gAMA');
    expect(data.subarray(-12, -4).toString('latin1')).toBe('\0\0\0\0IEND');
    // Morceau qui déborde du fichier : refusé.
    expect(() => checkIconImage(png(64, 64).subarray(0, 40))).toThrow();
  });
  it('retire les métadonnées : WebP (EXIF, XMP), drapeaux et taille RIFF recalculés', () => {
    const raw = riff([vp8x(64, 64, 0x08 | 0x04 | 0x10), vp8l(64, 64), riffChunk('EXIF', Buffer.from('GPS48', 'latin1')), riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1'))]);
    const { data } = checkIconImage(raw);
    const text = data.toString('latin1');
    for (const gone of ['EXIF', 'GPS48', 'XMP ', 'xmpmeta']) expect(text).not.toContain(gone);
    expect(data.readUInt32LE(4)).toBe(data.length - 8);
    expect(data[20]).toBe(0x10); // drapeaux EXIF et XMP effacés, les autres gardés
    expect(data.equals(riff([vp8x(64, 64, 0x10), vp8l(64, 64)]))).toBe(true);
  });
  it('retire les métadonnées : GIF (commentaires, extensions d’application sauf la boucle)', () => {
    const loop = gifExt(0xff, Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([1, 0, 0]));
    const xmp = gifExt(0xff, Buffer.from('XMP DataXMP', 'latin1'), Buffer.from('<x:xmpmeta/>', 'latin1'));
    const comment = gifExt(0xfe, Buffer.from('GPS secret', 'latin1'));
    const { data } = checkIconImage(Buffer.concat([gif(64, 64, [loop, xmp, comment, frame()]), Buffer.from('<script>')]));
    expect(data.equals(gif(64, 64, [loop, frame()]))).toBe(true);
    // Sans bloc de fin : ajouté.
    expect(checkIconImage(gif(64, 64, [frame()], false)).data.equals(gif())).toBe(true);
  });
  it('valeur du champ icon : emoji ou nom court, ou img:<identifiant>', () => {
    for (const ok of ['', 'file', '\u{1F4D8}', `img:${'a'.repeat(22)}`]) expect(pageIconSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['img:abc', 'img:', `img:${'a'.repeat(23)}`, `img:${'a'.repeat(21)}!`, 'x'.repeat(17)]) expect(pageIconSchema.safeParse(bad).success).toBe(false);
  });
});

describe('icône image de page', () => {
  let app: FastifyInstance;
  let db: DB;
  const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();

  async function boot(extra: Record<string, string> = {}) {
    sessions.clear();
    const dataDir = mkdtempSync(join(tmpdir(), 'nb-icon-'));
    const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
    db = openDb(':memory:');
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
    for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
      db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
    }
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0), ('prive', 'Privé', 0, 0)").run();
    db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit')").run();
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'ed2', 'edit')").run();
    const page = (id: string, space: string, parent: string | null, position = 0) =>
      db.prepare('INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, \'\', 1, 1, ?)').run(id, space, parent, `Titre ${id}`, doc, position);
    page('p1', 'sp', null);
    page('p2', 'sp', null, 1);
    page('enfant', 'sp', 'p1');
    page('secret', 'sp', null, 2);
    page('ailleurs', 'prive', null);
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'ed2', 'write'), ('secret', 'ed1', 'read')").run();
  }
  beforeEach(() => boot());
  const reboot = async (extra: Record<string, string>) => { await app.close(); db.close(); await boot(extra); };
  afterEach(async () => { await app.close(); db.close(); });

  async function login(id: string) {
    if (!sessions.has(id)) {
      const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
      const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
      const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
      sessions.set(id, { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } });
    }
    return sessions.get(id)!;
  }
  type S = Awaited<ReturnType<typeof login>>;
  const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, cookies: s?.cookies, headers: { ...s?.headers, ...headers } });
  const put = async (who: string | null, page: string, data: Buffer) => call(who ? await login(who) : null, 'PUT', `/api/v3/pages/${page}/icon-image`, { image: b64(data) });
  const iconOf = (page: string) => (db.prepare('SELECT icon FROM pages WHERE id = ?').get(page) as { icon: string } | undefined)?.icon;
  const images = () => db.prepare('SELECT id, page_id FROM page_icon_images ORDER BY page_id').all() as { id: string; page_id: string }[];
  async function setIcon(page = 'p1', data = png()) {
    const res = await put('ed1', page, data);
    expect(res.statusCode, res.body).toBe(200);
    const icon = res.json().icon as string;
    return { icon, id: iconImageId(icon)! };
  }
  async function bearer(who: string, scopes: string[], spaceIds?: string[]) {
    const res = await call(await login(who), 'POST', '/api/v3/tokens', { name: 'essai', scopes, expiresInDays: 7, ...(spaceIds ? { spaceIds } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  it('s’importe, désigne l’image de la page et se lit avec des en-têtes sûrs', async () => {
    const data = png(128, 128);
    const res = await put('ed1', 'p1', data);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().icon).toMatch(/^img:[A-Za-z0-9_-]{22}$/);
    expect(res.headers.etag).toBe(`"${res.json().version}"`);
    const { icon } = res.json() as { icon: string };
    expect(iconOf('p1')).toBe(icon);
    expect((await call(await login('ed2'), 'GET', '/api/v3/pages/p1')).json().icon).toBe(icon);

    const got = await call(await login('ed2'), 'GET', `/api/v3/page-icons/${iconImageId(icon)}`);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-disposition']).toBe('inline');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['cache-control']).toBe('private, no-cache');
    expect(got.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(got.rawPayload.equals(data)).toBe(true);
    const again = await app.inject({ method: 'GET', url: `/api/v3/page-icons/${iconImageId(icon)}`, cookies: (await login('ed2')).cookies, headers: { 'if-none-match': got.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect((db.prepare("SELECT meta FROM audit_log WHERE action = 'page.icon.set'").get() as { meta: string }).meta).toContain('image/png');

    // Le type servi est celui reconnu sur les octets, pour chaque format.
    for (const [img, mime] of [[jpeg(), 'image/jpeg'], [webp(), 'image/webp'], [gif(), 'image/gif']] as const) {
      const { id } = await setIcon('p2', img);
      expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${id}`)).headers['content-type']).toBe(mime);
    }
  });

  it('refuse SVG, HTML, fausse signature, base64 invalide et image trop lourde', async () => {
    expect((await put('ed1', 'p1', SVG)).statusCode).toBe(400);
    expect((await put('ed1', 'p1', HTML)).statusCode).toBe(400);
    expect((await put('ed1', 'p1', Buffer.concat([png().subarray(0, 8), SVG]))).statusCode).toBe(400);
    expect((await call(await login('ed1'), 'PUT', '/api/v3/pages/p1/icon-image', { image: '<svg/>' })).statusCode).toBe(400);
    // Un octet de trop : 413 ; bien au-delà, le corps est refusé avant même d'être décodé.
    expect((await put('ed1', 'p1', Buffer.concat([png(), Buffer.alloc(512 * 1024 + 1 - png().length)]))).statusCode).toBe(413);
    expect((await put('ed1', 'p1', Buffer.concat([png(), Buffer.alloc(2 * 512 * 1024)]))).statusCode).toBe(400);
    // Le type annoncé par la requête ne compte pas : seul le contenu décodé est examiné.
    expect((await call(await login('ed1'), 'PUT', '/api/v3/pages/p1/icon-image', { image: b64(SVG) }, { 'content-type': 'application/json' })).statusCode).toBe(400);
    expect(images()).toEqual([]);
    expect(iconOf('p1')).toBe('');
  });

  it('import réservé à qui peut modifier la page', async () => {
    expect((await put(null, 'p1', png())).statusCode).toBe(401);
    expect((await put('rd', 'p1', png())).statusCode).toBe(403);
    expect((await put('ed1', 'secret', png())).statusCode).toBe(403); // lecture seule sur la page restreinte
    expect((await put('ed1', 'ailleurs', png())).statusCode).toBe(404); // espace invisible
    // Jeton sans la portée d'écriture, ou limité à un autre espace.
    const readOnly = await bearer('ed1', ['read']);
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/icon-image', headers: readOnly, payload: { image: b64(png()) } })).statusCode).toBe(403);
    const elsewhere = await bearer('ed2', ['read', 'write'], ['prive']);
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/icon-image', headers: elsewhere, payload: { image: b64(png()) } })).statusCode).toBe(404);
    const writer = await bearer('ed1', ['read', 'write']);
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/icon-image', headers: writer, payload: { image: b64(png()) } })).statusCode).toBe(200);
    expect((await put('ed2', 'secret', png())).statusCode).toBe(200);
    // Retrait : mêmes droits.
    expect((await call(await login('ed1'), 'DELETE', '/api/v3/pages/secret/icon-image')).statusCode).toBe(403);
    expect((await call(await login('rd'), 'DELETE', '/api/v3/pages/p1/icon-image')).statusCode).toBe(403);
  });

  it('lecture réservée à qui lit la page, sans fuite entre espaces', async () => {
    const { id: inPrive } = await (async () => { const r = await put('ed2', 'ailleurs', png()); return { id: iconImageId(r.json().icon)! }; })();
    const { id: inSecret } = await (async () => { const r = await put('ed2', 'secret', png()); return { id: iconImageId(r.json().icon)! }; })();
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${inPrive}`)).statusCode).toBe(404);
    expect((await call(await login('admin'), 'GET', `/api/v3/page-icons/${inPrive}`)).statusCode).toBe(200);
    expect((await call(null, 'GET', `/api/v3/page-icons/${inPrive}`)).statusCode).toBe(404);
    expect((await call(await login('rd'), 'GET', `/api/v3/page-icons/${inSecret}`)).statusCode).toBe(404);
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${inSecret}`)).statusCode).toBe(200);
    // Un 304 ne passe jamais avant le contrôle d'accès.
    const etag = (await call(await login('ed2'), 'GET', `/api/v3/page-icons/${inPrive}`)).headers.etag as string;
    expect((await app.inject({ method: 'GET', url: `/api/v3/page-icons/${inPrive}`, cookies: (await login('ed1')).cookies, headers: { 'if-none-match': etag } })).statusCode).toBe(404);
    // Jeton limité à un autre espace.
    const limited = await bearer('ed2', ['read'], ['sp']);
    expect((await app.inject({ method: 'GET', url: `/api/v3/page-icons/${inPrive}`, headers: limited })).statusCode).toBe(404);
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${'x'.repeat(22)}`)).statusCode).toBe(404);
    expect((await call(await login('ed1'), 'GET', '/api/v3/page-icons/..%2F..%2Fetc')).statusCode).toBe(400);
    // Espace public : lisible sans compte, comme la page.
    db.prepare("UPDATE spaces SET visibility = 'public' WHERE id = 'prive'").run();
    expect((await call(null, 'GET', `/api/v3/page-icons/${inPrive}`)).statusCode).toBe(200);
  });

  it('page à la corbeille : lisible par qui voit la corbeille, purgée à la suppression définitive', async () => {
    const { id } = await setIcon('p1');
    const child = await setIcon('enfant');
    expect((await call(await login('ed1'), 'DELETE', '/api/v3/pages/p1')).statusCode).toBe(204);
    expect((await call(await login('ed2'), 'GET', `/api/v3/page-icons/${id}`)).statusCode).toBe(200);
    expect((await call(await login('rd'), 'GET', `/api/v3/page-icons/${id}`)).statusCode).toBe(404);
    expect((await call(await login('admin'), 'DELETE', '/api/v3/pages/p1/permanent')).statusCode).toBe(204);
    expect(images().map((r) => r.id)).not.toContain(id);
    expect(images().map((r) => r.id)).not.toContain(child.id);
  });

  it('le champ icon n’accepte que l’image de cette page', async () => {
    const { icon } = await setIcon('p1');
    const ed1 = await login('ed1');
    const etagOf = async (p: string) => (await call(ed1, 'GET', `/api/v3/pages/${p}`)).headers.etag as string;
    // Image d'une autre page : refusée (PATCH v3), sans rien changer.
    expect((await call(ed1, 'PATCH', '/api/v3/pages/p2', { icon })).statusCode).toBe(400);
    expect(iconOf('p2')).toBe('');
    expect((await call(ed1, 'PATCH', '/api/v3/pages/p2', { icon: `img:${randomBytes(16).toString('base64url')}` })).statusCode).toBe(400);
    expect((await call(ed1, 'PATCH', '/api/v3/pages/p2', { icon: 'img:abc' })).statusCode).toBe(400);
    // Création : une page neuve n'a aucune image.
    expect((await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sp', icon })).statusCode).toBe(400);
    expect((await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sp', icon: 'file' })).statusCode).toBe(201);
    // La sienne : acceptée (même valeur, rien ne disparaît).
    const same = await call(ed1, 'PATCH', '/api/v3/pages/p1', { icon }, { 'if-match': await etagOf('p1') });
    expect(same.statusCode, same.body).toBe(200);
    expect(images()).toHaveLength(1);
  });

  it('remplacement : une seule image courante, l’ancienne adresse ne répond plus', async () => {
    const first = await setIcon('p1');
    const second = await setIcon('p1', jpeg());
    expect(second.id).not.toBe(first.id);
    expect(images()).toEqual([{ id: second.id, page_id: 'p1' }]);
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${first.id}`)).statusCode).toBe(404);
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${second.id}`)).statusCode).toBe(200);
    // Un emoji à la place : l'image disparaît.
    expect((await call(await login('ed1'), 'PATCH', '/api/v3/pages/p1', { icon: 'star' })).statusCode).toBe(200);
    expect(images()).toEqual([]);
    // Retrait explicite : l'icône redevient vide.
    await setIcon('p1');
    expect((await call(await login('ed1'), 'DELETE', '/api/v3/pages/p1/icon-image')).statusCode).toBe(204);
    expect(iconOf('p1')).toBe('');
    expect(images()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'page.icon.remove'").get() as { n: number }).n).toBe(1);
  });

  it('nettoyage : image que plus aucune icône ne désigne', async () => {
    const { id } = await setIcon('p1');
    const kept = await setIcon('p2');
    db.prepare("UPDATE pages SET icon = 'file' WHERE id = 'p1'").run();
    expect((await call(await login('ed1'), 'GET', `/api/v3/page-icons/${id}`)).statusCode).toBe(404);
    cleanup(db);
    expect(images()).toEqual([{ id: kept.id, page_id: 'p2' }]);
  });

  it('partages publics : seulement les pages servies par le lien', async () => {
    const admin = await login('admin');
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(200);
    const root = await setIcon('p1');
    const child = await setIcon('enfant');
    const other = await setIcon('p2');
    const secret = await (async () => { const r = await put('ed2', 'secret', png()); return iconImageId(r.json().icon)!; })();
    const share = await call(await login('ed1'), 'PUT', '/api/v3/pages/p1/share', {});
    expect(share.statusCode, share.body).toBe(201);
    const token = (share.json().url as string).split('/share/')[1]!;
    const pub = (tok: string, id: string) => app.inject({ method: 'GET', url: `/api/v3/public/shares/${tok}/page-icons/${id}` });
    const ok = await pub(token, root.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await pub(token, child.id)).statusCode).toBe(404); // sous-pages non incluses
    expect((await pub(token, other.id)).statusCode).toBe(404);
    expect((await pub(token, secret)).statusCode).toBe(404);
    await call(await login('ed1'), 'PUT', '/api/v3/pages/p1/share', { includeChildren: true });
    expect((await pub(token, child.id)).statusCode).toBe(200);
    expect((await pub('x'.repeat(43), root.id)).statusCode).toBe(404);

    // Lien d'espace : pages servies seulement (ni page restreinte, ni autre espace).
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: true })).statusCode).toBe(200);
    const inPrive = await (async () => { const r = await put('ed2', 'ailleurs', png()); return iconImageId(r.json().icon)!; })();
    const sp = await call(admin, 'POST', '/api/v3/spaces/sp/shares', {});
    expect(sp.statusCode, sp.body).toBe(201);
    const spaceToken = (sp.json().url as string).split('/share/')[1]!;
    expect((await pub(spaceToken, other.id)).statusCode).toBe(200);
    expect((await pub(spaceToken, child.id)).statusCode).toBe(200);
    expect((await pub(spaceToken, secret)).statusCode).toBe(404);
    expect((await pub(spaceToken, inPrive)).statusCode).toBe(404);
    // Partage coupé : plus rien.
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: false })).statusCode).toBe(200);
    expect((await pub(token, root.id)).statusCode).toBe(404);
    expect((await pub(spaceToken, other.id)).statusCode).toBe(404);
  });

  it('copie et duplication : l’image est copiée pour la nouvelle page', async () => {
    const data = png(32, 32);
    const src = await setIcon('p1', data);
    const dup = await call(await login('ed1'), 'POST', '/api/v3/pages/p1/duplicate');
    expect(dup.statusCode, dup.body).toBe(201);
    const dupId = iconImageId(dup.json().icon);
    expect(dupId).toBeTruthy();
    expect(dupId).not.toBe(src.id);
    const row = db.prepare('SELECT page_id, data FROM page_icon_images WHERE id = ?').get(dupId) as { page_id: string; data: Buffer };
    expect(row.page_id).toBe(dup.json().id);
    expect(row.data.equals(data)).toBe(true);

    const copy = await call(await login('ed2'), 'POST', '/api/v3/pages/p1/copy', { spaceId: 'prive' });
    expect(copy.statusCode, copy.body).toBe(201);
    const copied = db.prepare("SELECT id, icon FROM pages WHERE space_id = 'prive' AND title = 'Titre p1'").get() as { id: string; icon: string };
    expect(iconImageId(copied.icon)).not.toBe(src.id);
    expect((db.prepare('SELECT page_id FROM page_icon_images WHERE id = ?').get(iconImageId(copied.icon)) as { page_id: string }).page_id).toBe(copied.id);
    // La sous-page copiée garde aussi son image.
    const child = await setIcon('enfant');
    const tree = await call(await login('ed2'), 'POST', '/api/v3/pages/p1/copy', { spaceId: 'prive' });
    expect(tree.statusCode).toBe(201);
    const copiedChild = db.prepare("SELECT id, icon FROM pages WHERE space_id = 'prive' AND title = 'Titre enfant' ORDER BY created_at DESC").get() as { id: string; icon: string };
    expect(iconImageId(copiedChild.icon)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(iconImageId(copiedChild.icon)).not.toBe(child.id);
    // Supprimer la source ne touche pas aux copies.
    db.prepare("DELETE FROM pages WHERE id = 'p1'").run();
    expect(db.prepare('SELECT 1 FROM page_icon_images WHERE id = ?').get(dupId)).toBeTruthy();

    // Image disparue : la copie retombe sur l'icône par défaut.
    db.prepare("UPDATE pages SET icon = ? WHERE id = 'p2'").run(`img:${'z'.repeat(22)}`);
    const orphan = await call(await login('ed1'), 'POST', '/api/v3/pages/p2/duplicate');
    expect(orphan.statusCode).toBe(201);
    expect(orphan.json().icon).toBe('');
    // Une source qui ne possède pas l'image désignée ne la transmet pas.
    expect(copyIconImage(db, 'p2', `img:${dupId}`, 'enfant', null)).toBe('');
  });

  it('modèle : l’icône image n’est pas reprise', async () => {
    await setIcon('p1');
    const res = await call(await login('ed1'), 'POST', '/api/v3/templates', { pageId: 'p1', name: 'Modèle' });
    expect(res.statusCode, res.body).toBe(201);
    expect((db.prepare('SELECT icon FROM page_templates').get() as { icon: string }).icon).toBe('');
  });

  it('exports : jamais la valeur img:, l’image dans l’archive ZIP', async () => {
    const data = png(48, 48);
    await setIcon('p1', data);
    const md = await call(await login('ed1'), 'GET', '/api/v3/pages/p1/export?format=markdown');
    expect(md.statusCode).toBe(200);
    expect(md.body.startsWith('# Titre p1\n')).toBe(true);
    expect(md.body).not.toContain('img:');

    const zip = await call(await login('ed1'), 'GET', '/api/v3/pages/p1/export/zip?subpages=true');
    expect(zip.statusCode, zip.body).toBe(200);
    const z = unzipSync(new Uint8Array(zip.rawPayload));
    const iconFile = Object.keys(z).find((n) => /^attachments\/icone-1\.png$/.test(n));
    expect(iconFile).toBeTruthy();
    expect(Buffer.from(z[iconFile!]!).equals(data)).toBe(true);
    const page = strFromU8(z['Titre p1.md']!);
    expect(page.startsWith('# ![icône](attachments/icone-1.png) Titre p1')).toBe(true);
    expect(page).not.toContain('img:');

    const html = unzipSync(new Uint8Array((await call(await login('ed1'), 'GET', '/api/v3/pages/p1/export/zip?format=html')).rawPayload));
    expect(strFromU8(html['Titre p1.html']!)).toContain('<h1><img src="attachments/icone-1.png" alt="" width="32" height="32"> Titre p1</h1>');
  });

  it('stocke et sert l’image sans ses métadonnées ; ETag sur les octets nettoyés', async () => {
    const exif = seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 48.8566', 'latin1'));
    const raw = jpeg(64, 64, [exif]);
    const { id } = await setIcon('p1', raw);
    const row = db.prepare('SELECT data, size, sha256 FROM page_icon_images WHERE id = ?').get(id) as { data: Buffer; size: number; sha256: string };
    expect(row.data.toString('latin1')).not.toContain('GPSLatitude');
    expect(row.size).toBe(row.data.length);
    expect(row.size).toBeLessThan(raw.length);
    expect(row.sha256).toBe(createHash('sha256').update(row.data).digest('hex'));
    const got = await call(await login('ed1'), 'GET', `/api/v3/page-icons/${id}`);
    expect(got.rawPayload.equals(row.data)).toBe(true);
    expect(got.headers.etag).toBe(`"${row.sha256}"`);
    expect(JSON.parse((db.prepare("SELECT meta FROM audit_log WHERE action = 'page.icon.set'").get() as { meta: string }).meta).size).toBe(row.size);
  });

  it('quota personnel commun avec les pièces jointes : 413 à l’import, icône vide à la copie', async () => {
    await reboot({ ATTACHMENT_USER_MB: '1' });
    const big = () => png(64, 64, 400 * 1024);
    await setIcon('p1', big());
    await setIcon('p2', big());
    const third = await put('ed1', 'enfant', big());
    expect(third.statusCode).toBe(413);
    expect(third.json().detail ?? third.body).toMatch(/Quota personnel/);
    expect(iconOf('enfant')).toBe('');
    // Remplacer sa propre image ne compte pas l'ancienne.
    await setIcon('p1', big());
    // Les icônes comptent pour les pièces jointes, et inversement.
    const boundary = 'nbquota';
    const att = await app.inject({
      method: 'POST', url: '/api/v3/pages/p1/attachments', cookies: (await login('ed1')).cookies,
      headers: { ...(await login('ed1')).headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), randomBytes(300 * 1024), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    expect(att.statusCode).toBe(413);
    // Copie au-delà du quota : la page est copiée, l'icône retombe sur la valeur par défaut.
    const dup = await call(await login('ed1'), 'POST', '/api/v3/pages/p1/duplicate');
    expect(dup.statusCode, dup.body).toBe(201);
    expect(dup.json().icon).toBe('');
    // Une autre personne a son propre quota.
    expect((await put('ed2', 'enfant', big())).statusCode).toBe(200);
  });

  it('plafond de l’instance commun avec les pièces jointes', async () => {
    await reboot({ ATTACHMENTS_TOTAL_MB: '1' });
    const big = () => png(64, 64, 400 * 1024);
    await setIcon('p1', big());
    expect((await put('ed2', 'p2', big())).statusCode).toBe(200);
    const full = await put('ed2', 'enfant', big());
    expect(full.statusCode).toBe(413);
    expect(full.body).toMatch(/Espace de stockage/);
    const copy = await call(await login('ed2'), 'POST', '/api/v3/pages/p1/copy', { spaceId: 'prive' });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().page.icon).toBe('');
    expect(images()).toHaveLength(2);
  });

  it('sauvegarde : l’image suit la base', async () => {
    const { id } = await setIcon('p1');
    const file = join(mkdtempSync(join(tmpdir(), 'nb-icon-bak-')), 'copie.db');
    await backupTo(db, file);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare('SELECT page_id FROM page_icon_images WHERE id = ?').get(id)).toEqual({ page_id: 'p1' });
    copy.close();
  });
});

describe('migration', () => {
  it('ajoute la table sans toucher aux icônes existantes', () => {
    const file = oldDb(MIGRATIONS.length - 1, (d) => { d.prepare("UPDATE pages SET icon = 'file' WHERE id = 'p1'").run(); });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare("SELECT icon FROM pages WHERE id = 'p1'").get()).toEqual({ icon: 'file' });
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_icon_images').get()).toEqual({ n: 0 });
    // Le type est contraint par la base : jamais de SVG, même inséré à la main.
    expect(() => up.prepare("INSERT INTO page_icon_images (id, page_id, mime, data, size, sha256, created_at) VALUES ('a', 'p1', 'image/svg+xml', x'00', 1, '', 0)").run()).toThrow();
    up.close();
  });
});
