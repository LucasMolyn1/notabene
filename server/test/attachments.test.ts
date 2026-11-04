// Pièces jointes (lots 10a et 10b) : droits, plafonds, type reconnu sur les octets, nom d'origine assaini, partage public, nettoyage.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { contentDisposition, drainAttachmentGc, parseRange, sanitizeFilename, sniffMime, sweepAttachments } from '../src/lib/attachments.js';
import { tarHeader, tarStream } from '../src/lib/tar.js';
import { MAX_CONCURRENT_UPLOADS, uploadError } from '../src/routes/attachments.js';
import { hashPassword } from '../src/lib/password.js';
import { oldDb } from './migrations.js';

const PASS = 'Sup3r-secret-pass';
const doc = JSON.stringify({ type: 'doc', content: [] });
let app: FastifyInstance;
let db: DB;
let dataDir: string;
let filesDir: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>fetch("/api/v3/me")</script></body></html>');

async function boot(extra: Record<string, string> = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'nb-att-'));
  filesDir = join(dataDir, 'attachments');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0), ('prive', 'Privé', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit')").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'ed2', 'edit')").run();
  const page = (id: string, space: string, parent: string | null) =>
    db.prepare('INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, \'\', 1, 1, 0)').run(id, space, parent, id, doc);
  page('p1', 'sp', null);
  page('p2', 'sp', null);
  page('enfant', 'sp', 'p1');
  page('secret', 'sp', null);
  page('ailleurs', 'prive', null);
  db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'ed2', 'write'), ('secret', 'rd', 'read')").run();
}
// Les tests unitaires du début ne démarrent pas de serveur.
afterEach(async () => { if (!app) return; await app.close(); db.close(); app = undefined as unknown as FastifyInstance; });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;

