// Espaces personnels (lot 6 bis) : un seul membre, invisibles des administrateurs, orphelins repris sous contrôle.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from '../src/auth/context.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { spaceRoles } from '../src/lib/space-access.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('shared', 'Commun', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('shared', 'everyone', 'edit')").run();
});
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
const enable = async () => expect((await call(await login('admin'), 'PUT', '/api/v3/admin/personal-spaces', { enabled: true })).statusCode).toBe(200);
const names = async (s: S | null) => ((await call(s, 'GET', '/api/v3/spaces')).json() as { name: string }[]).map((x) => x.name).sort();
async function mine(id: string) {
  const s = await login(id);
  const res = await call(s, 'POST', '/api/v3/spaces/personal');
  expect(res.statusCode).toBeLessThan(300);
  const space = res.json() as { id: string };
  const page = await call(s, 'POST', '/api/v3/pages', { spaceId: space.id, title: `Secret de ${id}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `contenu intime ${id}` }] }] } });
  expect(page.statusCode).toBe(201);
  return { s, spaceId: space.id, pageId: page.json().id as string };
}

describe('création', () => {
  it('refusée tant que l’instance ne l’autorise pas ; réservée à qui peut écrire', async () => {
    expect((await call(await login('ed1'), 'POST', '/api/v3/spaces/personal')).statusCode).toBe(403);
    expect((await call(await login('ed1'), 'PUT', '/api/v3/admin/personal-spaces', { enabled: true })).statusCode).toBe(403);
    await enable();
    expect((await call(await login('rd'), 'POST', '/api/v3/spaces/personal')).statusCode).toBe(403);
    expect((await call(null, 'POST', '/api/v3/spaces/personal')).statusCode).toBe(401);
    expect((await call(await login('ed1'), 'POST', '/api/v3/spaces/personal')).statusCode).toBe(201);
  });

  it('un seul espace par compte : un second appel renvoie le même ; le réglage ne ferme que la création', async () => {
    await enable();
    const ed1 = await login('ed1');
    const first = (await call(ed1, 'POST', '/api/v3/spaces/personal')).json() as { id: string; kind: string; ownerId: string; role: string; visibility: string };
    const again = await call(ed1, 'POST', '/api/v3/spaces/personal');
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
    expect(first).toMatchObject({ kind: 'personal', ownerId: 'ed1', role: 'full', visibility: 'private' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'personal'").get()).toEqual({ n: 1 });
    await call(await login('admin'), 'PUT', '/api/v3/admin/personal-spaces', { enabled: false });
    expect((await call(ed1, 'GET', `/api/v3/pages?spaceId=${first.id}`)).statusCode).toBe(200); // l'existant reste à son propriétaire
    expect((await call(await login('ed2'), 'POST', '/api/v3/spaces/personal')).statusCode).toBe(403);
  });
});

describe('accès : le propriétaire seul', () => {
  it('ni les administrateurs, ni les autres comptes, ni les visiteurs ne voient l’espace ni ses pages', async () => {
    await enable();
    const m = await mine('ed1');
    expect(await names(m.s)).toContain('Espace de Nom ed1');
    for (const who of [await login('admin'), await login('ed2'), await login('rd'), null]) {
      expect(await names(who)).not.toContain('Espace de Nom ed1');
      expect((await call(who, 'GET', `/api/v3/pages/${m.pageId}`)).statusCode).toBeGreaterThanOrEqual(401);
    }
    const admin = await login('admin');
    expect((await call(admin, 'GET', `/api/v3/pages/${m.pageId}`)).statusCode).toBe(404);
    expect((await call(admin, 'PATCH', `/api/v3/pages/${m.pageId}`, { title: 'X' })).statusCode).toBe(404);
    expect((await call(admin, 'POST', '/api/v3/pages', { spaceId: m.spaceId, title: 'Intrus' })).statusCode).toBe(404);
    expect((await call(admin, 'PATCH', `/api/v3/spaces/${m.spaceId}`, { name: 'Pris' })).statusCode).toBe(404);
    expect((await call(admin, 'GET', `/api/v3/spaces/${m.spaceId}/members`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/v3/spaces/${m.spaceId}`)).statusCode).toBe(404);
    expect((await call(admin, 'POST', '/api/v3/admin/import/markdown', { spaceId: m.spaceId, files: [{ path: 'a.md', content: '# a' }] })).statusCode).toBe(404);
    const search = (await call(admin, 'GET', '/api/v3/search?q=intime')).json() as { items: unknown[] };
    expect(search.items).toHaveLength(0);
    const listed = (await call(admin, 'GET', '/api/v3/pages?limit=100')).json() as { items: { id: string }[] };
    expect(listed.items.map((p) => p.id)).not.toContain(m.pageId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pages').get()).toEqual({ n: 1 });
  });

  it('aucune adhésion ajoutée à la main (groupe, tout le monde, personne) n’ouvre l’espace', async () => {
    await enable();
    const m = await mine('ed1');
    db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES (?, 'everyone', 'full')").run(m.spaceId);
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, 'ed2', 'full')").run(m.spaceId);
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, 'admin', 'full')").run(m.spaceId);
    for (const id of ['ed2', 'admin', 'rd']) {
      const role = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: 'admin' | 'editor' | 'reader' };
      const auth: Auth = { user: { id, name: id, email: null, role: role.role }, via: 'session', scopes: new Set(['read']) };
      expect(spaceRoles(db, auth).has(m.spaceId), id).toBe(false);
    }
  });

  it('on n’y ajoute personne, on ne la rend pas publique, et la base le refuse aussi', async () => {
    await enable();
    const m = await mine('ed1');
    expect((await call(m.s, 'PUT', `/api/v3/spaces/${m.spaceId}/members`, { userId: 'ed2', role: 'view' })).statusCode).toBe(409);
    expect((await call(m.s, 'GET', `/api/v3/spaces/${m.spaceId}/members`)).statusCode).toBe(409);
    expect((await call(m.s, 'PATCH', `/api/v3/spaces/${m.spaceId}`, { visibility: 'public' })).statusCode).toBe(409);
    expect((await call(m.s, 'PATCH', `/api/v3/spaces/${m.spaceId}`, { name: 'Mon coin' })).statusCode).toBe(200);
    expect(() => db.prepare("UPDATE spaces SET visibility = 'public' WHERE id = ?").run(m.spaceId)).toThrow(/toujours privé/);
    expect(() => db.prepare("INSERT INTO spaces (id, name, visibility, kind, owner_id, created_at, updated_at) VALUES ('x', 'x', 'public', 'personal', 'ed2', 0, 0)").run()).toThrow(/toujours privé/);
  });

  it('les mentions ne proposent que le propriétaire dans son espace', async () => {
    await enable();
    const m = await mine('ed1');
    const found = (await call(m.s, 'GET', `/api/v3/pages/${m.pageId}/mentionable?q=Nom`)).json() as { items: { id: string }[] };
    expect(found.items.map((u) => u.id)).toEqual(['ed1']);
  });

  it('le propriétaire peut copier une page vers un espace commun, et supprimer son espace', async () => {
    await enable();
    const m = await mine('ed1');
    expect((await call(m.s, 'POST', `/api/v3/pages/${m.pageId}/copy`, { spaceId: 'shared' })).statusCode).toBe(201);
    expect((await call(m.s, 'DELETE', '/api/v3/spaces/personal')).statusCode).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'personal'").get()).toEqual({ n: 0 });
    expect((await call(m.s, 'DELETE', '/api/v3/spaces/personal')).statusCode).toBe(404);
  });
});

