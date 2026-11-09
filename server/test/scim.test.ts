// SCIM 2.0 (lot 17) : désactivé par défaut, jeton dédié, élévation de privilèges impossible, cycle de vie des comptes et des
// groupes, PATCH (formats Authentik et Entra), filtres, pagination, audit, révocation, limitation de débit, migration v29.
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { upsertUser } from '../src/auth/oidc.js';
import { sha256 } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
let app: FastifyInstance;
let db: DB;

async function start(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({ ...env, ...extra }), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
}
beforeEach(async () => { await start(); });
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

// Active SCIM et crée un jeton par l'API d'administration (chemin réel).
async function setup(defaultRole: 'reader' | 'editor' = 'reader') {
  const admin = await login('admin');
  expect((await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: true, defaultRole, reauth: { password: PASS } })).statusCode).toBe(200);
  const res = await call(admin, 'POST', '/api/v3/admin/scim/tokens', { name: 'Authentik', reauth: { password: PASS } });
  expect(res.statusCode).toBe(201);
  return { admin, token: res.json().token as string, tokenId: res.json().id as string };
}

const scim = (token: string | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({
    method, url: `/scim/v2${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/scim+json' } : {}), ...headers },
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });

const newUser = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: [USER], userName, externalId: `ext-${userName}`, name: { givenName: 'Prénom', familyName: userName }, emails: [{ value: `${userName}@corp.example`, type: 'work', primary: true }], active: true, ...extra,
});
const userRow = (id: string) => db.prepare('SELECT id, sub, email, name, role, disabled, password_hash FROM users WHERE id = ?').get(id) as { sub: string; email: string; name: string; role: string; disabled: number; password_hash: string | null } | undefined;
const auditRows = (prefix: string) => db.prepare("SELECT action, user_id, target, meta FROM audit_log WHERE action LIKE ? || '%' ORDER BY id").all(prefix) as { action: string; user_id: string | null; target: string | null; meta: string | null }[];

describe('activation et administration', () => {
  it('désactivé par défaut : 404 identique à une adresse inconnue, même avec un jeton valide', async () => {
    const admin = await login('admin');
    const token = (await call(admin, 'POST', '/api/v3/admin/scim/tokens', { name: 'IdP', reauth: { password: PASS } })).json().token as string;
    for (const url of ['/Users', '/Groups', '/ServiceProviderConfig', '/Schemas', '/inconnu']) {
      const res = await scim(token, 'GET', url);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'Ressource introuvable' });
    }
    expect((await scim(token, 'POST', '/Users', newUser('alice'))).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scim_users').get()).toEqual({ n: 0 });
    expect((await call(admin, 'GET', '/api/v3/admin/scim')).json()).toMatchObject({ enabled: false, defaultRole: 'reader', endpoint: 'http://localhost:3000/scim/v2' });
  });

  it('réservée à un administrateur en session ; jeton affiché une fois, stocké haché ; réauthentification exigée', async () => {
    const ed = await login('ed1');
    expect((await call(ed, 'GET', '/api/v3/admin/scim')).statusCode).toBe(403);
    expect((await call(ed, 'POST', '/api/v3/admin/scim/tokens', { name: 'x', reauth: { password: PASS } })).statusCode).toBe(403);
    const admin = await login('admin');
    // Un jeton d'API, même de portée admin, ne gère pas SCIM.
    const apiToken = (await call(admin, 'POST', '/api/v3/tokens', { name: 'api', scopes: ['read', 'admin'] })).json().token as string;
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/scim', headers: { authorization: `Bearer ${apiToken}` } })).statusCode).toBe(403);
    expect((await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: true, defaultRole: 'reader', reauth: { password: 'mauvais' } })).statusCode).toBe(401);
    expect((await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: true, defaultRole: 'admin', reauth: { password: PASS } })).statusCode).toBe(400);
    const created = await call(admin, 'POST', '/api/v3/admin/scim/tokens', { name: 'Authentik', reauth: { password: PASS } });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json() as { token: string; id: string };
    expect(token).toMatch(/^nbscim_[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT token_hash, prefix FROM scim_tokens WHERE id = ?').get(id) as { token_hash: string; prefix: string };
    expect(row.token_hash).toBe(sha256(token));
    expect(JSON.stringify(db.prepare('SELECT * FROM scim_tokens').all())).not.toContain(token);
    const view = (await call(admin, 'GET', '/api/v3/admin/scim')).json();
    expect(JSON.stringify(view)).not.toContain(token);
    expect(view.tokens[0]).toMatchObject({ id, name: 'Authentik', prefix: row.prefix, revokedAt: null });
    expect(auditRows('scim.').map((a) => a.action)).toEqual(['scim.token.create']);
  });

  it('CONFIG_LOCKED : réglage pris dans l’environnement, non modifiable', async () => {
    await app.close(); db.close();
    await start({ CONFIG_LOCKED: 'true', SCIM_ENABLED: 'true', SCIM_DEFAULT_ROLE: 'editor' });
    const admin = await login('admin');
    expect((await call(admin, 'GET', '/api/v3/admin/scim')).json()).toMatchObject({ enabled: true, defaultRole: 'editor', locked: true });
    expect((await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: false, defaultRole: 'reader', reauth: { password: PASS } })).statusCode).toBe(409);
  });

  it('désactiver SCIM rend de nouveau 404', async () => {
    const { admin, token } = await setup();
    expect((await scim(token, 'GET', '/Users')).statusCode).toBe(200);
    await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: false, defaultRole: 'reader', reauth: { password: PASS } });
    expect((await scim(token, 'GET', '/Users')).statusCode).toBe(404);
  });
});

describe('authentification', () => {
  it('jeton SCIM obligatoire ; ni session ni jeton d’API ; erreurs au format SCIM', async () => {
    const { admin } = await setup();
    const noAuth = await scim(null, 'GET', '/Users');
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.headers['content-type']).toContain('application/scim+json');
    expect(noAuth.headers['www-authenticate']).toContain('Bearer');
    expect(noAuth.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
    expect((await scim(`nbscim_${'a'.repeat(43)}`, 'GET', '/Users')).statusCode).toBe(401);
    expect((await scim(null, 'GET', '/Users', undefined, { authorization: 'Basic YTpi' })).statusCode).toBe(401);
    const apiToken = (await call(admin, 'POST', '/api/v3/tokens', { name: 'api', scopes: ['read', 'write', 'admin'] })).json().token as string;
    expect((await scim(apiToken, 'GET', '/Users')).statusCode).toBe(401);
    // Session administrateur (cookie et CSRF) : refusée aussi.
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users', cookies: admin.cookies, headers: admin.headers })).statusCode).toBe(401);
    // Sans jeton, aucune donnée : même la découverte est protégée.
    expect((await scim(null, 'GET', '/ServiceProviderConfig')).statusCode).toBe(401);
  });

  it('le jeton SCIM n’ouvre rien d’autre que /scim', async () => {
    const { token } = await setup();
    for (const url of ['/api/v3/me', '/api/v3/spaces', '/api/v3/admin/users', '/api/v3/admin/scim', '/mcp']) {
      const res = await app.inject({ method: url === '/mcp' ? 'POST' : 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('révocation et expiration', async () => {
    const { admin, token, tokenId } = await setup();
    expect((await scim(token, 'GET', '/Users')).statusCode).toBe(200);
    expect((await call(admin, 'DELETE', `/api/v3/admin/scim/tokens/${tokenId}`)).statusCode).toBe(204);
    expect((await scim(token, 'GET', '/Users')).statusCode).toBe(401);
    expect((await call(admin, 'DELETE', `/api/v3/admin/scim/tokens/${tokenId}`)).statusCode).toBe(404);
    const other = (await call(admin, 'POST', '/api/v3/admin/scim/tokens', { name: 'b', reauth: { password: PASS } })).json();
    db.prepare('UPDATE scim_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, other.id);
    expect((await scim(other.token, 'GET', '/Users')).statusCode).toBe(401);
    expect(auditRows('scim.token.revoke')).toHaveLength(1);
  });

  it('échec d’authentification journalisé, au plus une fois par minute et par adresse', async () => {
    await setup();
    for (let i = 0; i < 5; i++) await scim('mauvais', 'GET', '/Users');
    const rows = auditRows('scim.auth.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).not.toContain('mauvais');
  });

  it('limitation de débit', async () => {
    await app.close(); db.close();
    await start({ SCIM_RATE_LIMIT_PER_MINUTE: '3' });
    const { token } = await setup();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await scim(token, 'GET', '/Users')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const res = await scim(token, 'GET', '/Users');
    expect(res.json()).toMatchObject({ status: '429' });
  });
});

describe('découverte', () => {
  it('ServiceProviderConfig, ResourceTypes, Schemas', async () => {
    const { token } = await setup();
    const spc = await scim(token, 'GET', '/ServiceProviderConfig');
    expect(spc.headers['content-type']).toContain('application/scim+json');
    expect(spc.json()).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, changePassword: { supported: false } });
    expect((await scim(token, 'GET', '/ResourceTypes')).json().Resources.map((r: { id: string }) => r.id)).toEqual(['User', 'Group']);
    expect((await scim(token, 'GET', '/ResourceTypes/User')).json().endpoint).toBe('/Users');
    expect((await scim(token, 'GET', '/Schemas')).json().totalResults).toBe(2);
    expect((await scim(token, 'GET', `/Schemas/${USER}`)).json().name).toBe('User');
    expect((await scim(token, 'GET', '/Schemas/inconnu')).statusCode).toBe(404);
    expect((await scim(token, 'GET', '/Inconnu')).json()).toMatchObject({ status: '404' });
  });
});

describe('Users', () => {
  it('cycle de vie : création, lecture, liste, PUT, désactivation, réactivation, suppression sans perte de contenu', async () => {
    const { token } = await setup();
    const created = await scim(token, 'POST', '/Users', newUser('alice'));
    expect(created.statusCode).toBe(201);
    const u = created.json();
    expect(created.headers.location).toBe(`http://localhost:3000/scim/v2/Users/${u.id}`);
    expect(u).toMatchObject({ schemas: [USER], userName: 'alice', externalId: 'ext-alice', displayName: 'Prénom alice', active: true, emails: [{ value: 'alice@corp.example', primary: true }], groups: [] });
    expect(u.meta).toMatchObject({ resourceType: 'User', location: created.headers.location });
    // Rôle fixé, identifiant OIDC = externalId, aucun mot de passe.
    expect(userRow(u.id)).toMatchObject({ sub: 'ext-alice', role: 'reader', disabled: 0, password_hash: null });

    expect((await scim(token, 'GET', `/Users/${u.id}`)).json().userName).toBe('alice');
    const put = await scim(token, 'PUT', `/Users/${u.id}`, newUser('alice', { displayName: 'Alice Martin', emails: [{ value: 'alice.martin@corp.example', primary: true }] }));
    expect(put.statusCode).toBe(200);
    expect(userRow(u.id)).toMatchObject({ name: 'Alice Martin', email: 'alice.martin@corp.example', sub: 'ext-alice' });

    // Désactivation : sessions fermées et jetons d'API révoqués.
    db.prepare("INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, last_seen_at) VALUES ('h1', ?, 'c', 0, ?, 0)").run(u.id, Date.now() + 3_600_000);
    db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at) VALUES ('t1', ?, 'x', 'hh', 'nb_', '[]', 0, ?)").run(u.id, Date.now() + 3_600_000);
    const off = await scim(token, 'PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
    expect(userRow(u.id)!.disabled).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id)).toEqual({ n: 0 });
    expect((db.prepare("SELECT revoked_at FROM api_tokens WHERE id = 't1'").get() as { revoked_at: number | null }).revoked_at).not.toBeNull();
    // Format Entra : op en majuscule, booléen en chaîne, sans chemin.
    const on = await scim(token, 'PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'Replace', value: { active: 'True' } }] });
    expect(on.json().active).toBe(true);

    // Contenu de la personne : conservé après suppression SCIM.
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s1', 'S', 0, 0)").run();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, created_by, updated_at) VALUES ('p1', 's1', 'Page', '{}', '', 0, ?, 0)").run(u.id);
    expect((await scim(token, 'DELETE', `/Users/${u.id}`)).statusCode).toBe(204);
    expect((await scim(token, 'GET', `/Users/${u.id}`)).statusCode).toBe(404);
    expect(userRow(u.id)!.disabled).toBe(1);
    expect(db.prepare("SELECT created_by FROM pages WHERE id = 'p1'").get()).toEqual({ created_by: u.id });
    // Nouveau provisionnement : le compte existant est rattaché de nouveau et réactivé.
    const again = await scim(token, 'POST', '/Users', newUser('alice'));
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(u.id);
    expect(userRow(u.id)!.disabled).toBe(0);
    expect(auditRows('scim.user.').map((a) => a.action)).toEqual(['scim.user.create', 'scim.user.update', 'scim.user.deactivate', 'scim.user.update', 'scim.user.delete', 'scim.user.create']);
  });

  it('liste : filtre eq (insensible à la casse pour userName), pagination startIndex et count', async () => {
    const { token } = await setup();
    for (const n of ['u1', 'u2', 'u3', 'u4', 'u5']) expect((await scim(token, 'POST', '/Users', newUser(n))).statusCode).toBe(201);
    const all = (await scim(token, 'GET', '/Users')).json();
    expect(all).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 5, startIndex: 1, itemsPerPage: 5 });
    const page = (await scim(token, 'GET', '/Users?startIndex=2&count=2')).json();
    expect(page).toMatchObject({ totalResults: 5, startIndex: 2, itemsPerPage: 2 });
    expect(page.Resources.map((r: { userName: string }) => r.userName)).toEqual(['u2', 'u3']);
    expect((await scim(token, 'GET', '/Users?count=0')).json()).toMatchObject({ totalResults: 5, itemsPerPage: 0, Resources: [] });
    expect((await scim(token, 'GET', '/Users?startIndex=-4&count=9999')).json()).toMatchObject({ startIndex: 1, itemsPerPage: 5 });
    const f = (q: string) => scim(token, 'GET', `/Users?filter=${encodeURIComponent(q)}`);
    expect((await f('userName eq "U3"')).json().Resources.map((r: { userName: string }) => r.userName)).toEqual(['u3']);
    expect((await f('externalId eq "ext-u4"')).json().totalResults).toBe(1);
    expect((await f('emails.value eq "U5@CORP.EXAMPLE"')).json().totalResults).toBe(1);
    expect((await f('active eq true')).json().totalResults).toBe(5);
    expect((await f(`${USER}:userName eq "u1"`)).json().totalResults).toBe(1);
    // Injection : la valeur reste une valeur.
    expect((await f('userName eq "u1\' OR 1=1 --"')).json().totalResults).toBe(0);
    for (const bad of ['userName co "u"', 'userName eq "a" or userName eq "b"', 'password eq "x"', 'active eq "true"', 'userName eq u1']) {
      const res = await f(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().scimType).toBe('invalidFilter');
    }
  });

  it('élévation de privilèges impossible : rôle fixé, roles ignoré, jamais admin, comptes admin invisibles', async () => {
    const { admin, token } = await setup();
    const res = await scim(token, 'POST', '/Users', newUser('bob', { roles: [{ value: 'admin', primary: true }], 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'IT' } }));
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(userRow(id)!.role).toBe('reader');
    const patched = await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'roles', value: [{ value: 'admin' }] }, { op: 'replace', value: { roles: 'admin', title: 'Chef' } }] });
    expect(patched.statusCode).toBe(200);
    expect(userRow(id)!.role).toBe('reader');
    // Rôle par défaut « editor » : appliqué aux nouveaux comptes seulement.
    await call(admin, 'PUT', '/api/v3/admin/scim/settings', { enabled: true, defaultRole: 'editor', reauth: { password: PASS } });
    const ed = (await scim(token, 'POST', '/Users', newUser('carol'))).json().id as string;
    expect(userRow(ed)!.role).toBe('editor');
    expect(userRow(id)!.role).toBe('reader');
    // Les administrateurs ne sont ni listés ni accessibles.
    const list = (await scim(token, 'GET', '/Users')).json();
    expect(list.Resources.map((r: { id: string }) => r.id)).not.toContain('admin');
    expect((await scim(token, 'GET', '/Users/admin')).statusCode).toBe(404);
    expect((await scim(token, 'PUT', '/Users/admin', newUser('admin'))).statusCode).toBe(404);
    expect((await scim(token, 'PATCH', '/Users/admin', { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] })).statusCode).toBe(404);
    expect((await scim(token, 'DELETE', '/Users/admin')).statusCode).toBe(404);
    // Un compte non provisionné (local) est invisible aussi.
    expect((await scim(token, 'GET', '/Users/ed1')).statusCode).toBe(404);
    // Un compte SCIM promu administrateur (connexion OIDC) devient intouchable.
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
    expect((await scim(token, 'GET', `/Users/${id}`)).statusCode).toBe(404);
    expect((await scim(token, 'DELETE', `/Users/${id}`)).statusCode).toBe(404);
    expect(userRow(id)).toMatchObject({ role: 'admin', disabled: 0 });
    expect((await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'G', members: [{ value: id }] })).statusCode).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get()).toEqual({ n: 2 });
  });

  it('rattachement d’un compte existant par son identifiant OIDC, jamais d’un administrateur ni d’un compte local', async () => {
    const { token } = await setup();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('oidc1', 'abc123', 'x@corp.example', 'X', 'editor', 0)").run();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('oidcadm', 'adm456', 'a@corp.example', 'A', 'admin', 0)").run();
    const linked = await scim(token, 'POST', '/Users', newUser('xavier', { externalId: 'abc123' }));
    expect(linked.statusCode).toBe(201);
    expect(linked.json().id).toBe('oidc1');
    expect(userRow('oidc1')).toMatchObject({ role: 'editor', name: 'Prénom xavier' }); // rôle existant conservé
    const adm = await scim(token, 'POST', '/Users', newUser('adm', { externalId: 'adm456' }));
    expect(adm.statusCode).toBe(409);
    expect(adm.json().scimType).toBe('uniqueness');
    expect(userRow('oidcadm')).toMatchObject({ name: 'A', role: 'admin' });
    for (const ext of ['local:admin@example.com', 'LDAP:alice', 'saml:x', 'scim:abc', 'dev-admin']) {
      const res = await scim(token, 'POST', '/Users', newUser(`p${ext.length}`, { externalId: ext }));
      expect(res.statusCode, ext).toBe(400);
    }
    expect(userRow('admin')).toMatchObject({ name: 'Nom admin', disabled: 0 });
  });

  it('validation : mot de passe refusé, unicité, champs bornés, corps invalides', async () => {
    const { token } = await setup();
    const pw = await scim(token, 'POST', '/Users', newUser('dan', { password: 'Secret123!' }));
    expect(pw.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scim_users').get()).toEqual({ n: 0 });
    const id = (await scim(token, 'POST', '/Users', newUser('dan'))).json().id as string;
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'password', value: 'x' }] })).statusCode).toBe(400);
    expect(userRow(id)!.password_hash).toBeNull();
    const dup = await scim(token, 'POST', '/Users', newUser('DAN', { externalId: 'autre' }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    expect((await scim(token, 'POST', '/Users', newUser('eve', { externalId: 'ext-dan' }))).statusCode).toBe(409);
    expect((await scim(token, 'POST', '/Users', newUser('x'.repeat(300)))).statusCode).toBe(400);
    expect((await scim(token, 'POST', '/Users', newUser('fay', { emails: [{ value: 'pas-une-adresse' }] }))).statusCode).toBe(400);
    expect((await scim(token, 'POST', '/Users', newUser('a\u0000b'))).statusCode).toBe(400);
    expect((await scim(token, 'POST', '/Users', [1, 2])).statusCode).toBe(400);
    const syntax = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, payload: '{"userName":' });
    expect(syntax.statusCode).toBe(400);
    expect(syntax.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    const proto = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: '{"userName":"g","__proto__":{"x":1}}' });
    expect(proto.statusCode).toBe(400);
    const huge = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, payload: JSON.stringify(newUser('big', { displayName: 'x'.repeat(1_100_000) })) });
    expect(huge.statusCode).toBe(413);
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'nickName2', value: 'x' }] })).json().scimType).toBe('invalidPath');
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'move', path: 'active', value: true }] })).statusCode).toBe(400);
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'remove', path: 'userName' }] })).statusCode).toBe(400);
    expect((await scim(token, 'GET', '/Users/../../api')).statusCode).toBe(404);
  });

  it('PATCH : chemins simples, nom, adresses filtrées, retrait', async () => {
    const { token } = await setup();
    const id = (await scim(token, 'POST', '/Users', newUser('gil'))).json().id as string;
    const ops = (Operations: object[]) => scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations });
    expect((await ops([{ op: 'replace', path: 'userName', value: 'gilles' }, { op: 'replace', path: 'displayName', value: 'Gilles D.' }])).json()).toMatchObject({ userName: 'gilles', displayName: 'Gilles D.' });
    expect((await ops([{ op: 'replace', path: 'emails[type eq "work"].value', value: 'g@corp.example' }])).json().emails).toEqual([{ value: 'g@corp.example', type: 'work', primary: true }]);
    expect(userRow(id)!.sub).toBe('ext-gil'); // l'identifiant OIDC ne change jamais par SCIM
    expect((await ops([{ op: 'remove', path: 'emails' }])).json().emails).toEqual([]);
    expect(userRow(id)!.email).toBeNull();
    expect((await ops([{ op: 'replace', path: 'groups', value: [] }])).json().scimType).toBe('mutability');
  });
});

