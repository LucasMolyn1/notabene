// Bases : relations, cumuls (P1), sous-éléments, dépendances, décalage et réglages (P2), vue chronologie.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { limits, MAX_BASE_CHARS } from '../src/lib/bases.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

const sessions = new Map<string, S>();
beforeEach(async () => {
  sessions.clear();
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor'], ['rd@example.com', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, `Nom ${email.split('@')[0]}`, role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

interface S { cookies: Record<string, string>; headers: Record<string, string> }
async function login(email: string): Promise<S> {
  if (!sessions.has(email)) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    sessions.set(email, { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } });
  }
  return sessions.get(email)!;
}
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });

const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
const publicSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'public'").get() as { id: string }).id;

interface Prop { id: string; name: string; type: string; config: Record<string, unknown>; options: { id: string }[] }
interface Row { id: string; values: Record<string, unknown>; parentId: string | null; blockedBy: string[] }
interface Base { page: { id: string }; properties: Prop[]; rows: Row[]; views: { id: string; config: Record<string, unknown> }[]; settings: Record<string, unknown>; canWrite: boolean }

async function newBase(s: S, title = 'Tâches', spaceId = teamSpace()) {
  const res = await call(s, 'POST', '/api/v3/bases', { spaceId, title });
  expect(res.statusCode).toBe(201);
  const b = res.json() as Base;
  return { id: b.page.id, nom: b.properties[0]!.id };
}
const addProp = async (s: S, base: string, body: object, status = 201) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as Prop;
};
const addRow = async (s: S, base: string, body: object = {}) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/rows`, { values: {}, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Row;
};
const patchRow = (s: S, base: string, row: string, body: object) => call(s, 'PATCH', `/api/v3/bases/${base}/rows/${row}`, body);
const get = async (s: S | null, base: string) => (await call(s, 'GET', `/api/v3/bases/${base}`)).json() as Base;
const rawVals = (row: string) => JSON.parse((db.prepare('SELECT vals FROM base_rows WHERE id = ?').get(row) as { vals: string }).vals) as Record<string, unknown>;
const restrict = async (page: string, entries: { userId: string; level: 'read' | 'write' }[]) => {
  const res = await call(await login('admin@example.com'), 'PUT', `/api/v3/pages/${page}/permissions`, { entries });
  expect(res.statusCode).toBe(200);
};

/** Deux bases : Projets (cible, avec Budget et Fait) et Tâches (avec une relation vers Projets). */
async function linked(twoWay = false) {
  const ed = await login('ed1@example.com');
  const proj = await newBase(ed, 'Projets');
  const budget = (await addProp(ed, proj.id, { name: 'Budget', type: 'number' })).id;
  const fait = (await addProp(ed, proj.id, { name: 'Fait', type: 'checkbox' })).id;
  const p1 = await addRow(ed, proj.id, { values: { [proj.nom]: 'Alpha', [budget]: 10, [fait]: true } });
  const p2 = await addRow(ed, proj.id, { values: { [proj.nom]: 'Beta', [budget]: 30 } });
  const tasks = await newBase(ed, 'Tâches');
  const rel = await addProp(ed, tasks.id, { name: 'Projet', type: 'relation', config: { targetId: proj.id, twoWay } });
  return { ed, proj, budget, fait, p1, p2, tasks, rel };
}

describe('relations', () => {
  it('une cellule relation garde des identifiants de lignes et se lit avec le titre des lignes liées', async () => {
    const { ed, proj, p1, p2, tasks, rel } = await linked();
    expect(rel.config).toEqual({ targetId: proj.id, targetTitle: 'Projets', backPropertyId: null });
    const t = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id, p2.id, p1.id] } });
    expect(t.values[rel.id]).toEqual([{ id: p1.id, title: 'Alpha' }, { id: p2.id, title: 'Beta' }]);
    expect(rawVals(t.id)[rel.id]).toEqual([p1.id, p2.id]);
    // Ligne d'une autre base, identifiant mal formé, objet au lieu d'identifiant : refusés.
    const other = await addRow(ed, tasks.id);
    for (const v of [[other.id], ['../x'], [{ id: p1.id }], p1.id]) expect((await patchRow(ed, tasks.id, t.id, { values: { [rel.id]: v } })).statusCode, JSON.stringify(v)).toBe(400);
    // Plafond de liens par cellule.
    expect((await patchRow(ed, tasks.id, t.id, { values: { [rel.id]: Array.from({ length: 51 }, () => p1.id) } })).statusCode).toBe(400);
    expect((await patchRow(ed, tasks.id, t.id, { values: { [rel.id]: null } })).statusCode).toBe(200);
    expect(rawVals(t.id)[rel.id]).toBeUndefined();
  });

  it('écrire une relation demande de lire la base cible : sinon 404, même réponse qu’une base inexistante', async () => {
    const { proj, tasks, rel, p1 } = await linked();
    const ed2 = await login('ed2@example.com');
    await restrict(proj.id, [{ userId: 'ed1', level: 'write' }]);
    const t = await addRow(ed2, tasks.id);
    const res = await patchRow(ed2, tasks.id, t.id, { values: { [rel.id]: [p1.id] } });
    expect(res.statusCode).toBe(404);
    expect((await patchRow(ed2, tasks.id, t.id, { values: { [rel.id]: null } })).statusCode).toBe(404);
    expect((await call(ed2, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'R2', type: 'relation', config: { targetId: proj.id } })).statusCode).toBe(404);
    expect((await call(ed2, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'R3', type: 'relation', config: { targetId: 'nexistepas' } })).statusCode).toBe(404);
    // Une page ordinaire n'est pas une base cible.
    const pageRes = await call(ed2, 'POST', '/api/v3/pages', { spaceId: teamSpace(), title: 'Doc' });
    const docId = (pageRes.json() as { id: string }).id;
    expect((await call(ed2, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'R4', type: 'relation', config: { targetId: docId } })).statusCode).toBe(404);
  });

  it('un lecteur qui ne lit pas la base cible voit des cellules vides, sans titre de cible ni cumul, en lecture comme en CSV', async () => {
    const { ed, proj, budget, p1, tasks, rel } = await linked();
    const sum = await addProp(ed, tasks.id, { name: 'Total', type: 'rollup', config: { relationId: rel.id, targetPropertyId: budget, fn: 'sum' } });
    await addRow(ed, tasks.id, { values: { [tasks.nom]: 'T1', [rel.id]: [p1.id] } });
    await restrict(proj.id, [{ userId: 'ed1', level: 'write' }]);
    const ed2 = await login('ed2@example.com');
    const seen = await get(ed2, tasks.id);
    const r = seen.properties.find((p) => p.id === rel.id)!;
    expect(r.config).toEqual({ targetId: proj.id, targetTitle: null, backPropertyId: null });
    expect(seen.rows[0]!.values[rel.id]).toBeUndefined();
    expect(seen.rows[0]!.values[sum.id]).toBeUndefined();
    const csv = (await call(ed2, 'GET', `/api/v3/bases/${tasks.id}/export`)).body;
    expect(csv).not.toContain('Alpha');
    // Le propriétaire voit tout.
    const own = await get(ed, tasks.id);
    expect(own.rows[0]!.values[rel.id]).toEqual([{ id: p1.id, title: 'Alpha' }]);
    expect(own.rows[0]!.values[sum.id]).toBe(10);
  });

  it('relation double : colonne miroir dans la cible, cellules tenues à jour dans les deux sens', async () => {
    const { ed, proj, p1, p2, tasks, rel } = await linked(true);
    const target = await get(ed, proj.id);
    const mirror = target.properties.find((p) => p.type === 'relation')!;
    // Nom neutre : le titre de la base d'origine n'est pas montré aux lecteurs de la cible.
    expect(mirror.name).toBe('Relation');
    expect(mirror.config).toEqual({ targetId: tasks.id, targetTitle: 'Tâches', backPropertyId: rel.id });
    expect((await get(ed, tasks.id)).properties.find((p) => p.id === rel.id)!.config.backPropertyId).toBe(mirror.id);
    const t1 = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'T1', [rel.id]: [p1.id] } });
    const t2 = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'T2', [rel.id]: [p1.id, p2.id] } });
    expect(rawVals(p1.id)[mirror.id]).toEqual([t1.id, t2.id]);
    expect(rawVals(p2.id)[mirror.id]).toEqual([t2.id]);
    expect((await patchRow(ed, tasks.id, t2.id, { values: { [rel.id]: [p2.id] } })).statusCode).toBe(200);
    expect(rawVals(p1.id)[mirror.id]).toEqual([t1.id]);
    // Écrire depuis la cible met à jour l'origine.
    expect((await patchRow(ed, proj.id, p2.id, { values: { [mirror.id]: [] } })).statusCode).toBe(200);
    expect(rawVals(t2.id)[rel.id]).toBeUndefined();
  });

  it('relation double : il faut pouvoir modifier la base cible, à la création comme à chaque écriture (403, rien n’est écrit)', async () => {
    const { ed, proj, p1, tasks } = await linked();
    const ed2 = await login('ed2@example.com');
    await restrict(proj.id, [{ userId: 'ed1', level: 'write' }, { userId: 'ed2', level: 'read' }]);
    expect((await call(ed2, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'Double', type: 'relation', config: { targetId: proj.id, twoWay: true } })).statusCode).toBe(403);
    expect((await get(ed, proj.id)).properties.filter((p) => p.type === 'relation')).toHaveLength(0);
    const rel = await addProp(ed, tasks.id, { name: 'Double', type: 'relation', config: { targetId: proj.id, twoWay: true } });
    const t = await addRow(ed2, tasks.id, { values: { [tasks.nom]: 'avant' } });
    const res = await patchRow(ed2, tasks.id, t.id, { values: { [tasks.nom]: 'après', [rel.id]: [p1.id] } });
    expect(res.statusCode).toBe(403);
    expect(rawVals(t.id)).toEqual({ [tasks.nom]: 'avant' });
    expect(Object.keys(rawVals(p1.id))).not.toContain(rel.config.backPropertyId);
    // Une relation simple vers la même base reste possible en lecture seule sur la cible.
    const simple = await addProp(ed2, tasks.id, { name: 'Simple', type: 'relation', config: { targetId: proj.id } });
    expect((await patchRow(ed2, tasks.id, t.id, { values: { [simple.id]: [p1.id] } })).statusCode).toBe(200);
  });

  it('supprimer une colonne d’une relation double laisse l’autre en relation simple, avec ses valeurs', async () => {
    const { ed, proj, p1, tasks, rel } = await linked(true);
    const t = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id] } });
    const mirrorId = (await get(ed, tasks.id)).properties.find((p) => p.id === rel.id)!.config.backPropertyId as string;
    expect((await call(ed, 'DELETE', `/api/v3/bases/${tasks.id}/properties/${rel.id}`)).statusCode).toBe(204);
    const mirror = (await get(ed, proj.id)).properties.find((p) => p.id === mirrorId)!;
    expect(mirror.config.backPropertyId).toBeNull();
    expect(rawVals(p1.id)[mirrorId]).toEqual([t.id]);
    // Plus de synchronisation : écrire le miroir ne touche plus l'ancienne origine.
    expect((await patchRow(ed, proj.id, p1.id, { values: { [mirrorId]: null } })).statusCode).toBe(200);
  });

  it('plafonds : 10 relations et 10 cumuls par base, 50 liens par cellule miroir (409, rien n’est écrit)', async () => {
    const { ed, proj, p1, tasks, rel } = await linked(true);
    for (let i = 1; i < 10; i++) await addProp(ed, tasks.id, { name: `R${i}`, type: 'relation', config: { targetId: proj.id } });
    await addProp(ed, tasks.id, { name: 'R10', type: 'relation', config: { targetId: proj.id } }, 409);
    for (let i = 0; i < 10; i++) await addProp(ed, tasks.id, { name: `C${i}`, type: 'rollup', config: { relationId: rel.id, fn: 'count' } });
    await addProp(ed, tasks.id, { name: 'C10', type: 'rollup', config: { relationId: rel.id, fn: 'count' } }, 409);
    const mirrorId = rel.config.backPropertyId as string;
    for (let i = 0; i < 50; i++) await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id] } });
    expect((rawVals(p1.id)[mirrorId] as string[]).length).toBe(50);
    const extra = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'de trop' } });
    expect((await patchRow(ed, tasks.id, extra.id, { values: { [rel.id]: [p1.id] } })).statusCode).toBe(409);
    expect(rawVals(extra.id)[rel.id]).toBeUndefined();
    expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/rows`, { values: { [rel.id]: [p1.id] } })).statusCode).toBe(409);
  });

  it('la cible d’une relation ne change pas, une configuration mal formée est refusée', async () => {
    const { ed, proj, tasks, rel } = await linked();
    expect((await call(ed, 'PATCH', `/api/v3/bases/${tasks.id}/properties/${rel.id}`, { config: { relationId: rel.id, fn: 'count' } })).statusCode).toBe(400);
    expect((await call(ed, 'PATCH', `/api/v3/bases/${tasks.id}/properties/${rel.id}`, { name: 'Projet parent' })).statusCode).toBe(200);
    expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'X', type: 'relation' })).statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'X', type: 'relation', config: { targetId: proj.id, extra: 1 } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: 'X', type: 'text', config: { targetId: proj.id } })).statusCode).toBe(400);
  });
});

