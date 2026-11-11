// Bases (P7) : automatisations et boutons de ligne. Cas permis et cas refusés : boucle, droits retirés, plafonds, SSRF, fuites.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import {
  MAX_AUTOMATIONS, MAX_DUE_PER_AUTHOR_PER_TICK, MAX_FAILURES, MAX_RECURRENCES_PER_AUTHOR, MAX_ROWS_TOUCHED, MAX_RUNS_PER_MINUTE, nextOccurrence,
} from '../src/lib/base-automations.js';
import { MAX_ROWS } from '../src/lib/bases.js';
import { type Mail, Mailer } from '../src/lib/mail.js';
import { sign } from '../src/lib/webhooks.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const baseEnv = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let srv: Server | null = null;
let mailer: FakeMailer;

class FakeMailer extends Mailer {
  sent: Mail[] = [];
  constructor() { super(() => { throw new Error('inutilisé'); }); }
  override get enabled() { return true; }
  override async send(mail: Mail) { this.sent.push(mail); }
}
const sessions = new Map<string, S>();

async function boot(extra: Record<string, string> = {}) {
  sessions.clear();
  db = openDb(':memory:');
  seedDemo(db);
  mailer = new FakeMailer();
  app = await buildApp({ config: loadConfig({ ...baseEnv, ...extra }), db, clientDir: '/nonexistent', mailer });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
}
beforeEach(async () => { await boot(); });
afterEach(async () => {
  await app.close();
  db.close();
  if (srv) { await new Promise<void>((r) => srv!.close(() => r())); srv = null; }
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

interface Prop { id: string; options: { id: string; name: string }[] }
interface Row { id: string; values: Record<string, unknown> }
async function newBase(s: S, title = 'Projet') {
  const res = await call(s, 'POST', '/api/v3/bases', { spaceId: teamSpace(), title });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json() as { page: { id: string }; properties: Prop[] };
  return { id: b.page.id, nom: b.properties[0]!.id };
}
const addProp = async (s: S, base: string, body: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Prop;
};
const addRow = async (s: S, base: string, values: object = {}) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/rows`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Row;
};
const patchRow = async (s: S, base: string, row: string, values: object) => {
  const res = await call(s, 'PATCH', `/api/v3/bases/${base}/rows/${row}`, { values });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Row;
};
const rowOf = async (s: S, base: string, id: string) => ((await call(s, 'GET', `/api/v3/bases/${base}`)).json() as { rows: Row[] }).rows.find((r) => r.id === id)!;
interface Auto { id: string; status: string; statusReason: string | null; enabled: boolean; author: { id: string } | null; actions: Record<string, unknown>[]; masked: boolean; webhookSecret?: string; nextRunAt: number | null }
const create = async (s: S, base: string, body: object, status = 201) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/automations`, { name: 'Auto', ...body });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as Auto;
};
const autoOf = (id: string) => db.prepare('SELECT * FROM base_automations WHERE id = ?').get(id) as { status: string; status_reason: string | null; author_id: string | null; failures: number; webhook_url: string | null; webhook_secret: string | null; next_run_at: number | null };
const runs = (id: string) => db.prepare('SELECT status, code, rows FROM base_automation_runs WHERE automation_id = ? ORDER BY id').all(id) as { status: string; code: string; rows: number }[];
const restrict = async (page: string, entries: { userId: string; level: 'read' | 'write' }[]) =>
  expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${page}/permissions`, { entries })).statusCode).toBe(200);
const enableWebhooks = async () => expect((await call(await login('admin'), 'PUT', '/api/v3/admin/automations', { webhooks: true })).statusCode).toBe(200);

async function collector(status = 200) {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = status; res.end('ok'); });
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/hook`, received };
}

