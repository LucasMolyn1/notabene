// Bases (P8) : formulaires liés à une base, réponses anonymes facultatives. Cas permis et cas refusés : réglages désactivés par
// défaut, jeton révoqué, débit, taille, champ piège, ticket, options, questions non exposées, base restreinte, migration.
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { FORM_ROOM_RATIO, FormTickets, ipRateKey, MAX_BASE_RESPONSES_PER_HOUR, MAX_RESPONSES_PER_HOUR, MIN_FILL_MS, SUBMIT_PER_MINUTE } from '../src/lib/base-forms.js';
import { MAX_FAILURES, MAX_RUNS_PER_MINUTE } from '../src/lib/base-automations.js';
import { MAX_ROWS } from '../src/lib/bases.js';
import { sha256 } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';
import { maskShareToken } from '../src/lib/shares.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const KEY = randomBytes(32).toString('base64');
const baseEnv = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: KEY, AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
const sessions = new Map<string, S>();

beforeEach(async () => {
  sessions.clear();
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(baseEnv), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => {
  await app.automations.idle();
  await app.close();
  db.close();
});

interface S { cookies: Record<string, string>; headers: Record<string, string> }
async function login(id: string): Promise<S> {
  if (!sessions.has(id)) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    sessions.set(id, { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } });
  }
  return sessions.get(id)!;
}
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;

interface Prop { id: string; name: string; options: { id: string; name: string }[] }
async function enable() {
  const admin = await login('admin');
  expect((await call(admin, 'PUT', '/api/v3/admin/forms', { enabled: true })).statusCode).toBe(200);
  expect((await call(admin, 'PATCH', `/api/v3/spaces/${teamSpace()}`, { forms: true })).statusCode).toBe(200);
}
const addProp = async (s: S, base: string, body: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Prop;
};
/** Base « Demandes » : Nom (texte), Priorité (sélection), Secret (texte non exposé), Qui (personne). */
async function demandes() {
  const ed = await login('ed1');
  const res = await call(ed, 'POST', '/api/v3/bases', { spaceId: teamSpace(), title: 'Demandes internes' });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json() as { page: { id: string }; properties: Prop[] };
  const prio = await addProp(ed, b.page.id, { name: 'Priorité', type: 'select', options: [{ name: 'Haute' }, { name: 'Basse' }] });
  const secret = await addProp(ed, b.page.id, { name: 'Secret interne', type: 'text' });
  const who = await addProp(ed, b.page.id, { name: 'Qui', type: 'person' });
  return { ed, id: b.page.id, nom: b.properties[0]!.id, prio, secret, who };
}
const newForm = async (s: S, base: string, body: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/forms`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; mode: string; active: boolean };
};
const linkOf = async (s: S, base: string, fid: string, body?: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/forms/${fid}/link`, body);
  expect([200, 201], res.body).toContain(res.statusCode);
  return /\/form\/([A-Za-z0-9_-]{32})$/.exec(res.json().url as string)![1]!;
};
/** Formulaire anonyme sur « Demandes » : Nom (obligatoire) et Priorité, avec son jeton. */
async function anonymousForm(extra: object = {}) {
  await enable();
  const b = await demandes();
  const f = await newForm(b.ed, b.id, { title: 'Signaler', thanks: 'Merci !', mode: 'anonymous', questions: [{ propertyId: b.nom, label: 'Votre demande', required: true }, { propertyId: b.prio.id }], ...extra });
  const token = await linkOf(b.ed, b.id, f.id);
  return { ...b, fid: f.id, token };
}
/** Ticket déjà « vieux » de quelques secondes (le délai minimal est réel : on ne l'attend pas dans les tests). */
const oldTicket = (fid: string, ageMs = MIN_FILL_MS + 1000) => {
  const row = db.prepare('SELECT id, token_hash FROM base_forms WHERE id = ?').get(fid) as { id: string; token_hash: string };
  return new FormTickets(KEY).issue(row, Date.now() - ageMs);
};
const view = (token: string, s: S | null = null) => call(s, 'GET', `/api/v3/public/forms/${token}`);
// Chaque envoi depuis une adresse différente (la limite par adresse a son propre test), sauf adresse imposée.
let ip = 0;
const submit = (token: string, body: object, s: S | null = null, remoteAddress = `10.0.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  app.inject({ method: 'POST', url: `/api/v3/public/forms/${token}`, payload: body, cookies: s?.cookies, headers: s?.headers, remoteAddress });
const rowsOf = (base: string) => db.prepare('SELECT vals, created_by FROM base_rows WHERE base_id = ? ORDER BY position').all(base) as { vals: string; created_by: string | null }[];

describe('réglages désactivés par défaut', () => {
  it('instance, espace et espace personnel', async () => {
    const admin = await login('admin');
    expect((await call(admin, 'GET', '/api/v3/admin/forms')).json()).toMatchObject({ enabled: false, count: 0 });
    expect((await call(admin, 'GET', '/api/v3/spaces')).json().find((s: { id: string }) => s.id === teamSpace()).forms).toBe(false);
    const b = await demandes();
    // Instance coupée.
    let res = await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [{ propertyId: b.nom }] });
    expect(res.statusCode).toBe(403);
    expect((await call(b.ed, 'GET', `/api/v3/bases/${b.id}/forms`)).json()).toMatchObject({ available: false, instanceEnabled: false, spaceEnabled: false });
    // Instance ouverte, espace encore coupé.
    expect((await call(admin, 'PUT', '/api/v3/admin/forms', { enabled: true })).statusCode).toBe(200);
    res = await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [{ propertyId: b.nom }] });
    expect(res.statusCode).toBe(403);
    // Seul un administrateur ouvre les formulaires d'un espace.
    expect((await call(b.ed, 'PATCH', `/api/v3/spaces/${teamSpace()}`, { forms: true })).statusCode).toBe(403);
    // Espace personnel : jamais.
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('personal_spaces', '{\"enabled\":true}', 0)").run();
    const mine = (await call(b.ed, 'POST', '/api/v3/spaces/personal')).json() as { id: string };
    const pb = (await call(b.ed, 'POST', '/api/v3/bases', { spaceId: mine.id, title: 'Perso' })).json() as { page: { id: string }; properties: Prop[] };
    res = await call(b.ed, 'POST', `/api/v3/bases/${pb.page.id}/forms`, { title: 'F', questions: [{ propertyId: pb.properties[0]!.id }] });
    expect(res.statusCode).toBe(409);
    expect((await call(admin, 'PATCH', `/api/v3/spaces/${mine.id}`, { forms: true })).statusCode).toBe(404); // l'administrateur ne voit pas l'espace
    db.prepare('UPDATE spaces SET forms_enabled = 1 WHERE id = ?').run(mine.id);
    res = await call(b.ed, 'POST', `/api/v3/bases/${pb.page.id}/forms`, { title: 'F', questions: [{ propertyId: pb.properties[0]!.id }] });
    expect(res.statusCode).toBe(409);
  });

  it('gestion réservée au droit d’écriture ; lien et configuration depuis la session web seulement', async () => {
    const f = await anonymousForm();
    // Rôle lecteur : refusé ; éditeur sans droit d'écriture sur la base : introuvable.
    expect((await call(await login('rd'), 'GET', `/api/v3/bases/${f.id}/forms`)).statusCode).toBe(403);
    expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${f.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    expect((await call(await login('ed2'), 'GET', `/api/v3/bases/${f.id}/forms`)).statusCode).toBe(404);
    expect((await call(await login('ed2'), 'POST', `/api/v3/bases/${f.id}/forms/${f.fid}/link`, { confirmRestricted: true })).statusCode).toBe(404);
    const tok = await call(f.ed, 'POST', '/api/v3/tokens', { name: 'outil', scopes: ['read', 'write'], expiresInDays: 7 });
    const bearer = { authorization: `Bearer ${tok.json().token as string}` };
    expect((await app.inject({ method: 'POST', url: `/api/v3/bases/${f.id}/forms/${f.fid}/link`, headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v3/bases/${f.id}/forms/${f.fid}`, headers: bearer, payload: { mode: 'accounts' } })).statusCode).toBe(403);
    // Révoquer reste possible par jeton.
    expect((await app.inject({ method: 'DELETE', url: `/api/v3/bases/${f.id}/forms/${f.fid}/link`, headers: bearer })).statusCode).toBe(204);
    expect((await view(f.token)).statusCode).toBe(404);
  });
});

