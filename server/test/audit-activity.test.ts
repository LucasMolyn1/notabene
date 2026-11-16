// Journal d'audit lisible et activité de l'API : libellés, cibles résolues (requêtes groupées), connexion attribuée,
// modifications journalisées par session et par jeton (`via`), agrégat `api.access` borné, refus `auth.denied`, compteur de
// requêtes des jetons, aucun texte de page dans le journal.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { resetAuditThrottle } from '../src/lib/audit.js';
import { type AuditRow, toAuditEvent } from '../src/lib/audit-events.js';
import { auditLabel, AUDIT_LABELS, resolveTargets } from '../src/lib/audit-labels.js';
import { hashPassword } from '../src/lib/password.js';
import { routeFamily } from '../src/lib/token-activity.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', RATE_LIMIT_PER_MINUTE: '100000' };
const PASS = 'Sup3r-secret-pass';
const SECRET_TITLE = 'TITRESECRET';
const SECRET_TEXT = 'TEXTESECRET';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  resetAuditThrottle();
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['adm', 'admin'], ['ed', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sA', 'Espace A', 0, 0), ('sB', 'Espace B', 0, 0)").run();
  db.prepare("INSERT INTO spaces (id, name, kind, owner_id, created_at, updated_at) VALUES ('sPers', 'Perso', 'personal', 'ed', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('sA', 'ed', 'edit'), ('sB', 'ed', 'edit')").run();
  const page = (id: string, space: string, title: string) => db.prepare('INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
    .run(id, space, title, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: SECRET_TEXT }] }] }), SECRET_TEXT);
  page('pA', 'sA', SECRET_TITLE); page('pB', 'sB', 'Page B'); page('pPers', 'sPers', 'Titre perso');
});
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const call = (s: S, method: Method, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, cookies: s.cookies, headers: { ...s.headers, ...headers } });
const bearer = (tok: string, method: Method, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok}`, ...headers } });
async function token(s: S, body: object = {}) {
  const res = await call(s, 'POST', '/api/v3/tokens', { name: 'Outil CI', scopes: ['read', 'write'], ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; token: string };
}
// Les crochets onResponse s'exécutent juste après l'envoi de la réponse.
const settle = () => new Promise((r) => setTimeout(r, 20));
const rows = (action: string) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { user_id: string | null; target: string | null; meta: string | null; token_id: string | null; token_name: string | null }[];

describe('libellés et cibles', () => {
  it('un libellé français par action connue, un libellé générique propre sinon', () => {
    expect(auditLabel('share.create')).toBe('Lien de partage créé');
    expect(auditLabel('auth.login')).toBe('Connexion');
    expect(auditLabel('settings.smtp')).toBe('Réglages modifiés : e-mail (SMTP)');
    expect(auditLabel('page.inconnue')).toBe('Action sur une page');
    expect(auditLabel('truc.machin.failed')).toBe('Action (échec)');
    expect(auditLabel('zzz')).toBe('Action enregistrée');
    for (const label of Object.values(AUDIT_LABELS)) expect(label).not.toMatch(/^[a-z_.]+$/);
  });

  it('cibles résolues par type, une requête par type quelle que soit la taille du lot ; espace personnel sans titre', async () => {
    const t = await token(await login('ed'));
    db.prepare("INSERT INTO groups (id, name, created_at) VALUES ('g1', 'Équipe', 0)").run();
    db.prepare("INSERT INTO page_comments (id, page_id, author_id, body, created_at, updated_at) VALUES ('c1', 'pA', 'ed', 'texte du commentaire', 0, 0)").run();
    const input = [
      ...Array.from({ length: 60 }, () => ({ action: 'page.create', target: 'pA' })),
      { action: 'page.trash', target: 'pPers' }, { action: 'page.create', target: 'disparue' },
      { action: 'space.create', target: 'sB' }, { action: 'user.update', target: 'ed' }, { action: 'token.create', target: t.id },
      { action: 'group.update', target: 'g1' }, { action: 'comment.create', target: 'c1' }, { action: 'settings.smtp', target: 'smtp' },
      { action: 'auth.denied', target: 'ldap:jean.dupont' }, { action: 'trash.empty', target: null },
    ];
    const spy = vi.spyOn(db, 'prepare');
    const out = resolveTargets(db, input);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(7);
    spy.mockRestore();
    expect(out[0]).toEqual({ type: 'page', id: 'pA', title: SECRET_TITLE });
    expect(out.slice(60)).toEqual([
      { type: 'page', id: 'pPers', title: null }, { type: 'page', id: 'disparue', title: null },
      { type: 'space', id: 'sB', title: 'Espace B' }, { type: 'user', id: 'ed', title: 'Nom ed' }, { type: 'token', id: t.id, title: 'Outil CI' },
      { type: 'group', id: 'g1', title: 'Équipe' }, { type: 'comment', id: 'c1', title: SECRET_TITLE }, { type: 'settings', id: 'smtp', title: null },
      { type: 'other', id: 'ldap:jean.dupont', title: null }, null,
    ]);
  });

  it('liste et export : label et targetInfo ; `target` reste l’identifiant ; connexion attribuée à la personne', async () => {
    // Ligne ancienne écrite sans auteur : la connexion revient à la personne connectée.
    db.prepare("INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (1, NULL, 'auth.login', 'ed', NULL, NULL)").run();
    await login('ed');
    const adm = await login('adm');
    const items = (await call(adm, 'GET', '/api/v3/admin/audit/events?action=auth.login')).json().items as { actor: { id: string; name: string } | null; label: string; target: string; targetInfo: unknown }[];
    expect(items.length).toBe(3);
    for (const e of items) expect(e.actor).not.toBeNull();
    const ed = items.filter((e) => e.target === 'ed');
    expect(ed).toHaveLength(2);
    for (const e of ed) expect(e).toMatchObject({ label: 'Connexion', actor: { id: 'ed', name: 'Nom ed' }, targetInfo: { type: 'user', id: 'ed', title: 'Nom ed' } });
    expect(((await call(adm, 'GET', '/api/v3/admin/audit/events?userId=ed&action=auth.login')).json().items as unknown[]).length).toBe(2);
    const json = JSON.parse((await call(adm, 'GET', '/api/v3/admin/audit/export?format=json&action=auth.login')).body) as { label: string; targetInfo: { title: string } }[];
    expect(json.every((e) => e.label === 'Connexion' && !!e.targetInfo)).toBe(true);
    const csv = (await call(adm, 'GET', '/api/v3/admin/audit/export?format=csv&action=auth.login')).body;
    expect(csv).toContain('"Connexion","user","Nom ed"');
    const legacy = (await call(adm, 'GET', '/api/v3/admin/audit?action=auth.login')).json() as { user: string; label: string; target: string }[];
    expect(legacy.every((r) => r.label === 'Connexion' && typeof r.target === 'string' && !!r.user)).toBe(true);
    // Format stable (SIEM, sortie standard) : label oui, targetInfo non.
    const raw = db.prepare('SELECT a.*, NULL AS user_name FROM audit_log a LIMIT 1').get() as AuditRow;
    expect(toAuditEvent(raw)).toHaveProperty('label');
    expect(toAuditEvent(raw)).not.toHaveProperty('targetInfo');
  });
});

describe('modifications journalisées', () => {
  async function everything(who: { s?: S; tok?: string }) {
    const go = (m: Method, url: string, body?: object, headers: Record<string, string> = {}) => (who.tok ? bearer(who.tok, m, url, body, headers) : call(who.s!, m, url, body, headers));
    const ok = async (m: Method, url: string, body?: object, headers: Record<string, string> = {}) => {
      const res = await go(m, url, body, headers);
      expect(res.statusCode, `${m} ${url} ${res.body}`).toBeLessThan(300);
      return res;
    };
    const created = (await ok('POST', '/api/v3/pages', { spaceId: 'sA', title: `${SECRET_TITLE} 2`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: SECRET_TEXT }] }] } })).json() as { id: string };
    await ok('PATCH', `/api/v3/pages/${created.id}`, { title: 'Nouveau titre secret' });
    await ok('PATCH', `/api/v3/pages/${created.id}`, { content: { type: 'doc', content: [] } }, { 'if-match': '"2"' }).catch(() => undefined);
    await ok('POST', `/api/v3/pages/${created.id}/move`, { parentId: 'pA' });
    const dup = (await ok('POST', `/api/v3/pages/${created.id}/duplicate`)).json() as { id: string };
    await ok('DELETE', `/api/v3/pages/${dup.id}`);
    await ok('POST', `/api/v3/pages/${dup.id}/restore`);
    const versions = (await ok('GET', `/api/v3/pages/${created.id}/versions`)).json() as { id: number }[];
    if (versions.length) await ok('POST', `/api/v3/pages/${created.id}/versions/${versions.at(-1)!.id}/restore`);
    const comment = (await ok('POST', '/api/v3/pages/pA/comments', { body: SECRET_TEXT })).json() as { id: string };
    await ok('PATCH', `/api/v3/pages/pA/comments/${comment.id}`, { body: `${SECRET_TEXT} modifié` });
    await ok('DELETE', `/api/v3/pages/pA/comments/${comment.id}`);
    await ok('POST', '/api/v3/pages/pA/labels', { name: 'etiquette' });
    await ok('DELETE', '/api/v3/pages/pA/labels/etiquette');
    await ok('GET', '/api/v3/pages/pA/export');
    await ok('GET', `/api/v3/search?q=${SECRET_TEXT}`);
    return created.id;
  }
  const ACTIONS = ['page.create', 'page.update', 'page.move', 'page.duplicate', 'page.trash', 'page.restore', 'comment.create', 'comment.update', 'comment.delete', 'page.label.add', 'page.label.remove', 'page.export'];

  it('par jeton : chaque action porte le jeton (via) ; par session : sans via ; aucun texte de page', async () => {
    const ed = await login('ed');
    const t = await token(ed);
    await everything({ tok: t.token });
    await settle();
    for (const a of [...ACTIONS, 'search']) {
      const r = rows(a);
      expect(r.length, a).toBeGreaterThan(0);
      expect(r.every((x) => x.user_id === 'ed' && x.token_id === t.id && x.token_name === 'Outil CI'), a).toBe(true);
    }
    const before = db.prepare('SELECT MAX(id) AS n FROM audit_log').get() as { n: number };
    resetAuditThrottle();
    await everything({ s: ed });
    const fresh = db.prepare('SELECT action, token_id FROM audit_log WHERE id > ?').all(before.n) as { action: string; token_id: string | null }[];
    for (const a of ACTIONS) expect(fresh.some((x) => x.action === a && x.token_id === null), a).toBe(true);
    // Recherche d'une session : pas journalisée (bruit).
    expect(fresh.some((x) => x.action === 'search')).toBe(false);
    // Champs modifiés seulement.
    expect(JSON.parse(rows('page.update')[0]!.meta!)).toEqual({ fields: ['title'] });
    // Ni dans la table, ni dans le format envoyé au SIEM : aucun titre ni texte de page.
    const all = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    expect(all).not.toContain(SECRET_TEXT);
    expect(all).not.toContain(SECRET_TITLE);
    expect(all).not.toContain('Nouveau titre');
    const events = (db.prepare('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id').all() as AuditRow[]).map(toAuditEvent);
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${SECRET_TEXT}|${SECRET_TITLE}`));
  });

  it('le filtre par famille retrouve les nouvelles actions', async () => {
    const ed = await login('ed');
    await everything({ s: ed });
    const adm = await login('adm');
    const pages = (await call(adm, 'GET', '/api/v3/admin/audit/events?action=page.&limit=200')).json().items as { action: string; label: string }[];
    for (const a of ['page.create', 'page.update', 'page.move', 'page.trash', 'page.restore', 'page.duplicate']) expect(pages.some((e) => e.action === a), a).toBe(true);
    expect(pages.every((e) => e.action.startsWith('page.') && !!e.label)).toBe(true);
    expect((await call(adm, 'GET', '/api/v3/admin/audit/events?action=comment.')).json().items).toHaveLength(3);
  });

  it('page.update : au plus une ligne par minute, champs réunis', async () => {
    const ed = await login('ed');
    for (const title of ['a', 'b', 'c']) expect((await call(ed, 'PATCH', '/api/v3/pages/pA', { title })).statusCode).toBe(200);
    expect(rows('page.update')).toHaveLength(1);
  });

  it('lignes de base : ajout et modification journalisés sans valeur', async () => {
    const ed = await login('ed');
    const t = await token(ed);
    const base = (await bearer(t.token, 'POST', '/api/v3/bases', { spaceId: 'sA', title: 'Base' })).json() as { page: { id: string }; properties: { id: string }[] };
    const row = (await bearer(t.token, 'POST', `/api/v3/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: SECRET_TEXT } })).json() as { id: string };
    expect((await bearer(t.token, 'PATCH', `/api/v3/bases/${base.page.id}/rows/${row.id}`, { values: { [base.properties[0]!.id]: 'autre' } })).statusCode).toBe(200);
    expect((await bearer(t.token, 'GET', `/api/v3/bases/${base.page.id}/export`)).statusCode).toBe(200);
    for (const a of ['base.row.create', 'base.row.update', 'base.export']) expect(rows(a)[0]?.token_id, a).toBe(t.id);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(SECRET_TEXT);
  });
});

describe('activité des jetons', () => {
  it('familles de routes', () => {
    expect(routeFamily('/api/v3/pages/:id')).toBe('pages');
    expect(routeFamily('/api/v3/pages/:id/comments/:cid')).toBe('comments');
    expect(routeFamily('/api/v3/spaces/:id/export/zip')).toBe('export');
    expect(routeFamily('/api/v3/search')).toBe('search');
    expect(routeFamily('/mcp')).toBe('mcp');
    expect(routeFamily('/api/v3/inexistant')).toBe('autre');
    expect(routeFamily(undefined)).toBe('inconnue');
  });

  it('1000 requêtes d’un jeton : une ligne api.access par famille et par fenêtre, sans identifiant de page', async () => {
    const ed = await login('ed');
    const t = await token(ed);
    for (let i = 0; i < 1000; i++) await bearer(t.token, 'GET', i % 2 ? '/api/v3/pages/pA' : '/api/v3/pages/inexistante');
    for (let i = 0; i < 10; i++) await bearer(t.token, 'GET', '/api/v3/spaces');
    await settle();
    expect(rows('api.access')).toHaveLength(0); // écrit à la fin de la fenêtre
    app.tokenActivity.flush(true);
    const access = rows('api.access');
    expect(access.length).toBeLessThanOrEqual(2);
    const pages = access.map((r) => ({ ...r, meta: JSON.parse(r.meta!) })).find((r) => r.meta.routes[0] === 'pages')!;
    expect(pages).toMatchObject({ user_id: 'ed', target: t.id, token_id: t.id, meta: { requests: 1000, routes: ['pages'], statuses: { 200: 500, 404: 500 }, windowMinutes: 5 } });
    expect(JSON.stringify(access)).not.toContain('pA');
    expect(JSON.stringify(access)).not.toContain('inexistante');
    // Compteur du jeton : à jour dans la liste avant même l'écriture en base (au plus une par minute).
    const listed = ((await call(ed, 'GET', '/api/v3/tokens')).json() as { id: string; requestCount: number; lastUsedAt: number | null }[]).find((x) => x.id === t.id)!;
    expect(listed.requestCount).toBe(1010);
    expect(typeof listed.lastUsedAt).toBe('number');
    app.tokenActivity.flushCounts();
    expect(db.prepare('SELECT request_count AS n FROM api_tokens WHERE id = ?').get(t.id)).toEqual({ n: 1010 });
    expect(((await call(ed, 'GET', '/api/v3/tokens')).json() as { id: string; requestCount: number }[]).find((x) => x.id === t.id)!.requestCount).toBe(1010);
  });

  it('refus d’un jeton : portée insuffisante, espace hors périmètre ; réponse inchangée, volume borné', async () => {
    const ed = await login('ed');
    const readOnly = await token(ed, { scopes: ['read'] });
    expect((await bearer(readOnly.token, 'POST', '/api/v3/pages', { spaceId: 'sA', title: 'x' })).statusCode).toBe(403);
    const limited = await token(ed, { scopes: ['read', 'write'], spaceIds: ['sA'] });
    const outside = await bearer(limited.token, 'GET', '/api/v3/pages/pB');
    const missing = await bearer(limited.token, 'GET', '/api/v3/pages/inexistante');
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body.replace('inexistante', 'pB'));
    for (let i = 0; i < 50; i++) await bearer(limited.token, 'GET', '/api/v3/pages/pB');
    await settle();
    const denied = rows('auth.denied');
    expect(denied).toHaveLength(2); // une ligne immédiate par raison
    const byReason = Object.fromEntries(denied.map((r) => [JSON.parse(r.meta!).reason, r]));
    expect(byReason.scope).toMatchObject({ user_id: 'ed', token_id: readOnly.id });
    expect(byReason.space).toMatchObject({ user_id: 'ed', token_id: limited.id });
    // Une page inexistante n'est pas un refus.
    app.tokenActivity.flush(true);
    const after = rows('auth.denied');
    expect(after).toHaveLength(3);
    expect(JSON.parse(after[2]!.meta!)).toMatchObject({ reason: 'space', aggregated: true, requests: 50, routes: ['pages'], statuses: { 404: 50 } });
    expect(JSON.stringify(after)).not.toContain('pB');
    // Liste réservée aux administrateurs : libellé et outcome.
    const adm = await login('adm');
    const items = (await call(adm, 'GET', '/api/v3/admin/audit/events?action=auth.denied')).json().items as { outcome: string; label: string; actor: { via: { id: string } } }[];
    expect(items.every((e) => e.outcome === 'failure' && e.label === 'Accès refusé' && !!e.actor.via)).toBe(true);
  });
});