describe('déclencheurs et actions', () => {
  it('ligne ajoutée : modifie une propriété, avec la date du jour et la personne qui déclenche ; la réponse inclut le résultat', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const date = (await addProp(ed, b.id, { name: 'Créée', type: 'date' })).id;
    const who = (await addProp(ed, b.id, { name: 'Qui', type: 'person' })).id;
    await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: date, value: { dynamic: 'today' } }, { type: 'set_property', propertyId: who, value: { dynamic: 'actor' } }] });
    const row = await addRow(await login('ed2'), b.id, { [b.nom]: 'A' });
    expect(row.values[date]).toBe(new Date().toISOString().slice(0, 10));
    expect(row.values[who]).toEqual({ id: 'ed2', name: 'Nom ed2' });
  });

  it('propriété modifiée avec filtre : ne se déclenche que si la colonne change et que la ligne passe le filtre', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const st = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const done = st.options.at(-1)!.id;
    const fin = (await addProp(ed, b.id, { name: 'Fini le', type: 'date' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'property_changed', propertyId: st.id, filters: [{ propertyId: st.id, op: 'eq', value: done }] }, actions: [{ type: 'set_property', propertyId: fin, value: '2026-01-02' }] });
    const row = await addRow(ed, b.id, { [b.nom]: 'A' });
    expect((await patchRow(ed, b.id, row.id, { [b.nom]: 'B' })).values[fin]).toBeUndefined();
    expect((await patchRow(ed, b.id, row.id, { [st.id]: st.options[1]!.id })).values[fin]).toBeUndefined();
    expect((await patchRow(ed, b.id, row.id, { [st.id]: done })).values[fin]).toBe('2026-01-02');
    expect(runs(a.id)).toEqual([{ status: 'ok', code: 'ok', rows: 1 }]);
  });

  it('ajouter une ligne dans une autre base modifiable par l’auteur ; notifier des personnes nommées et la colonne Personne', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const log = await newBase(ed, 'Journal');
    const who = (await addProp(ed, b.id, { name: 'Responsable', type: 'person' })).id;
    await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [
      { type: 'add_row', baseId: log.id, values: { [log.nom]: 'Nouvelle tâche' } },
      { type: 'notify', userIds: ['ed1'], propertyId: who },
    ] });
    await addRow(ed, b.id, { [b.nom]: 'A', [who]: 'ed2' });
    const logRows = ((await call(ed, 'GET', `/api/v3/bases/${log.id}`)).json() as { rows: Row[] }).rows;
    expect(logRows.map((r) => r.values[log.nom])).toEqual(['Nouvelle tâche']);
    const notes = db.prepare("SELECT user_id, page_id, actor_id FROM notifications WHERE type = 'automation' ORDER BY user_id").all();
    // L'auteur qui se notifie lui-même reçoit la notification (allowSelf) ; la personne de la colonne aussi.
    // Aucun auteur enregistré pour une notification d'automatisation (le nom de la personne qui déclenche ne sort pas).
    expect(notes).toEqual([{ user_id: 'ed1', page_id: b.id, actor_id: null }, { user_id: 'ed2', page_id: b.id, actor_id: null }]);
  });

  it('une personne qui ne lit pas la base n’est ni acceptée comme destinataire ni notifiée', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    await restrict(b.id, [{ userId: 'ed1', level: 'write' }]);
    const res = await call(ed, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'N', trigger: { type: 'row_added' }, actions: [{ type: 'notify', userIds: ['ed2'] }] });
    expect(res.statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'N', trigger: { type: 'row_added' }, actions: [{ type: 'notify', userIds: ['inconnu'] }] })).json().detail)
      .toBe(res.json().detail);
    const who = (await addProp(ed, b.id, { name: 'Qui', type: 'person' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'property_changed', propertyId: b.nom }, actions: [{ type: 'notify', propertyId: who }] });
    // Cellule écrite quand ed2 lisait encore la base (simulée) : il ne la lit plus, il ne reçoit rien.
    db.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES ('r-old', ?, 0, ?, 0, 0)").run(b.id, JSON.stringify({ [who]: 'ed2' }));
    await patchRow(ed, b.id, 'r-old', { [b.nom]: 'x' });
    expect(runs(a.id)).toEqual([{ status: 'ok', code: 'ok', rows: 0 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'ed2'").get()).toEqual({ n: 0 });
  });
});

describe('aucune chaîne d’automatisations', () => {
  it('une écriture d’automatisation ne déclenche jamais une autre automatisation (ni elle-même)', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const st = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: st.id, value: st.options[1]!.id }, { type: 'add_row', values: { [b.nom]: 'copie' } }] });
    const c = await create(ed, b.id, { trigger: { type: 'property_changed', propertyId: st.id }, actions: [{ type: 'set_property', propertyId: note, value: 'chaîne' }] });
    const row = await addRow(ed, b.id, { [b.nom]: 'A' });
    expect(row.values[st.id]).toBe(st.options[1]!.id);
    expect(row.values[note]).toBeUndefined();
    // Une seule ligne ajoutée par l'automatisation (elle ne s'est pas redéclenchée sur sa propre ligne).
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(b.id) as { n: number }).n).toBe(2);
    expect(runs(a.id)).toHaveLength(1);
    expect(runs(c.id)).toHaveLength(0);
    // Une personne qui modifie le statut déclenche bien la seconde.
    expect((await patchRow(ed, b.id, row.id, { [st.id]: st.options[2]!.id })).values[note]).toBe('chaîne');
  });

  it('un bouton n’enchaîne pas non plus', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const flag = (await addProp(ed, b.id, { name: 'Ok', type: 'checkbox' })).id;
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    const btn = await create(ed, b.id, { trigger: { type: 'button', label: 'Valider' }, actions: [{ type: 'set_property', propertyId: flag, value: true }] });
    const c = await create(ed, b.id, { trigger: { type: 'property_changed', propertyId: flag }, actions: [{ type: 'set_property', propertyId: note, value: 'x' }] });
    const row = await addRow(ed, b.id);
    const res = await call(ed, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().row.values[flag]).toBe(true);
    expect(res.json().row.values[note]).toBeUndefined();
    expect(runs(c.id)).toHaveLength(0);
  });
});