describe('réponse anonyme', () => {
  it('écrit une ligne sans compte ; la page publique ne montre que la configuration', async () => {
    const f = await anonymousForm();
    await call(f.ed, 'POST', `/api/v3/bases/${f.id}/rows`, { values: { [f.nom]: 'ligne existante', [f.secret.id]: 'confidentiel', [f.who.id]: 'ed1' } });
    const res = await view(f.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const body = res.json();
    expect(body.form).toEqual({
      title: 'Signaler', description: '', mode: 'anonymous',
      questions: [
        { id: f.nom, label: 'Votre demande', type: 'text', required: true },
        { id: f.prio.id, label: 'Priorité', type: 'select', required: false, options: f.prio.options.map((o) => ({ id: o.id, name: o.name, color: expect.any(String) })) },
      ],
    });
    // Ni lignes, ni nom de base, ni colonne non exposée, ni personne.
    for (const leak of ['ligne existante', 'confidentiel', 'Demandes internes', 'Secret interne', 'Nom ed1', f.secret.id, f.who.id, 'Merci']) expect(res.body).not.toContain(leak);
    const ok = await submit(f.token, { answers: { [f.nom]: 'Imprimante en panne', [f.prio.id]: f.prio.options[0]!.id }, ticket: oldTicket(f.fid) });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toEqual({ thanks: 'Merci !' });
    expect(ok.headers['cache-control']).toBe('no-store');
    const rows = rowsOf(f.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.created_by).toBeNull();
    expect(JSON.parse(rows[1]!.vals)).toEqual({ [f.nom]: 'Imprimante en panne', [f.prio.id]: f.prio.options[0]!.id });
    // Audit : le volume, jamais le contenu ; une réponse anonyme ne garde ni compte ni adresse.
    const a = db.prepare("SELECT user_id, ip, meta FROM audit_log WHERE action = 'base.form.submit'").all() as { user_id: string | null; ip: string | null; meta: string }[];
    expect(a).toEqual([{ user_id: null, ip: null, meta: JSON.stringify({ formId: f.fid, anonymous: true }) }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain('Imprimante');
    // Compteurs de gestion ; le jeton n'est jamais rendu ni stocké.
    const list = await call(f.ed, 'GET', `/api/v3/bases/${f.id}/forms`);
    expect(list.json().items[0]).toMatchObject({ id: f.fid, active: true, responses: 1, mode: 'anonymous' });
    expect(list.body).not.toContain(f.token);
    expect(JSON.stringify(db.prepare('SELECT * FROM base_forms').all())).not.toContain(f.token);
  });

  it('une session reste anonyme dans un formulaire anonyme', async () => {
    const f = await anonymousForm();
    const rd = await login('rd');
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) }, rd)).statusCode).toBe(201);
    expect(rowsOf(f.id)[0]!.created_by).toBeNull();
    expect((db.prepare("SELECT user_id FROM audit_log WHERE action = 'base.form.submit'").get() as { user_id: string | null }).user_id).toBeNull();
  });

  it('anonyme jamais par défaut ; Personne et Page refusées en anonyme ; types non écrivables refusés', async () => {
    await enable();
    const b = await demandes();
    const f = await newForm(b.ed, b.id, { title: 'F', questions: [{ propertyId: b.nom }, { propertyId: b.who.id }] });
    expect(f.mode).toBe('accounts');
    // Passer en anonyme avec une question Personne : refusé.
    let res = await call(b.ed, 'PATCH', `/api/v3/bases/${b.id}/forms/${f.id}`, { mode: 'anonymous' });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('anonymous_type');
    const page = await addProp(b.ed, b.id, { name: 'Page', type: 'page_link' });
    res = await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', mode: 'anonymous', questions: [{ propertyId: page.id }] });
    expect(res.statusCode).toBe(400);
    for (const body of [{ name: 'Calcul', type: 'formula', formula: '1+1' }, { name: 'Num', type: 'unique_id' }, { name: 'Créé', type: 'created_time' }, { name: 'Par', type: 'created_by' }]) {
      const p = await addProp(b.ed, b.id, body);
      res = await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [{ propertyId: p.id }] });
      expect(res.statusCode, body.type).toBe(400);
    }
    // Colonne d'une autre base, doublon, aucune question.
    expect((await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [{ propertyId: 'inconnue' }] })).statusCode).toBe(400);
    expect((await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [{ propertyId: b.nom }, { propertyId: b.nom }] })).statusCode).toBe(400);
    expect((await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', questions: [] })).statusCode).toBe(400);
  });
});

