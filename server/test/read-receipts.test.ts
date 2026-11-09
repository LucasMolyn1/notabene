import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createApiToken } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { exportUserData } from '../src/lib/personal-data.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

let app: FastifyInstance;
let db: DB;

// ed1 demande, ed2 est l'auteur de la page, ed3 un autre éditeur, rd un lecteur, out un compte qu'on prive d'accès.
const USERS = [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['ed3', 'editor'], ['rd', 'reader'], ['out', 'editor']] as const;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of USERS) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("UPDATE pages SET created_by = 'ed2' WHERE id = ?").run(pageId());
});
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, ...s });
const bearer = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
const pageId = () => (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur BeNote'").get() as { id: string }).id;
const url = (suffix = '') => `/api/v3/pages/${pageId()}/read-receipt${suffix}`;
// Restreint la page à `ids` (permission fine en écriture).
const restrict = (ids: string[]) => { for (const id of ids) db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, 'write')").run(pageId(), id); };
const receipts = () => (db.prepare('SELECT COUNT(*) AS n FROM page_read_receipts').get() as { n: number }).n;
const audits = (action: string) => db.prepare('SELECT meta FROM audit_log WHERE action = ? ORDER BY id').all(action) as { meta: string | null }[];

async function sessions() {
  const out: Record<string, S> = {};
  for (const [id] of USERS) out[id] = await login(id);
  return out as Record<(typeof USERS)[number][0], S>;
}

describe('accusé de lecture : demande et droits', () => {
  it('état initial, demande par un éditeur, idempotente ; lecteur refusé', async () => {
    const s = await sessions();
    const initial = (await call(s.rd, 'GET', url())).json();
    expect(initial).toEqual({
      pageId: pageId(), requested: false, requestedBy: null, requestedAt: null, myAck: null, canRequest: false, canAck: false, canSeeReaders: false,
    });
    expect((await call(s.rd, 'PUT', url())).statusCode).toBe(403);
    const res = await call(s.ed1, 'PUT', url());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requested: true, requestedBy: { id: 'ed1', name: 'Nom ed1' }, myAck: null, canRequest: true, canAck: true, canSeeReaders: true, readersCount: 0 });
    expect(JSON.stringify(res.json())).not.toContain('@example.com');
    const at = res.json().requestedAt as number;
    // Idempotent : ni nouvelle date, ni nouveau demandeur, ni nouvelle entrée d'audit.
    expect((await call(s.ed3, 'PUT', url())).json()).toMatchObject({ requestedAt: at, requestedBy: { id: 'ed1' }, canSeeReaders: false });
    expect(audits('read-receipt.request')).toHaveLength(1);
    // Un lecteur voit l'état et peut accuser réception, sans voir la liste.
    const asReader = (await call(s.rd, 'GET', url())).json();
    expect(asReader).toMatchObject({ requested: true, canRequest: false, canAck: true, canSeeReaders: false });
    expect(asReader).not.toHaveProperty('readersCount');
  });

  it('accuser réception : idempotent, renouvelé, reconfirmation après modification', async () => {
    const s = await sessions();
    expect((await call(s.rd, 'POST', url('/ack'))).statusCode).toBe(409); // rien de demandé
    expect(receipts()).toBe(0);
    await call(s.ed1, 'PUT', url());
    const first = (await call(s.rd, 'POST', url('/ack'))).json();
    expect(first.myAck).toEqual({ ackedAt: expect.any(Number), modifiedSinceAck: false });
    await new Promise((r) => setTimeout(r, 5));
    const again = (await call(s.rd, 'POST', url('/ack'))).json();
    expect(again.myAck.ackedAt).toBeGreaterThan(first.myAck.ackedAt);
    expect(receipts()).toBe(1);
    // La page est modifiée : signalé à la personne et dans la liste, jusqu'à ce qu'elle reconfirme.
    db.prepare('UPDATE pages SET updated_at = updated_at + 1000 WHERE id = ?').run(pageId());
    expect((await call(s.rd, 'GET', url())).json().myAck).toMatchObject({ modifiedSinceAck: true });
    expect((await call(s.ed1, 'GET', url('/readers'))).json().items).toEqual([{ user: { id: 'rd', name: 'Nom rd' }, ackedAt: again.myAck.ackedAt, modifiedSinceAck: true }]);
    expect((await call(s.rd, 'POST', url('/ack'))).json().myAck).toMatchObject({ modifiedSinceAck: false });
    expect((await call(s.ed1, 'GET', url('/readers'))).json().items[0]).toMatchObject({ modifiedSinceAck: false });
    // Aucun audit par accusé.
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'read-receipt.%' AND action != 'read-receipt.request'").get()).toEqual({ n: 0 });
  });

  it('liste des lecteurs : demandeur, auteur et administrateur seulement ; aucun nom ni nombre pour les autres', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    await call(s.ed3, 'POST', url('/ack'));
    for (const who of ['ed1', 'ed2', 'admin'] as const) {
      const state = (await call(s[who], 'GET', url())).json();
      expect(state, who).toMatchObject({ canSeeReaders: true, readersCount: 2 });
      const list = await call(s[who], 'GET', url('/readers'));
      expect(list.statusCode, who).toBe(200);
      expect(list.json().items.map((i: { user: { id: string } }) => i.user.id).sort()).toEqual(['ed3', 'rd']);
      expect(list.body).not.toContain('@example.com');
    }
    for (const who of ['ed3', 'rd'] as const) {
      const state = await call(s[who], 'GET', url());
      expect(state.json(), who).toMatchObject({ canSeeReaders: false });
      expect(state.json()).not.toHaveProperty('readersCount');
      expect(state.body).not.toContain('Nom rd');
      expect((await call(s[who], 'GET', url('/readers'))).statusCode, who).toBe(403);
    }
    // Jeton d'un administrateur sans la portée admin : pas plus de droits qu'un éditeur.
    const adminRead = createApiToken(db, 'admin', { name: 'l', scopes: ['read'], expiresInDays: 30 }).token;
    expect((await bearer(adminRead, 'GET', url('/readers'))).statusCode).toBe(403);
    const adminFull = createApiToken(db, 'admin', { name: 'a', scopes: ['read', 'admin'], expiresInDays: 30 }).token;
    expect((await bearer(adminFull, 'GET', url('/readers'))).statusCode).toBe(200);
    // Auteur par jeton en lecture : autorisé.
    const authorRead = createApiToken(db, 'ed2', { name: 'l', scopes: ['read'], expiresInDays: 30 }).token;
    expect((await bearer(authorRead, 'GET', url('/readers'))).json().items).toHaveLength(2);
    // Sans demande : liste vide pour l'auteur ou un administrateur.
    await call(s.ed1, 'DELETE', url());
    expect((await call(s.ed2, 'GET', url('/readers'))).json()).toEqual({ items: [], nextCursor: null });
    expect((await call(s.ed1, 'GET', url('/readers'))).statusCode).toBe(403); // n'est plus demandeur
  });

  it('page illisible : 404 sur toutes les routes ; sans session : 401', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.out, 'POST', url('/ack'));
    restrict(['ed1', 'ed2', 'ed3', 'rd']);
    for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['DELETE', ''], ['POST', '/ack'], ['DELETE', '/ack'], ['GET', '/readers']] as const) {
      expect((await call(s.out, method, url(suffix))).statusCode, `${method} ${suffix}`).toBe(404);
    }
    expect((await call(s.ed1, 'GET', '/api/v3/pages/inconnue/read-receipt')).statusCode).toBe(404);
    expect((await call(s.ed1, 'GET', '/api/v3/pages/..%2Fx/read-receipt')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: url() })).statusCode).toBe(401);
    // Le compte qui ne lit plus la page n'est ni listé ni compté.
    expect((await call(s.ed1, 'GET', url('/readers'))).json().items).toEqual([]);
    expect((await call(s.ed1, 'GET', url())).json()).toMatchObject({ readersCount: 0 });
  });

  it('pagination par curseur ; comptes désactivés écartés ; curseur forgé refusé', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    const ids = ['rd', 'ed3', 'out', 'admin', 'ed2'];
    const ins = db.prepare('INSERT INTO page_read_receipts (page_id, user_id, acked_at, page_updated_at) VALUES (?, ?, ?, 0)');
    ids.forEach((id, n) => ins.run(pageId(), id, 1000 + (n < 2 ? 0 : n))); // rd et ed3 à la même date
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'out'").run();
    const p1 = (await call(s.ed1, 'GET', url('/readers?limit=2'))).json();
    expect(p1.items.map((i: { user: { id: string } }) => i.user.id)).toEqual(['ed2', 'admin']);
    const p2 = (await call(s.ed1, 'GET', url(`/readers?limit=2&cursor=${p1.nextCursor}`))).json();
    expect(p2.items.map((i: { user: { id: string } }) => i.user.id)).toEqual(['ed3', 'rd']);
    expect(p2.nextCursor).toBeNull();
    expect((await call(s.ed1, 'GET', url())).json().readersCount).toBe(4);
    for (const bad of ['forge', encodeCursor({ a: -1, i: 'rd' }), encodeCursor({ a: 1, i: '../x' }), encodeCursor({ a: 'x', i: 'rd' })]) {
      expect((await call(s.ed1, 'GET', url(`/readers?cursor=${bad}`))).statusCode, bad).toBe(400);
    }
    for (const q of ['limit=0', 'limit=201', 'limit=x']) expect((await call(s.ed1, 'GET', url(`/readers?${q}`))).statusCode, q).toBe(400);
  });

  it('retirer son propre accusé', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    await call(s.ed3, 'POST', url('/ack'));
    expect((await call(s.rd, 'DELETE', url('/ack'))).statusCode).toBe(204);
    expect((await call(s.rd, 'GET', url())).json().myAck).toBeNull();
    expect((await call(s.rd, 'DELETE', url('/ack'))).statusCode).toBe(204); // idempotent
    // Seul son propre accusé est retiré.
    expect(db.prepare('SELECT user_id FROM page_read_receipts').all()).toEqual([{ user_id: 'ed3' }]);
  });

  it('désactivation par un éditeur : efface les accusés, journalisée avec le nombre', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    await call(s.ed3, 'POST', url('/ack'));
    expect((await call(s.rd, 'DELETE', url())).statusCode).toBe(403);
    // ed3, autre éditeur, ne peut pas retirer la demande d'autrui (il la reposerait à son nom et verrait les accusés).
    expect((await call(s.ed3, 'DELETE', url())).statusCode).toBe(403);
    expect(receipts()).toBe(2);
    // Le demandeur retire la demande : le nombre lui est rendu et figure dans l'audit.
    const res = await call(s.ed1, 'DELETE', url());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: true, receiptsDeleted: 2 });
    expect(receipts()).toBe(0);
    expect(audits('read-receipt.clear')).toEqual([{ meta: JSON.stringify({ receiptsDeleted: 2 }) }]);
    expect((await call(s.rd, 'GET', url())).json()).toMatchObject({ requested: false, myAck: null, canAck: false });
    expect((await call(s.rd, 'POST', url('/ack'))).statusCode).toBe(409);
    // Sans demande : rien à effacer, aucune entrée d'audit.
    expect((await call(s.ed1, 'DELETE', url())).json()).toEqual({ cleared: false, receiptsDeleted: null });
    expect(audits('read-receipt.clear')).toHaveLength(1);
    // Le demandeur obtient le nombre.
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    expect((await call(s.ed1, 'DELETE', url())).json()).toEqual({ cleared: true, receiptsDeleted: 1 });
    // L'auteur aussi, même sans accusé.
    await call(s.ed3, 'PUT', url());
    expect((await call(s.ed2, 'DELETE', url())).json()).toEqual({ cleared: true, receiptsDeleted: 0 });
  });

  it('jetons d’API : portées respectées', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    const readOnly = createApiToken(db, 'ed3', { name: 'l', scopes: ['read'], expiresInDays: 30 }).token;
    const write = createApiToken(db, 'ed3', { name: 'e', scopes: ['read', 'write'], expiresInDays: 30 }).token;
    const ai = createApiToken(db, 'ed3', { name: 'i', scopes: ['ai'], expiresInDays: 30 }).token;
    expect((await bearer(ai, 'GET', url())).statusCode).toBe(403);
    expect((await bearer(readOnly, 'GET', url())).json()).toMatchObject({ requested: true, canAck: false, canRequest: false });
    expect((await bearer(readOnly, 'POST', url('/ack'))).statusCode).toBe(403);
    expect((await bearer(readOnly, 'DELETE', url('/ack'))).statusCode).toBe(403);
    expect((await bearer(readOnly, 'PUT', url())).statusCode).toBe(403);
    expect((await bearer(readOnly, 'DELETE', url())).statusCode).toBe(403);
    expect((await bearer(write, 'POST', url('/ack'))).statusCode).toBe(200);
    expect((await bearer(write, 'DELETE', url('/ack'))).statusCode).toBe(204);
    expect((await bearer(write, 'DELETE', url())).statusCode).toBe(403); // ed3 n'est ni le demandeur, ni l'auteur, ni administrateur
    expect((await bearer(write, 'PUT', url())).statusCode).toBe(200);
  });

  it('événements : demande et retrait seulement, jamais un accusé ; aucun webhook', async () => {
    const s = await sessions();
    const seen: { type: string; pageId?: string; by?: unknown }[] = [];
    const off = app.bus.subscribe((e) => { if (e.type === 'page.read-receipt') seen.push(e); });
    await call(s.ed1, 'PUT', url());
    await call(s.ed1, 'PUT', url()); // déjà demandé : pas d'événement
    await call(s.rd, 'POST', url('/ack'));
    await call(s.rd, 'DELETE', url('/ack'));
    await call(s.ed1, 'DELETE', url());
    off();
    // Accuser réception et retirer son accusé ne diffusent rien (cela révélerait qui lit, et combien).
    expect(seen.map((e) => [e.pageId, e.by ?? null])).toEqual([
      [pageId(), { id: 'ed1', name: 'Nom ed1' }], [pageId(), { id: 'ed1', name: 'Nom ed1' }],
    ]);
    expect((await call(s.admin, 'POST', '/api/v3/admin/webhooks', { name: 'w', url: 'https://example.com/h', events: ['page.read-receipt'] })).statusCode).toBe(400);
  });
});