describe('droits de l’auteur', () => {
  it('auteur désactivé, accès perdu ou rôle réduit : automatisation suspendue, rien n’est écrit', async () => {
    const ed = await login('ed1');
    const ed2 = await login('ed2');
    const b = await newBase(ed);
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    const mk = async () => (await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: note, value: 'auto' }] })).id;

    const a1 = await mk();
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed1'").run();
    expect(autoOf(a1)).toMatchObject({ status: 'suspended', status_reason: 'author' });
    expect((await addRow(ed2, b.id)).values[note]).toBeUndefined();
    db.prepare("UPDATE users SET disabled = 0 WHERE id = 'ed1'").run();
    await call(ed, 'DELETE', `/api/v3/bases/${b.id}/automations/${a1}`);

    const a2 = await mk();
    await restrict(b.id, [{ userId: 'ed2', level: 'write' }]);
    expect((await addRow(ed2, b.id)).values[note]).toBeUndefined();
    expect(autoOf(a2)).toMatchObject({ status: 'suspended', status_reason: 'access' });
    expect(runs(a2).at(-1)).toMatchObject({ status: 'skipped', code: 'access' });
    db.prepare('DELETE FROM page_acl WHERE page_id = ?').run(b.id);
    db.prepare('DELETE FROM base_automations').run();

    const a3 = await mk();
    db.prepare("UPDATE users SET role = 'reader' WHERE id = 'ed1'").run();
    expect((await addRow(ed2, b.id)).values[note]).toBeUndefined();
    expect(autoOf(a3)).toMatchObject({ status: 'suspended', status_reason: 'access' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'base.automation.suspended'").get()).toEqual({ n: 2 });
  });

  it('jamais plus que l’auteur : base cible illisible refusée ; reprendre l’automatisation d’un administrateur revalide avec ses propres droits', async () => {
    const admin = await login('admin');
    const ed = await login('ed1');
    const b = await newBase(ed);
    const secret = await newBase(admin, 'Secret');
    await restrict(secret.id, [{ userId: 'admin', level: 'write' }]);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'X', trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: secret.id, values: {} }] })).statusCode).toBe(404);
    // Lecture seule sur la cible : 403.
    await restrict(secret.id, [{ userId: 'admin', level: 'write' }, { userId: 'ed1', level: 'read' }]);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'X', trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: secret.id, values: {} }] })).statusCode).toBe(403);
    await restrict(secret.id, [{ userId: 'admin', level: 'write' }]);

    const a = await create(admin, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: secret.id, values: { [secret.nom]: 'confidentiel' } }] });
    // ed1 voit l'automatisation, l'action est masquée (ni identifiant ni valeurs de la base qu'il ne lit pas).
    const listed = (await call(ed, 'GET', `/api/v3/bases/${b.id}/automations`)).json() as { items: Auto[] };
    expect(listed.items[0]!.masked).toBe(true);
    expect(listed.items[0]!.actions[0]).toEqual({ type: 'add_row', baseId: null, values: {} });
    expect(JSON.stringify(listed)).not.toContain(secret.id);
    expect(JSON.stringify(listed)).not.toContain('confidentiel');
    // Réactiver ou changer le déclencheur : revalidé avec SES droits, refusé.
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { trigger: { type: 'row_added', filters: [] } })).statusCode).toBe(404);
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { enabled: true })).statusCode).toBe(404);
    expect(autoOf(a.id).author_id).toBe('admin');
    // Renommer ou désactiver : permis, l'auteur ne change pas.
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { name: 'Renommée', enabled: false })).statusCode).toBe(200);
    expect(autoOf(a.id).author_id).toBe('admin');
    // ed2 la redéfinit avec des actions qu'il peut faire : il en devient l'auteur.
    const ed2 = await login('ed2');
    const res = await call(ed2, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { enabled: true, actions: [{ type: 'add_row', values: {} }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().author).toEqual({ id: 'ed2', name: 'Nom ed2' });
  });

  it('lecteur : ni liste, ni création, ni clic, ni bouton affiché', async () => {
    const ed = await login('ed1');
    const rd = await login('rd');
    const b = await newBase(ed);
    const btn = await create(ed, b.id, { trigger: { type: 'button', label: 'Valider' }, actions: [{ type: 'add_row', values: {} }] });
    const row = await addRow(ed, b.id);
    expect((await call(rd, 'GET', `/api/v3/bases/${b.id}/automations`)).statusCode).toBe(403);
    expect((await call(rd, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'X', trigger: { type: 'row_added' }, actions: [{ type: 'add_row', values: {} }] })).statusCode).toBe(403);
    expect((await call(rd, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id })).statusCode).toBe(403);
    expect((await call(rd, 'GET', `/api/v3/bases/${b.id}`)).json().buttons).toEqual([]);
    expect((await call(ed, 'GET', `/api/v3/bases/${b.id}`)).json().buttons).toEqual([{ id: btn.id, label: 'Valider' }]);
    expect((await call(null, 'GET', `/api/v3/bases/${b.id}/automations`)).statusCode).toBe(401);
  });

  it('bouton : droits de la personne qui clique, jamais ceux de l’auteur', async () => {
    const admin = await login('admin');
    const ed = await login('ed1');
    const b = await newBase(ed);
    const secret = await newBase(admin, 'Secret');
    await restrict(secret.id, [{ userId: 'admin', level: 'write' }]);
    const btn = await create(admin, b.id, { trigger: { type: 'button', label: 'Copier' }, actions: [{ type: 'add_row', baseId: secret.id, values: {} }] });
    const row = await addRow(ed, b.id);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id })).statusCode).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(secret.id) as { n: number }).n).toBe(0);
    // Le bouton n'est pas suspendu pour autant : l'administrateur peut toujours s'en servir.
    expect(autoOf(btn.id).status).toBe('active');
    expect((await call(admin, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id })).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(secret.id) as { n: number }).n).toBe(1);
    // Ligne d'une autre base : 404.
    const other = await newBase(ed, 'Autre');
    const foreign = await addRow(ed, other.id);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: foreign.id })).statusCode).toBe(404);
  });
});