function form(filename: string, data: Buffer, type = 'application/octet-stream') {
  const boundary = `----nb${randomBytes(8).toString('hex')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  return { payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}
const upload = (s: S | null, page: string, filename: string, data: Buffer, type?: string, auth?: Record<string, string>) => {
  const f = form(filename, data, type);
  return app.inject({ method: 'POST', url: `/api/v3/pages/${page}/attachments`, payload: f.payload, cookies: s?.cookies, headers: { ...s?.headers, ...auth, 'content-type': f.type } });
};
const get = (s: S | null, url: string) => app.inject({ method: 'GET', url, cookies: s?.cookies, headers: s?.headers });
const del = (s: S, url: string) => app.inject({ method: 'DELETE', url, cookies: s.cookies, headers: s.headers });
const auditActions = () => (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);
const filesOnDisk = () => (existsSync(filesDir) ? readdirSync(filesDir) : []);

describe('reconnaissance du type et assainissement du nom', () => {
  it('reconnaît les types par leurs octets ; SVG, HTML et texte restent octet-stream', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('application/zip');
    for (const bad of [SVG, HTML, Buffer.from('console.log(1)'), Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.alloc(0)]) expect(sniffMime(bad)).toBe('application/octet-stream');
  });

  it('ne garde que le dernier segment du nom, sans caractère de contrôle ni inversion de sens', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('..')).toBe('fichier');
    expect(sanitizeFilename('')).toBe('fichier');
    expect(sanitizeFilename('rapport\u202Efdp.exe')).toBe('rapportfdp.exe');
    expect(sanitizeFilename('a\r\nb\u0000.txt')).toBe('ab.txt');
    expect(sanitizeFilename(`${'x'.repeat(500)}.pdf`)).toHaveLength(200);
    expect(sanitizeFilename(`${'x'.repeat(500)}.pdf`).endsWith('.pdf')).toBe(true);
  });

  it('écrit un Content-Disposition sans guillemet ni retour à la ligne injectable', () => {
    const h = contentDisposition('attachment', 'été "x"; filename=evil.html');
    expect(h).toBe('attachment; filename="_t_ _x__ filename_evil.html"; filename*=UTF-8\'\'%C3%A9t%C3%A9%20%22x%22%3B%20filename%3Devil.html');
    expect(h).not.toMatch(/[\r\n]/);
  });
});

describe('envoi et droits', () => {
  it('un rédacteur envoie un fichier : rangé sous son identifiant, en 0600, empreinte et type vérifiés, journalisé', async () => {
    await boot();
    const ed1 = await login('ed1');
    const res = await upload(ed1, 'p1', 'photo.png', PNG, 'text/html');
    expect(res.statusCode, res.body).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({ pageId: 'p1', name: 'photo.png', mime: 'image/png', size: PNG.length, inline: true, uploader: { id: 'ed1', name: 'Nom ed1' } });
    expect(a.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(filesOnDisk()).toEqual([a.id]);
    expect(statSync(join(filesDir, a.id)).mode & 0o777).toBe(0o600);
    expect(statSync(filesDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(filesDir, a.id)).equals(PNG)).toBe(true);
    expect(auditActions()).toContain('attachment.upload');

    const list = await get(ed1, '/api/v3/pages/p1/attachments');
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    // Lecteur : lit la liste et le fichier.
    const rd = await login('rd');
    expect((await get(rd, '/api/v3/pages/p1/attachments')).json().items).toHaveLength(1);
    expect((await get(rd, `/api/v3/attachments/${a.id}`)).statusCode).toBe(200);
  });

  it('refuse le lecteur, le visiteur, le jeton sans portée write et la page hors espace ; accepte le jeton write', async () => {
    await boot();
    const rd = await login('rd');
    expect((await upload(rd, 'p1', 'a.txt', Buffer.from('x'))).statusCode).toBe(403);
    expect((await upload(null, 'p1', 'a.txt', Buffer.from('x'))).statusCode).toBe(401);
    const ed1 = await login('ed1');
    const readTok = (await app.inject({ method: 'POST', url: '/api/v3/tokens', cookies: ed1.cookies, headers: ed1.headers, payload: { name: 'lecture', scopes: ['read'], expiresInDays: 7 } })).json().token;
    expect((await upload(null, 'p1', 'a.txt', Buffer.from('x'), undefined, { authorization: `Bearer ${readTok}` })).statusCode).toBe(403);
    const writeTok = (await app.inject({ method: 'POST', url: '/api/v3/tokens', cookies: ed1.cookies, headers: ed1.headers, payload: { name: 'ecriture', scopes: ['read', 'write'], expiresInDays: 7 } })).json().token;
    expect((await upload(null, 'p1', 'a.txt', Buffer.from('x'), undefined, { authorization: `Bearer ${writeTok}` })).statusCode).toBe(201);
    // Espace dont ed1 n'est pas membre : la page n'existe pas pour lui.
    expect((await upload(ed1, 'ailleurs', 'a.txt', Buffer.from('x'))).statusCode).toBe(404);
    // Page restreinte : introuvable pour ed1, lecture seule pour rd (403 par le rôle de toute façon).
    expect((await upload(ed1, 'secret', 'a.txt', Buffer.from('x'))).statusCode).toBe(404);
    // Sans CSRF, la session ne peut pas envoyer.
    const f = form('a.txt', Buffer.from('x'));
    expect((await app.inject({ method: 'POST', url: '/api/v3/pages/p1/attachments', payload: f.payload, cookies: ed1.cookies, headers: { 'content-type': f.type } })).statusCode).toBe(403);
    // Pas de multipart, pas de fichier, fichier vide.
    expect((await app.inject({ method: 'POST', url: '/api/v3/pages/p1/attachments', cookies: ed1.cookies, headers: ed1.headers, payload: { a: 1 } })).statusCode).toBe(415);
    expect((await upload(ed1, 'p1', 'vide.txt', Buffer.alloc(0))).statusCode).toBe(400);
    expect(filesOnDisk().filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('refuse une base', async () => {
    await boot();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, kind) VALUES ('base1', 'sp', 'Base', '{}', '', 1, 1, 'base')").run();
    expect((await upload(await login('ed1'), 'base1', 'a.txt', Buffer.from('x'))).statusCode).toBe(409);
  });
});

describe('plafonds', () => {
  it('par fichier : 413, aucun fichier ni temporaire laissé', async () => {
    await boot({ ATTACHMENT_MAX_MB: '1' });
    const ed1 = await login('ed1');
    const res = await upload(ed1, 'p1', 'gros.bin', randomBytes(1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().detail).toMatch(/1 Mo/);
    expect(filesOnDisk()).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n).toBe(0);
    expect((await upload(ed1, 'p1', 'juste.bin', randomBytes(1024 * 1024))).statusCode).toBe(201);
  });

  it('par instance : le volume total ne dépasse jamais le plafond', async () => {
    await boot({ ATTACHMENTS_TOTAL_MB: '1' });
    const ed1 = await login('ed1');
    expect((await upload(ed1, 'p1', 'a.bin', randomBytes(600 * 1024))).statusCode).toBe(201);
    const second = await upload(ed1, 'p1', 'b.bin', randomBytes(600 * 1024));
    expect(second.statusCode).toBe(413);
    expect(filesOnDisk()).toHaveLength(1);
    expect((await upload(ed1, 'p1', 'c.bin', randomBytes(400 * 1024))).statusCode).toBe(201);
  });

  it('par personne : quota propre à chacun, vérifié à l’enregistrement', async () => {
    await boot({ ATTACHMENT_USER_MB: '1' });
    const ed1 = await login('ed1');
    expect((await upload(ed1, 'p1', 'a.bin', randomBytes(600 * 1024))).statusCode).toBe(201);
    const second = await upload(ed1, 'p1', 'b.bin', randomBytes(600 * 1024));
    expect(second.statusCode).toBe(413);
    expect(second.json().detail).toMatch(/Quota personnel/);
    expect((await upload(await login('ed2'), 'p1', 'c.bin', randomBytes(600 * 1024))).statusCode).toBe(201);
    expect(filesOnDisk().filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('envois en cours : comptés dans le plafond, limités à trois par personne, coupés après un silence', async () => {
    await boot({ ATTACHMENTS_TOTAL_MB: '1', ATTACHMENT_UPLOAD_IDLE_SECONDS: '1' });
    const ed1 = await login('ed1');
    // Envoi qui s'arrête au milieu : le corps reste ouvert, sans plus rien envoyer.
    const stalled = (bytes: number) => {
      const f = form('lent.bin', Buffer.alloc(0));
      const body = new PassThrough();
      // En-tête de la partie seulement (sans la fin `\r\n--frontière--\r\n`), puis des octets du fichier.
      body.write(f.payload.subarray(0, f.payload.length - Buffer.byteLength(`\r\n--${f.type.split('boundary=')[1]!}--\r\n`)));
      body.write(randomBytes(bytes));
      const res = app.inject({ method: 'POST', url: '/api/v3/pages/p1/attachments', payload: body, cookies: ed1.cookies, headers: { ...ed1.headers, 'content-type': f.type } });
      return { res, body };
    };
    const tmpCount = () => filesOnDisk().filter((n) => n.startsWith('.tmp-')).length;
    const first = stalled(700 * 1024);
    await vi.waitFor(() => expect(tmpCount()).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    // Les 700 Ko en cours sont réservés : 400 Ko de plus dépasseraient le plafond de 1 Mo.
    expect((await upload(await login('ed2'), 'p1', 'b.bin', randomBytes(400 * 1024))).statusCode).toBe(413);
    const others = [stalled(1), stalled(1)];
    await vi.waitFor(() => expect(tmpCount()).toBe(MAX_CONCURRENT_UPLOADS));
    expect((await upload(ed1, 'p1', 'x.bin', Buffer.from('x'))).statusCode).toBe(429);
    for (const s of [first, ...others]) {
      const r = await s.res;
      expect(r.statusCode).toBe(408);
      s.body.end();
    }
    expect(tmpCount()).toBe(0);
    // Réservations rendues : l'envoi passe de nouveau.
    expect((await upload(ed1, 'p1', 'b.bin', randomBytes(400 * 1024))).statusCode).toBe(201);
  });

  it('erreur « fichier trop lourd » de l’analyseur : 413', () => {
    expect(uploadError(Object.assign(new Error('x'), { code: 'FST_REQ_FILE_TOO_LARGE' }), 25).statusCode).toBe(413);
    expect(uploadError(Object.assign(new Error('x'), { code: 'FST_FILES_LIMIT' }), 25).statusCode).toBe(400);
    expect(uploadError(new Error('ECONNRESET'), 25).statusCode).toBe(400);
  });

  it('accepte un fichier plus gros que la limite des corps JSON (12 Mo)', async () => {
    await boot();
    const res = await upload(await login('ed1'), 'p1', 'video.mp4', randomBytes(13 * 1024 * 1024));
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('réponse servie', () => {
  it('SVG et HTML déguisés en PNG : octet-stream, téléchargement forcé, aucune exécution possible', async () => {
    await boot();
    const ed1 = await login('ed1');
    for (const [name, data] of [['image.png', SVG], ['page.png', HTML], ['dessin.svg', SVG], ['index.html', HTML]] as const) {
      const up = await upload(ed1, 'p1', name, data, 'image/png');
      expect(up.json().mime).toBe('application/octet-stream');
      const got = await get(ed1, `/api/v3/attachments/${up.json().id}`);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('application/octet-stream');
      expect(got.headers['content-disposition']).toMatch(/^attachment; /);
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(got.rawPayload.equals(data)).toBe(true);
    }
  });

  it('image raster reconnue : en ligne avec son type ; PDF : type gardé mais téléchargement forcé ; ETag', async () => {
    await boot();
    const ed1 = await login('ed1');
    const png = (await upload(ed1, 'p1', 'photo.png', PNG)).json();
    const got = await get(ed1, `/api/v3/attachments/${png.id}`);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-disposition']).toBe('inline; filename="photo.png"; filename*=UTF-8\'\'photo.png');
    expect(got.headers['cache-control']).toBe('private, no-store');
    const again = await app.inject({ method: 'GET', url: `/api/v3/attachments/${png.id}`, cookies: ed1.cookies, headers: { 'if-none-match': got.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    const pdf = (await upload(ed1, 'p1', 'doc.pdf', Buffer.from('%PDF-1.7\n<</JavaScript (app.alert(1))>>'))).json();
    const gotPdf = await get(ed1, `/api/v3/attachments/${pdf.id}`);
    expect(gotPdf.headers['content-type']).toBe('application/pdf');
    expect(gotPdf.headers['content-disposition']).toMatch(/^attachment; /);
  });

  it('nom piégé : assaini en base, jamais utilisé comme chemin', async () => {
    await boot();
    const ed1 = await login('ed1');
    const up = await upload(ed1, 'p1', '../../../../tmp/evil.sh', Buffer.from('#!/bin/sh\nrm -rf /'));
    expect(up.statusCode).toBe(201);
    expect(up.json().name).toBe('evil.sh');
    expect(filesOnDisk()).toEqual([up.json().id]);
    expect(readdirSync(dataDir).sort()).toEqual(['attachments']);
    const utf = await upload(ed1, 'p1', 'Compte rendu été.pdf', Buffer.from('%PDF-1.4'));
    expect(utf.json().name).toBe('Compte rendu été.pdf');
    expect((await get(ed1, `/api/v3/attachments/${utf.json().id}`)).headers['content-disposition']).toContain("filename*=UTF-8''Compte%20rendu%20%C3%A9t%C3%A9.pdf");
  });
});

describe('lecture contrôlée à chaque requête', () => {
  it('page restreinte, hors espace, à la corbeille, droit retiré : introuvable', async () => {
    await boot();
    const ed2 = await login('ed2');
    const secret = (await upload(ed2, 'secret', 'note.txt', Buffer.from('confidentiel'))).json();
    const ailleurs = (await upload(ed2, 'ailleurs', 'note.txt', Buffer.from('privé'))).json();
    const ed1 = await login('ed1');
    const rd = await login('rd');
    expect((await get(ed1, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(404);
    expect((await get(ed1, '/api/v3/pages/secret/attachments')).statusCode).toBe(404);
    expect((await get(ed1, `/api/v3/attachments/${ailleurs.id}`)).statusCode).toBe(404);
    expect((await get(null, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(404);
    expect((await get(rd, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(200);
    // Droit retiré : la requête suivante est refusée (aucun cache).
    db.prepare("DELETE FROM page_acl WHERE page_id = 'secret' AND user_id = 'rd'").run();
    expect((await get(rd, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(404);
    // Page à la corbeille : plus lisible.
    expect((await del(ed2, '/api/v3/pages/secret')).statusCode).toBe(204);
    expect((await get(ed2, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(404);
    // Suppression : réservée à qui peut modifier la page.
    const p1 = (await upload(ed1, 'p1', 'a.txt', Buffer.from('a'))).json();
    expect((await del(rd, `/api/v3/attachments/${p1.id}`)).statusCode).toBe(403);
    expect((await del(ed2, `/api/v3/attachments/${ailleurs.id}`)).statusCode).toBe(204);
    expect((await del(ed1, `/api/v3/attachments/${ailleurs.id}`)).statusCode).toBe(404);
  });

  it('espace public : un visiteur lit sans compte, mais jamais une page restreinte', async () => {
    await boot();
    db.prepare("UPDATE spaces SET visibility = 'public' WHERE id = 'sp'").run();
    const ed2 = await login('ed2');
    const open = (await upload(ed2, 'p1', 'a.txt', Buffer.from('a'))).json();
    const secret = (await upload(ed2, 'secret', 'b.txt', Buffer.from('b'))).json();
    expect((await get(null, `/api/v3/attachments/${open.id}`)).statusCode).toBe(200);
    expect((await get(null, `/api/v3/attachments/${secret.id}`)).statusCode).toBe(404);
  });

  it('lien de partage public : seulement les pièces jointes des pages qu’il couvre', async () => {
    await boot();
    const admin = await login('admin');
    expect((await app.inject({ method: 'PUT', url: '/api/v3/admin/sharing', cookies: admin.cookies, headers: admin.headers, payload: { enabled: true } })).statusCode).toBe(200);
    const ed1 = await login('ed1');
    const root = (await upload(ed1, 'p1', 'r.txt', Buffer.from('r'))).json();
    const child = (await upload(ed1, 'enfant', 'c.txt', Buffer.from('c'))).json();
    const other = (await upload(ed1, 'p2', 'o.txt', Buffer.from('o'))).json();
    const shared = await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/share', cookies: ed1.cookies, headers: ed1.headers, payload: {} });
    const token = (shared.json().url as string).split('/share/')[1]!;
    const pub = (id: string, t = token) => app.inject({ method: 'GET', url: `/api/v3/public/shares/${t}/attachments/${id}` });
    expect((await pub(root.id)).statusCode).toBe(200);
    expect((await pub(root.id)).headers['referrer-policy']).toBe('no-referrer');
    expect((await pub(child.id)).statusCode).toBe(404);
    expect((await pub(other.id)).statusCode).toBe(404);
    expect((await pub(root.id, 'x'.repeat(32))).statusCode).toBe(404);
    // Sans le lien, la page privée reste fermée au visiteur.
    expect((await get(null, `/api/v3/attachments/${root.id}`)).statusCode).toBe(404);
    // Sous-pages incluses : l'enfant est couvert.
    await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/share', cookies: ed1.cookies, headers: ed1.headers, payload: { includeChildren: true } });
    expect((await pub(child.id)).statusCode).toBe(200);
    // Partage retiré : plus rien.
    await app.inject({ method: 'DELETE', url: '/api/v3/pages/p1/share', cookies: ed1.cookies, headers: ed1.headers });
    expect((await pub(root.id)).statusCode).toBe(404);
  });
});

describe('nettoyage', () => {
  it('suppression d’une pièce jointe, d’une page (corbeille vidée) ou d’un espace : fichiers effacés du disque, journalisé', async () => {
    await boot();
    const ed1 = await login('ed1');
    const a = (await upload(ed1, 'p1', 'a.txt', Buffer.from('a'))).json();
    const b = (await upload(ed1, 'p2', 'b.txt', Buffer.from('b'))).json();
    const c = (await upload(ed1, 'enfant', 'c.txt', Buffer.from('c'))).json();
    expect(filesOnDisk().sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await del(ed1, `/api/v3/attachments/${a.id}`)).statusCode).toBe(204);
    expect(filesOnDisk().sort()).toEqual([b.id, c.id].sort());
    expect(auditActions()).toContain('attachment.delete');
    // Page à la corbeille : le fichier reste (restauration possible), puis disparaît à la suppression définitive (sous-page comprise).
    const admin = await login('admin');
    expect((await del(ed1, '/api/v3/pages/p1')).statusCode).toBe(204);
    expect(filesOnDisk()).toContain(c.id);
    expect((await del(admin, '/api/v3/pages/p1/permanent')).statusCode).toBe(204);
    // Effacement après la réponse (crochet onResponse) : on l'attend.
    await vi.waitFor(() => expect(filesOnDisk()).toEqual([b.id]));
    // Espace supprimé : cascade jusqu'aux fichiers.
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('autre', 'Autre', 0, 0)").run();
    expect((await del(admin, '/api/v3/spaces/sp')).statusCode).toBe(204);
    // La ligne de la file disparaît juste après l'effacement du fichier : on attend les deux.
    await vi.waitFor(() => {
      expect(filesOnDisk()).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM attachment_gc').get() as { n: number }).n).toBe(0);
    });
  });

  it('au démarrage : envois interrompus effacés, fichiers sans ligne mis en quarantaine, fichiers connus et noms étrangers conservés', async () => {
    await boot();
    const ed1 = await login('ed1');
    const kept = (await upload(ed1, 'p1', 'a.txt', Buffer.from('a'))).json();
    writeFileSync(join(filesDir, '.tmp-0123456789abcdef01234567'), 'partiel');
    writeFileSync(join(filesDir, 'AAAAAAAAAAAAAAAAAAAAAA'), 'orphelin');
    writeFileSync(join(filesDir, 'LISEZ-MOI.txt'), 'déposé à la main');
    // Purge de la corbeille par la tâche horaire (aucune requête DELETE) : la ligne disparaît, le fichier attend la file d'effacement.
    const gone = (await upload(ed1, 'p2', 'b.txt', Buffer.from('b'))).json();
    db.prepare("DELETE FROM pages WHERE id = 'p2'").run();
    expect(filesOnDisk()).toContain(gone.id);
    const quarantine = join(dataDir, 'attachments-quarantaine');
    expect(await sweepAttachments(db, filesDir, quarantine)).toEqual({ temp: 1, quarantined: 1 });
    expect(filesOnDisk().sort()).toEqual(['LISEZ-MOI.txt', kept.id].sort());
    expect(readdirSync(quarantine)).toEqual(['AAAAAAAAAAAAAAAAAAAAAA']);
    expect(statSync(quarantine).mode & 0o777).toBe(0o700);
  });

  it('file d’effacement : jamais le fichier d’une pièce jointe encore en base', async () => {
    await boot();
    const kept = (await upload(await login('ed1'), 'p1', 'a.txt', Buffer.from('a'))).json();
    db.prepare('INSERT INTO attachment_gc (id) VALUES (?)').run(kept.id);
    expect(await drainAttachmentGc(db, filesDir)).toBe(0);
    expect(filesOnDisk()).toEqual([kept.id]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM attachment_gc').get() as { n: number }).n).toBe(0);
  });

  it('effacement après réponse : seulement pour une suppression authentifiée et réussie', async () => {
    await boot();
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, 'BBBBBBBBBBBBBBBBBBBBBB'), 'en attente');
    db.prepare("INSERT INTO attachment_gc (id) VALUES ('BBBBBBBBBBBBBBBBBBBBBB')").run();
    const pause = () => new Promise((r) => setTimeout(r, 100));
    expect((await app.inject({ method: 'DELETE', url: '/api/v3/pages/p1' })).statusCode).toBe(401);
    const ed1 = await login('ed1');
    expect((await del(ed1, '/api/v3/attachments/CCCCCCCCCCCCCCCCCCCCCC')).statusCode).toBe(404);
    await pause();
    expect(filesOnDisk()).toContain('BBBBBBBBBBBBBBBBBBBBBB');
    expect((await del(ed1, '/api/v3/pages/p2')).statusCode).toBe(204);
    await vi.waitFor(() => expect(filesOnDisk()).not.toContain('BBBBBBBBBBBBBBBBBBBBBB'));
  });

  it('migration : une base au schéma précédent reçoit les tables sans perdre ses pages', () => {
    const file = oldDb(18);
    const up = openDb(file);
    expect(up.prepare("SELECT name FROM sqlite_master WHERE name IN ('attachments', 'attachment_gc', 'attachments_ad') ORDER BY name").all()).toHaveLength(3);
    expect(up.prepare("SELECT id FROM pages WHERE id = 'p1'").get()).toBeTruthy();
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(19);
  });
});

// ---- Lot 10b : requêtes partielles, données personnelles -------------------------------------

describe('requêtes partielles (Range)', () => {
  it('analyse une seule plage ; ignore les formes invalides ou multiples ; 416 hors du fichier', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=50-5000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    for (const ignored of ['bytes=0-1,5-6', 'items=0-1', 'bytes=10-5', 'bytes=-', 'bytes=abc', `bytes=${'9'.repeat(16)}-`, 'bytes=0-1\r\nx: y', `bytes=${'0'.repeat(200)}`]) {
      expect(parseRange(ignored, 100), ignored).toBeNull();
    }
  });

  it('sert 206 avec les mêmes en-têtes de sécurité, 416 hors du fichier, et le fichier entier si la plage est ignorée', async () => {
    await boot();
    const ed1 = await login('ed1');
    const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(3000)]);
    const a = (await upload(ed1, 'p1', 'film.mp4', video)).json();
    expect(a.mime).toBe('video/mp4');
    const ranged = (range: string, extra: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: `/api/v3/attachments/${a.id}`, cookies: ed1.cookies, headers: { ...ed1.headers, range, ...extra } });

    const full = await get(ed1, `/api/v3/attachments/${a.id}`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');

    const part = await ranged('bytes=0-99');
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${video.length}`);
    expect(part.headers['content-length']).toBe('100');
    expect(part.rawPayload.equals(video.subarray(0, 100))).toBe(true);
    expect(part.headers).toMatchObject({
      'content-type': 'video/mp4', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store', 'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer',
    });
    expect(part.headers['content-disposition']).toMatch(/^attachment;/);

    const tail = await ranged('bytes=-10');
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(video.subarray(-10))).toBe(true);
    expect((await ranged(`bytes=1000-`)).rawPayload.equals(video.subarray(1000))).toBe(true);

    const out = await ranged(`bytes=${video.length}-`);
    expect(out.statusCode).toBe(416);
    expect(out.headers['content-range']).toBe(`bytes */${video.length}`);
    expect(out.headers['x-content-type-options']).toBe('nosniff');

    for (const r of ['bytes=0-1,5-6', 'items=0-1', 'bytes=10-5']) {
      const res = await ranged(r);
      expect(res.statusCode, r).toBe(200);
      expect(res.rawPayload.equals(video)).toBe(true);
    }
    // If-Range : plage servie seulement pour la même version du fichier.
    expect((await ranged('bytes=0-9', { 'if-range': '"autre"' })).statusCode).toBe(200);
    expect((await ranged('bytes=0-9', { 'if-range': `"${a.sha256}"` })).statusCode).toBe(206);
  });

  it('revérifie les droits à chaque morceau, y compris par le lien de partage public', async () => {
    await boot();
    const admin = await login('admin');
    expect((await app.inject({ method: 'PUT', url: '/api/v3/admin/sharing', cookies: admin.cookies, headers: admin.headers, payload: { enabled: true } })).statusCode).toBe(200);
    const ed1 = await login('ed1');
    const audio = Buffer.concat([Buffer.from('ID3'), randomBytes(2000)]);
    const a = (await upload(ed1, 'p1', 'son.mp3', audio)).json();
    const range = { range: 'bytes=0-15' };
    // Un visiteur sans compte, ou un autre espace : introuvable, même avec une plage.
    expect((await app.inject({ method: 'GET', url: `/api/v3/attachments/${a.id}`, headers: range })).statusCode).toBe(404);

    const token = ((await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/share', cookies: ed1.cookies, headers: ed1.headers, payload: {} })).json().url as string).split('/share/')[1]!;
    const pub = await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}/attachments/${a.id}`, headers: range });
    expect(pub.statusCode).toBe(206);
    expect(pub.rawPayload.equals(audio.subarray(0, 16))).toBe(true);
    expect(pub.headers).toMatchObject({ 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' });
    await app.inject({ method: 'DELETE', url: '/api/v3/pages/p1/share', cookies: ed1.cookies, headers: ed1.headers });
    expect((await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}/attachments/${a.id}`, headers: range })).statusCode).toBe(404);

    // Page restreinte à quelqu'un d'autre entre deux morceaux : le suivant est refusé.
    const first = await app.inject({ method: 'GET', url: `/api/v3/attachments/${a.id}`, cookies: ed1.cookies, headers: { ...ed1.headers, ...range } });
    expect(first.statusCode).toBe(206);
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/p1/permissions', cookies: admin.cookies, headers: admin.headers, payload: { entries: [{ userId: 'ed2', level: 'write' }] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v3/attachments/${a.id}`, cookies: ed1.cookies, headers: { ...ed1.headers, range: 'bytes=16-31' } })).statusCode).toBe(404);
  });
});