describe('corrections de la revue de sécurité', () => {
  it('SCIM ne réactive que les comptes qu’il a désactivés : un compte rattaché déjà désactivé le reste', async () => {
    const { token } = await setup();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at, disabled) VALUES ('off1', 'sub-off', 'o@corp.example', 'O', 'editor', 0, 1)").run();
    const linked = await scim(token, 'POST', '/Users', newUser('olga', { externalId: 'sub-off', active: true }));
    expect(linked.statusCode).toBe(201);
    expect(linked.json().active).toBe(false);
    expect(userRow('off1')!.disabled).toBe(1);
    const put = await scim(token, 'PUT', '/Users/off1', newUser('olga', { externalId: 'sub-off', active: true }));
    expect(put.json().active).toBe(false);
    const patch = await scim(token, 'PATCH', '/Users/off1', { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] });
    expect(patch.json().active).toBe(false);
    expect(userRow('off1')!.disabled).toBe(1);
    // Désactivé par SCIM : SCIM peut le réactiver, y compris après une suppression puis un nouveau provisionnement.
    const id = (await scim(token, 'POST', '/Users', newUser('paul'))).json().id as string;
    await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] })).json().active).toBe(true);
    await scim(token, 'DELETE', `/Users/${id}`);
    expect((await scim(token, 'POST', '/Users', newUser('paul'))).json()).toMatchObject({ id, active: true });
  });

  it('compte désactivé hors SCIM, DELETE SCIM puis re-POST actif : reste désactivé', async () => {
    const { token } = await setup();
    const id = (await scim(token, 'POST', '/Users', newUser('rita'))).json().id as string;
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
    expect((await scim(token, 'DELETE', `/Users/${id}`)).statusCode).toBe(204);
    const again = await scim(token, 'POST', '/Users', newUser('rita', { active: true }));
    expect(again.json().active).toBe(false);
    expect(userRow(id)!.disabled).toBe(1);
  });

  it('externalId immuable une fois défini (PUT et PATCH) ; absent d’un PUT, conservé', async () => {
    const { token } = await setup();
    const id = (await scim(token, 'POST', '/Users', newUser('quentin'))).json().id as string;
    const put = await scim(token, 'PUT', `/Users/${id}`, newUser('quentin', { externalId: 'autre' }));
    expect(put.statusCode).toBe(400);
    expect(put.json().scimType).toBe('mutability');
    for (const op of [{ op: 'remove', path: 'externalId' }, { op: 'replace', path: 'externalId', value: 'autre' }, { op: 'replace', value: { externalId: 'autre' } }]) {
      const res = await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [op] });
      expect(res.statusCode).toBe(400);
      expect(res.json().scimType).toBe('mutability');
    }
    const { externalId: _drop, ...noExt } = newUser('quentin', { displayName: 'Q' });
    expect((await scim(token, 'PUT', `/Users/${id}`, noExt)).json()).toMatchObject({ externalId: 'ext-quentin', displayName: 'Q' });
    expect((await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'externalId', value: 'ext-quentin' }] })).statusCode).toBe(200);
    // Sans externalId à la création : il peut être posé une fois, sans changer l'identifiant OIDC.
    const bare = (await scim(token, 'POST', '/Users', { schemas: [USER], userName: 'rita' })).json().id as string;
    expect((await scim(token, 'PATCH', `/Users/${bare}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'externalId', value: 'ext-rita' }] })).json().externalId).toBe('ext-rita');
    expect(userRow(bare)!.sub).toBe(`scim:${bare}`);
    expect((await scim(token, 'PATCH', `/Users/${bare}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'externalId', value: 'x' }] })).statusCode).toBe(400);
  });

  it('409 génériques : rien ne distingue un administrateur, un compte SCIM ou un groupe local', async () => {
    const { admin, token } = await setup();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('adm2', 'sub-adm', 'a@corp.example', 'A', 'admin', 0)").run();
    await scim(token, 'POST', '/Users', newUser('sam'));
    const vsAdmin = (await scim(token, 'POST', '/Users', newUser('s2', { externalId: 'sub-adm' }))).json();
    const vsName = (await scim(token, 'POST', '/Users', newUser('SAM', { externalId: 'x1' }))).json();
    const vsExt = (await scim(token, 'POST', '/Users', newUser('s3', { externalId: 'ext-sam' }))).json();
    expect(vsAdmin).toEqual(vsName);
    expect(vsExt).toEqual(vsName);
    expect(vsName).toMatchObject({ status: '409', scimType: 'uniqueness' });
    await call(admin, 'POST', '/api/v3/groups', { name: 'Local caché' });
    await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Visible' });
    const vsLocal = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'local caché' })).json();
    const vsScim = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'visible' })).json();
    expect(vsLocal).toEqual(vsScim);
    expect(vsLocal.detail).toBe(vsName.detail);
  });

  it('suppression de groupe : restriction de page relue dans la transaction (groupe non seul : vraie suppression)', async () => {
    const { token } = await setup();
    const g = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Partagé' })).json();
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s1', 'S', 0, 0)").run();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('p1', 's1', 'Page', '{}', '', 0, 0)").run();
    db.prepare("INSERT INTO page_acl_groups (page_id, group_id, level) VALUES ('p1', ?, 'read')").run(g.id);
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('p1', 'ed1', 'read')").run();
    expect((await scim(token, 'DELETE', `/Groups/${g.id}`)).statusCode).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE id = ?').get(g.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM page_acl WHERE page_id = 'p1'").get()).toEqual({ n: 1 });
    expect(auditRows('scim.group.delete')[0]!.meta).toContain('"detached":false');
  });

  it('compte promu administrateur : retiré des groupes SCIM (à la connexion, et à la prochaine écriture SCIM)', async () => {
    const { token } = await setup();
    const [a, b] = [(await scim(token, 'POST', '/Users', newUser('tom'))).json().id as string, (await scim(token, 'POST', '/Users', newUser('ugo'))).json().id as string];
    const g = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Eq', members: [{ value: a }, { value: b }] })).json();
    const local = db.prepare("INSERT INTO groups (id, name, created_at) VALUES ('loc', 'Loc', 0)").run();
    expect(local.changes).toBe(1);
    db.prepare("INSERT INTO group_members (group_id, user_id) VALUES ('loc', ?)").run(a);
    // Connexion OIDC avec le rôle administrateur.
    upsertUser(db, { sub: 'ext-tom', email: 't@corp.example', name: 'Tom', role: 'admin' });
    expect(db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(a)).toEqual([{ group_id: 'loc' }]);
    // Promotion par un autre chemin : la prochaine écriture SCIM sur le groupe retire le membre devenu invisible.
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(b);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).json().members).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(g.id)).toEqual({ n: 1 });
    await scim(token, 'PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'Équipe' }] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(g.id)).toEqual({ n: 0 });
    // Le filtre par membre ne révèle pas non plus un administrateur.
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, b);
    expect((await scim(token, 'GET', `/Groups?filter=${encodeURIComponent(`members.value eq "${b}"`)}`)).json().totalResults).toBe(0);
  });
});

