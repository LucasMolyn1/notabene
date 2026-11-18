// Partage d'un espace entier par lien (lecture seule, sans compte) : réglages, droits, contenu servi, révocation, expiration.
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { backupTo } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { cleanup, type DB, openDb } from '../src/db.js';
import { sha256 } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';

const PASS = 'Sup3r-secret-pass';
const doc = (...content: object[]) => JSON.stringify({ type: 'doc', content });
const para = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(40)]);
let app: FastifyInstance;
let db: DB;
let dataDir: string;
const logs: string[] = [];

async function boot(logger = false) {
  dataDir = mkdtempSync(join(tmpdir(), 'nb-spshare-'));
  const clientDir = mkdtempSync(join(tmpdir(), 'nb-spshare-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><head><title>BeNote</title></head><body></body></html>');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir, ...(logger ? { logger: { level: 'info', stream: { write: (s: string) => { logs.push(s); } } } } : {}) });
  for (const [id, role] of [['admin', 'admin'], ['mgr', 'editor'], ['ed', 'editor'], ['out', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  // Espace privé : seuls ses membres le voient (aucun accès « tout le monde »).
  db.prepare("INSERT INTO spaces (id, name, icon, created_at, updated_at) VALUES ('prive', 'Client X', 'folder', 0, 0), ('autre', 'Autre', 'folder', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'mgr', 'full'), ('prive', 'ed', 'edit'), ('prive', 'rd', 'view'), ('autre', 'mgr', 'full')").run();
  const page = (id: string, space: string, parent: string | null, title: string, content: string, position = 0, kind = 'doc') =>
    db.prepare('INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, position, kind) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)').run(id, space, parent, title, content, title, position, kind);
  page('accueil', 'prive', null, 'Accueil', doc(para(text('Bienvenue '), { type: 'mention', attrs: { id: 'mgr' } }, text(' voir '), { type: 'pageLink', attrs: { id: 'chapitre' } }, text(' et '), { type: 'pageLink', attrs: { id: 'ailleurs' } })));
  page('chapitre', 'prive', 'accueil', 'Chapitre', doc(para(text('contenu chapitre'))));
  page('secret', 'prive', null, 'Secret', doc(para(text('contenu secret'))), 1);
  page('sous-secret', 'prive', 'secret', 'Sous-secret', doc(para(text('contenu sous-secret'))));
  page('jete', 'prive', null, 'Jetée', doc(para(text('contenu jeté'))), 2);
  page('base1', 'prive', null, 'Base', doc(), 3, 'base');
  page('ailleurs', 'autre', null, 'Ailleurs', doc(para(text('hors espace'))));
  db.prepare("UPDATE pages SET deleted_at = 1, trash_root = 'jete' WHERE id = 'jete'").run();
  db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'mgr', 'write')").run();
}
beforeEach(async () => { logs.length = 0; sessions.clear(); await boot(); });
afterEach(async () => { await app.close(); db.close(); });

const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();
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
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
async function enable(pages = true, spaces = true) {
  const admin = await login('admin');
  expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: pages })).statusCode).toBe(200);
  expect((await call(admin, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: spaces })).statusCode).toBe(200);
}
async function create(who = 'mgr', body: object = {}, space = 'prive') {
  const res = await call(await login(who), 'POST', `/api/v3/spaces/${space}/shares`, body);
  expect(res.statusCode, res.body).toBe(201);
  const j = res.json() as { id: string; url: string; expiresAt: number | null };
  return { ...j, token: j.url.split('/share/')[1]! };
}
const pub = (token: string, extra = '') => app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}${extra}` });
const auditActions = () => (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);

describe('réglages et droits', () => {
  it('désactivé par défaut, et le partage public des pages seul ne suffit pas', async () => {
    const mgr = await login('mgr');
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
    expect((await call(mgr, 'GET', '/api/v3/spaces/prive/shares')).json()).toMatchObject({ available: false, instanceEnabled: false, spaceSharingEnabled: false });
    await enable(true, false);
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
    // Le réglage dédié sans le partage public de l'instance ne vaut rien non plus.
    const admin = await login('admin');
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: false })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: true })).json()).toMatchObject({ enabled: true, effective: false });
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
    expect((await call(admin, 'GET', '/api/v3/admin/sharing')).json()).toMatchObject({ enabled: false, spaces: { enabled: true, links: 0 } });
    // Seul un administrateur règle l'instance.
    expect((await call(mgr, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: true })).statusCode).toBe(403);
  });

  it('réservé aux gestionnaires de l’espace et aux administrateurs, en session web', async () => {
    await enable();
    expect((await call(await login('ed'), 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
    expect((await call(await login('rd'), 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
    expect((await call(await login('ed'), 'GET', '/api/v3/spaces/prive/shares')).statusCode).toBe(403);
    // Sans accès à l'espace : introuvable.
    expect((await call(await login('out'), 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(404);
    expect((await call(await login('out'), 'GET', '/api/v3/spaces/prive/shares')).statusCode).toBe(404);
    expect((await call(null, 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(401);
    const tok = await call(await login('admin'), 'POST', '/api/v3/tokens', { name: 'essai', scopes: ['read', 'write', 'admin'], expiresInDays: 7 });
    expect((await app.inject({ method: 'POST', url: '/api/v3/spaces/prive/shares', headers: { authorization: `Bearer ${tok.json().token}` }, payload: {} })).statusCode).toBe(403);
    await create('mgr');
    await create('admin');
    expect(auditActions().filter((a) => a === 'space.share.create')).toHaveLength(2);
  });

  it('jamais un espace personnel, et pas quand l’espace interdit le partage', async () => {
    await enable();
    db.prepare("INSERT INTO spaces (id, name, kind, owner_id, sharing_enabled, created_at, updated_at) VALUES ('perso', 'Perso', 'personal', 'mgr', 0, 0, 0)").run();
    expect((await call(await login('mgr'), 'POST', '/api/v3/spaces/perso/shares', {})).statusCode).toBe(403);
    db.prepare("UPDATE spaces SET sharing_enabled = 0 WHERE id = 'prive'").run();
    expect((await call(await login('mgr'), 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(403);
  });

  it('valide les entrées et plafonne le nombre de liens actifs', async () => {
    await enable();
    const mgr = await login('mgr');
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', { expiresInDays: 0 })).statusCode).toBe(400);
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', { expiresInDays: 366 })).statusCode).toBe(400);
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', { label: 'x'.repeat(81) })).statusCode).toBe(400);
    for (let i = 0; i < 20; i++) await create('mgr', { label: `client ${i}` });
    expect((await call(mgr, 'POST', '/api/v3/spaces/prive/shares', {})).statusCode).toBe(409);
  });
});

describe('lien et stockage', () => {
  it('jeton long montré une seule fois ; seule son empreinte est gardée', async () => {
    await enable();
    const s = await create('mgr', { label: 'Client X', expiresInDays: 30 });
    expect(s.url).toMatch(/^http:\/\/localhost:3000\/share\/[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT * FROM space_shares WHERE id = ?').get(s.id) as Record<string, unknown>;
    expect(row.token_hash).toBe(sha256(s.token));
    expect(JSON.stringify(row)).not.toContain(s.token);
    const list = await call(await login('mgr'), 'GET', '/api/v3/spaces/prive/shares');
    expect(list.json()).toMatchObject({ available: true, items: [{ id: s.id, label: 'Client X', expired: false, createdBy: 'Nom mgr' }] });
    expect(list.body).not.toContain(s.token);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(s.token);
  });
});

describe('lecture sans compte', () => {
  it('sert l’arborescence d’un espace privé, sans pages restreintes, corbeille, bases ni autre espace', async () => {
    await enable();
    const { token } = await create();
    const res = await pub(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const j = res.json();
    expect(j).toMatchObject({ kind: 'space', indexing: false, space: { name: 'Client X' }, root: null, page: { id: 'accueil', title: 'Accueil' } });
    expect(j.tree).toEqual([
      { id: 'accueil', parentId: null, title: 'Accueil', icon: expect.any(String) },
      { id: 'chapitre', parentId: 'accueil', title: 'Chapitre', icon: expect.any(String) },
    ]);
    expect(res.body).not.toMatch(/Secret|Jetée|Base|Ailleurs|Nom mgr|"mention"|prive/);
    expect(res.body).toContain('@personne');
    expect(res.body).toContain('page non partagée');
    const chap = await pub(token, '/pages/chapitre');
    expect(chap.statusCode).toBe(200);
    expect(chap.json().page.title).toBe('Chapitre');
    // Pages exclues ou hors espace : la même réponse qu'un jeton inconnu.
    const unknown = await pub('A'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    for (const id of ['secret', 'sous-secret', 'jete', 'base1', 'ailleurs', 'inconnue']) {
      const r = await pub(token, `/pages/${id}`);
      expect(r.statusCode, id).toBe(404);
      expect(r.body).toBe(unknown.body);
    }
    // Une page restreinte APRÈS la création du lien cesse d'être servie, avec son sous-arbre.
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('accueil', 'mgr', 'write')").run();
    expect((await pub(token, '/pages/chapitre')).statusCode).toBe(404);
    expect((await pub(token)).json()).toMatchObject({ page: null, tree: [] });
  });

  it('pièces jointes : seulement par le jeton et pour une page servie', async () => {
    await enable();
    const mgr = await login('mgr');
    const upload = async (page: string) => {
      const boundary = `----nb${randomBytes(8).toString('hex')}`;
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const res = await app.inject({ method: 'POST', url: `/api/v3/pages/${page}/attachments`, payload, cookies: mgr.cookies, headers: { ...mgr.headers, 'content-type': `multipart/form-data; boundary=${boundary}` } });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { id: string }).id;
    };
    const open = await upload('chapitre');
    const hidden = await upload('secret');
    const elsewhere = await upload('ailleurs');
    const { token } = await create();
    const att = (id: string, t = token) => app.inject({ method: 'GET', url: `/api/v3/public/shares/${t}/attachments/${id}` });
    expect((await att(open)).statusCode).toBe(200);
    expect((await att(hidden)).statusCode).toBe(404);
    expect((await att(elsewhere)).statusCode).toBe(404);
    expect((await att(open, 'B'.repeat(43))).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v3/attachments/${open}` })).statusCode).toBe(404);
  });
});