describe('mode réservé aux comptes', () => {
  it('sans session : 401 ; avec une session : ligne créée par le compte, Personne = soi seulement', async () => {
    await enable();
    const b = await demandes();
    const f = await newForm(b.ed, b.id, { title: 'F', questions: [{ propertyId: b.nom, required: true }, { propertyId: b.who.id }] });
    const token = await linkOf(b.ed, b.id, f.id);
    let res = await view(token);
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('login_required');
    expect(res.body).not.toContain(b.nom);
    expect((await submit(token, { answers: { [b.nom]: 'x' }, ticket: oldTicket(f.id) })).statusCode).toBe(401);
    const rd = await login('rd');
    expect((await view(token, rd)).statusCode).toBe(200);
    // Une autre personne que soi : refusé.
    res = await submit(token, { answers: { [b.nom]: 'x', [b.who.id]: 'ed2' }, ticket: oldTicket(f.id) }, rd);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'invalid', questionId: b.who.id });
    res = await submit(token, { answers: { [b.nom]: 'Demande', [b.who.id]: 'rd' }, ticket: oldTicket(f.id) }, rd);
    expect(res.statusCode, res.body).toBe(201);
    const row = rowsOf(b.id)[0]!;
    expect(row.created_by).toBe('rd');
    expect(JSON.parse(row.vals)[b.who.id]).toBe('rd');
    // Un jeton d'API ne répond pas à un formulaire.
    const tok = await call(rd, 'POST', '/api/v3/tokens', { name: 'outil', scopes: ['read', 'write'], expiresInDays: 7 });
    expect((await app.inject({ method: 'POST', url: `/api/v3/public/forms/${token}`, headers: { authorization: `Bearer ${tok.json().token as string}` }, payload: { answers: { [b.nom]: 'x' }, ticket: oldTicket(f.id) } })).statusCode).toBe(401);
  });
});