describe('Groups', () => {
  async function users(token: string, ...names: string[]) {
    const ids: string[] = [];
    for (const n of names) ids.push((await scim(token, 'POST', '/Users', newUser(n))).json().id as string);
    return ids;
  }

  it('cycle de vie et PATCH des membres (formats Authentik et Entra)', async () => {
    const { token } = await setup();
    const [a, b, c] = await users(token, 'a', 'b', 'c');
    const created = await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Équipe Infra', externalId: 'g-ext', members: [{ value: a }] });
    expect(created.statusCode).toBe(201);
    const g = created.json();
    expect(g).toMatchObject({ displayName: 'Équipe Infra', externalId: 'g-ext', members: [{ value: a, display: 'Prénom a' }] });
    expect(created.headers.location).toBe(`http://localhost:3000/scim/v2/Groups/${g.id}`);
    expect(db.prepare('SELECT source, external_id FROM groups WHERE id = ?').get(g.id)).toEqual({ source: 'local', external_id: null });

    const ops = (Operations: object[], q = '') => scim(token, 'PATCH', `/Groups/${g.id}${q}`, { schemas: [PATCH], Operations });
    const members = async () => ((await scim(token, 'GET', `/Groups/${g.id}`)).json().members as { value: string }[]).map((m) => m.value).sort();
    expect((await ops([{ op: 'add', path: 'members', value: [{ value: b }, { value: c }] }])).statusCode).toBe(200);
    expect(await members()).toEqual([a, b, c].sort());
    expect((await ops([{ op: 'remove', path: `members[value eq "${b}"]` }])).statusCode).toBe(200);
    expect(await members()).toEqual([a, c].sort());
    // Entra : retrait avec liste de valeurs ; ajout sans chemin.
    await ops([{ op: 'Remove', path: 'members', value: [{ value: a }] }]);
    expect(await members()).toEqual([c]);
    await ops([{ op: 'Add', value: { members: [{ value: b }] } }]);
    expect(await members()).toEqual([b, c].sort());
    await ops([{ op: 'replace', path: 'members', value: [{ value: a }] }, { op: 'replace', path: 'displayName', value: 'Infra' }]);
    expect(await members()).toEqual([a]);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).json().displayName).toBe('Infra');
    // L'appartenance apparaît sur la ressource User.
    expect((await scim(token, 'GET', `/Users/${a}`)).json().groups).toEqual([{ value: g.id, display: 'Infra', $ref: `http://localhost:3000/scim/v2/Groups/${g.id}` }]);
    // excludedAttributes=members
    expect((await scim(token, 'GET', `/Groups/${g.id}?excludedAttributes=members`)).json().members).toBeUndefined();
    expect((await scim(token, 'GET', '/Groups?excludedAttributes=members')).json().Resources[0].members).toBeUndefined();
    // PUT remplace (sans membres : vidé).
    expect((await scim(token, 'PUT', `/Groups/${g.id}`, { schemas: [GROUP], displayName: 'Infra', externalId: 'g-ext' })).json().members).toEqual([]);
    // Filtres.
    const f = (q: string) => scim(token, 'GET', `/Groups?filter=${encodeURIComponent(q)}`);
    expect((await f('displayName eq "INFRA"')).json().totalResults).toBe(1);
    expect((await f('externalId eq "g-ext"')).json().totalResults).toBe(1);
    expect((await f('displayName eq "Autre"')).json().totalResults).toBe(0);
    // Suppression : le groupe disparaît, les comptes restent.
    expect((await scim(token, 'DELETE', `/Groups/${g.id}`)).statusCode).toBe(204);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE id = ?').get(g.id)).toEqual({ n: 0 });
    expect(userRow(a)!.disabled).toBe(0);
    expect(auditRows('scim.group.').map((r) => r.action)).toEqual(['scim.group.create', ...Array(6).fill('scim.group.update'), 'scim.group.delete']);
  });

  it('séparation avec les groupes locaux : invisibles par SCIM, noms uniques, groupe SCIM non modifiable localement', async () => {
    const { admin, token } = await setup();
    const [a] = await users(token, 'a');
    const local = (await call(admin, 'POST', '/api/v3/groups', { name: 'Direction' })).json();
    expect((await scim(token, 'GET', '/Groups')).json().totalResults).toBe(0);
    expect((await scim(token, 'GET', `/Groups/${local.id}`)).statusCode).toBe(404);
    expect((await scim(token, 'GET', '/Groups/everyone')).statusCode).toBe(404);
    expect((await scim(token, 'PATCH', `/Groups/${local.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: a }] }] })).statusCode).toBe(404);
    expect((await scim(token, 'DELETE', `/Groups/${local.id}`)).statusCode).toBe(404);
    const clash = await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'direction' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().scimType).toBe('uniqueness');
    const g = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Support', members: [{ value: a }] })).json();
    expect((await call(admin, 'PATCH', `/api/v3/groups/${g.id}`, { name: 'Autre' })).statusCode).toBe(409);
    expect((await call(admin, 'PUT', `/api/v3/groups/${g.id}/members/ed1`)).statusCode).toBe(409);
    expect((await call(admin, 'DELETE', `/api/v3/groups/${g.id}/members/${a}`)).statusCode).toBe(409);
    const listed = (await call(admin, 'GET', '/api/v3/groups')).json() as { id: string; scim?: boolean }[];
    expect(listed.find((x) => x.id === g.id)!.scim).toBe(true);
    expect(listed.find((x) => x.id === local.id)!.scim).toBe(false);
    expect((await call(admin, 'GET', `/api/v3/groups/${g.id}/members`)).json()).toMatchObject({ synced: true, scim: true });
    // Membres : seulement des comptes provisionnés, non administrateurs.
    for (const bad of ['ed1', 'admin', 'inconnu']) {
      expect((await scim(token, 'PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: bad }] }] })).statusCode, bad).toBe(400);
    }
    // Un administrateur peut supprimer le groupe SCIM.
    expect((await call(admin, 'DELETE', `/api/v3/groups/${g.id}`)).statusCode).toBe(204);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).statusCode).toBe(404);
  });

  it('suppression d’un groupe seul à ouvrir une page : détaché et vidé, la page reste fermée', async () => {
    const { token } = await setup();
    const [a] = await users(token, 'a');
    const g = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Secret', members: [{ value: a }] })).json();
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s1', 'S', 0, 0)").run();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('p1', 's1', 'Page', '{}', '', 0, 0)").run();
    db.prepare("INSERT INTO page_acl_groups (page_id, group_id, level) VALUES ('p1', ?, 'read')").run(g.id);
    expect((await scim(token, 'DELETE', `/Groups/${g.id}`)).statusCode).toBe(204);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_acl_groups WHERE group_id = ?').get(g.id)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(g.id)).toEqual({ n: 0 });
    expect(auditRows('scim.group.delete')[0]!.meta).toContain('"detached":true');
  });

  it('suppression d’un compte : retiré des groupes SCIM seulement', async () => {
    const { admin, token } = await setup();
    const [a] = await users(token, 'a');
    const g = (await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'G1', members: [{ value: a }] })).json();
    const local = (await call(admin, 'POST', '/api/v3/groups', { name: 'Local' })).json();
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(local.id, a);
    await scim(token, 'DELETE', `/Users/${a}`);
    expect(db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(a)).toEqual([{ group_id: local.id }]);
    expect((await scim(token, 'GET', `/Groups/${g.id}`)).json().members).toEqual([]);
  });
});

describe('audit', () => {
  it('acteur SCIM (aucun compte), jeton identifié, ni secret ni valeur reçue', async () => {
    const { token, tokenId } = await setup();
    const id = (await scim(token, 'POST', '/Users', newUser('henri'))).json().id as string;
    await scim(token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'H', members: [{ value: id }] });
    const rows = auditRows('scim.user.').concat(auditRows('scim.group.'));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.user_id).toBeNull();
      expect(JSON.parse(r.meta!)).toMatchObject({ via: 'scim', client: tokenId });
      expect(r.meta).not.toContain('henri');
      expect(r.meta).not.toContain('corp.example');
      expect(r.meta).not.toContain(token);
    }
    expect(rows[0]!.target).toBe(id);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(token);
  });
});

describe('données personnelles', () => {
  it('export : rattachement SCIM inclus ; effacement : rattachement supprimé', async () => {
    const { admin, token } = await setup();
    const id = (await scim(token, 'POST', '/Users', newUser('ines'))).json().id as string;
    const data = (await call(admin, 'GET', `/api/v3/admin/users/${id}/export`)).json();
    expect(data.profile.scim).toMatchObject({ userName: 'ines', externalId: 'ext-ines' });
    expect((await call(admin, 'POST', `/api/v3/admin/users/${id}/erase`, { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scim_users').get()).toEqual({ n: 0 });
  });
});

describe('migration v29', () => {
  it('ajoute les tables, avec cascades', () => {
    const file = oldDb(28);
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    up.prepare("INSERT INTO scim_users (user_id, user_name, external_id, created_at, updated_at) VALUES ('u1', 'U', 'e1', 0, 0)").run();
    expect(() => up.prepare("INSERT INTO scim_users (user_id, user_name, created_at, updated_at) VALUES ('u1', 'u', 0, 0)").run()).toThrow();
    up.prepare("INSERT INTO groups (id, name, created_at) VALUES ('g1', 'G', 0)").run();
    up.prepare("INSERT INTO scim_groups (group_id, external_id, created_at, updated_at) VALUES ('g1', 'x', 0, 0)").run();
    up.prepare("INSERT INTO scim_tokens (id, name, token_hash, prefix, created_by, created_at, expires_at) VALUES ('t1', 'T', 'h', 'p', 'u1', 0, 1)").run();
    up.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM scim_users').get()).toEqual({ n: 0 });
    expect(up.prepare('SELECT created_by FROM scim_tokens').get()).toEqual({ created_by: null });
    up.prepare("DELETE FROM groups WHERE id = 'g1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM scim_groups').get()).toEqual({ n: 0 });
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