describe('coupe-circuits et plafonds', () => {
  it('fréquence : au-delà de N exécutions par minute, mise en pause', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: note, value: 'x' }] });
    for (let i = 0; i < MAX_RUNS_PER_MINUTE; i++) expect((await addRow(ed, b.id)).values[note]).toBe('x');
    expect((await addRow(ed, b.id)).values[note]).toBeUndefined();
    expect(autoOf(a.id)).toMatchObject({ status: 'paused', status_reason: 'frequency' });
    expect((await addRow(ed, b.id)).values[note]).toBeUndefined();
    // Réactiver remet l'automatisation en marche.
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { enabled: true })).json().status).toBe('active');
  });

  it('erreurs répétées : pause après MAX_FAILURES échecs du webhook', async () => {
    await app.close(); db.close();
    await boot({ WEBHOOK_ALLOW_PRIVATE: 'true' });
    await enableWebhooks();
    const { url, received } = await collector(500);
    const ed = await login('ed1');
    const b = await newBase(ed);
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'webhook', url }] });
    for (let i = 0; i < MAX_FAILURES + 2; i++) { await addRow(ed, b.id); await app.automations.idle(); }
    expect(received).toHaveLength(MAX_FAILURES);
    expect(autoOf(a.id)).toMatchObject({ status: 'paused', status_reason: 'errors' });
    expect(runs(a.id).filter((r) => r.code === 'webhook_failed')).toHaveLength(MAX_FAILURES);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'base.automation.paused'").get()).toEqual({ n: 1 });
  });

  it('plafonds : automatisations par base, actions, destinataires, filtres ; entrées strictes', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const body = { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', values: {} }] };
    for (let i = 0; i < MAX_AUTOMATIONS; i++) await create(ed, b.id, body);
    await create(ed, b.id, body, 409);
    db.prepare('DELETE FROM base_automations').run();
    await create(ed, b.id, { ...body, actions: Array.from({ length: 6 }, () => ({ type: 'add_row', values: {} })) }, 400);
    await create(ed, b.id, { ...body, actions: [{ type: 'notify', userIds: Array.from({ length: 21 }, (_, i) => `u${i}`) }] }, 400);
    await create(ed, b.id, { trigger: { type: 'row_added', filters: Array.from({ length: 6 }, () => ({ propertyId: b.nom, op: 'empty' })) }, actions: body.actions }, 400);
    // Opérateur inconnu, champ en trop, déclencheur inconnu, expression : refusés.
    await create(ed, b.id, { trigger: { type: 'row_added', filters: [{ propertyId: b.nom, op: 'regex', value: '.*' }] }, actions: body.actions }, 400);
    await create(ed, b.id, { ...body, extra: 1 }, 400);
    await create(ed, b.id, { trigger: { type: 'page_viewed' }, actions: body.actions }, 400);
    await create(ed, b.id, { ...body, actions: [{ type: 'set_property', propertyId: b.nom, value: 'x', formula: 'prop("Nom")' }] }, 400);
    // Colonne calculée ou inconnue, valeur invalide pour le type, valeur dynamique sur le mauvais type.
    const f = (await addProp(ed, b.id, { name: 'F', type: 'formula', formula: '1' })).id;
    await create(ed, b.id, { ...body, actions: [{ type: 'set_property', propertyId: f, value: 1 }] }, 400);
    const n = (await addProp(ed, b.id, { name: 'N', type: 'number' })).id;
    await create(ed, b.id, { ...body, actions: [{ type: 'set_property', propertyId: n, value: 'abc' }] }, 400);
    await create(ed, b.id, { ...body, actions: [{ type: 'set_property', propertyId: n, value: { dynamic: 'today' } }] }, 400);
    await create(ed, b.id, { trigger: { type: 'recurrence', every: 'day', timeZone: 'Mars/Olympus' }, actions: body.actions }, 400);
  });

  it('récurrence : lignes touchées plafonnées par exécution', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const flag = (await addProp(ed, b.id, { name: 'Ok', type: 'checkbox' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'recurrence', every: 'hour' }, actions: [{ type: 'set_property', propertyId: flag, value: true }] });
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < MAX_ROWS_TOUCHED + 20; i++) ins.run(`r${i}`, b.id, i, '{}', 0, 0);
    db.prepare('UPDATE base_automations SET next_run_at = 1 WHERE id = ?').run(a.id);
    expect(app.automations.runDue()).toBe(1);
    expect(runs(a.id)).toEqual([{ status: 'ok', code: 'truncated', rows: MAX_ROWS_TOUCHED }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ? AND json_extract(vals, '$.' || ?) = 1").get(b.id, flag) as { n: number }).n).toBe(MAX_ROWS_TOUCHED);
    // Échéance suivante posée dans le futur : pas de seconde exécution immédiate.
    expect(autoOf(a.id).next_run_at!).toBeGreaterThan(Date.now());
    expect(app.automations.runDue()).toBe(0);
  });
});