describe('webhooks', () => {
  it('aucun événement d’un espace personnel n’est transmis à un service externe ; ceux d’un espace partagé le sont', async () => {
    await enable();
    const m = await mine('ed1');
    const page = db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('ps', 'shared', 'Page', '{}', '', 1, 1)");
    page.run();
    db.prepare("INSERT INTO webhooks (id, name, url, secret, events, created_at) VALUES ('h1', 'essai', 'https://hooks.invalid/x', 'secret-secret', ?, 0)").run(JSON.stringify(['page.updated', 'page.created']));
    app.bus.publish({ type: 'page.updated', spaceId: m.spaceId, pageId: m.pageId, version: 2 });
    app.bus.publish({ type: 'page.updated', pageId: m.pageId, version: 3 }); // sans espace dans l'événement : retrouvé par la page
    await new Promise((r) => setTimeout(r, 400));
    expect(db.prepare("SELECT last_at FROM webhooks WHERE id = 'h1'").get()).toEqual({ last_at: null });
    app.bus.publish({ type: 'page.updated', spaceId: 'shared', pageId: 'ps', version: 2 });
    for (let i = 0; i < 40 && (db.prepare("SELECT last_at FROM webhooks WHERE id = 'h1'").get() as { last_at: number | null }).last_at === null; i++) await new Promise((r) => setTimeout(r, 100));
    expect((db.prepare("SELECT last_at FROM webhooks WHERE id = 'h1'").get() as { last_at: number | null }).last_at).not.toBeNull();
  });
});