describe('cumuls', () => {
  it('count, sum, avg, min, max et percent_checked se calculent sur les lignes liées', async () => {
    const { ed, budget, fait, p1, p2, tasks, rel } = await linked();
    const mk = async (name: string, fn: string, targetPropertyId?: string) => (await addProp(ed, tasks.id, { name, type: 'rollup', config: { relationId: rel.id, fn, ...(targetPropertyId ? { targetPropertyId } : {}) } })).id;
    const ids = { count: await mk('N', 'count'), sum: await mk('S', 'sum', budget), avg: await mk('A', 'avg', budget), min: await mk('Mi', 'min', budget), max: await mk('Ma', 'max', budget), pct: await mk('P', 'percent_checked', fait) };
    const t = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id, p2.id] } });
    expect([ids.count, ids.sum, ids.avg, ids.min, ids.max, ids.pct].map((k) => t.values[k])).toEqual([2, 40, 20, 10, 30, 50]);
    const empty = await addRow(ed, tasks.id);
    expect(empty.values[ids.count]).toBe(0);
    expect(empty.values[ids.sum]).toBe(0);
    expect(empty.values[ids.avg]).toBeUndefined();
    expect(empty.values[ids.pct]).toBeUndefined();
    // Un cumul ne s'écrit pas ; la CSV donne un nombre.
    expect((await patchRow(ed, tasks.id, t.id, { values: { [ids.sum]: 3 } })).statusCode).toBe(400);
    const csv = (await call(ed, 'GET', `/api/v3/bases/${tasks.id}/export`)).body;
    expect(csv).toContain('Alpha, Beta');
    expect(csv.split('\r\n')[1]).toContain(',2,40,20,10,30,50');
  });

  it('cumuls refusés : fonction sur un mauvais type, cumul de cumul, formule lisant une relation ou un cumul', async () => {
    const { ed, proj, budget, tasks, rel } = await linked();
    const bad = async (config: object) => expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: `x${Math.random()}`, type: 'rollup', config })).statusCode, JSON.stringify(config)).toBe(400);
    await bad({ relationId: rel.id, fn: 'sum', targetPropertyId: proj.nom });
    await bad({ relationId: rel.id, fn: 'sum' });
    await bad({ relationId: rel.id, fn: 'percent_checked', targetPropertyId: budget });
    await bad({ relationId: tasks.nom, fn: 'count' });
    await bad({ relationId: rel.id, fn: 'median', targetPropertyId: budget });
    // Cumul dans la cible, puis cumul de ce cumul : refusé.
    const back = await addProp(ed, proj.id, { name: 'Vers tâches', type: 'relation', config: { targetId: tasks.id } });
    const inner = await addProp(ed, proj.id, { name: 'Nb', type: 'rollup', config: { relationId: back.id, fn: 'count' } });
    await bad({ relationId: rel.id, fn: 'sum', targetPropertyId: inner.id });
    const sum = await addProp(ed, tasks.id, { name: 'Total', type: 'rollup', config: { relationId: rel.id, fn: 'sum', targetPropertyId: budget } });
    for (const formula of ['prop("Total") + 1', 'prop("Projet")']) {
      expect((await call(ed, 'POST', `/api/v3/bases/${tasks.id}/properties`, { name: `F${formula.length}`, type: 'formula', formula })).statusCode).toBe(400);
    }
    // La relation lue par un cumul ne se supprime pas ; la configuration du cumul se modifie.
    expect((await call(ed, 'DELETE', `/api/v3/bases/${tasks.id}/properties/${rel.id}`)).statusCode).toBe(409);
    const upd = await call(ed, 'PATCH', `/api/v3/bases/${tasks.id}/properties/${sum.id}`, { config: { relationId: rel.id, fn: 'max', targetPropertyId: budget } });
    expect(upd.statusCode).toBe(200);
    expect((upd.json() as Prop).config).toEqual({ relationId: rel.id, targetPropertyId: budget, fn: 'max' });
    expect((await call(ed, 'PATCH', `/api/v3/bases/${tasks.id}/properties/${tasks.nom}`, { config: { relationId: rel.id, fn: 'count' } })).statusCode).toBe(400);
  });

  it('les cumuls partagent le budget de calcul des formules', async () => {
    const { ed, p1, p2, tasks, rel } = await linked();
    const n = (await addProp(ed, tasks.id, { name: 'N', type: 'rollup', config: { relationId: rel.id, fn: 'count' } })).id;
    for (let i = 0; i < 5; i++) await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id, p2.id] } });
    const count = async () => (await get(ed, tasks.id)).rows.filter((r) => typeof r.values[n] === 'number').length;
    expect(await count()).toBe(5);
    const saved = limits.formulaChars;
    limits.formulaChars = 7;
    try { expect(await count()).toBeLessThan(5); } finally { limits.formulaChars = saved; }
  });
});