describe('récurrence', () => {
  it('prochaine échéance selon le fuseau horaire (heure d’été comprise)', () => {
    const at = (iso: string) => Date.parse(iso);
    const t = { type: 'recurrence' as const, every: 'day' as const, hour: 8, weekday: 1, day: 1, timeZone: 'Europe/Paris', filters: [] };
    expect(new Date(nextOccurrence(t, at('2026-01-15T10:00:00Z'))).toISOString()).toBe('2026-01-16T07:00:00.000Z');
    expect(new Date(nextOccurrence(t, at('2026-07-15T05:00:00Z'))).toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(new Date(nextOccurrence({ ...t, every: 'week', weekday: 1 }, at('2026-11-11T12:00:00Z'))).toISOString()).toBe('2026-11-16T07:00:00.000Z');
    expect(new Date(nextOccurrence({ ...t, every: 'month', day: 3 }, at('2026-11-11T12:00:00Z'))).toISOString()).toBe('2026-12-03T07:00:00.000Z');
    expect(new Date(nextOccurrence({ ...t, every: 'hour', timeZone: 'UTC' }, at('2026-11-11T12:20:00Z'))).toISOString()).toBe('2026-11-11T13:00:00.000Z');
  });

  it('exécute les échéances avec filtre « aujourd’hui » et ajoute une ligne', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const due = (await addProp(ed, b.id, { name: 'Échéance', type: 'date' })).id;
    const late = (await addProp(ed, b.id, { name: 'En retard', type: 'checkbox' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'recurrence', every: 'day', hour: 6, timeZone: 'Europe/Paris', filters: [{ propertyId: due, op: 'lt', value: { dynamic: 'today' } }] }, actions: [{ type: 'set_property', propertyId: late, value: true }, { type: 'add_row', values: { [b.nom]: 'Point du jour' } }] });
    expect(a.nextRunAt).toBeGreaterThan(Date.now());
    const old = await addRow(ed, b.id, { [due]: '2020-01-01' });
    const fresh = await addRow(ed, b.id, { [due]: '2999-01-01' });
    db.prepare('UPDATE base_automations SET next_run_at = 1 WHERE id = ?').run(a.id);
    app.automations.runDue();
    expect((await rowOf(ed, b.id, old.id)).values[late]).toBe(true);
    expect((await rowOf(ed, b.id, fresh.id)).values[late]).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(b.id) as { n: number }).n).toBe(3);
  });
});

describe('webhook', () => {
  it('désactivé par défaut, interdit en espace personnel, garde réseau (SSRF), secret jamais relu', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const body = (url: string) => ({ trigger: { type: 'row_added' }, actions: [{ type: 'webhook', url }] });
    await create(ed, b.id, body('https://example.com/h'), 403);
    expect((await call(ed, 'PUT', '/api/v3/admin/automations', { webhooks: true })).statusCode).toBe(403);
    await enableWebhooks();
    for (const url of ['https://127.0.0.1/h', 'https://[::1]/h', 'https://169.254.169.254/latest', 'http://example.com/h', 'https://u:p@example.com/h', 'file:///etc/passwd']) {
      await create(ed, b.id, body(url), 400);
    }
    // Espace personnel : rien ne sort.
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/personal-spaces', { enabled: true })).statusCode).toBe(200);
    const personal = (await call(ed, 'POST', '/api/v3/spaces/personal')).json() as { id: string };
    const pb = (await call(ed, 'POST', '/api/v3/bases', { spaceId: personal.id, title: 'Perso' })).json() as { page: { id: string } };
    await create(ed, pb.page.id, body('https://93.184.215.14/h'), 403);
  });

  it('envoi signé, identifiants seulement ; adresse et secret jamais rendus ; coupé par l’administrateur sans erreur', async () => {
    await app.close(); db.close();
    await boot({ WEBHOOK_ALLOW_PRIVATE: 'true' });
    await enableWebhooks();
    const { url, received } = await collector();
    const ed = await login('ed1');
    const b = await newBase(ed);
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'webhook', url: `${url}?token=tres-secret` }] });
    expect(a.webhookSecret).toMatch(/^whsec_/);
    expect(a.actions).toEqual([{ type: 'webhook', origin: new URL(url).origin }]);
    const listed = (await call(ed, 'GET', `/api/v3/bases/${b.id}/automations`)).body;
    expect(listed).not.toContain('tres-secret');
    expect(listed).not.toContain(a.webhookSecret!);
    expect(autoOf(a.id).webhook_url).not.toContain('tres-secret');
    expect(autoOf(a.id).webhook_secret).not.toContain(a.webhookSecret!);
    expect(JSON.stringify(db.prepare('SELECT meta FROM audit_log').all())).not.toContain('tres-secret');
    const row = await addRow(ed, b.id, { [b.nom]: 'contenu privé de la ligne' });
    await app.automations.idle();
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.body).not.toContain('contenu privé');
    expect(JSON.parse(got.body)).toMatchObject({ event: 'base.automation', data: { automationId: a.id, baseId: b.id, trigger: 'row_added', rowIds: [row.id] } });
    const ts = got.headers['x-notabene-timestamp'] as string;
    expect(got.headers['x-notabene-signature']).toBe(`sha256=${sign(a.webhookSecret!, ts, got.body)}`);
    // Modifier les actions sans nouvelle adresse garde l'adresse et le secret ; le secret n'est pas renvoyé.
    const kept = await call(ed, 'PATCH', `/api/v3/bases/${b.id}/automations/${a.id}`, { actions: [{ type: 'webhook' }] });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().webhookSecret).toBeUndefined();
    expect(kept.json().actions).toEqual([{ type: 'webhook', origin: new URL(url).origin }]);
    const rotated = (await call(ed, 'POST', `/api/v3/bases/${b.id}/automations/${a.id}/webhook-secret`)).json().webhookSecret as string;
    expect(rotated).not.toBe(a.webhookSecret);
    // Coupé par l'administrateur : sauté (code webhook_disabled), aucun envoi, pas d'erreur comptée.
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/automations', { webhooks: false })).statusCode).toBe(200);
    await addRow(ed, b.id);
    await app.automations.idle();
    expect(received).toHaveLength(1);
    expect(runs(a.id).at(-1)).toMatchObject({ status: 'ok', code: 'webhook_disabled' });
    expect(autoOf(a.id).failures).toBe(0);
  });
});

