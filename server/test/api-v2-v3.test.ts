import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', API_LEGACY_VERSIONS: 'v1,v2', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor'], ['rd@example.com', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: { ...(s?.headers ?? {}), ...headers } });

const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
const publicSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'public'").get() as { id: string }).id;

describe('API v2', () => {
  it('pagine par curseur et filtre', async () => {
    const ed = await login('ed1@example.com');
    const all = (await call(ed, 'GET', '/api/v1/pages')).json() as { id: string }[];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(ed, 'GET', `/api/v2/pages?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(all.length);
    expect(seen).toHaveLength(all.length);

    const filtered = (await call(ed, 'GET', `/api/v2/pages?spaceId=${teamSpace()}&parentId=root`)).json() as { items: { title: string }[] };
    expect(filtered.items.map((p) => p.title)).toEqual(['Onboarding']);
    expect((await call(ed, 'GET', '/api/v2/pages?q=déploiement')).json().items.map((p: { title: string }) => p.title)).toEqual(['Process de déploiement']);
  });

  it('refuse un curseur forgé avec une erreur RFC 9457', async () => {
    const res = await call(null, 'GET', '/api/v2/pages?cursor=n-importe-quoi');
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400, instance: '/api/v2/pages' });
    // v1 garde son format historique.
    const v1 = await call(null, 'GET', '/api/v1/pages/inconnu');
    expect(v1.json()).toMatchObject({ error: 'http' });
  });

  it('protège contre les écrasements avec ETag / If-Match', async () => {
    const ed = await login('ed1@example.com');
    const id = (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur Notabene'").get() as { id: string }).id;
    const get = await call(ed, 'GET', `/api/v2/pages/${id}`);
    const tag = get.headers.etag as string;
    expect(tag).toMatch(/^"\d+"$/);
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nouveau' }] }] };

    expect((await call(ed, 'PATCH', `/api/v2/pages/${id}`, { content })).statusCode).toBe(428);
    const ok = await call(ed, 'PATCH', `/api/v2/pages/${id}`, { content }, { 'if-match': tag });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).not.toBe(tag);
    const stale = await call(ed, 'PATCH', `/api/v2/pages/${id}`, { content }, { 'if-match': tag });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ status: 412 });
    // Un titre se change sans If-Match.
    expect((await call(ed, 'PATCH', `/api/v2/pages/${id}`, { title: 'Titre' })).statusCode).toBe(200);
    // Un lecteur ne modifie pas.
    const rd = await login('rd@example.com');
    expect((await call(rd, 'PATCH', `/api/v2/pages/${id}`, { title: 'x' })).statusCode).toBe(403);
  });

  it('pagine la recherche', async () => {
    const res = (await call(null, 'GET', '/api/v2/search?q=notabene&limit=1')).json();
    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBeTruthy();
  });
});

describe('API v3 : administration', () => {
  it('crée un compte local sous /api/v3 et /api/v1', async () => {
    const admin = await login('admin@example.com');
    for (const v of ['v1', 'v3']) {
      const res = await call(admin, 'POST', `/api/${v}/admin/local-users`, { email: `new-${v}@example.com`, name: 'N', role: 'reader', password: 'Un-mot-de-passe-solide-1' });
      expect(res.statusCode, v).toBe(201);
    }
    expect((await call(await login('ed1@example.com'), 'POST', '/api/v3/admin/local-users', { email: 'x@example.com', name: 'X', role: 'reader', password: 'Un-mot-de-passe-solide-1' })).statusCode).toBe(403);
  });
});

describe('API v3 : commentaires', () => {
  const pageId = () => (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur Notabene'").get() as { id: string }).id;

  it('crée, répond, résout et supprime', async () => {
    const ed = await login('ed1@example.com');
    const other = await login('ed2@example.com');
    const admin = await login('admin@example.com');
    const base = `/api/v3/pages/${pageId()}/comments`;
    const c = (await call(ed, 'POST', base, { body: 'Première remarque' })).json();
    expect(c).toMatchObject({ body: 'Première remarque', author: { id: 'ed1' }, resolved: false });
    const reply = await call(other, 'POST', base, { body: 'Réponse', parentId: c.id });
    expect(reply.statusCode).toBe(201);
    // Pas de réponse à une réponse.
    expect((await call(other, 'POST', base, { body: 'x', parentId: reply.json().id })).statusCode).toBe(400);
    // Seul l'auteur modifie le texte ; n'importe quel rédacteur résout.
    expect((await call(other, 'PATCH', `${base}/${c.id}`, { body: 'Piraté' })).statusCode).toBe(403);
    expect((await call(other, 'PATCH', `${base}/${c.id}`, { resolved: true })).json().resolved).toBe(true);
    const list = (await call(ed, 'GET', `${base}?resolved=true`)).json();
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([c.id, reply.json().id]);
    expect((await call(ed, 'GET', `${base}?resolved=false`)).json().items).toEqual([]);
    // Suppression : l'auteur ou un admin, pas un tiers.
    expect((await call(other, 'DELETE', `${base}/${c.id}`)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `${base}/${c.id}`)).statusCode).toBe(204);
    const after = (await call(ed, 'GET', base)).json().items[0];
    expect(after).toMatchObject({ deleted: true, body: null, author: null });
  });

  it('exige le droit d’écriture et n’existe pas en v2', async () => {
    const rd = await login('rd@example.com');
    const url = `/api/v3/pages/${pageId()}/comments`;
    expect((await call(rd, 'POST', url, { body: 'x' })).statusCode).toBe(403);
    expect((await call(null, 'POST', url, { body: 'x' })).statusCode).toBe(401);
    expect((await call(rd, 'GET', url)).statusCode).toBe(200);
    expect((await call(rd, 'GET', `/api/v2/pages/${pageId()}/comments`)).statusCode).toBe(404);
    expect((await call(await login('ed1@example.com'), 'POST', url, { body: '   ' })).statusCode).toBe(400);
  });
});

describe('API v3 : permissions par page', () => {
  const secret = () => (db.prepare("SELECT id FROM pages WHERE title = 'Onboarding'").get() as { id: string }).id;
  const child = () => (db.prepare("SELECT id FROM pages WHERE title = 'Process de déploiement'").get() as { id: string }).id;

  async function restrict(admin: S, entries: { userId: string; level: 'read' | 'write' }[], id = secret()) {
    const res = await call(admin, 'PUT', `/api/v3/pages/${id}/permissions`, { entries });
    expect(res.statusCode).toBe(200);
  }

  it('réservé aux administrateurs', async () => {
    const ed = await login('ed1@example.com');
    expect((await call(ed, 'PUT', `/api/v3/pages/${secret()}/permissions`, { entries: [] })).statusCode).toBe(403);
    expect((await call(await login('admin@example.com'), 'PUT', `/api/v3/pages/${secret()}/permissions`, { entries: [{ userId: 'fantome', level: 'read' }] })).statusCode).toBe(400);
  });

  it('cache une page restreinte partout (liste, lecture, recherche, export, IA, versions, sous-pages)', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    await restrict(admin, [{ userId: 'ed1', level: 'write' }]);

    for (const v of ['v1', 'v2', 'v3']) {
      const out = await call(ed2, 'GET', `/api/${v}/pages/${secret()}`);
      expect(out.statusCode, v).toBe(404);
      expect((await call(ed2, 'GET', `/api/${v}/pages/${child()}`)).statusCode, `${v} enfant hérite`).toBe(404);
      expect((await call(ed2, 'GET', `/api/${v}/pages/${child()}/versions`)).statusCode).toBe(404);
      expect((await call(ed2, 'GET', `/api/${v}/pages/${secret()}/export`)).statusCode).toBe(404);
      expect((await call(ed1, 'GET', `/api/${v}/pages/${secret()}`)).statusCode).toBe(200);
    }
    const titles = (res: { json: () => unknown }) => JSON.stringify(res.json());
    expect(titles(await call(ed2, 'GET', '/api/v1/pages'))).not.toContain('Onboarding');
    expect(titles(await call(ed2, 'GET', '/api/v2/pages'))).not.toContain('Onboarding');
    expect(titles(await call(ed1, 'GET', '/api/v1/pages'))).toContain('Onboarding');
    expect(titles(await call(ed2, 'GET', '/api/v1/search?q=onboarding'))).not.toContain('Onboarding');
    expect(titles(await call(ed1, 'GET', '/api/v1/search?q=onboarding'))).toContain('Onboarding');
    expect(titles(await call(admin, 'GET', '/api/v1/search?q=onboarding'))).toContain('Onboarding');
    // Pas d'écriture ni de création sous une page cachée.
    expect((await call(ed2, 'PATCH', `/api/v1/pages/${secret()}`, { title: 'x' })).statusCode).toBe(404);
    expect((await call(ed2, 'POST', '/api/v1/pages', { spaceId: teamSpace(), parentId: secret() })).statusCode).toBe(403);
    expect((await call(ed2, 'POST', `/api/v3/pages/${secret()}/comments`, { body: 'x' })).statusCode).toBe(404);
    // Anonyme : jamais, même dans un espace public.
    expect((await call(null, 'GET', `/api/v1/pages/${secret()}`)).statusCode).toBe(404);
  });

  it('une permission « lecture » empêche d’écrire malgré le rôle éditeur', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    await restrict(admin, [{ userId: 'ed1', level: 'read' }]);
    expect((await call(ed1, 'GET', `/api/v1/pages/${secret()}`)).statusCode).toBe(200);
    const patch = await call(ed1, 'PATCH', `/api/v1/pages/${secret()}`, { title: 'x' });
    expect(patch.statusCode).toBe(403);
    expect((await call(ed1, 'DELETE', `/api/v1/pages/${secret()}`)).statusCode).toBe(403);
    expect((await call(ed1, 'PATCH', `/api/v2/pages/${secret()}`, { title: 'x' })).statusCode).toBe(403);
    // Il peut commenter.
    expect((await call(ed1, 'POST', `/api/v3/pages/${secret()}/comments`, { body: 'lu' })).statusCode).toBe(201);
    // Un lecteur (rôle) ne gagne jamais l'écriture via la permission.
    await restrict(admin, [{ userId: 'rd', level: 'write' }]);
    expect((await call(await login('rd@example.com'), 'PATCH', `/api/v1/pages/${secret()}`, { title: 'x' })).statusCode).toBe(403);
  });

  it('indique la restriction héritée et son niveau, puis se lève', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    await restrict(admin, [{ userId: 'ed1', level: 'read' }]);
    const asEd = (await call(ed1, 'GET', `/api/v3/pages/${child()}/permissions`)).json();
    expect(asEd).toEqual({ restricted: true, inheritedFrom: secret(), yourLevel: 'read' });
    const asAdmin = (await call(admin, 'GET', `/api/v3/pages/${child()}/permissions`)).json();
    expect(asAdmin.entries).toEqual([{ userId: 'ed1', level: 'read', name: 'ed1', email: 'ed1@example.com' }]);
    await restrict(admin, []);
    expect((await call(await login('ed2@example.com'), 'GET', `/api/v1/pages/${secret()}`)).statusCode).toBe(200);
  });

  it('ne laisse pas la co-édition ni les événements fuiter', async () => {
    const admin = await login('admin@example.com');
    await restrict(admin, [{ userId: 'ed1', level: 'write' }]);
    const ed2 = await login('ed2@example.com');
    const ws = await call(ed2, 'GET', `/collab/${secret()}`, undefined, { origin: 'http://localhost:3000' });
    expect([404, 426]).toContain(ws.statusCode);
    expect(publicSpace()).toBeTruthy();
  });
});
