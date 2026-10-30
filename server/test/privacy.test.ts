import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, cleanup, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['admin2@example.com', 'admin'], ['ed@example.com', 'editor'], ['ed2@example.com', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run(email.split('@')[0], `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, ...(s ?? {}) });
const space = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private' LIMIT 1").get() as { id: string }).id;

async function seedActivity(ed: S) {
  const page = (await call(ed, 'POST', '/api/v3/pages', { spaceId: space(), title: 'Ma page' })).json().id as string;
  await call(ed, 'POST', `/api/v3/pages/${page}/comments`, { body: 'mon commentaire' });
  await call(ed, 'PUT', `/api/v3/pages/${page}/favorite`);
  await call(ed, 'POST', '/api/v3/tokens', { name: 'mon jeton', scopes: ['read'], expiresInDays: 30 });
  return page;
}

describe('export des données personnelles', () => {
  it('renvoie les données de la personne, sans aucun secret', async () => {
    const ed = await login('ed@example.com');
    const page = await seedActivity(ed);
    const res = await call(ed, 'GET', '/api/v3/me/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.json();
    expect(data.profile).toMatchObject({ email: 'ed@example.com', role: 'editor' });
    expect(data.pagesCreated.map((p: { id: string }) => p.id)).toContain(page);
    expect(data.comments[0].body).toBe('mon commentaire');
    expect(data.favorites).toHaveLength(1);
    const text = JSON.stringify(data);
    for (const forbidden of ['password_hash', 'scrypt', 'totp_secret', 'token_hash', 'id_hash', 'recovery']) expect(text).not.toContain(forbidden);
  });

  it('n’expose pas le titre d’une page restreinte devenue illisible', async () => {
    const admin = await login('admin@example.com');
    const ed = await login('ed@example.com');
    const page = await seedActivity(ed);
    expect((await call(admin, 'PUT', `/api/v3/pages/${page}/permissions`, { entries: [{ userId: 'ed2', level: 'write' }] })).statusCode).toBe(200);
    expect(JSON.stringify((await call(ed, 'GET', '/api/v3/me/export')).json())).not.toContain('Ma page');
  });

  it('exige une session, et un administrateur pour exporter un autre compte', async () => {
    expect((await call(null, 'GET', '/api/v3/me/export')).statusCode).toBe(401);
    const ed = await login('ed@example.com');
    expect((await call(ed, 'GET', '/api/v3/admin/users/ed2/export')).statusCode).toBe(403);
    const admin = await login('admin@example.com');
    expect((await call(admin, 'GET', '/api/v3/admin/users/ed/export')).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/v3/admin/users/inconnu/export')).statusCode).toBe(404);
  });
});

describe('effacement d’un compte', () => {
  it('anonymise : le contenu reste sans auteur, le compte et ses données propres disparaissent', async () => {
    const admin = await login('admin@example.com');
    const ed = await login('ed@example.com');
    const page = await seedActivity(ed);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = 'ed' AND ip IS NOT NULL").get()).not.toEqual({ n: 0 });

    const res = await call(admin, 'POST', '/api/v3/admin/users/ed/erase', { reauth: { password: PASS } });
    expect(res.statusCode).toBe(200);

    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'ed'").get()).toEqual({ n: 0 });
    for (const t of ['sessions', 'api_tokens', 'favorites', 'page_watch', 'notification_prefs']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = 'ed'`).get(), t).toEqual({ n: 0 });
    }
    // Ce qu'elle a écrit reste, sans auteur.
    expect(db.prepare('SELECT created_by, updated_by FROM pages WHERE id = ?').get(page)).toEqual({ created_by: null, updated_by: null });
    expect(db.prepare('SELECT author_id, body FROM page_comments WHERE page_id = ?').get(page)).toEqual({ author_id: null, body: 'mon commentaire' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = 'ed' OR target = 'ed'").get()).toEqual({ n: 0 });
    // Ses connexions (identité seulement en cible) n'ont plus ni cible ni adresse IP.
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND target IS NULL AND ip IS NOT NULL").get()).toEqual({ n: 0 });
    // Sa session ne marche plus.
    expect((await call(ed, 'GET', '/api/v3/me/export')).statusCode).toBe(401);
    // L'effacement est journalisé, sans identité de la personne effacée.
    const entry = db.prepare("SELECT user_id, target, meta FROM audit_log WHERE action = 'user.erase'").get() as { user_id: string; target: string | null; meta: string };
    expect(entry.user_id).toBe('admin');
    expect(entry.target).toBeNull();
    expect(entry.meta).not.toContain('ed@example.com');
  });

  it('exige les droits d’administrateur et la ressaisie du mot de passe', async () => {
    const ed = await login('ed@example.com');
    expect((await call(ed, 'POST', '/api/v3/admin/users/ed2/erase', { reauth: { password: PASS } })).statusCode).toBe(403);
    const admin = await login('admin@example.com');
    expect((await call(admin, 'POST', '/api/v3/admin/users/ed2/erase', { reauth: { password: 'faux' } })).statusCode).toBe(401);
    expect((await call(admin, 'POST', '/api/v3/admin/users/ed2/erase', {})).statusCode).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'ed2'").get()).toEqual({ n: 1 });
  });

  it('refuse de supprimer son propre compte, et un compte inconnu', async () => {
    const admin = await login('admin@example.com');
    expect((await call(admin, 'POST', '/api/v3/admin/users/admin/erase', { reauth: { password: PASS } })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/api/v3/admin/users/inconnu/erase', { reauth: { password: PASS } })).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'admin'").get()).toEqual({ n: 1 });
  });
});