describe('copie et nettoyage', () => {
  it('dupliquer une base retire les relations vers une autre base (et leurs cumuls), et reporte une relation vers elle-même', async () => {
    const { ed, budget, p1, tasks, rel } = await linked(true);
    await addProp(ed, tasks.id, { name: 'Total', type: 'rollup', config: { relationId: rel.id, fn: 'sum', targetPropertyId: budget } });
    const self = await addProp(ed, tasks.id, { name: 'Voir aussi', type: 'relation', config: { targetId: tasks.id, twoWay: true } });
    const nb = await addProp(ed, tasks.id, { name: 'Nb', type: 'rollup', config: { relationId: self.id, fn: 'count' } });
    const a = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'A', [rel.id]: [p1.id] } });
    const b = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'B', [self.id]: [a.id] }, parentId: a.id, blockedBy: [a.id] });
    const date = (await addProp(ed, tasks.id, { name: 'Début', type: 'date' })).id;
    expect((await call(ed, 'PATCH', `/api/v3/bases/${tasks.id}/settings`, { subitems: true, startPropertyId: date })).statusCode).toBe(200);
    const mirrorBefore = (rawVals(p1.id)[rel.config.backPropertyId as string] as string[]).length;

    const dup = (await call(ed, 'POST', `/api/v3/pages/${tasks.id}/duplicate`)).json() as { id: string };
    const copy = await get(ed, dup.id);
    const names = copy.properties.map((p) => p.name);
    expect(names).not.toContain('Projet');
    expect(names).not.toContain('Total');
    const cSelf = copy.properties.find((p) => p.name === 'Voir aussi')!;
    const cMirror = copy.properties.find((p) => p.id === cSelf.config.backPropertyId)!;
    expect(cSelf.config.targetId).toBe(dup.id);
    expect(cMirror.config).toMatchObject({ targetId: dup.id, backPropertyId: cSelf.id });
    const cA = copy.rows.find((r) => r.values[copy.properties[0]!.id] === 'A')!;
    const cB = copy.rows.find((r) => r.values[copy.properties[0]!.id] === 'B')!;
    expect(cA.id).not.toBe(a.id);
    expect(cB.values[cSelf.id]).toEqual([{ id: cA.id, title: 'A' }]);
    expect(cA.values[cMirror.id]).toEqual([{ id: cB.id, title: 'B' }]);
    expect(cB.values[copy.properties.find((p) => p.name === 'Nb')!.id]).toBe(1);
    expect(nb.id).not.toBe(copy.properties.find((p) => p.name === 'Nb')!.id);
    expect(cB.parentId).toBe(cA.id);
    expect(cB.blockedBy).toEqual([cA.id]);
    expect(copy.settings).toMatchObject({ subitems: true, startPropertyId: copy.properties.find((p) => p.name === 'Début')!.id });
    // La base cible n'a reçu aucun nouveau lien.
    expect((rawVals(p1.id)[rel.config.backPropertyId as string] as string[]).length).toBe(mirrorBefore);
    expect(b.id).toBeTruthy();
  });

  it('copier une base vers un autre espace ne garde aucune relation vers une autre base', async () => {
    const { ed, p1, tasks, rel } = await linked();
    await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id] } });
    const res = await call(ed, 'POST', `/api/v3/pages/${tasks.id}/copy`, { spaceId: publicSpace() });
    expect(res.statusCode).toBe(201);
    const root = (res.json() as { page: { id: string } }).page.id;
    const copy = await get(ed, root);
    expect(copy.properties.filter((p) => p.type === 'relation')).toHaveLength(0);
    expect(JSON.stringify(copy.rows)).not.toContain(p1.id);
  });

  it('supprimer des lignes les retire des cellules qui les citaient, dans toutes les bases', async () => {
    const { ed, proj, p1, p2, tasks, rel } = await linked(true);
    const t = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id, p2.id] } });
    const seen: string[] = [];
    const off = app.bus.subscribe((e) => { if (e.type === 'base.changed' && e.pageId) seen.push(e.pageId); });
    expect((await call(ed, 'POST', `/api/v3/bases/${proj.id}/rows/delete`, { ids: [p1.id] })).json()).toEqual({ deleted: 1 });
    off();
    expect(rawVals(t.id)[rel.id]).toEqual([p2.id]);
    expect(seen).toContain(tasks.id);
    // Côté origine : supprimer la tâche nettoie la colonne miroir.
    await call(ed, 'POST', `/api/v3/bases/${tasks.id}/rows/delete`, { ids: [t.id] });
    expect(rawVals(p2.id)[rel.config.backPropertyId as string]).toBeUndefined();
  });

  it('une base cible à la corbeille puis purgée : les liens sont ignorés à la lecture, et l’écriture répond 404', async () => {
    const { ed, proj, p1, tasks, rel } = await linked();
    const n = (await addProp(ed, tasks.id, { name: 'N', type: 'rollup', config: { relationId: rel.id, fn: 'count' } })).id;
    const t = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id] } });
    expect((await call(ed, 'DELETE', `/api/v3/pages/${proj.id}`)).statusCode).toBe(204);
    let seen = await get(ed, tasks.id);
    expect(seen.rows[0]!.values[rel.id]).toBeUndefined();
    expect(seen.rows[0]!.values[n]).toBeUndefined();
    expect(seen.properties.find((p) => p.id === rel.id)!.config.targetTitle).toBeNull();
    expect((await patchRow(ed, tasks.id, t.id, { values: { [rel.id]: [p1.id] } })).statusCode).toBe(404);
    expect((await call(await login('admin@example.com'), 'DELETE', `/api/v3/pages/${proj.id}/permanent`)).statusCode).toBe(204);
    seen = await get(ed, tasks.id);
    expect(seen.rows[0]!.values[rel.id]).toBeUndefined();
    expect((await call(ed, 'GET', `/api/v3/bases/${tasks.id}/export`)).statusCode).toBe(200);
  });
});