describe('jeton du lien', () => {
  it('révoqué : 404 ; renouvelé : l’ancien cesse de valoir', async () => {
    const f = await anonymousForm();
    const t2 = await linkOf(f.ed, f.id, f.fid);
    expect(t2).not.toBe(f.token);
    expect((await view(f.token)).statusCode).toBe(404);
    expect((await view(t2)).statusCode).toBe(200);
    expect((await call(f.ed, 'DELETE', `/api/v3/bases/${f.id}/forms/${f.fid}/link`)).statusCode).toBe(204);
    expect((await view(t2)).statusCode).toBe(404);
    expect((await submit(t2, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).statusCode).toBe(404);
    expect((await view('A'.repeat(32))).statusCode).toBe(404);
    expect((await view('court')).statusCode).toBe(404);
    expect(db.prepare("SELECT action FROM audit_log WHERE action LIKE 'base.form.link.%' ORDER BY id").all().map((r) => (r as { action: string }).action))
      .toEqual(['base.form.link.create', 'base.form.link.rotate', 'base.form.link.revoke']);
  });

  it('instance coupée : liens révoqués, réactiver ne les rouvre pas', async () => {
    const f = await anonymousForm();
    const admin = await login('admin');
    expect((await call(admin, 'PUT', '/api/v3/admin/forms', { enabled: false })).json()).toEqual({ enabled: false, revoked: 1 });
    expect((await view(f.token)).statusCode).toBe(404);
    await call(admin, 'PUT', '/api/v3/admin/forms', { enabled: true });
    expect((await view(f.token)).statusCode).toBe(404);
    expect((await call(f.ed, 'GET', `/api/v3/bases/${f.id}/forms`)).json().items[0].active).toBe(false);
  });

  it('instance coupée sans révocation (base modifiée à la main) : le lien se tait quand même', async () => {
    const f = await anonymousForm();
    db.prepare("UPDATE settings SET value = '{\"enabled\":false}' WHERE key = 'base_forms'").run();
    expect((await view(f.token)).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = '{\"enabled\":true}' WHERE key = 'base_forms'").run();
    db.prepare('UPDATE spaces SET forms_enabled = 0').run();
    expect((await view(f.token)).statusCode).toBe(404);
  });

  it('espace coupé, base à la corbeille ou déplacée : liens révoqués', async () => {
    const f = await anonymousForm();
    const admin = await login('admin');
    expect((await call(admin, 'PATCH', `/api/v3/spaces/${teamSpace()}`, { forms: false })).statusCode).toBe(200);
    expect((await view(f.token)).statusCode).toBe(404);
    expect((db.prepare('SELECT token_hash FROM base_forms WHERE id = ?').get(f.fid) as { token_hash: string | null }).token_hash).toBeNull();
    await call(admin, 'PATCH', `/api/v3/spaces/${teamSpace()}`, { forms: true });
    const token = await linkOf(f.ed, f.id, f.fid);
    expect((await call(f.ed, 'DELETE', `/api/v3/pages/${f.id}`)).statusCode).toBe(204);
    expect((await view(token)).statusCode).toBe(404);
    expect((db.prepare('SELECT token_hash FROM base_forms WHERE id = ?').get(f.fid) as { token_hash: string | null }).token_hash).toBeNull();
  });

  it('compte qui a créé le lien sans droit d’écriture : lien mort', async () => {
    const f = await anonymousForm();
    db.prepare("UPDATE users SET role = 'reader' WHERE id = 'ed1'").run();
    expect((await view(f.token)).statusCode).toBe(404);
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).statusCode).toBe(404);
    db.prepare("UPDATE users SET role = 'editor' WHERE id = 'ed1'").run();
    expect((await view(f.token)).statusCode).toBe(200);
    // Permissions de page qui lui retirent l'écriture (confirmées par un autre rédacteur) : mort aussi.
    const admin = await login('admin');
    await call(admin, 'PUT', `/api/v3/pages/${f.id}/permissions`, { entries: [{ userId: 'ed1', level: 'read' }, { userId: 'ed2', level: 'write' }] });
    await call(await login('ed2'), 'PATCH', `/api/v3/bases/${f.id}/forms/${f.fid}`, { confirmRestricted: true });
    expect((db.prepare('SELECT link_by FROM base_forms WHERE id = ?').get(f.fid) as { link_by: string }).link_by).toBe('ed1');
    expect((await view(f.token)).statusCode).toBe(404);
  });

  it('passer en anonyme révoque le lien et demande les réglages actifs', async () => {
    await enable();
    const b = await demandes();
    const f = await newForm(b.ed, b.id, { title: 'F', questions: [{ propertyId: b.nom }] });
    const token = await linkOf(b.ed, b.id, f.id);
    expect((await view(token, await login('rd'))).statusCode).toBe(200);
    let res = await call(b.ed, 'PATCH', `/api/v3/bases/${b.id}/forms/${f.id}`, { mode: 'anonymous' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'anonymous', active: false, linkCreatedAt: null });
    expect((await view(token)).statusCode).toBe(404);
    expect(db.prepare("SELECT meta FROM audit_log WHERE action = 'base.form.link.revoke'").get()).toEqual({ meta: JSON.stringify({ formId: f.id, reason: 'anonymous' }) });
    // Retour en comptes, instance coupée : repasser en anonyme est refusé.
    await call(b.ed, 'PATCH', `/api/v3/bases/${b.id}/forms/${f.id}`, { mode: 'accounts' });
    db.prepare("UPDATE settings SET value = '{\"enabled\":false}' WHERE key = 'base_forms'").run();
    res = await call(b.ed, 'PATCH', `/api/v3/bases/${b.id}/forms/${f.id}`, { mode: 'anonymous' });
    expect(res.statusCode).toBe(403);
    // Une autre modification reste possible et ne révoque rien.
    expect((await call(b.ed, 'PATCH', `/api/v3/bases/${b.id}/forms/${f.id}`, { title: 'G' })).statusCode).toBe(200);
  });

  it('compte qui a créé le lien désactivé : lien révoqué', async () => {
    const f = await anonymousForm();
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed1'").run();
    expect((await view(f.token)).statusCode).toBe(404);
    expect(db.prepare('SELECT token_hash, title FROM base_forms WHERE id = ?').get(f.fid)).toEqual({ token_hash: null, title: 'Signaler' });
  });

  it('jamais dans les journaux', () => {
    expect(maskShareToken('/form/abcdefghijklmnopqrstuvwxyzABCDEF')).toBe('/form/[jeton]');
    expect(maskShareToken('/api/v3/public/forms/abcdefghijklmnopqrstuvwxyzABCDEF')).toBe('/api/v3/public/forms/[jeton]');
    expect(maskShareToken('/api/v3/bases/b1/forms/f1')).toBe('/api/v3/bases/b1/forms/f1');
  });
});