describe('conservation des données', () => {
  const day = 86_400_000;
  const seed = () => {
    const sp = space();
    const old = Date.now() - 40 * day;
    const mk = (id: string, parent: string | null, deletedAt: number | null, root: string | null) =>
      db.prepare("INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, deleted_at, trash_root) VALUES (?, ?, ?, ?, '{}', '', ?, ?, ?, ?)").run(id, sp, parent, id, old, old, deletedAt, root);
    mk('vieille', null, old, 'vieille'); mk('vieille-enfant', 'vieille', old, 'vieille');
    mk('recente', null, Date.now() - 2 * day, 'recente');
    db.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at, read_at) VALUES ('n-vieille', 'ed', 'comment', 'recente', ?, ?)").run(old, old);
    db.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at, read_at) VALUES ('n-non-lue', 'ed', 'comment', 'recente', ?, NULL)").run(old);
    db.prepare("INSERT INTO audit_log (at, user_id, action, ip) VALUES (?, 'ed', 'auth.login', '203.0.113.9')").run(Date.now() - 100 * day);
    db.prepare("INSERT INTO audit_log (at, user_id, action, ip) VALUES (?, 'ed', 'auth.login', '203.0.113.9')").run(Date.now() - 10 * day);
    db.prepare("INSERT INTO audit_log (at, user_id, action, ip) VALUES (?, 'ed', 'auth.login', '203.0.113.9')").run(Date.now() - 400 * day);
  };
  const retention = { trashDays: 30, notificationDays: 90, auditIpDays: 90, auditDays: 365 };
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  it('vide la corbeille ancienne (avec ses sous-pages), les notifications lues, les IP et le vieux journal', () => {
    seed();
    cleanup(db, { ...retention, notificationDays: 30 });
    expect(n("SELECT COUNT(*) AS n FROM pages WHERE id IN ('vieille', 'vieille-enfant')")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM pages WHERE id = 'recente'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM notifications WHERE id = 'n-vieille'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM notifications WHERE id = 'n-non-lue'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND ip IS NOT NULL")).toBe(1); // récent seulement
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login'")).toBe(2); // 400 jours supprimé
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'trash.purge'")).toBe(1);
  });

  it('0 jour désactive chaque purge', () => {
    seed();
    cleanup(db, { trashDays: 0, notificationDays: 0, auditIpDays: 0, auditDays: 0 });
    expect(n("SELECT COUNT(*) AS n FROM pages WHERE id = 'vieille'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM notifications")).toBe(2);
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND ip IS NOT NULL")).toBe(3);
  });
});