describe('sous-éléments', () => {
  it('une ligne se range sous une autre de la même base, sans cycle, sur 4 niveaux au plus', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const rows: Row[] = [await addRow(ed, b.id)];
    for (let i = 1; i <= 4; i++) rows.push(await addRow(ed, b.id, { parentId: rows[i - 1]!.id }));
    expect(rows[4]!.parentId).toBe(rows[3]!.id);
    const deep = await call(ed, 'POST', `/api/v3/bases/${b.id}/rows`, { values: {}, parentId: rows[4]!.id });
    expect(deep.statusCode).toBe(409);
    // Cycle : une ligne sous elle-même ou sous un de ses sous-éléments.
    expect((await patchRow(ed, b.id, rows[1]!.id, { parentId: rows[1]!.id })).statusCode).toBe(409);
    expect((await patchRow(ed, b.id, rows[0]!.id, { parentId: rows[2]!.id })).statusCode).toBe(409);
    // Déplacer un sous-arbre qui dépasserait la profondeur.
    const other = await addRow(ed, b.id);
    const mid = await addRow(ed, b.id, { parentId: other.id });
    expect((await patchRow(ed, b.id, rows[1]!.id, { parentId: mid.id })).statusCode).toBe(409);
    expect((await patchRow(ed, b.id, rows[3]!.id, { parentId: mid.id })).statusCode).toBe(200);
    // Ligne d'une autre base.
    const b2 = await newBase(ed, 'Autre');
    const foreign = await addRow(ed, b2.id);
    expect((await patchRow(ed, b.id, rows[0]!.id, { parentId: foreign.id })).statusCode).toBe(400);
    expect((await patchRow(ed, b.id, rows[3]!.id, { parentId: null })).json().parentId).toBeNull();
  });

  it('supprimer une ligne supprime ses sous-éléments, comptés au journal et dans le plafond de suppression', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const top = await addRow(ed, b.id);
    const child = await addRow(ed, b.id, { parentId: top.id });
    await addRow(ed, b.id, { parentId: child.id });
    const keep = await addRow(ed, b.id);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/rows/delete`, { ids: [top.id] })).json()).toEqual({ deleted: 3 });
    expect((await get(ed, b.id)).rows.map((r) => r.id)).toEqual([keep.id]);
    const entry = db.prepare("SELECT meta FROM audit_log WHERE action = 'base.rows.delete' ORDER BY id DESC LIMIT 1").get() as { meta: string };
    expect(JSON.parse(entry.meta)).toMatchObject({ count: 3, remaining: 1 });
    // Plafond : 500 lignes, sous-éléments compris ; au-delà rien n'est supprimé.
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, 0, 0, ?)');
    for (let i = 0; i < 500; i++) ins.run(`enfant${i}`, b.id, i + 10, '{}', keep.id);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/rows/delete`, { ids: [keep.id] })).statusCode).toBe(409);
    expect((await get(ed, b.id)).rows).toHaveLength(501);
  });
});