describe('révocation, expiration et fermetures', () => {
  it('révoquer coupe le lien aussitôt ; un autre espace ne révoque rien', async () => {
    await enable();
    const s = await create();
    const mgr = await login('mgr');
    expect((await call(mgr, 'DELETE', `/api/v3/spaces/autre/shares/${s.id}`)).statusCode).toBe(404);
    expect((await call(await login('ed'), 'DELETE', `/api/v3/spaces/prive/shares/${s.id}`)).statusCode).toBe(403);
    expect((await pub(s.token)).statusCode).toBe(200);
    expect((await call(mgr, 'DELETE', `/api/v3/spaces/prive/shares/${s.id}`)).statusCode).toBe(204);
    expect((await pub(s.token)).statusCode).toBe(404);
    expect((await call(mgr, 'DELETE', `/api/v3/spaces/prive/shares/${s.id}`)).statusCode).toBe(404);
    expect(auditActions()).toContain('space.share.revoke');
  });

  it('le lien meurt dès que son créateur ne gère plus l\'espace (retiré, rétrogradé, plus administrateur)', async () => {
    await enable();
    const s = await create();
    expect((await pub(s.token)).statusCode).toBe(200);
    db.prepare("UPDATE space_members SET role = 'edit' WHERE space_id = 'prive' AND user_id = 'mgr'").run();
    expect((await pub(s.token)).statusCode).toBe(404);
    db.prepare("UPDATE space_members SET role = 'full' WHERE space_id = 'prive' AND user_id = 'mgr'").run();
    expect((await pub(s.token)).statusCode).toBe(200);
    db.prepare("DELETE FROM space_members WHERE space_id = 'prive' AND user_id = 'mgr'").run();
    expect((await pub(s.token)).statusCode).toBe(404);
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'mgr', 'full')").run();
    db.prepare("UPDATE users SET role = 'reader' WHERE id = 'mgr'").run();
    expect((await pub(s.token)).statusCode).toBe(404);
  });

  it('un lien expiré se tait, puis est purgé', async () => {
    await enable();
    const s = await create('mgr', { expiresInDays: 1 });
    expect(s.expiresAt).toBeGreaterThan(Date.now());
    expect((await pub(s.token)).statusCode).toBe(200);
    db.prepare('UPDATE space_shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, s.id);
    expect((await pub(s.token)).statusCode).toBe(404);
    expect((await call(await login('mgr'), 'GET', '/api/v3/spaces/prive/shares')).json().items[0].expired).toBe(true);
    cleanup(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM space_shares').get()).toEqual({ n: 0 });
  });

  it('couper le réglage dédié, le partage public ou celui de l’espace retire les liens ; réactiver ne les ressuscite pas', async () => {
    const admin = await login('admin');
    await enable();
    const a = await create();
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: false })).json()).toMatchObject({ removed: 1 });
    await enable();
    expect((await pub(a.token)).statusCode).toBe(404);
    expect(auditActions()).toContain('settings.space_sharing');

    const b = await create();
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: false })).statusCode).toBe(200);
    await enable();
    expect((await pub(b.token)).statusCode).toBe(404);

    const c = await create();
    expect((await call(admin, 'PATCH', '/api/v3/spaces/prive', { sharing: false })).statusCode).toBe(200);
    expect((await call(admin, 'PATCH', '/api/v3/spaces/prive', { sharing: true })).statusCode).toBe(200);
    expect((await pub(c.token)).statusCode).toBe(404);

    // Réglage relu à chaque lecture, même sans passer par la route qui efface les liens.
    const d = await create();
    db.prepare("UPDATE settings SET value = '{\"enabled\":false}' WHERE key = 'public_space_sharing'").run();
    expect((await pub(d.token)).statusCode).toBe(404);
  });

  it('le compte créateur désactivé emporte ses liens ; un espace supprimé aussi', async () => {
    await enable();
    const s = await create('mgr');
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'mgr'").run();
    expect((await pub(s.token)).statusCode).toBe(404);
    const t = await create('admin');
    db.prepare("DELETE FROM spaces WHERE id = 'prive'").run();
    expect((await pub(t.token)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM space_shares').get()).toEqual({ n: 0 });
  });
});

describe('journaux, enveloppe et sauvegarde', () => {
  it('le jeton n’apparaît jamais dans les journaux ; l’enveloppe /share n’est jamais indexée', async () => {
    await app.close(); db.close(); sessions.clear();
    await boot(true);
    await enable();
    const { token } = await create();
    const shell = await app.inject({ method: 'GET', url: `/share/${token}` });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(shell.headers['cache-control']).toBe('no-store');
    await pub(token);
    await pub(token, '/pages/chapitre');
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).toContain('[jeton]');
  });

  it('une sauvegarde ne garde aucun lien', async () => {
    await enable();
    await create();
    const file = join(dataDir, 'copie.db');
    await backupTo(db, file);
    const copy = new Database(file);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM space_shares').get()).toEqual({ n: 0 });
    copy.close();
  });
});