describe('disparitions', () => {
  it('colonne supprimée : en panne (y compris depuis une autre base) ; bouton en panne refusé ; base en corbeille : sautée', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const log = await newBase(ed, 'Journal');
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    const target = (await addProp(ed, log.id, { name: 'Texte', type: 'text' })).id;
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: note, value: 'x' }] });
    const c = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: log.id, values: { [target]: 'y' } }] });
    const btn = await create(ed, b.id, { trigger: { type: 'button', label: 'B' }, actions: [{ type: 'set_property', propertyId: note, value: 'z' }] });
    expect((await call(ed, 'DELETE', `/api/v3/bases/${b.id}/properties/${note}`)).statusCode).toBe(204);
    expect((await call(ed, 'DELETE', `/api/v3/bases/${log.id}/properties/${target}`)).statusCode).toBe(204);
    expect(autoOf(a.id)).toMatchObject({ status: 'broken', status_reason: 'config' });
    expect(autoOf(c.id)).toMatchObject({ status: 'broken', status_reason: 'config' });
    expect(autoOf(btn.id).status).toBe('broken');
    const row = await addRow(ed, b.id);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id })).statusCode).toBe(409);
    expect((await call(ed, 'GET', `/api/v3/bases/${b.id}`)).json().buttons).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(log.id) as { n: number }).n).toBe(0);

    // Option supprimée : la configuration est revalidée à l'exécution, l'automatisation tombe en panne sans écrire.
    const st = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const d = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: st.id, value: st.options[0]!.id }] });
    await call(ed, 'PATCH', `/api/v3/bases/${b.id}/properties/${st.id}`, { options: st.options.slice(1) });
    expect((await addRow(ed, b.id)).values[st.id]).toBeUndefined();
    expect(autoOf(d.id)).toMatchObject({ status: 'broken', status_reason: 'config' });

    // Base cible supprimée définitivement : en panne à l'exécution.
    const e = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: log.id, values: {} }] });
    db.prepare('DELETE FROM pages WHERE id = ?').run(log.id);
    await addRow(ed, b.id);
    expect(autoOf(e.id)).toMatchObject({ status: 'broken', status_reason: 'config' });

    // Base supprimée : ses automatisations disparaissent avec elle.
    db.prepare('DELETE FROM pages WHERE id = ?').run(b.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM base_automations').get()).toEqual({ n: 0 });
  });

  it('historique : codes et nombres seulement, auteur nommé s’il lit la base', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', values: { [b.nom]: 'texte' } }] });
    await addRow(ed, b.id, { [b.nom]: 'secret de ligne' });
    const res = (await call(ed, 'GET', `/api/v3/bases/${b.id}/automations/${a.id}/runs`)).json() as { items: Record<string, unknown>[] };
    expect(res.items).toEqual([{ at: expect.any(Number), trigger: 'row_added', status: 'ok', code: 'ok', rows: 1, actor: { id: 'ed1', name: 'Nom ed1' } }]);
    expect(JSON.stringify(res)).not.toContain('secret de ligne');
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'base.automation.create'").get()).toEqual({ n: 1 });
  });
});