describe('dépendances et décalage', () => {
  async function planned(dependencies = true) {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed, 'Planning');
    const start = (await addProp(ed, b.id, { name: 'Début', type: 'date' })).id;
    const end = (await addProp(ed, b.id, { name: 'Fin', type: 'date' })).id;
    const res = await call(ed, 'PATCH', `/api/v3/bases/${b.id}/settings`, { dependencies, startPropertyId: start, endPropertyId: end });
    expect(res.statusCode).toBe(200);
    const row = (s: string, e?: string) => addRow(ed, b.id, { values: { [start]: s, ...(e ? { [end]: e } : {}) } });
    return { ed, b, start, end, row };
  }

  it('« bloqué par » : 10 lignes au plus, de la même base, sans cycle', async () => {
    const { ed, b, row } = await planned(false);
    const [r1, r2, r3] = [await row('2027-01-01'), await row('2027-01-01'), await row('2027-01-01')];
    expect((await patchRow(ed, b.id, r2.id, { blockedBy: [r1.id] })).json().blockedBy).toEqual([r1.id]);
    expect((await patchRow(ed, b.id, r3.id, { blockedBy: [r2.id] })).statusCode).toBe(200);
    expect((await patchRow(ed, b.id, r1.id, { blockedBy: [r3.id] })).statusCode).toBe(409);
    expect((await patchRow(ed, b.id, r1.id, { blockedBy: [r1.id] })).statusCode).toBe(409);
    expect((await patchRow(ed, b.id, r1.id, { blockedBy: Array.from({ length: 11 }, (_, i) => `x${i}`) })).statusCode).toBe(400);
    const b2 = await newBase(ed, 'Autre');
    const foreign = await addRow(ed, b2.id);
    expect((await patchRow(ed, b.id, r1.id, { blockedBy: [foreign.id] })).statusCode).toBe(400);
    expect((await get(ed, b.id)).rows.find((r) => r.id === r1.id)!.blockedBy).toEqual([]);
    // Supprimer une ligne bloquante retire la dépendance.
    await call(ed, 'POST', `/api/v3/bases/${b.id}/rows/delete`, { ids: [r2.id] });
    expect((await get(ed, b.id)).rows.find((r) => r.id === r3.id)!.blockedBy).toEqual([]);
  });

  it('une ligne bloquée commence après la fin de ses bloqueurs : décalage en cascade, durée conservée, jamais vers le passé', async () => {
    const { ed, b, start, end, row } = await planned();
    const a = await row('2027-01-01', '2027-01-05');
    const bb = await row('2027-01-03', '2027-01-04');
    const c = await row('2027-01-06');
    const later = await row('2027-03-01', '2027-03-02');
    expect((await patchRow(ed, b.id, c.id, { blockedBy: [bb.id] })).statusCode).toBe(200);
    expect((await patchRow(ed, b.id, later.id, { blockedBy: [a.id] })).statusCode).toBe(200);
    const res = await patchRow(ed, b.id, bb.id, { blockedBy: [a.id] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Row & { row: Row; shifted: Row[] };
    // Compatibilité : la ligne reste à la racine de la réponse.
    expect(body.values[start]).toBe('2027-01-06');
    expect(body.row.values).toEqual(body.values);
    expect(body.row.values[end]).toBe('2027-01-07');
    expect(body.shifted.map((r) => r.id)).toEqual([c.id]);
    expect(body.shifted[0]!.values[start]).toBe('2027-01-08');
    expect(rawVals(later.id)[start]).toBe('2027-03-01');
    // Allonger A pousse B puis C.
    const res2 = (await patchRow(ed, b.id, a.id, { values: { [end]: '2027-01-10' } })).json() as { shifted: Row[] };
    expect(res2.shifted.map((r) => r.id).sort()).toEqual([bb.id, c.id].sort());
    expect(rawVals(bb.id)).toMatchObject({ [start]: '2027-01-11', [end]: '2027-01-12' });
    expect(rawVals(c.id)[start]).toBe('2027-01-13');
    // Raccourcir A ne ramène rien en arrière.
    expect(((await patchRow(ed, b.id, a.id, { values: { [end]: '2027-01-02' } })).json() as { shifted: Row[] }).shifted).toEqual([]);
    expect(rawVals(bb.id)[start]).toBe('2027-01-11');
  });

  it('sans dépendances activées, rien ne bouge', async () => {
    const { ed, b, start, row } = await planned(false);
    const a = await row('2027-01-01', '2027-01-05');
    const bb = await row('2027-01-02');
    const res = (await patchRow(ed, b.id, bb.id, { blockedBy: [a.id] })).json() as Row & { shifted: Row[] };
    expect(res.values[start]).toBe('2027-01-02');
    expect(res.shifted).toEqual([]);
  });

  it('décalage borné : plus de 20 niveaux ou plus de 200 lignes répond 409 et n’écrit rien', async () => {
    const { ed, b, start, end } = await planned();
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    const dep = db.prepare('INSERT INTO base_row_deps (base_id, row_id, blocker_id) VALUES (?, ?, ?)');
    const day = (n: number) => new Date(Date.UTC(2027, 0, 1 + n)).toISOString().slice(0, 10);
    // Chaîne de 22 lignes, chacune le lendemain de la précédente.
    for (let i = 0; i < 22; i++) {
      ins.run(`ch${i}`, b.id, i, JSON.stringify({ [start]: day(i), [end]: day(i) }));
      if (i) dep.run(b.id, `ch${i}`, `ch${i - 1}`);
    }
    const res = await patchRow(ed, b.id, 'ch0', { values: { [b.nom]: 'modifiée', [end]: day(3) } });
    expect(res.statusCode).toBe(409);
    expect(rawVals('ch0')).toEqual({ [start]: day(0), [end]: day(0) });
    expect(rawVals('ch21')[start]).toBe(day(21));
    // 20 niveaux passent.
    db.prepare("DELETE FROM base_row_deps WHERE row_id = 'ch21'").run();
    expect((await patchRow(ed, b.id, 'ch0', { values: { [end]: day(1) } })).statusCode).toBe(200);
    expect(rawVals('ch20')[start]).toBe(day(21));

    // Éventail de 201 lignes bloquées par la même.
    ins.run('racine', b.id, 100, JSON.stringify({ [start]: day(0), [end]: day(0) }));
    for (let i = 0; i < 201; i++) { ins.run(`f${i}`, b.id, 200 + i, JSON.stringify({ [start]: day(1) })); dep.run(b.id, `f${i}`, 'racine'); }
    expect((await patchRow(ed, b.id, 'racine', { values: { [end]: day(5) } })).statusCode).toBe(409);
    expect(rawVals('racine')[end]).toBe(day(0));
    expect(rawVals('f0')[start]).toBe(day(1));
    db.prepare("DELETE FROM base_rows WHERE id = 'f200'").run();
    const ok = (await patchRow(ed, b.id, 'racine', { values: { [end]: day(5) } })).json() as { shifted: Row[] };
    expect(ok.shifted).toHaveLength(200);
  });
});

describe('réglages et vue chronologie', () => {
  it('les réglages se lisent avec la base, n’acceptent que des colonnes Date, et sont journalisés', async () => {
    const ed = await login('ed1@example.com');
    const rd = await login('rd@example.com');
    const b = await newBase(ed);
    expect((await get(ed, b.id)).settings).toEqual({ subitems: false, dependencies: false, startPropertyId: null, endPropertyId: null });
    const d = (await addProp(ed, b.id, { name: 'Début', type: 'date' })).id;
    const url = `/api/v3/bases/${b.id}/settings`;
    expect((await call(ed, 'PATCH', url, { startPropertyId: b.nom })).statusCode).toBe(400);
    expect((await call(ed, 'PATCH', url, { startPropertyId: d, endPropertyId: d })).statusCode).toBe(400);
    expect((await call(ed, 'PATCH', url, { unknown: true })).statusCode).toBe(400);
    expect((await call(rd, 'PATCH', url, { subitems: true })).statusCode).toBe(403);
    const res = await call(ed, 'PATCH', url, { subitems: true, dependencies: true, startPropertyId: d });
    expect(res.json()).toEqual({ subitems: true, dependencies: true, startPropertyId: d, endPropertyId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'base.settings' AND target = ?").get(b.id)).toEqual({ n: 1 });
    // Supprimer la colonne de début la retire des réglages.
    await call(ed, 'DELETE', `/api/v3/bases/${b.id}/properties/${d}`);
    expect((await get(ed, b.id)).settings.startPropertyId).toBeNull();
  });

  it('une vue chronologie a une échelle, un regroupement et une couleur facultatifs, sur une colonne Sélection ou Statut', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const status = (await addProp(ed, b.id, { name: 'Statut', type: 'status' })).id;
    const views = `/api/v3/bases/${b.id}/views`;
    const v = await call(ed, 'POST', views, { name: 'Chrono', config: { type: 'timeline', colorBy: status } });
    expect(v.statusCode).toBe(201);
    expect((v.json() as { config: Record<string, unknown> }).config).toMatchObject({ type: 'timeline', scale: 'week', colorBy: status });
    expect((await call(ed, 'POST', views, { name: 'x', config: { type: 'timeline', scale: 'year' } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', views, { name: 'x', config: { type: 'timeline', groupBy: b.nom } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', views, { name: 'x', config: { type: 'table', scale: 'day' } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', views, { name: 'x', config: { type: 'timeline', start: b.nom } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', views, { name: 'Groupée', config: { type: 'timeline', scale: 'month', groupBy: status } })).statusCode).toBe(201);
    // Supprimer la colonne de couleur et de regroupement : la vue reste une chronologie.
    await call(ed, 'DELETE', `/api/v3/bases/${b.id}/properties/${status}`);
    const all = (await get(ed, b.id)).views.map((x) => x.config);
    expect(all.filter((c) => c.type === 'timeline')).toEqual([
      { type: 'timeline', scale: 'week', sort: [], filters: [], hidden: [] },
      { type: 'timeline', scale: 'month', sort: [], filters: [], hidden: [] },
    ]);
  });
});

describe('relecture sécurité', () => {
  it('supprimer des lignes ne réécrit que les lignes qui les citaient', async () => {
    const { ed, proj, p1, p2, tasks, rel } = await linked();
    const t1 = await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id] } });
    await addRow(ed, tasks.id, { values: { [rel.id]: [p2.id] } });
    await addRow(ed, tasks.id, { values: { [tasks.nom]: 'sans lien' } });
    db.exec("CREATE TEMP TABLE upd (id TEXT); CREATE TEMP TRIGGER base_rows_upd AFTER UPDATE OF vals ON base_rows BEGIN INSERT INTO upd VALUES (NEW.id); END;");
    await call(ed, 'POST', `/api/v3/bases/${proj.id}/rows/delete`, { ids: [p1.id] });
    expect((db.prepare('SELECT id FROM upd').all() as { id: string }[]).map((r) => r.id)).toEqual([t1.id]);
    expect(rawVals(t1.id)[rel.id]).toBeUndefined();
    const entry = db.prepare("SELECT meta FROM audit_log WHERE action = 'base.rows.delete' ORDER BY id DESC LIMIT 1").get() as { meta: string };
    expect(JSON.parse(entry.meta).linked).toEqual([tasks.id]);
  });

  it('le volume lu dans les bases liées est borné pour une lecture ; une relation vers soi-même réutilise les lignes lues', async () => {
    const { ed, p1, p2, tasks, rel } = await linked();
    const self = await addProp(ed, tasks.id, { name: 'Voir aussi', type: 'relation', config: { targetId: tasks.id } });
    const a = await addRow(ed, tasks.id, { values: { [tasks.nom]: 'A' } });
    await addRow(ed, tasks.id, { values: { [rel.id]: [p1.id, p2.id], [self.id]: [a.id] } });
    const saved = limits.linkedChars;
    limits.linkedChars = 1;
    try {
      const row = (await get(ed, tasks.id)).rows[1]!;
      expect(row.values[rel.id]).toBeUndefined();
      expect(row.values[self.id]).toEqual([{ id: a.id, title: 'A' }]);
    } finally { limits.linkedChars = saved; }
    expect((await get(ed, tasks.id)).rows[1]!.values[rel.id]).toHaveLength(2);
  });

  it('une cellule miroir respecte la taille maximale de la base cible (409, rien n’est écrit)', async () => {
    const { ed, proj, p1, tasks, rel } = await linked(true);
    const used = (db.prepare('SELECT SUM(length(vals)) AS n FROM base_rows WHERE base_id = ?').get(proj.id) as { n: number }).n;
    // Base cible remplie à 5 caractères près : ajouter la ligne au miroir la ferait déborder.
    db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, 99, ?, 0, 0)')
      .run('enorme', proj.id, JSON.stringify({ x: 'a'.repeat(MAX_BASE_CHARS - used - 5 - 8) }));
    const t = await addRow(ed, tasks.id);
    expect((await patchRow(ed, tasks.id, t.id, { values: { [rel.id]: [p1.id] } })).statusCode).toBe(409);
    expect(rawVals(t.id)[rel.id]).toBeUndefined();
    expect(rawVals(p1.id)[rel.config.backPropertyId as string]).toBeUndefined();
  });

  it('supprimer un côté d’une relation double prévient l’autre base et le journalise', async () => {
    const { ed, proj, tasks, rel } = await linked(true);
    const seen: string[] = [];
    const off = app.bus.subscribe((e) => { if (e.type === 'base.changed' && e.pageId) seen.push(e.pageId); });
    expect((await call(ed, 'DELETE', `/api/v3/bases/${tasks.id}/properties/${rel.id}`)).statusCode).toBe(204);
    off();
    expect(seen).toEqual(expect.arrayContaining([tasks.id, proj.id]));
    const entry = db.prepare("SELECT meta FROM audit_log WHERE action = 'base.property.remove' ORDER BY id DESC LIMIT 1").get() as { meta: string };
    expect(JSON.parse(entry.meta).linked).toEqual([proj.id]);
  });

  it('un cumul ne nomme pas la colonne de la cible pour qui ne peut pas la lire', async () => {
    const { ed, proj, budget, tasks, rel } = await linked();
    const sum = await addProp(ed, tasks.id, { name: 'Total', type: 'rollup', config: { relationId: rel.id, targetPropertyId: budget, fn: 'sum' } });
    expect(sum.config.targetPropertyId).toBe(budget);
    await restrict(proj.id, [{ userId: 'ed1', level: 'write' }]);
    const seen = (await get(await login('ed2@example.com'), tasks.id)).properties.find((p) => p.id === sum.id)!;
    expect(seen.config).toEqual({ relationId: rel.id, targetPropertyId: null, fn: 'sum' });
    expect((await get(ed, tasks.id)).properties.find((p) => p.id === sum.id)!.config.targetPropertyId).toBe(budget);
  });
});

