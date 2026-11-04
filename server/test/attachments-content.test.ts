// Pièces jointes dans le contenu (lot 10) : blocs acceptés, export, copie des fichiers avec la page, nettoyage des non-citées.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { drainAttachmentGc, reservations, sweepUnreferenced, UNREFERENCED_GRACE_MS } from '../src/lib/attachments.js';
import { type DocNode, sanitizeDoc } from '../src/lib/content.js';
import { toMarkdown } from '../src/lib/markdown.js';
import { hashPassword } from '../src/lib/password.js';
import { renderHtml } from '../src/lib/render-html.js';
import { oldDb } from './migrations.js';

const PASS = 'Sup3r-secret-pass';
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(40)]);
let app: FastifyInstance | undefined;
let db: DB;
let filesDir: string;

async function boot(extra: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nb-attc-'));
  filesDir = join(dataDir, 'attachments');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, id, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0), ('sp2', 'Autre', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit'), ('sp2', 'everyone', 'edit')").run();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('p1', 'sp', 'Source', '{\"type\":\"doc\",\"content\":[]}', '', 1, 1)").run();
}
afterEach(async () => { if (app) { await app.close(); db.close(); app = undefined; } });

async function login(id: string) {
  const res = await app!.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app!.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app!.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });

async function upload(s: S, page: string, name: string, data: Buffer): Promise<string> {
  const boundary = `----nb${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app!.inject({ method: 'POST', url: `/api/v3/pages/${page}/attachments`, payload, cookies: s.cookies, headers: { ...s.headers, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const docWith = (fileId: string, imageId: string) => ({ type: 'doc', content: [
  { type: 'attachment', attrs: { id: fileId, name: 'note.pdf', size: 8, mime: 'application/pdf' } },
  { type: 'image', attrs: { src: `/api/v3/attachments/${imageId}`, alt: 'photo' } },
] });
const refs = (content: DocNode) => {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'attachment' || n.type === 'video' || n.type === 'audio') out.push(String(n.attrs?.id));
    if (n.type === 'image') out.push(String(n.attrs?.src).split('/').pop()!);
    (n.content ?? []).forEach(walk);
  };
  walk(content);
  return out;
};
// Enregistre un contenu (If-Match obligatoire) et renvoie le statut.
async function save(s: S, page: string, content: object): Promise<number> {
  const etag = (await call(s, 'GET', `/api/v3/pages/${page}`)).headers.etag as string;
  return (await app!.inject({ method: 'PATCH', url: `/api/v3/pages/${page}`, payload: { content }, cookies: s.cookies, headers: { ...s.headers, 'if-match': etag } })).statusCode;
}
const rowsOf = (pageId: string) => (db.prepare('SELECT id FROM attachments WHERE page_id = ? ORDER BY rowid').all(pageId) as { id: string }[]).map((r) => r.id);

describe('blocs de pièce jointe dans le contenu', () => {
  it('garde les attributs valides, retire le bloc sans identifiant valide sans refuser la page', () => {
    const doc = sanitizeDoc({ type: 'doc', content: [
      { type: 'attachment', attrs: { id: ID, name: 'a.pdf', size: 12, mime: 'application/pdf', onclick: 'x' } },
      { type: 'attachment', attrs: { id: ID, name: 'b', size: -1, mime: 'text/html' } },
      { type: 'video', attrs: { id: ID, name: 'v.mp4', width: 50 } },
      { type: 'video', attrs: { id: ID, name: 'v.mp4', width: 640 } },
      { type: 'audio', attrs: { id: ID, name: 'son.mp3' } },
      { type: 'attachment', attrs: { id: '../../etc/passwd', name: 'x' } },
      { type: 'audio', attrs: {} },
      { type: 'paragraph', content: [{ type: 'text', text: 'reste' }] },
    ] });
    expect(doc.content).toEqual([
      { type: 'attachment', attrs: { id: ID, name: 'a.pdf', size: 12, mime: 'application/pdf' } },
      { type: 'attachment', attrs: { id: ID, name: 'b' } },
      { type: 'video', attrs: { id: ID, name: 'v.mp4' } },
      { type: 'video', attrs: { id: ID, name: 'v.mp4', width: 640 } },
      { type: 'audio', attrs: { id: ID, name: 'son.mp3' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'reste' }] },
    ]);
  });

  it('export Markdown et rendu HTML : lien vers le fichier, nom échappé', () => {
    const doc: DocNode = { type: 'doc', content: [{ type: 'attachment', attrs: { id: ID, name: 'rapport <b>[x]</b>.pdf' } }, { type: 'video', attrs: { id: ID, name: 'v.mp4' } }] };
    const md = toMarkdown('T', '', doc, () => null);
    expect(md).toContain(`[rapport <b>\\[x\\]</b>.pdf](/api/v3/attachments/${ID})`);
    expect(md).toContain(`[v.mp4](/api/v3/attachments/${ID})`);
    const html = renderHtml(doc, () => null);
    expect(html).toContain(`<a href="/api/v3/attachments/${ID}" rel="nofollow">rapport &lt;b&gt;[x]&lt;/b&gt;.pdf</a>`);
    expect(html).not.toContain('<b>');
  });

  it('/config donne la taille maximale ; une page enregistre ses blocs ; espace public : fichier et image lisibles sans compte', async () => {
    await boot({ ATTACHMENT_MAX_MB: '7' });
    expect((await call(null, 'GET', '/api/v3/config')).json().attachmentMaxMb).toBe(7);
    db.prepare("UPDATE spaces SET visibility = 'public' WHERE id = 'sp'").run();
    const ed1 = await login('ed1');
    const file = await upload(ed1, 'p1', 'note.pdf', Buffer.from('%PDF-1.4'));
    const img = await upload(ed1, 'p1', 'photo.png', PNG);
    expect(await save(ed1, 'p1', docWith(file, img))).toBe(200);
    expect(refs((await call(ed1, 'GET', '/api/v3/pages/p1')).json().content)).toEqual([file, img]);
    expect((await call(null, 'GET', `/api/v3/attachments/${img}`)).statusCode).toBe(200);
    expect((await call(null, 'GET', `/api/v3/attachments/${file}`)).statusCode).toBe(200);
    expect((await call(null, 'GET', '/api/v3/pages/p1/export')).body).toContain(`(/api/v3/attachments/${file})`);
  });
});

describe('copie des fichiers avec la page', () => {
  async function source() {
    await boot();
    const ed1 = await login('ed1');
    const file = await upload(ed1, 'p1', 'note.pdf', Buffer.from('%PDF-1.4'));
    const img = await upload(ed1, 'p1', 'photo.png', PNG);
    expect(await save(ed1, 'p1', docWith(file, img))).toBe(200);
    return { ed1, file, img };
  }
  // Supprime définitivement la source : la copie ne doit pas en dépendre.
  async function destroySource() {
    const admin = await login('admin');
    expect((await call(admin, 'DELETE', '/api/v3/pages/p1')).statusCode).toBe(204);
    expect((await call(admin, 'DELETE', '/api/v3/pages/p1/permanent')).statusCode).toBe(204);
    await vi.waitFor(() => expect(rowsOf('p1')).toEqual([]));
  }

  it('duplication : nouvelles lignes et nouveaux fichiers, la copie survit à la suppression de la source', async () => {
    const { ed1, file, img } = await source();
    const dup = await call(ed1, 'POST', '/api/v3/pages/p1/duplicate');
    expect(dup.statusCode, dup.body).toBe(201);
    const copy = (await call(ed1, 'GET', `/api/v3/pages/${dup.json().id}`)).json();
    const ids = refs(copy.content);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(file);
    expect(ids).not.toContain(img);
    expect(rowsOf(copy.id)).toEqual(ids);
    await destroySource();
    await vi.waitFor(() => expect(existsSync(join(filesDir, file))).toBe(false));
    for (const id of ids) expect((await call(ed1, 'GET', `/api/v3/attachments/${id}`)).statusCode).toBe(200);
  });

  it('copie vers un autre espace : idem, et le journal compte les fichiers copiés', async () => {
    const { ed1 } = await source();
    const res = await call(ed1, 'POST', '/api/v3/pages/p1/copy', { spaceId: 'sp2' });
    expect(res.statusCode, res.body).toBe(201);
    const pageId = res.json().page.id as string;
    expect(rowsOf(pageId)).toHaveLength(2);
    const meta = JSON.parse((db.prepare("SELECT meta FROM audit_log WHERE action = 'page.copy'").get() as { meta: string }).meta);
    expect(meta.attachments).toBe(2);
    await destroySource();
    for (const id of rowsOf(pageId)) expect((await call(ed1, 'GET', `/api/v3/attachments/${id}`)).statusCode).toBe(200);
  });

  it('modèle : fichiers rattachés au modèle, lisibles par l’espace ; page créée depuis le modèle : fichiers à elle', async () => {
    const { ed1, file } = await source();
    const t = await call(ed1, 'POST', '/api/v3/templates', { pageId: 'p1' });
    expect(t.statusCode, t.body).toBe(201);
    const tpl = (await call(ed1, 'GET', `/api/v3/templates/${t.json().id}`)).json();
    const tplIds = refs(tpl.content);
    expect(tplIds).toHaveLength(2);
    expect(tplIds).not.toContain(file);
    await destroySource();
    expect((await call(await login('rd'), 'GET', `/api/v3/attachments/${tplIds[0]}`)).statusCode).toBe(200);
    expect((await call(null, 'GET', `/api/v3/attachments/${tplIds[0]}`)).statusCode).toBe(404);
    // Une pièce jointe de modèle ne se supprime pas seule.
    expect((await call(ed1, 'DELETE', `/api/v3/attachments/${tplIds[0]}`)).statusCode).toBe(404);

    const created = await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sp', title: 'Depuis le modèle', content: tpl.content });
    expect(created.statusCode, created.body).toBe(201);
    const pageIds = refs(created.json().content);
    expect(rowsOf(created.json().id)).toEqual(pageIds);
    expect(pageIds.some((id) => tplIds.includes(id))).toBe(false);

    // Modèle supprimé : ses fichiers partent avec lui, pas ceux de la page créée.
    expect((await call(ed1, 'DELETE', `/api/v3/templates/${t.json().id}`)).statusCode).toBe(204);
    await vi.waitFor(() => expect(tplIds.some((id) => existsSync(join(filesDir, id)))).toBe(false));
    for (const id of pageIds) expect(existsSync(join(filesDir, id))).toBe(true);
  });

  it('pièce jointe illisible : jamais copiée ; plafond dépassé : copie refusée sans fichier laissé', async () => {
    await boot({ ATTACHMENTS_TOTAL_MB: '1' });
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('secret', 'sp', 'Secret', '{\"type\":\"doc\",\"content\":[]}', '', 1, 1)").run();
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'ed2', 'write')").run();
    const hidden = await upload(await login('ed2'), 'secret', 'cache.pdf', Buffer.from('%PDF-1.4'));
    const ed1 = await login('ed1');
    const created = await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sp', content: { type: 'doc', content: [{ type: 'attachment', attrs: { id: hidden, name: 'x' } }] } });
    expect(created.statusCode).toBe(201);
    expect(refs(created.json().content)).toEqual([hidden]);
    expect(rowsOf(created.json().id)).toEqual([]);

    const big = await upload(ed1, 'p1', 'gros.bin', randomBytes(600 * 1024));
    const before = readdirSync(filesDir).sort();
    expect(await save(ed1, 'p1', { type: 'doc', content: [{ type: 'attachment', attrs: { id: big, name: 'gros.bin' } }] })).toBe(200);
    expect((await call(ed1, 'POST', '/api/v3/pages/p1/duplicate')).statusCode).toBe(413);
    expect(readdirSync(filesDir).sort()).toEqual(before);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pages WHERE title LIKE '%(copie)'").get() as { n: number }).n).toBe(0);
  });
});

describe('pièces jointes qui ne sont plus citées', () => {
  it('marquées, puis supprimées après le délai ; citées de nouveau ou dans l’historique : conservées', async () => {
    await boot();
    const ed1 = await login('ed1');
    const never = await upload(ed1, 'p1', 'jamais.txt', Buffer.from('a'));
    const old = await upload(ed1, 'p1', 'ancien.txt', Buffer.from('b'));
    const back = await upload(ed1, 'p1', 'retour.txt', Buffer.from('c'));
    const block = (id: string) => ({ type: 'attachment', attrs: { id, name: 'x' } });
    // « ancien » n'est cité que par une version de l'historique (contenu actuel sans lui) : l'historique le garde.
    db.prepare("INSERT INTO page_versions (page_id, title, content, created_at, created_by, session_start) VALUES ('p1', 'Source', ?, 1, 'ed1', 1)")
      .run(JSON.stringify({ type: 'doc', content: [block(old)] }));
    expect(await save(ed1, 'p1', { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(200);
    const t0 = Date.now();
    expect(sweepUnreferenced(db, t0)).toBe(0);
    const since = (id: string) => (db.prepare('SELECT unreferenced_since AS s FROM attachments WHERE id = ?').get(id) as { s: number | null } | undefined)?.s;
    expect(since(never)).toBe(t0);
    expect(since(back)).toBe(t0);
    expect(since(old)).toBeNull();
    // « retour » est cité de nouveau avant la fin du délai : sa marque est levée.
    db.prepare("UPDATE pages SET content = ? WHERE id = 'p1'").run(JSON.stringify({ type: 'doc', content: [block(back)] }));
    expect(sweepUnreferenced(db, t0 + 1000)).toBe(0);
    expect(since(back)).toBeNull();
    expect(sweepUnreferenced(db, t0 + UNREFERENCED_GRACE_MS)).toBe(1);
    expect(rowsOf('p1').sort()).toEqual([old, back].sort());
    await drainAttachmentGc(db, filesDir);
    expect(existsSync(join(filesDir, never))).toBe(false);
    expect(existsSync(join(filesDir, old))).toBe(true);
    expect((db.prepare("SELECT action FROM audit_log WHERE action = 'attachment.unreferenced.purge'").get())).toBeTruthy();
  });

  it('migration v20 : les pièces jointes existantes sont conservées', () => {
    const file = oldDb(19, (raw) => raw.prepare(`INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, 'p1', 'u1', 'a.txt', 'application/octet-stream', 1, ?, 0)`).run(ID, 'a'.repeat(64)));
    const up = openDb(file);
    expect(up.prepare('SELECT id, page_id, template_id, unreferenced_since FROM attachments').all()).toEqual([{ id: ID, page_id: 'p1', template_id: null, unreferenced_since: null }]);
    up.prepare("DELETE FROM pages WHERE id = 'p1'").run();
    expect(up.prepare('SELECT id FROM attachment_gc').all()).toEqual([{ id: ID }]);
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(20);
  });
});

describe('citations d’une autre page et plafonds de copie', () => {
  const block = (id: string) => ({ type: 'attachment', attrs: { id, name: 'x' } });
  const addPage = (id: string) => db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, 'sp', ?, '{\"type\":\"doc\",\"content\":[]}', '', 1, 1)").run(id, id);
  const pageRefs = async (s: S, id: string) => refs((await call(s, 'GET', `/api/v3/pages/${id}`)).json().content);

  it('bloc collé depuis P dans Q : copié dans Q une seule fois ; illisible ou inconnu : retiré', async () => {
    await boot();
    addPage('q');
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('secret', 'sp', 'Secret', '{\"type\":\"doc\",\"content\":[]}', '', 1, 1)").run();
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'ed2', 'write')").run();
    const hidden = await upload(await login('ed2'), 'secret', 'cache.txt', Buffer.from('cache'));
    const ed1 = await login('ed1');
    const x = await upload(ed1, 'p1', 'x.txt', Buffer.from('x'));
    expect(await save(ed1, 'q', { type: 'doc', content: [block(x), block(hidden), block(ID)] })).toBe(200);
    const [copy, ...rest] = await pageRefs(ed1, 'q');
    expect(rest).toEqual([]);
    expect(copy).not.toBe(x);
    expect(db.prepare('SELECT page_id, copied_from FROM attachments WHERE id = ?').get(copy)).toEqual({ page_id: 'q', copied_from: x });
    // Le client garde l'identifiant d'origine (co-édition) : l'enregistrement suivant réutilise la même copie.
    expect(await save(ed1, 'q', { type: 'doc', content: [block(x), { type: 'paragraph', content: [{ type: 'text', text: 'suite' }] }] })).toBe(200);
    expect(await pageRefs(ed1, 'q')).toEqual([copy]);
    expect(rowsOf('q')).toEqual([copy]);
    // Retiré de P puis délai écoulé : le fichier de P part, celui de Q reste.
    expect(await save(ed1, 'p1', { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(200);
    const t0 = Date.now();
    sweepUnreferenced(db, t0);
    sweepUnreferenced(db, t0 + UNREFERENCED_GRACE_MS);
    await drainAttachmentGc(db, filesDir);
    expect(existsSync(join(filesDir, copy!))).toBe(true);
    expect((await call(ed1, 'GET', `/api/v3/attachments/${copy}`)).statusCode).toBe(200);
  });

  it('nettoyage : jamais un fichier encore cité par une autre page', async () => {
    await boot();
    addPage('q');
    const ed1 = await login('ed1');
    const x = await upload(ed1, 'p1', 'x.txt', Buffer.from('x'));
    // Citation écrite sans passer par l'API (ancienne page, import) : le nettoyage la trouve quand même.
    db.prepare("UPDATE pages SET content = ? WHERE id = 'q'").run(JSON.stringify({ type: 'doc', content: [block(x)] }));
    const t0 = Date.now();
    sweepUnreferenced(db, t0);
    expect(sweepUnreferenced(db, t0 + UNREFERENCED_GRACE_MS)).toBe(0);
    expect(rowsOf('p1')).toEqual([x]);
    expect((db.prepare('SELECT unreferenced_since AS s FROM attachments WHERE id = ?').get(x) as { s: number | null }).s).toBeNull();
  });

  it('plafond par opération et envois en cours comptés ; duplication à débit limité', async () => {
    await boot({ ATTACHMENT_COPY_MAX_MB: '1', ATTACHMENTS_TOTAL_MB: '3' });
    const ed1 = await login('ed1');
    const a = await upload(ed1, 'p1', 'a.bin', randomBytes(600 * 1024));
    const b = await upload(ed1, 'p1', 'b.bin', randomBytes(600 * 1024));
    expect(await save(ed1, 'p1', { type: 'doc', content: [block(a), block(b)] })).toBe(200);
    const tooMuch = await call(ed1, 'POST', '/api/v3/pages/p1/duplicate');
    expect(tooMuch.statusCode).toBe(413);
    expect(tooMuch.json().detail).toMatch(/1 Mo au plus/);
    expect(await save(ed1, 'p1', { type: 'doc', content: [block(a)] })).toBe(200);
    // 1,8 Mo en cours d'envoi : 600 Ko de plus dépasseraient les 3 Mo de l'instance (1,2 Mo déjà en base).
    reservations(db).total = 1800 * 1024;
    expect((await call(ed1, 'POST', '/api/v3/pages/p1/duplicate')).statusCode).toBe(413);
    reservations(db).total = 0;
    expect((await call(ed1, 'POST', '/api/v3/pages/p1/duplicate')).statusCode).toBe(201);
    expect(await save(ed1, 'p1', { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(200);
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await call(ed1, 'POST', '/api/v3/pages/p1/duplicate')).statusCode;
    expect(last).toBe(429);
  });
});