describe('migration v35', () => {
  it('depuis une base v34 avec données : notifications gardées, nouveau type accepté, tables créées', () => {
    const file = oldDb(34, (raw) => {
      raw.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, kind) VALUES ('b1', 's1', 'Base', '{}', '', 0, 0, 'base')").run();
      raw.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES ('r1', 'b1', 0, '{}', 0, 0)").run();
      raw.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n1', 'u1', 'mention', 'p1', 5), ('n2', 'u1', 'verification.expired', 'p1', 6)").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare('SELECT id, type FROM notifications ORDER BY id').all()).toEqual([{ id: 'n1', type: 'mention' }, { id: 'n2', type: 'verification.expired' }]);
    up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n3', 'u1', 'automation', 'b1', 7)").run();
    expect(() => up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n4', 'u1', 'inconnu', 'b1', 7)").run()).toThrow();
    up.prepare("INSERT INTO base_automations (id, base_id, name, kind, trigger, actions, author_id, created_at, updated_at) VALUES ('a1', 'b1', 'A', 'row_added', '{}', '[]', 'u1', 0, 0)").run();
    expect(() => up.prepare("INSERT INTO base_automations (id, base_id, name, kind, trigger, actions, created_at, updated_at) VALUES ('a2', 'b1', 'A', 'eval', '{}', '[]', 0, 0)").run()).toThrow();
    up.prepare("UPDATE users SET disabled = 1 WHERE id = 'u1'").run();
    expect(up.prepare("SELECT status, status_reason FROM base_automations WHERE id = 'a1'").get()).toEqual({ status: 'suspended', status_reason: 'author' });
    expect(up.pragma('foreign_key_check')).toEqual([]);
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});

describe('corrections de la revue de sécurité', () => {
  it('notifications d’automatisation regroupées par personne et par base ; un e-mail par heure au plus', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'notify', userIds: ['ed2'] }] });
    await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'notify', userIds: ['ed2'] }] });
    for (let i = 0; i < 3; i++) await addRow(ed, b.id);
    expect(db.prepare("SELECT count, read_at FROM notifications WHERE user_id = 'ed2' AND type = 'automation'").all()).toEqual([{ count: 6, read_at: null }]);
    expect(mailer.sent.filter((m) => m.to === 'ed2@example.com')).toHaveLength(1);
    // Lue, puis nouvelle exécution : nouvelle notification dans la cloche, mais pas de second e-mail dans l'heure.
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = 'ed2'").run(Date.now());
    await addRow(ed, b.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'ed2' AND read_at IS NULL").get() as { n: number }).n).toBe(1);
    expect(mailer.sent.filter((m) => m.to === 'ed2@example.com')).toHaveLength(1);
    // Une heure plus tard : un e-mail de nouveau.
    db.prepare("UPDATE notifications SET emailed_at = emailed_at - 3600001 WHERE user_id = 'ed2' AND emailed_at IS NOT NULL").run();
    await addRow(ed, b.id);
    expect(mailer.sent.filter((m) => m.to === 'ed2@example.com')).toHaveLength(2);
  });

  it('réindexation et événement uniques par écriture déclenchante et par passage du planificateur', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const note = (await addProp(ed, b.id, { name: 'Note', type: 'text' })).id;
    for (let i = 0; i < 3; i++) await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: note, value: `v${i}` }] });
    const events: string[] = [];
    const stop = app.bus.subscribe((e) => { if (e.type === 'base.changed' && e.pageId === b.id) events.push(e.type); });
    await addRow(ed, b.id);
    expect(events).toHaveLength(2); // la route + un seul pour les trois automatisations
    db.prepare('DELETE FROM base_automations').run();
    for (let i = 0; i < 3; i++) await create(ed, b.id, { trigger: { type: 'recurrence', every: 'hour' }, actions: [{ type: 'set_property', propertyId: note, value: `r${i}` }] });
    db.prepare('UPDATE base_automations SET next_run_at = 1').run();
    events.length = 0;
    expect(app.automations.runDue()).toBe(3);
    expect(events).toHaveLength(1);
    stop();
  });

  it('changement d’auteur : adresse du webhook à ressaisir, nouveau secret ; renouveler le secret : auteur ou administrateur seulement', async () => {
    await enableWebhooks();
    const ed = await login('ed1');
    const ed2 = await login('ed2');
    const b = await newBase(ed);
    const url = 'https://93.184.215.14/h';
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'webhook', url }] });
    const path = `/api/v3/bases/${b.id}/automations/${a.id}`;
    expect((await call(ed2, 'PATCH', path, { actions: [{ type: 'webhook' }] })).statusCode).toBe(400);
    expect((await call(ed2, 'POST', `${path}/webhook-secret`)).statusCode).toBe(403);
    expect((await call(ed, 'POST', `${path}/webhook-secret`)).statusCode).toBe(200);
    const taken = await call(ed2, 'PATCH', path, { actions: [{ type: 'webhook', url }] });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json().webhookSecret).toMatch(/^whsec_/);
    expect(taken.json().webhookSecret).not.toBe(a.webhookSecret);
    expect((await call(ed, 'POST', `${path}/webhook-secret`)).statusCode).toBe(403);
    expect((await call(await login('admin'), 'POST', `${path}/webhook-secret`)).statusCode).toBe(200);
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/automations', { webhooks: false })).statusCode).toBe(200);
    expect((await call(ed2, 'POST', `${path}/webhook-secret`)).statusCode).toBe(403);
  });

  it('adresse refusée : un seul message, rien de la résolution DNS', async () => {
    await enableWebhooks();
    const ed = await login('ed1');
    const b = await newBase(ed);
    const detail = async (url: string) => {
      const res = await call(ed, 'POST', `/api/v3/bases/${b.id}/automations`, { name: 'W', trigger: { type: 'row_added' }, actions: [{ type: 'webhook', url }] });
      expect(res.statusCode).toBe(400);
      return res.json().detail as string;
    };
    const unknown = await detail('https://nom-inexistant.invalid/h');
    expect(unknown).toBe(await detail('https://127.0.0.1/h'));
    expect(unknown).not.toMatch(/ENOTFOUND|getaddrinfo|EAI_|Adresse interne refusée/);
  });

  it('planificateur équitable : plafond par auteur et par passage ; nombre de récurrences par auteur', async () => {
    const ed = await login('ed1');
    const ed2 = await login('ed2');
    const b = await newBase(ed);
    const b2 = await newBase(ed2, 'Autre');
    const body = { trigger: { type: 'recurrence', every: 'hour' }, actions: [{ type: 'add_row', values: {} }] };
    for (let i = 0; i < MAX_DUE_PER_AUTHOR_PER_TICK + 3; i++) await create(ed, b.id, body);
    await create(ed2, b2.id, body);
    await create(ed2, b2.id, body);
    db.prepare('UPDATE base_automations SET next_run_at = 1').run();
    expect(app.automations.runDue()).toBe(MAX_DUE_PER_AUTHOR_PER_TICK + 2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(b2.id) as { n: number }).n).toBe(2);
    expect(app.automations.runDue()).toBe(3);
    // Plafond par auteur, toutes bases confondues.
    const ins = db.prepare("INSERT INTO base_automations (id, base_id, name, kind, trigger, actions, author_id, created_at, updated_at) VALUES (?, ?, 'R', 'recurrence', '{}', '[]', 'ed1', 0, 0)");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM base_automations WHERE author_id = 'ed1'").get() as { n: number }).n;
    const other = await newBase(ed, 'Troisième');
    for (let i = n; i < MAX_RECURRENCES_PER_AUTHOR; i++) ins.run(`x${i}`, other.id);
    const b3 = await newBase(ed, 'Quatrième');
    await create(ed, b3.id, body, 409);
    await create(ed, b3.id, { trigger: { type: 'row_added' }, actions: body.actions });
  });

  it('personne qui déclenche, écrite dans une autre base seulement si elle la lit', async () => {
    const ed = await login('ed1');
    const ed2 = await login('ed2');
    const b = await newBase(ed);
    const target = await newBase(ed, 'Cible');
    const who = (await addProp(ed, target.id, { name: 'Qui', type: 'person' })).id;
    await restrict(target.id, [{ userId: 'ed1', level: 'write' }]);
    const a = await create(ed, b.id, { trigger: { type: 'row_added' }, actions: [{ type: 'add_row', baseId: target.id, values: { [target.nom]: 'trace', [who]: { dynamic: 'actor' } } }] });
    await addRow(ed2, b.id);
    expect(runs(a.id)).toEqual([{ status: 'ok', code: 'ok', rows: 1 }]);
    const rows = ((await call(ed, 'GET', `/api/v3/bases/${target.id}`)).json() as { rows: Row[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values[who]).toBeUndefined();
    await addRow(ed, b.id);
    const after = ((await call(ed, 'GET', `/api/v3/bases/${target.id}`)).json() as { rows: Row[] }).rows;
    expect(after.map((r) => r.values[who])).toContainEqual({ id: 'ed1', name: 'Nom ed1' });
  });

  it('bouton : ses échecs ne le mettent pas en pause ; jamais en panne quand l’auteur est absent', async () => {
    const ed = await login('ed1');
    const ed2 = await login('ed2');
    const b = await newBase(ed);
    const full = await newBase(ed, 'Pleine');
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < MAX_ROWS; i++) ins.run(`f${i}`, full.id, i, '{}', 0, 0); })();
    const btn = await create(ed, b.id, { trigger: { type: 'button', label: 'Ajouter' }, actions: [{ type: 'add_row', baseId: full.id, values: {} }] });
    const row = await addRow(ed, b.id);
    for (let i = 0; i < MAX_FAILURES + 2; i++) expect((await call(ed2, 'POST', `/api/v3/bases/${b.id}/automations/${btn.id}/run`, { rowId: row.id })).statusCode).toBe(409);
    expect(autoOf(btn.id)).toMatchObject({ status: 'active', failures: 0 });

    // Lien vers une page lisible par l'auteur seulement ; auteur désactivé : refus, le bouton reste actif.
    const page = (await call(ed, 'POST', '/api/v3/pages', { spaceId: teamSpace(), title: 'Privée' })).json() as { id: string };
    await restrict(page.id, [{ userId: 'ed1', level: 'write' }]);
    const link = (await addProp(ed, b.id, { name: 'Lien', type: 'page_link' })).id;
    const btn2 = await create(ed, b.id, { trigger: { type: 'button', label: 'Lier' }, actions: [{ type: 'set_property', propertyId: link, value: page.id }] });
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed1'").run();
    expect((await call(ed2, 'POST', `/api/v3/bases/${b.id}/automations/${btn2.id}/run`, { rowId: row.id })).statusCode).toBe(403);
    expect(autoOf(btn2.id).status).toBe('active');
  });
});