describe('migration v32', () => {
  it('garde les colonnes existantes (configuration vide) et accepte relations, cumuls, sous-éléments et dépendances', () => {
    const file = oldDb(31, (raw) => {
      raw.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, kind) VALUES ('b1', 's1', 'Base', '{}', '', 0, 0, 'base')").run();
      raw.prepare("INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, formula) VALUES ('c1', 'b1', 'Nom', 'text', '[]', 0, 0, NULL), ('c2', 'b1', 'F', 'formula', '[]', 1, 0, '1')").run();
      raw.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES ('r1', 'b1', 0, '{}', 0, 0), ('r2', 'b1', 1, '{}', 0, 0)").run();
    });
    const up = openDb(file);
    expect(up.prepare("SELECT name, type, formula, config FROM base_properties WHERE id = 'c2'").get()).toEqual({ name: 'F', type: 'formula', formula: '1', config: '{}' });
    up.prepare("INSERT INTO base_properties (id, base_id, name, type, created_at, config) VALUES ('c3', 'b1', 'R', 'relation', 0, '{\"targetId\":\"b1\"}')").run();
    expect(() => up.prepare("INSERT INTO base_properties (id, base_id, name, type, created_at) VALUES ('c4', 'b1', 'X', 'inconnu', 0)").run()).toThrow();
    up.prepare("UPDATE base_rows SET parent_id = 'r1' WHERE id = 'r2'").run();
    up.prepare("INSERT INTO base_row_deps (base_id, row_id, blocker_id) VALUES ('b1', 'r2', 'r1')").run();
    expect(() => up.prepare("INSERT INTO base_row_deps (base_id, row_id, blocker_id) VALUES ('b1', 'r1', 'r1')").run()).toThrow();
    up.prepare("INSERT INTO base_settings (base_id, start_property_id) VALUES ('b1', 'c1')").run();
    // Supprimer la ligne parente supprime le sous-élément et la dépendance ; supprimer la base supprime tout.
    up.prepare("DELETE FROM base_rows WHERE id = 'r1'").run();
    expect((up.prepare('SELECT COUNT(*) AS n FROM base_row_deps').get() as { n: number }).n).toBe(0);
    expect((up.prepare('SELECT COUNT(*) AS n FROM base_rows').get() as { n: number }).n).toBe(0);
    up.prepare("DELETE FROM pages WHERE id = 'b1'").run();
    for (const t of ['base_properties', 'base_settings']) expect((up.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    up.close();
  });
});