describe('accusé de lecture : données personnelles', () => {
  it('export, effacement de compte (accusés supprimés, demandes anonymisées)', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    const data = exportUserData(db, 'rd')!;
    expect(data.readReceipts).toEqual([{ pageId: pageId(), title: 'Bienvenue sur BeNote', ackedAt: expect.any(Number) }]);
    expect(exportUserData(db, 'ed1')!.readReceiptRequests).toEqual([{ pageId: pageId(), title: 'Bienvenue sur BeNote', requestedAt: expect.any(Number) }]);
    // Page devenue illisible : absente de l'export.
    restrict(['ed1']);
    expect(exportUserData(db, 'rd')!.readReceipts).toEqual([]);
    db.prepare('DELETE FROM page_acl').run();
    expect((await call(s.admin, 'POST', '/api/v3/admin/users/rd/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(receipts()).toBe(0);
    expect((await call(s.admin, 'POST', '/api/v3/admin/users/ed1/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare('SELECT requested_by FROM page_read_requests').get()).toEqual({ requested_by: null });
    expect((await call(s.ed3, 'GET', url())).json()).toMatchObject({ requested: true, requestedBy: null });
  });

  it('suppression définitive de la page : demande et accusés supprimés', async () => {
    const s = await sessions();
    await call(s.ed1, 'PUT', url());
    await call(s.rd, 'POST', url('/ack'));
    db.prepare('DELETE FROM pages WHERE id = ?').run(pageId());
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_read_requests').get()).toEqual({ n: 0 });
    expect(receipts()).toBe(0);
  });
});

describe('migration v28', () => {
  it('ajoute les tables, avec cascades et anonymisation', () => {
    const file = oldDb(27, (old) => {
      old.prepare("INSERT INTO page_verifications (page_id, interval_days, created_at, updated_at) VALUES ('p1', 30, 0, 0)").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_verifications').get()).toEqual({ n: 1 });
    up.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES ('u2', 'sub:u2', 'V', 'reader', 0)").run();
    // Un accusé n'existe pas sans demande.
    expect(() => up.prepare("INSERT INTO page_read_receipts (page_id, user_id, acked_at, page_updated_at) VALUES ('p1', 'u2', 1, 0)").run()).toThrow();
    up.prepare("INSERT INTO page_read_requests (page_id, requested_by, created_at) VALUES ('p1', 'u1', 0)").run();
    up.prepare("INSERT INTO page_read_receipts (page_id, user_id, acked_at, page_updated_at) VALUES ('p1', 'u2', 1, 0), ('p1', 'u1', 2, 0)").run();
    expect(() => up.prepare("INSERT INTO page_read_receipts (page_id, user_id, acked_at, page_updated_at) VALUES ('p1', 'u2', 3, 0)").run()).toThrow();
    up.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(up.prepare('SELECT requested_by FROM page_read_requests').get()).toEqual({ requested_by: null });
    expect(up.prepare('SELECT user_id FROM page_read_receipts').all()).toEqual([{ user_id: 'u2' }]);
    up.prepare("DELETE FROM page_read_requests WHERE page_id = 'p1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_read_receipts').get()).toEqual({ n: 0 });
    up.prepare("INSERT INTO page_read_requests (page_id, created_at) VALUES ('p1', 0)").run();
    up.prepare("DELETE FROM pages WHERE id = 'p1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_read_requests').get()).toEqual({ n: 0 });
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