describe('anti-robot et plafonds', () => {
  it('champ piège : même réponse qu’un succès, rien n’est écrit', async () => {
    const f = await anonymousForm();
    const res = await submit(f.token, { answers: { [f.nom]: 'spam' }, ticket: oldTicket(f.fid), website: 'http://spam.example' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ thanks: 'Merci !' });
    expect(rowsOf(f.id)).toHaveLength(0);
  });

  it('ticket : trop rapide, falsifié, d’un autre formulaire, rejoué, expiré', async () => {
    const f = await anonymousForm();
    const fresh = (await view(f.token)).json().ticket as string;
    let res = await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: fresh });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('too_fast');
    const t = oldTicket(f.fid);
    const forged = `${t.slice(0, -2)}${t.endsWith('AA') ? 'BB' : 'AA'}`;
    res = await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: forged });
    expect(res.json().reason).toBe('ticket');
    // Signé avec une autre clé.
    const row = db.prepare('SELECT id, token_hash FROM base_forms WHERE id = ?').get(f.fid) as { id: string; token_hash: string };
    res = await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: new FormTickets(randomBytes(32).toString('base64')).issue(row, Date.now() - 10_000) });
    expect(res.json().reason).toBe('ticket');
    // Expiré.
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid, 3 * 3_600_000) })).json().reason).toBe('ticket');
    expect(rowsOf(f.id)).toHaveLength(0);
    // Rejoué après succès.
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: t })).statusCode).toBe(201);
    expect((await submit(f.token, { answers: { [f.nom]: 'y' }, ticket: t })).json().reason).toBe('ticket');
    expect(rowsOf(f.id)).toHaveLength(1);
  });

  it('ticket d’un lien renouvelé : refusé', async () => {
    const f = await anonymousForm();
    const t = oldTicket(f.fid);
    const t2 = await linkOf(f.ed, f.id, f.fid);
    expect((await submit(t2, { answers: { [f.nom]: 'x' }, ticket: t })).json().reason).toBe('ticket');
  });

  it(`débit : au plus ${SUBMIT_PER_MINUTE} envois par minute et par adresse, tous formulaires confondus`, async () => {
    const f = await anonymousForm();
    const codes: number[] = [];
    for (let i = 0; i <= SUBMIT_PER_MINUTE; i++) codes.push((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: 'mauvais' }, null, '192.0.2.7')).statusCode);
    expect(codes.slice(0, SUBMIT_PER_MINUTE).every((c) => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // Une autre adresse n'est pas bloquée ; la même adresse sur un autre formulaire, ou avec un jeton inventé, l'est.
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: 'mauvais' }, null, '192.0.2.8')).statusCode).toBe(400);
    const other = await newForm(f.ed, f.id, { title: 'Autre', mode: 'anonymous', questions: [{ propertyId: f.nom }] });
    const t2 = await linkOf(f.ed, f.id, other.id);
    expect((await submit(t2, { answers: { [f.nom]: 'x' }, ticket: 'mauvais' }, null, '192.0.2.7')).statusCode).toBe(429);
    expect((await submit('B'.repeat(32), { answers: {}, ticket: 'mauvais' }, null, '192.0.2.7')).statusCode).toBe(429);
  });

  it('débit en IPv6 : par préfixe /64', async () => {
    const f = await anonymousForm();
    for (let i = 1; i <= SUBMIT_PER_MINUTE; i++) expect((await submit(f.token, { answers: {}, ticket: 'mauvais' }, null, `2001:db8:1:2::${i}`)).statusCode).toBe(400);
    expect((await submit(f.token, { answers: {}, ticket: 'mauvais' }, null, '2001:db8:1:2:ffff:1:2:3')).statusCode).toBe(429);
    expect((await submit(f.token, { answers: {}, ticket: 'mauvais' }, null, '2001:db8:1:3::1')).statusCode).toBe(400);
  });

  it('clé de débit d’une adresse', () => {
    expect(ipRateKey('192.0.2.1')).toBe('192.0.2.1');
    expect(ipRateKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipRateKey('2001:0DB8:0001:0002:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipRateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipRateKey('2001:db8:1:2::')).toBe('2001:db8:1:2::/64');
    expect(ipRateKey('::1')).toBe('0:0:0:0::/64');
    expect(ipRateKey('::1:2:3:4:5:192.0.2.1')).toBe('0:1:2:3::/64');
    expect(ipRateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it(`plafond horaire par base : ${MAX_BASE_RESPONSES_PER_HOUR} réponses pour tous ses formulaires`, async () => {
    const f = await anonymousForm();
    const other = await newForm(f.ed, f.id, { title: 'Autre', mode: 'anonymous', questions: [{ propertyId: f.nom }] });
    const t2 = await linkOf(f.ed, f.id, other.id);
    db.prepare('UPDATE base_forms SET hour_start = ?, hour_count = ? WHERE id = ?').run(Date.now(), MAX_BASE_RESPONSES_PER_HOUR - 10, f.fid);
    db.prepare('UPDATE base_forms SET hour_start = ?, hour_count = ? WHERE id = ?').run(Date.now(), 10, other.id);
    const res = await submit(t2, { answers: { [f.nom]: 'x' }, ticket: oldTicket(other.id) });
    expect(res.statusCode).toBe(429);
    expect(res.json().reason).toBe('quota');
    // Fenêtre du premier formulaire passée : de nouveau accepté.
    db.prepare('UPDATE base_forms SET hour_start = ? WHERE id = ?').run(Date.now() - 3_600_001, f.fid);
    expect((await submit(t2, { answers: { [f.nom]: 'x' }, ticket: oldTicket(other.id) })).statusCode).toBe(201);
  });

  it('plafond horaire par formulaire', async () => {
    const f = await anonymousForm();
    db.prepare('UPDATE base_forms SET hour_start = ?, hour_count = ? WHERE id = ?').run(Date.now(), MAX_RESPONSES_PER_HOUR, f.fid);
    const res = await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) });
    expect(res.statusCode).toBe(429);
    expect(res.json().reason).toBe('quota');
    expect(rowsOf(f.id)).toHaveLength(0);
    // Fenêtre passée : de nouveau accepté.
    db.prepare('UPDATE base_forms SET hour_start = ? WHERE id = ?').run(Date.now() - 3_600_001, f.fid);
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
  });

  it('taille : corps trop gros (413), valeur trop longue, texte au-delà du plafond de la colonne', async () => {
    const f = await anonymousForm();
    expect((await submit(f.token, { answers: { [f.nom]: 'x'.repeat(40_000) }, ticket: oldTicket(f.fid) })).statusCode).toBe(413);
    let res = await submit(f.token, { answers: { [f.nom]: 'x'.repeat(5000) }, ticket: oldTicket(f.fid) });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('too_large');
    res = await submit(f.token, { answers: { [f.nom]: 'x'.repeat(2500) }, ticket: oldTicket(f.fid) });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('invalid');
    expect(rowsOf(f.id)).toHaveLength(0);
  });

  it('place gardée aux membres : plus de réponse au-delà de 80 % des lignes ou de la taille de la base', async () => {
    const f = await anonymousForm();
    const ins = db.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)");
    db.transaction(() => { for (let i = 0; i < Math.floor(MAX_ROWS * FORM_ROOM_RATIO); i++) ins.run(`r${i}`, f.id, i); })();
    const res = await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('full');
    // Un membre écrit encore.
    expect((await call(f.ed, 'POST', `/api/v3/bases/${f.id}/rows`, { values: { [f.nom]: 'membre' } })).statusCode).toBe(201);
    // Taille : quelques grosses lignes au-delà de 80 % de la taille maximale.
    db.prepare('DELETE FROM base_rows WHERE base_id = ?').run(f.id);
    const big = JSON.stringify({ x: 'y'.repeat(1_000_000) });
    db.transaction(() => { for (let i = 0; i < 8; i++) db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)').run(`g${i}`, f.id, i, big); })();
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).json().reason).toBe('full');
    expect((await call(f.ed, 'POST', `/api/v3/bases/${f.id}/rows`, { values: { [f.nom]: 'membre' } })).statusCode).toBe(201);
  });
});