describe('compte supprimé : espace orphelin', () => {
  it('reste invisible de tous, puis un administrateur le reprend (mot de passe redemandé, journal) ou le supprime', async () => {
    await enable();
    const a = await mine('ed1');
    const b = await mine('ed2');
    const admin = await login('admin');
    expect((await call(admin, 'POST', '/api/v3/admin/users/ed1/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare('SELECT owner_id FROM spaces WHERE id = ?').get(a.spaceId)).toEqual({ owner_id: null });
    expect((await call(admin, 'GET', `/api/v3/pages/${a.pageId}`)).statusCode).toBe(404);
    expect(await names(admin)).not.toContain('Espace de Nom ed1');

    const status = (await call(admin, 'GET', '/api/v3/admin/personal-spaces')).json() as { enabled: boolean; count: number; orphans: { id: string; pages: number }[] };
    expect(status.orphans).toEqual([expect.objectContaining({ id: a.spaceId, pages: 1 })]);
    expect(JSON.stringify(status)).not.toContain('intime'); // jamais de contenu

    // L'espace d'un compte existant n'est ni repris ni supprimé par un administrateur.
    expect((await call(admin, 'POST', `/api/v3/admin/personal-spaces/${b.spaceId}/recover`, { reauth: { password: PASS } })).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/v3/spaces/${b.spaceId}`)).statusCode).toBe(404);
    // Reprise : mot de passe obligatoire, puis espace partagé visible des administrateurs.
    expect((await call(admin, 'POST', `/api/v3/admin/personal-spaces/${a.spaceId}/recover`, { reauth: { password: 'mauvais' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect(db.prepare('SELECT kind FROM spaces WHERE id = ?').get(a.spaceId)).toEqual({ kind: 'personal' });
    expect((await call(admin, 'POST', `/api/v3/admin/personal-spaces/${a.spaceId}/recover`, { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare('SELECT kind, owner_id FROM spaces WHERE id = ?').get(a.spaceId)).toEqual({ kind: 'shared', owner_id: null });
    expect((await call(admin, 'GET', `/api/v3/pages/${a.pageId}`)).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'space.personal.recover'").get()).toEqual({ n: 1 });
    // Un autre orphelin se supprime directement.
    await call(admin, 'POST', '/api/v3/admin/users/ed2/erase', { reauth: { password: PASS } });
    expect((await call(admin, 'DELETE', `/api/v3/spaces/${b.spaceId}`)).statusCode).toBe(204);
  });
});

describe('migration v15', () => {
  it('les espaces existants restent partagés et leurs droits ne changent pas', () => {
    const file = oldDb(14);
    const up = openDb(file);
    expect(up.prepare('SELECT kind, owner_id FROM spaces').all()).toEqual([{ kind: 'shared', owner_id: null }]);
    up.close();
  });
});