// Lecture d'une archive tar (ustar) : noms, contenus, somme de contrôle de chaque en-tête.
function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number) => h.toString('ascii', a, b).replace(/\0.*$/s, '').trim();
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    expect(copy.reduce((s, b) => s + b, 0)).toBe(parseInt(field(148, 156), 8));
    expect(field(257, 263)).toBe('ustar');
    const size = parseInt(field(124, 136), 8);
    out.set(field(0, 100), buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('données personnelles et pièces jointes', () => {
  it('l’export liste les pièces jointes envoyées (pages encore lisibles seulement) ; l’archive contient les fichiers', async () => {
    await boot();
    const admin = await login('admin');
    const ed1 = await login('ed1');
    const mine = (await upload(ed1, 'p1', 'compte rendu été.pdf', Buffer.from('%PDF-1.7 contenu'))).json();
    const hidden = (await upload(ed1, 'p2', 'plus-lisible.txt', Buffer.from('cache'))).json();
    const ed2 = await login('ed2');
    await upload(ed2, 'p1', 'autrui.txt', Buffer.from('pas a moi'));
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/p2/permissions', cookies: admin.cookies, headers: admin.headers, payload: { entries: [{ userId: 'ed2', level: 'write' }] } })).statusCode).toBe(200);

    const json = (await get(ed1, '/api/v3/me/export')).json();
    expect(json.contributions.attachmentsUploaded).toBe(2);
    expect(json.attachments).toHaveLength(1);
    expect(json.attachments[0]).toMatchObject({ id: mine.id, pageId: 'p1', name: 'compte rendu été.pdf', mime: 'application/pdf', sha256: mine.sha256 });
    expect(JSON.stringify(json)).not.toContain(hidden.id);
    expect(JSON.stringify(json)).not.toContain('autrui');

    const res = await get(ed1, '/api/v3/me/export/archive');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-tar');
    expect(res.headers['content-disposition']).toBe('attachment; filename="mes-donnees-notabene.tar"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const files = untar(res.rawPayload);
    const data = JSON.parse(files.get('donnees.json')!.toString());
    expect(data.attachments[0]).toMatchObject({ id: mine.id, included: true, file: `pieces-jointes/${mine.id}-compte rendu _t_.pdf` });
    expect(files.get(data.attachments[0].file)!.toString()).toBe('%PDF-1.7 contenu');
    expect([...files.keys()]).toHaveLength(2);
    // L'archive est lisible par tar.
    const tarFile = join(dataDir, 'export.tar');
    writeFileSync(tarFile, res.rawPayload);
    expect(execFileSync('tar', ['-tf', tarFile]).toString().trim().split('\n')).toEqual(['donnees.json', data.attachments[0].file]);

    // Fichier absent du disque : signalé, pas joint.
    unlinkSync(join(filesDir, mine.id));
    const missing = untar((await get(ed1, '/api/v3/me/export/archive')).rawPayload);
    expect(JSON.parse(missing.get('donnees.json')!.toString()).attachments[0].included).toBe(false);
    expect(missing.size).toBe(1);
  });

  it('archive : session exigée ; un administrateur exporte un autre compte, un rédacteur non', async () => {
    await boot();
    expect((await get(null, '/api/v3/me/export/archive')).statusCode).toBe(401);
    const ed1 = await login('ed1');
    await upload(ed1, 'p1', 'a.txt', Buffer.from('a'));
    expect((await get(ed1, '/api/v3/admin/users/ed2/export/archive')).statusCode).toBe(403);
    const admin = await login('admin');
    const res = await get(admin, '/api/v3/admin/users/ed1/export/archive');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(untar(res.rawPayload).get('donnees.json')!.toString()).attachments).toHaveLength(1);
    expect((await get(admin, '/api/v3/admin/users/inconnu/export/archive')).statusCode).toBe(404);
  });

  it('effacement du compte : les fichiers restent rattachés à la page, l’envoyeur est anonymisé', async () => {
    await boot();
    const ed1 = await login('ed1');
    const a = (await upload(ed1, 'p1', 'garde.txt', Buffer.from('reste'))).json();
    const admin = await login('admin');
    expect((await app.inject({ method: 'POST', url: '/api/v3/admin/users/ed1/erase', cookies: admin.cookies, headers: admin.headers, payload: { reauth: { password: PASS } } })).statusCode).toBe(200);
    expect(db.prepare('SELECT page_id, uploader_id, name FROM attachments WHERE id = ?').get(a.id)).toEqual({ page_id: 'p1', uploader_id: null, name: 'garde.txt' });
    expect(readFileSync(join(filesDir, a.id)).toString()).toBe('reste');
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = 'ed1'").get()).toEqual({ n: 0 });
    const ed2 = await login('ed2');
    expect((await get(ed2, `/api/v3/attachments/${a.id}`)).rawPayload.toString()).toBe('reste');
    expect((await get(ed2, '/api/v3/pages/p1/attachments')).json().items[0].uploader).toBeNull();
  });

  it('tar : refuse un nom dangereux ou une taille qui ne correspond pas', async () => {
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'é.txt', 'x'.repeat(100), '']) expect(() => tarHeader(bad, 1, 0), bad).toThrow();
    const drain = async (size: number) => { let n = 0; for await (const chunk of tarStream([{ name: 'a', size, mtime: 0, body: () => Buffer.from('abc') }])) n += chunk.length; return n; };
    await expect(drain(2)).rejects.toThrow(/taille/);
    await expect(drain(3)).resolves.toBe(512 * 4);
  });
});