describe('validation des réponses', () => {
  it('option inconnue, question non exposée, clé injectée, obligatoire manquante, type invalide', async () => {
    const f = await anonymousForm();
    const t = () => oldTicket(f.fid);
    let res = await submit(f.token, { answers: { [f.nom]: 'x', [f.prio.id]: 'ffffffffff' }, ticket: t() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'invalid', questionId: f.prio.id });
    // Le message ne nomme que le libellé de la question, jamais la colonne.
    res = await submit(f.token, { answers: { [f.nom]: 42 }, ticket: t() });
    expect(res.json()).toMatchObject({ reason: 'invalid', questionId: f.nom });
    expect(res.json().detail).toContain('Votre demande');
    expect(res.body).not.toContain('Nom');
    // Colonne existante mais non exposée.
    res = await submit(f.token, { answers: { [f.nom]: 'x', [f.secret.id]: 'injecté' }, ticket: t() });
    expect(res.json().reason).toBe('unknown_question');
    res = await submit(f.token, { answers: { [f.nom]: 'x', constructor: 'y' }, ticket: t() });
    expect(res.json().reason).toBe('unknown_question');
    // Clé hors schéma, clé __proto__ (refusée par l'analyseur JSON).
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: t(), createdBy: 'admin' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v3/public/forms/${f.token}`, headers: { 'content-type': 'application/json' }, payload: `{"answers":{"__proto__":{"x":1}},"ticket":"${t()}"}` })).statusCode).toBe(400);
    res = await submit(f.token, { answers: { [f.prio.id]: f.prio.options[0]!.id }, ticket: t() });
    expect(res.json()).toMatchObject({ reason: 'required', questionId: f.nom });
    res = await submit(f.token, { answers: { [f.nom]: '   ' }, ticket: t() });
    expect(res.json().reason).toBe('required');
    expect(rowsOf(f.id)).toHaveLength(0);
  });

  it('question dont la colonne a disparu : retirée du formulaire ; plus aucune question : formulaire fermé', async () => {
    const f = await anonymousForm();
    expect((await call(f.ed, 'DELETE', `/api/v3/bases/${f.id}/properties/${f.prio.id}`)).statusCode).toBe(204);
    expect((await view(f.token)).json().form.questions.map((q: { id: string }) => q.id)).toEqual([f.nom]);
    expect((await submit(f.token, { answers: { [f.prio.id]: 'x', [f.nom]: 'y' }, ticket: oldTicket(f.fid) })).json().reason).toBe('unknown_question');
  });
});

describe('base restreinte', () => {
  it('confirmation exigée ; une restriction changée ferme le formulaire', async () => {
    await enable();
    const b = await demandes();
    const admin = await login('admin');
    expect((await call(admin, 'PUT', `/api/v3/pages/${b.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    const res = await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms`, { title: 'F', mode: 'anonymous', questions: [{ propertyId: b.nom }] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'restricted', code: 'restricted' });
    const f = await newForm(b.ed, b.id, { title: 'F', mode: 'anonymous', questions: [{ propertyId: b.nom }], confirmRestricted: true });
    const token = await linkOf(b.ed, b.id, f.id);
    expect((await view(token)).statusCode).toBe(200);
    expect((await submit(token, { answers: { [b.nom]: 'x' }, ticket: oldTicket(f.id) })).statusCode).toBe(201);
    // Restriction modifiée : fermé, et la gestion le signale.
    await call(admin, 'PUT', `/api/v3/pages/${b.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }, { userId: 'ed2', level: 'read' }] });
    expect((await view(token)).statusCode).toBe(404);
    expect((await call(b.ed, 'GET', `/api/v3/bases/${b.id}/forms`)).json().items[0].confirmed).toBe(false);
    expect((await call(b.ed, 'POST', `/api/v3/bases/${b.id}/forms/${f.id}/link`)).statusCode).toBe(409);
    // Un simple lecteur de la base restreinte ne gère pas ses formulaires.
    expect((await call(await login('ed2'), 'GET', `/api/v3/bases/${b.id}/forms`)).statusCode).toBe(403);
  });
});

describe('automatisations et notifications', () => {
  it('« ligne ajoutée » avec les droits de l’auteur ; personne qui déclenche vide en anonyme', async () => {
    const f = await anonymousForm();
    const etat = await addProp(f.ed, f.id, { name: 'État', type: 'text' });
    const res = await call(f.ed, 'POST', `/api/v3/bases/${f.id}/automations`, {
      name: 'Tri', trigger: { type: 'row_added' },
      actions: [{ type: 'set_property', propertyId: etat.id, value: 'reçu' }, { type: 'set_property', propertyId: f.who.id, value: { dynamic: 'actor' } }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
    const vals = JSON.parse(rowsOf(f.id)[0]!.vals) as Record<string, unknown>;
    expect(vals[etat.id]).toBe('reçu');
    expect(vals[f.who.id]).toBeUndefined();
    expect(db.prepare('SELECT status, actor_id FROM base_automation_runs').all()).toEqual([{ status: 'ok', actor_id: null }]);
  });

  it('celui qui répond ne met jamais une automatisation en pause (fréquence, échecs)', async () => {
    const f = await anonymousForm();
    const etat = await addProp(f.ed, f.id, { name: 'État', type: 'text' });
    const a = (await call(f.ed, 'POST', `/api/v3/bases/${f.id}/automations`, { name: 'Tri', trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: etat.id, value: 'reçu' }] })).json() as { id: string };
    db.prepare('UPDATE base_automations SET minute_start = ?, minute_runs = ? WHERE id = ?').run(Date.now(), MAX_RUNS_PER_MINUTE, a.id);
    expect((await submit(f.token, { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
    expect(db.prepare('SELECT status FROM base_automations WHERE id = ?').get(a.id)).toEqual({ status: 'active' });
    expect(db.prepare('SELECT status, code FROM base_automation_runs WHERE automation_id = ?').all(a.id)).toEqual([{ status: 'skipped', code: 'frequency' }]);
    // La même fréquence atteinte par un membre met en pause (comportement de P7 inchangé).
    await call(f.ed, 'POST', `/api/v3/bases/${f.id}/rows`, { values: { [f.nom]: 'membre' } });
    expect(db.prepare('SELECT status FROM base_automations WHERE id = ?').get(a.id)).toEqual({ status: 'paused' });

    // Échec d'écriture (base cible pleine) : non compté pour la pause.
    const target = (await call(f.ed, 'POST', '/api/v3/bases', { spaceId: teamSpace(), title: 'Journal' })).json() as { page: { id: string }; properties: Prop[] };
    const b2 = (await call(f.ed, 'POST', `/api/v3/bases/${f.id}/automations`, { name: 'Copie', trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: target.page.id, values: { [target.properties[0]!.id]: 'trace' } }] })).json() as { id: string };
    const ins = db.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)");
    db.transaction(() => { for (let i = 0; i < MAX_ROWS; i++) ins.run(`t${i}`, target.page.id, i); })();
    db.prepare('UPDATE base_automations SET failures = ? WHERE id = ?').run(MAX_FAILURES - 1, b2.id);
    expect((await submit(f.token, { answers: { [f.nom]: 'y' }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
    expect(db.prepare('SELECT status, failures FROM base_automations WHERE id = ?').get(b2.id)).toEqual({ status: 'active', failures: MAX_FAILURES - 1 });
    expect(db.prepare("SELECT status, code FROM base_automation_runs WHERE automation_id = ?").all(b2.id)).toEqual([{ status: 'error', code: 'write_failed' }]);
  });

  it('notification facultative au rédacteur, regroupée ; sans nom de répondant anonyme', async () => {
    const f = await anonymousForm({ notify: true });
    for (const v of ['a', 'b']) expect((await submit(f.token, { answers: { [f.nom]: v }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
    expect(db.prepare("SELECT user_id, type, actor_id, count FROM notifications WHERE type = 'form'").all()).toEqual([{ user_id: 'ed1', type: 'form', actor_id: null, count: 2 }]);
    // Mode comptes : le nom du répondant n'est pas enregistré non plus.
    db.prepare('DELETE FROM notifications').run();
    await call(f.ed, 'PATCH', `/api/v3/bases/${f.id}/forms/${f.fid}`, { mode: 'accounts' });
    const t2 = await linkOf(f.ed, f.id, f.fid);
    expect((await submit(t2, { answers: { [f.nom]: 'r' }, ticket: oldTicket(f.fid) }, await login('rd'))).statusCode).toBe(201);
    expect(db.prepare("SELECT actor_id FROM notifications WHERE type = 'form'").all()).toEqual([{ actor_id: null }]);
    const inbox = (await call(f.ed, 'GET', '/api/v3/notifications')).json() as { items: { actor: unknown }[] };
    expect(inbox.items[0]!.actor).toBeNull();
    await call(f.ed, 'PATCH', `/api/v3/bases/${f.id}/forms/${f.fid}`, { mode: 'anonymous' });
    const t3 = await linkOf(f.ed, f.id, f.fid);
    f.token = t3;
    // Sans notify : rien.
    db.prepare('DELETE FROM notifications').run();
    await call(f.ed, 'PATCH', `/api/v3/bases/${f.id}/forms/${f.fid}`, { notify: false });
    expect((await submit(f.token, { answers: { [f.nom]: 'c' }, ticket: oldTicket(f.fid) })).statusCode).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });
});

describe('journal du serveur', () => {
  it('aucune adresse IP pour les formulaires publics', async () => {
    const f = await anonymousForm();
    const logs: string[] = [];
    const logged = await buildApp({ config: loadConfig(baseEnv), db, clientDir: '/nonexistent', logger: { level: 'info', stream: { write: (s: string) => { logs.push(s); } } } });
    try {
      await logged.inject({ method: 'GET', url: `/api/v3/public/forms/${f.token}`, remoteAddress: '198.51.100.77' });
      await logged.inject({ method: 'POST', url: `/api/v3/public/forms/${f.token}`, payload: { answers: { [f.nom]: 'x' }, ticket: oldTicket(f.fid) }, remoteAddress: '198.51.100.77' });
      await logged.inject({ method: 'GET', url: '/api/v3/config', remoteAddress: '198.51.100.88' });
    } finally { await logged.close(); }
    const all = logs.join('\n');
    expect(all).toContain('/api/v3/public/forms/[jeton]');
    expect(all).not.toContain('198.51.100.77');
    expect(all).not.toContain(f.token);
    expect(all).toContain('198.51.100.88'); // les autres routes gardent l'adresse
  });
});

describe('sauvegarde', () => {
  it('les empreintes des liens ne sont pas gardées', async () => {
    const f = await anonymousForm();
    const { backupTo } = await import('../src/backup.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'nb-forms-')), 'b.db');
    await backupTo(db, file);
    const copy = new Database(file);
    expect(copy.prepare('SELECT token_hash, title FROM base_forms').all()).toEqual([{ token_hash: null, title: 'Signaler' }]);
    copy.close();
    expect((await view(f.token)).statusCode).toBe(200);
    expect(sha256(f.token)).toHaveLength(64);
  });
});

describe('migration v36', () => {
  it('depuis une base v35 avec données : notifications gardées, nouveau type accepté, espaces sans formulaires', () => {
    const file = oldDb(35, (raw) => {
      raw.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, kind) VALUES ('b1', 's1', 'Base', '{}', '', 0, 0, 'base')").run();
      raw.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES ('r1', 'b1', 0, '{}', 0, 0)").run();
      raw.prepare("INSERT INTO notifications (id, user_id, type, page_id, actor_id, created_at, emailed_at) VALUES ('n1', 'u1', 'automation', 'b1', 'u1', 5, 9), ('n2', 'u1', 'mention', 'p1', 'u1', 6, NULL)").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    // L'auteur d'une notification d'automatisation est effacé ; les autres sont gardés.
    expect(up.prepare('SELECT id, type, actor_id, emailed_at FROM notifications ORDER BY id').all()).toEqual([{ id: 'n1', type: 'automation', actor_id: null, emailed_at: 9 }, { id: 'n2', type: 'mention', actor_id: 'u1', emailed_at: null }]);
    up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n3', 'u1', 'form', 'b1', 7)").run();
    expect(() => up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n4', 'u1', 'inconnu', 'b1', 7)").run()).toThrow();
    expect(up.prepare("SELECT forms_enabled FROM spaces WHERE id = 's1'").get()).toEqual({ forms_enabled: 0 });
    up.prepare("INSERT INTO base_forms (id, base_id, title, questions, created_at, updated_at) VALUES ('f1', 'b1', 'F', '[]', 0, 0)").run();
    expect(up.prepare("SELECT mode, notify, token_hash FROM base_forms WHERE id = 'f1'").get()).toEqual({ mode: 'accounts', notify: 0, token_hash: null });
    expect(() => up.prepare("INSERT INTO base_forms (id, base_id, title, questions, mode, created_at, updated_at) VALUES ('f2', 'b1', 'F', '[]', 'public', 0, 0)").run()).toThrow();
    expect(up.pragma('foreign_key_check')).toEqual([]);
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
