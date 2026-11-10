// Bases (P5, P6) : nouveaux types de colonnes, ID unique, plages de dates, modèles de ligne, graphiques.
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { strFromU8, unzipSync } from 'fflate';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { limits } from '../src/lib/bases.js';
import { MAX_TEMPLATES } from '../src/lib/base-templates.js';
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
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

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

interface Prop { id: string; name: string; type: string; options: { id: string; name: string; color: string }[]; config: Record<string, unknown> }
interface Row { id: string; values: Record<string, unknown> }
interface Base { page: { id: string }; properties: Prop[]; rows: Row[]; views: { id: string; config: Record<string, unknown> }[]; rowTemplates: { id: string; name: string; values: Record<string, unknown> }[]; settings: Record<string, unknown> }
async function newBase(s: S, title = 'Projet') {
  const res = await call(s, 'POST', '/api/v3/bases', { spaceId: teamSpace(), title });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json() as Base;
  return { id: b.page.id, nom: b.properties[0]!.id, view: b.views[0]!.id };
}
const addProp = async (s: S, base: string, body: object, status = 201) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as Prop;
};
const addRow = async (s: S, base: string, values: object, status = 201, extra: object = {}) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/rows`, { values, ...extra });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as Row;
};
const patchRow = (s: S, base: string, row: string, values: object) => call(s, 'PATCH', `/api/v3/bases/${base}/rows/${row}`, { values });
const getBase = async (s: S, base: string) => (await call(s, 'GET', `/api/v3/bases/${base}`)).json() as Base;
const rowOf = async (s: S, base: string, id: string) => (await getBase(s, base)).rows.find((r) => r.id === id)!;
const restrict = async (page: string, entries: { userId: string; level: 'read' | 'write' }[]) =>
  expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${page}/permissions`, { entries })).statusCode).toBe(200);

describe('url, e-mail, téléphone', () => {
  it('url : http/https seulement, normalisée, sans identifiants ni caractères de contrôle', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const url = (await addProp(ed, b.id, { name: 'Site', type: 'url' })).id;
    expect((await addRow(ed, b.id, { [url]: 'https://exemple.fr/a b?x=1#h' })).values[url]).toBe('https://exemple.fr/a%20b?x=1#h');
    expect((await addRow(ed, b.id, { [url]: '  exemple.fr  ' })).values[url]).toBe('https://exemple.fr/');
    expect((await addRow(ed, b.id, { [url]: 'HTTP://EXEMPLE.FR' })).values[url]).toBe('http://exemple.fr/');
    expect((await addRow(ed, b.id, { [url]: '' })).values[url]).toBeUndefined();
    for (const v of [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://exemple.fr',
      'https://user:pass@exemple.fr', 'https://user@exemple.fr', 'https://exemple.fr/\r\nSet-Cookie: x', 'https://exemple.fr/\tx', `https://exemple.fr/${'a'.repeat(2000)}`,
      'https://', 'localhost:3000', 'https://exemple.fr/\u202e', 42, ['https://exemple.fr'],
    ]) await addRow(ed, b.id, { [url]: v }, 400);
  });

  it('e-mail et téléphone : validation linéaire, bornes', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const mail = (await addProp(ed, b.id, { name: 'Courriel', type: 'email' })).id;
    const tel = (await addProp(ed, b.id, { name: 'Téléphone', type: 'phone' })).id;
    const r = await addRow(ed, b.id, { [mail]: ' jean.dupont+test@exemple.co.uk ', [tel]: '+33 (0)1 23-45.67 89' });
    expect(r.values).toMatchObject({ [mail]: 'jean.dupont+test@exemple.co.uk', [tel]: '+33 (0)1 23-45.67 89' });
    for (const v of ['jean', 'a@b', '@exemple.fr', 'a@@exemple.fr', 'a..b@exemple.fr', '.a@exemple.fr', 'a@exemple..fr', 'a@-exemple.fr', 'a@exemple.1', '<a@exemple.fr>', 'a b@exemple.fr', 'a@exemple.fr\r\nBcc: x@y.fr', `${'a'.repeat(65)}@exemple.fr`, `a@${'b'.repeat(250)}.fr`, 'é@exemple.fr'])
      await addRow(ed, b.id, { [mail]: v }, 400);
    for (const v of ['12', 'abcde', '+33+1 23', '01 23\n45 67', '1'.repeat(31), '(((-)))', '0123456789#'])
      await addRow(ed, b.id, { [tel]: v }, 400);
    // ReDoS : une adresse pathologique est refusée immédiatement.
    const t0 = performance.now();
    await addRow(ed, b.id, { [mail]: `${'a.'.repeat(120)}@${'b-'.repeat(60)}` }, 400);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('CSV : url, e-mail et téléphone neutralisés comme du texte', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const mail = (await addProp(ed, b.id, { name: 'Courriel', type: 'email' })).id;
    const tel = (await addProp(ed, b.id, { name: 'Téléphone', type: 'phone' })).id;
    await addRow(ed, b.id, { [b.nom]: 'x', [mail]: '=cmd@exemple.fr', [tel]: '+33 1 23 45 67 89' });
    const csv = (await call(ed, 'GET', `/api/v3/bases/${b.id}/export`)).body;
    expect(csv).toContain("'=cmd@exemple.fr");
    expect(csv).toContain("'+33 1 23 45 67 89");
  });

  it('texte de recherche : url, e-mail, téléphone et ID unique', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const mail = (await addProp(ed, b.id, { name: 'Courriel', type: 'email' })).id;
    await addProp(ed, b.id, { name: 'Réf', type: 'unique_id', config: { prefix: 'TCK' } });
    await addRow(ed, b.id, { [mail]: 'trouvable@exemple.fr' });
    const text = (db.prepare('SELECT text FROM pages WHERE id = ?').get(b.id) as { text: string }).text;
    expect(text).toContain('trouvable@exemple.fr');
    expect(text).toContain('TCK-1');
  });
});

describe('créé, modifié, par', () => {
  it('dérivées de la ligne, non modifiables (même pour effacer), nommées comme une personne', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const ids: Record<string, string> = {};
    for (const t of ['created_time', 'updated_time', 'created_by', 'updated_by']) ids[t] = (await addProp(ed, b.id, { name: t, type: t })).id;
    const r = await addRow(ed, b.id, { [b.nom]: 'A' });
    const today = new Date().toISOString().slice(0, 10);
    expect(r.values).toMatchObject({ [ids.created_time!]: today, [ids.updated_time!]: today, [ids.created_by!]: { id: 'ed1', name: 'Nom ed1' }, [ids.updated_by!]: { id: 'ed1', name: 'Nom ed1' } });
    expect((await patchRow(await login('ed2'), b.id, r.id, { [b.nom]: 'B' })).json().values[ids.updated_by!]).toEqual({ id: 'ed2', name: 'Nom ed2' });
    for (const id of Object.values(ids)) {
      expect((await patchRow(ed, b.id, r.id, { [id]: 'x' })).statusCode).toBe(400);
      expect((await patchRow(ed, b.id, r.id, { [id]: null })).statusCode).toBe(400);
    }
    // Rien n'est stocké dans les cellules.
    const vals = JSON.parse((db.prepare('SELECT vals FROM base_rows WHERE id = ?').get(r.id) as { vals: string }).vals) as Record<string, unknown>;
    for (const id of Object.values(ids)) expect(vals[id]).toBeUndefined();
    // Une formule lit la date de création et le nom de l'auteur.
    const f = await addProp(ed, b.id, { name: 'F', type: 'formula', formula: 'concat(prop("created_by"), " ", formatDate(prop("created_time"), "AAAA"))' });
    expect((await rowOf(ed, b.id, r.id)).values[f.id]).toBe(`Nom ed1 ${today.slice(0, 4)}`);
  });

  it('auteur qui ne peut plus lire la base : nom absent', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const by = (await addProp(ed, b.id, { name: 'Par', type: 'created_by' })).id;
    const r = await addRow(await login('ed2'), b.id, { [b.nom]: 'A' });
    await restrict(b.id, [{ userId: 'ed1', level: 'write' }]);
    expect((await rowOf(ed, b.id, r.id)).values[by]).toBeUndefined();
  });
});

describe('ID unique', () => {
  it('numérote les lignes existantes, attribue à la création, ne réutilise jamais, immuable', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const a = await addRow(ed, b.id, { [b.nom]: 'A' });
    const c = await addRow(ed, b.id, { [b.nom]: 'B' });
    const uid = await addProp(ed, b.id, { name: 'Réf', type: 'unique_id', config: { prefix: 'T' } });
    expect(uid.config).toEqual({ prefix: 'T', next: 3 });
    let base = await getBase(ed, b.id);
    expect(base.rows.map((r) => r.values[uid.id])).toEqual(['T-1', 'T-2']);
    const d = await addRow(ed, b.id, { [b.nom]: 'C' });
    expect(d.values[uid.id]).toBe('T-3');
    // Une ligne refusée ne consomme pas de numéro (transaction).
    await addRow(ed, b.id, { [b.nom]: 5 }, 400);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.id}/rows/delete`, { ids: [d.id] })).statusCode).toBe(200);
    expect((await addRow(ed, b.id, { [b.nom]: 'D' })).values[uid.id]).toBe('T-4');
    for (const v of [7, 'T-9', null]) expect((await patchRow(ed, b.id, a.id, { [uid.id]: v })).statusCode).toBe(400);
    await addRow(ed, b.id, { [uid.id]: 99 }, 400);
    expect((await rowOf(ed, b.id, a.id)).values[uid.id]).toBe('T-1');
    // Préfixe : modifiable (le compteur, jamais) ; validé.
    const p = await call(ed, 'PATCH', `/api/v3/bases/${b.id}/properties/${uid.id}`, { config: { prefix: null } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().config).toEqual({ prefix: null, next: 5 });
    expect((await rowOf(ed, b.id, c.id)).values[uid.id]).toBe('2');
    for (const config of [{ prefix: 'TROP-LONG1' }, { prefix: 'a b' }, { prefix: '' }, { next: 1 }, { prefix: '<x>' }])
      expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/properties/${uid.id}`, { config })).statusCode, JSON.stringify(config)).toBe(400);
    // Une seule par base.
    await addProp(ed, b.id, { name: 'Autre', type: 'unique_id' }, 409);
    await addProp(ed, b.id, { name: 'Mauvais', type: 'text', config: { prefix: 'X' } }, 400);
    base = await getBase(ed, b.id);
    expect(base.rows.map((r) => r.values[uid.id])).toEqual(['1', '2', '4']);
  });

  it('le compteur est celui de la base : supprimer puis recréer la colonne ne réutilise aucun numéro ; la copie repart de zéro', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const first = (await addProp(ed, b.id, { name: 'Réf', type: 'unique_id' })).id;
    const a = await addRow(ed, b.id, { [b.nom]: 'A' });
    const c = await addRow(ed, b.id, { [b.nom]: 'B' });
    expect([a.values[first], c.values[first]]).toEqual(['1', '2']);
    expect((await call(ed, 'DELETE', `/api/v3/bases/${b.id}/properties/${first}`)).statusCode).toBe(204);
    const again = await addProp(ed, b.id, { name: 'Réf', type: 'unique_id', config: { prefix: 'N' } });
    expect(again.config).toEqual({ prefix: 'N', next: 5 });
    expect((await getBase(ed, b.id)).rows.map((r) => r.values[again.id])).toEqual(['N-3', 'N-4']);
    expect((await addRow(ed, b.id, {})).values[again.id]).toBe('N-5');
    // Les réglages modifiés ensuite ne touchent pas au compteur.
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/settings`, { subitems: true })).statusCode).toBe(200);
    expect((await addRow(ed, b.id, {})).values[again.id]).toBe('N-6');
    // Copie : renumérotée à partir de 1 ; une base copiée sans colonne ID unique repart aussi de 1.
    const dup = (await call(ed, 'POST', `/api/v3/pages/${b.id}/duplicate`)).json().id as string;
    const copy = await getBase(ed, dup);
    const cu = copy.properties.find((p) => p.type === 'unique_id')!;
    expect(copy.rows.map((r) => r.values[cu.id])).toEqual(['N-1', 'N-2', 'N-3', 'N-4']);
    expect((await call(ed, 'DELETE', `/api/v3/bases/${b.id}/properties/${again.id}`)).statusCode).toBe(204);
    const dup2 = (await call(ed, 'POST', `/api/v3/pages/${b.id}/duplicate`)).json().id as string;
    expect((await addProp(ed, dup2, { name: 'Réf', type: 'unique_id' })).config).toEqual({ prefix: null, next: 5 });
  });

  it('copie de base : renumérote et remet le compteur ; filtre texte et formule lisent le texte', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const uid = (await addProp(ed, b.id, { name: 'Réf', type: 'unique_id', config: { prefix: 'K' } })).id;
    const rows = [];
    for (const n of ['A', 'B', 'C']) rows.push(await addRow(ed, b.id, { [b.nom]: n }));
    await call(ed, 'POST', `/api/v3/bases/${b.id}/rows/delete`, { ids: [rows[0]!.id] });
    const f = await addProp(ed, b.id, { name: 'F', type: 'formula', formula: 'concat("n° ", prop("Réf"))' });
    expect((await rowOf(ed, b.id, rows[1]!.id)).values[f.id]).toBe('n° K-2');
    const dup = await call(ed, 'POST', `/api/v3/pages/${b.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const copy = await getBase(ed, dup.json().id as string);
    const cu = copy.properties.find((p) => p.name === 'Réf')!;
    expect(cu.config).toEqual({ prefix: 'K', next: 3 });
    expect(copy.rows.map((r) => r.values[cu.id])).toEqual(['K-1', 'K-2']);
    expect((await addRow(ed, copy.page.id, {})).values[cu.id]).toBe('K-3');
    // La base d'origine garde son compteur.
    expect((await addRow(ed, b.id, {})).values[uid]).toBe('K-4');
  });
});

describe('plage de dates', () => {
  it('valeur { start, end } validée, CSV, formule lit le début', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const pl = (await addProp(ed, b.id, { name: 'Plage', type: 'date_range' })).id;
    const r = await addRow(ed, b.id, { [b.nom]: 'A', [pl]: { start: '2026-01-01', end: '2026-01-05' } });
    expect(r.values[pl]).toEqual({ start: '2026-01-01', end: '2026-01-05' });
    expect((await addRow(ed, b.id, { [pl]: { start: '2026-02-01' } })).values[pl]).toEqual({ start: '2026-02-01', end: null });
    expect((await addRow(ed, b.id, { [pl]: { start: '2026-02-01', end: '2026-02-01' } })).values[pl]).toEqual({ start: '2026-02-01', end: '2026-02-01' });
    for (const v of [{ start: '2026-01-05', end: '2026-01-01' }, { end: '2026-01-01' }, { start: '2026-02-30' }, { start: '2026-01-01', fin: '2026-01-02' }, '2026-01-01', ['2026-01-01'], { start: '2026-01-01', end: 5 }, { start: null }])
      await addRow(ed, b.id, { [pl]: v }, 400);
    const f = await addProp(ed, b.id, { name: 'F', type: 'formula', formula: 'dateAdd(prop("Plage"), 1)' });
    expect((await rowOf(ed, b.id, r.id)).values[f.id]).toBe('2026-01-02');
    const csv = (await call(ed, 'GET', `/api/v3/bases/${b.id}/export`)).body;
    expect(csv).toContain('2026-01-01 / 2026-01-05');
  });

  it('réglages, calendrier, flux iCalendar, Mes tâches et décalage des dépendances lisent la plage', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const pl = (await addProp(ed, b.id, { name: 'Plage', type: 'date_range' })).id;
    const fin = (await addProp(ed, b.id, { name: 'Fin', type: 'date' })).id;
    const resp = (await addProp(ed, b.id, { name: 'Responsable', type: 'person' })).id;
    const settings = `/api/v3/bases/${b.id}/settings`;
    expect((await call(ed, 'PATCH', settings, { startPropertyId: pl, endPropertyId: fin })).statusCode).toBe(400);
    expect((await call(ed, 'PATCH', settings, { endPropertyId: pl })).statusCode).toBe(400);
    const st = await call(ed, 'PATCH', settings, { startPropertyId: pl, dependencies: true });
    expect(st.statusCode, st.body).toBe(200);
    expect((await call(ed, 'PATCH', settings, { endPropertyId: fin })).statusCode).toBe(400);
    // Calendrier : une plage porte sa fin.
    const views = `/api/v3/bases/${b.id}/views`;
    expect((await call(ed, 'POST', views, { name: 'Cal', config: { type: 'calendar', dateId: pl, endId: fin } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', views, { name: 'Cal', config: { type: 'calendar', dateId: pl } })).statusCode).toBe(201);
    // Décalage : la ligne bloquée commence le lendemain de la fin de la plage bloquante, durée conservée.
    const a = await addRow(ed, b.id, { [b.nom]: 'A', [pl]: { start: '2026-01-01', end: '2026-01-05' }, [resp]: 'ed1' });
    const c = await addRow(ed, b.id, { [b.nom]: 'C', [pl]: { start: '2026-01-03', end: '2026-01-04' } }, 201, { blockedBy: [a.id] });
    expect(c.values[pl]).toEqual({ start: '2026-01-06', end: '2026-01-07' });
    const moved = await patchRow(ed, b.id, a.id, { [pl]: { start: '2026-01-01', end: '2026-01-10' } });
    expect(moved.json().shifted.map((r: Row) => r.values[pl])).toEqual([{ start: '2026-01-11', end: '2026-01-12' }]);
    // Mes tâches : l'échéance est la fin de la plage.
    const tasks = (await call(ed, 'GET', '/api/v3/my-tasks')).json() as { tasks: { rowId: string; due: string | null }[] };
    expect(tasks.tasks.find((t) => t.rowId === a.id)!.due).toBe('2026-01-10');
    // Flux iCalendar : DTEND exclusif, lendemain de la fin.
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(200);
    const created = await call(ed, 'POST', `/api/v3/bases/${b.id}/ical`);
    expect(created.statusCode, created.body).toBe(201);
    const token = /\/ical\/([A-Za-z0-9_-]{32})\.ics$/.exec(created.json().url as string)![1]!;
    const ics = (await app.inject({ method: 'GET', url: `/ical/${token}.ics` })).body;
    expect(ics).toContain('DTSTART;VALUE=DATE:20260101');
    expect(ics).toContain('DTEND;VALUE=DATE:20260111');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260111');
  });

  it('migration v34 : refait la table des colonnes sans perdre les réglages ni les colonnes', () => {
    const file = oldDb(33, (raw) => {
      raw.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, kind) VALUES ('b1', 's1', 'Base', '{}', '', 0, 0, 'base')").run();
      raw.prepare("INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, config) VALUES ('d1', 'b1', 'Début', 'date', '[]', 0, 0, '{}'), ('d2', 'b1', 'Fin', 'date', '[]', 1, 0, '{}')").run();
      raw.prepare("INSERT INTO base_settings (base_id, subitems, dependencies, start_property_id, end_property_id) VALUES ('b1', 1, 1, 'd1', 'd2')").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare('SELECT * FROM base_settings').get()).toEqual({ base_id: 'b1', subitems: 1, dependencies: 1, start_property_id: 'd1', end_property_id: 'd2', unique_id_next: 1 });
    expect((up.prepare('SELECT COUNT(*) AS n FROM base_properties').get() as { n: number }).n).toBe(2);
    up.prepare("INSERT INTO base_properties (id, base_id, name, type, created_at) VALUES ('u1', 'b1', 'Réf', 'unique_id', 0)").run();
    expect(() => up.prepare("INSERT INTO base_properties (id, base_id, name, type, created_at) VALUES ('u2', 'b1', 'Réf2', 'unique_id', 0)").run()).toThrow();
    expect(() => up.prepare("INSERT INTO base_properties (id, base_id, name, type, created_at) VALUES ('x', 'b1', 'X', 'inconnu', 0)").run()).toThrow();
    expect(up.pragma('foreign_key_check')).toEqual([]);
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});

describe('budget des expressions régulières', () => {
  it('un budget de pas par lecture, partagé par toutes les lignes ; un seul pour tout un export', async () => {
    const ed = await login('ed1');
    const mk = async (title: string) => {
      const b = await newBase(ed, title);
      const f = (await addProp(ed, b.id, { name: 'F', type: 'formula', formula: 'regexTest(prop("Nom"), "(a|aa)*b")' })).id;
      for (let i = 0; i < 3; i++) await addRow(ed, b.id, { [b.nom]: 'a'.repeat(200) });
      return { ...b, f };
    };
    const one = await mk('Un');
    const saved = limits.regexSteps;
    try {
      // Assez de pas pour environ une ligne et demie : les suivantes sont vides, sans erreur.
      limits.regexSteps = 4500;
      const vals = (await getBase(ed, one.id)).rows.map((r) => r.values[one.f]);
      expect(vals[0]).toBe(false);
      expect(vals.slice(1)).toContain(undefined);
      // Export ZIP de deux bases : le budget est partagé, la seconde base n'a plus de pas.
      limits.regexSteps = 7000;
      const parent = (await call(ed, 'POST', '/api/v3/pages', { spaceId: teamSpace(), title: 'Dossier' })).json().id as string;
      const two = await mk('Deux');
      for (const id of [one.id, two.id]) expect((await call(ed, 'POST', `/api/v3/pages/${id}/move`, { parentId: parent })).statusCode).toBeLessThan(300);
      const res = await call(ed, 'GET', `/api/v3/pages/${parent}/export/zip?subpages=true`);
      expect(res.statusCode, res.body).toBe(200);
      const files = unzipSync(new Uint8Array(res.rawPayload));
      const csv = Object.entries(files).filter(([n]) => n.endsWith('.csv')).map(([, d]) => strFromU8(d));
      expect(csv).toHaveLength(2);
      const filled = csv.join('\n').split('\r\n').filter((l) => l.endsWith(',non')).length;
      // Environ 2 800 pas par ligne : 2 lignes calculées pour tout l'export (un budget par base en aurait donné 4).
      expect(filled).toBe(2);
    } finally { limits.regexSteps = saved; }
    // Budget normal : toutes les lignes sont calculées.
    expect((await getBase(ed, one.id)).rows.map((r) => r.values[one.f])).toEqual([false, false, false]);
  });
});

describe('modèles de ligne', () => {
  async function setup() {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const statut = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const resp = (await addProp(ed, b.id, { name: 'Responsable', type: 'person' })).id;
    const prio = (await addProp(ed, b.id, { name: 'Priorité', type: 'number' })).id;
    return { ed, ...b, statut, resp, prio };
  }
  const tpl = (b: string) => `/api/v3/bases/${b}/row-templates`;

  it('création, lecture dans la base, ligne créée depuis un modèle (valeurs puis values par-dessus), audit sans valeurs', async () => {
    const t = await setup();
    const res = await call(t.ed, 'POST', tpl(t.id), { name: '  Bogue  ', values: { [t.nom]: 'Bogue : ', [t.statut.id]: t.statut.options[1]!.id, [t.resp]: 'ed1', [t.prio]: 2 } });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as { id: string; name: string; values: Record<string, unknown> };
    expect(created.name).toBe('Bogue');
    expect(created.values[t.resp]).toEqual({ id: 'ed1', name: 'Nom ed1' });
    const base = await getBase(t.ed, t.id);
    expect(base.rowTemplates).toEqual([created]);
    expect((await getBase(await login('rd'), t.id)).rowTemplates).toHaveLength(1);
    const r = await addRow(t.ed, t.id, { [t.prio]: 5, [t.resp]: null }, 201, { templateId: created.id });
    expect(r.values).toEqual({ [t.nom]: 'Bogue : ', [t.statut.id]: t.statut.options[1]!.id, [t.prio]: 5 });
    const audits = db.prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'base.template.%'").all() as { action: string; meta: string }[];
    expect(audits.map((a) => a.action)).toEqual(['base.template.add']);
    expect(audits[0]!.meta).not.toContain('Bogue');
    // Modification (valeurs remplacées) et suppression.
    const up = await call(t.ed, 'PATCH', `${tpl(t.id)}/${created.id}`, { name: 'Anomalie', values: { [t.prio]: 1 } });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json()).toEqual({ id: created.id, name: 'Anomalie', values: { [t.prio]: 1 } });
    expect((await call(t.ed, 'DELETE', `${tpl(t.id)}/${created.id}`)).statusCode).toBe(204);
    expect((await getBase(t.ed, t.id)).rowTemplates).toEqual([]);
    expect((db.prepare("SELECT action FROM audit_log WHERE action LIKE 'base.template.%' ORDER BY id").all() as { action: string }[]).map((a) => a.action))
      .toEqual(['base.template.add', 'base.template.update', 'base.template.remove']);
  });

  it('droits, validation, plafond, modèle d’une autre base', async () => {
    const t = await setup();
    const rd = await login('rd');
    expect((await call(rd, 'POST', tpl(t.id), { name: 'x', values: {} })).statusCode).toBe(403);
    const f = (await addProp(t.ed, t.id, { name: 'F', type: 'formula', formula: '1' })).id;
    const uid = (await addProp(t.ed, t.id, { name: 'Réf', type: 'unique_id' })).id;
    const cb = (await addProp(t.ed, t.id, { name: 'Par', type: 'created_by' })).id;
    for (const values of [{ [f]: 1 }, { [uid]: 1 }, { [cb]: 'ed1' }, { inconnue: 'x' }, { [t.prio]: 'abc' }, { [t.resp]: 'personne' }])
      expect((await call(t.ed, 'POST', tpl(t.id), { name: 'x', values })).statusCode, JSON.stringify(values)).toBe(400);
    for (const name of ['', '   ', 'x'.repeat(61)]) expect((await call(t.ed, 'POST', tpl(t.id), { name, values: {} })).statusCode).toBe(400);
    expect((await call(t.ed, 'POST', tpl(t.id), { name: 'x', values: {}, extra: 1 })).statusCode).toBe(400);
    const ids: string[] = [];
    for (let i = 0; i < MAX_TEMPLATES; i++) ids.push((await call(t.ed, 'POST', tpl(t.id), { name: `M${i}`, values: {} })).json().id as string);
    expect((await call(t.ed, 'POST', tpl(t.id), { name: 'trop', values: {} })).statusCode).toBe(409);
    // Modèle d'une autre base : introuvable, à l'usage comme à la modification.
    const other = await newBase(t.ed, 'Autre');
    await addRow(t.ed, other.id, {}, 404, { templateId: ids[0] });
    expect((await call(t.ed, 'PATCH', `${tpl(other.id)}/${ids[0]!}`, { name: 'y' })).statusCode).toBe(404);
    expect((await call(t.ed, 'DELETE', `${tpl(other.id)}/${ids[0]!}`)).statusCode).toBe(404);
    expect((await call(rd, 'DELETE', `${tpl(t.id)}/${ids[0]!}`)).statusCode).toBe(403);
    // Base illisible : 404.
    await restrict(t.id, [{ userId: 'ed1', level: 'write' }]);
    expect((await call(await login('ed2'), 'POST', tpl(t.id), { name: 'x', values: {} })).statusCode).toBe(404);
  });

  it('valeurs devenues invalides ignorées ; colonne ou option supprimée nettoie les modèles ; copie de base', async () => {
    const t = await setup();
    const page = (await call(t.ed, 'POST', '/api/v3/pages', { spaceId: teamSpace(), title: 'Lien' })).json().id as string;
    const lien = (await addProp(t.ed, t.id, { name: 'Lien', type: 'page_link' })).id;
    const m = (await call(t.ed, 'POST', tpl(t.id), { name: 'M', values: { [t.resp]: 'ed2', [lien]: page, [t.statut.id]: t.statut.options[0]!.id, [t.prio]: 3 } })).json() as { id: string };
    const dup = await call(t.ed, 'POST', `/api/v3/pages/${t.id}/duplicate`);
    expect(dup.statusCode).toBe(201);
    const copy = await getBase(t.ed, dup.json().id as string);
    const prioCopy = copy.properties.find((p) => p.name === 'Priorité')!.id;
    expect(copy.rowTemplates).toHaveLength(1);
    expect(copy.rowTemplates[0]!.values[prioCopy]).toBe(3);
    expect(copy.rowTemplates[0]!.id).not.toBe(m.id);
    // ed2 perd l'accès, la page part à la corbeille : la ligne se crée sans ces valeurs.
    await restrict(t.id, [{ userId: 'ed1', level: 'write' }]);
    expect((await call(t.ed, 'DELETE', `/api/v3/pages/${page}`)).statusCode).toBe(204);
    const r = await addRow(t.ed, t.id, {}, 201, { templateId: m.id });
    expect(r.values).toEqual({ [t.statut.id]: t.statut.options[0]!.id, [t.prio]: 3 });
    // Option retirée, colonne supprimée : nettoyées dans le modèle.
    expect((await call(t.ed, 'PATCH', `/api/v3/bases/${t.id}/properties/${t.statut.id}`, { options: t.statut.options.slice(1) })).statusCode).toBe(200);
    expect((await call(t.ed, 'DELETE', `/api/v3/bases/${t.id}/properties/${t.prio}`)).statusCode).toBe(204);
    const vals = JSON.parse((db.prepare('SELECT vals FROM base_row_templates WHERE id = ?').get(m.id) as { vals: string }).vals) as Record<string, unknown>;
    expect(vals[t.statut.id]).toBeUndefined();
    expect(vals[t.prio]).toBeUndefined();
  });
});

describe('graphiques', () => {
  async function setup() {
    const ed = await login('ed1');
    const b = await newBase(ed, 'Ventes');
    const statut = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const tags = await addProp(ed, b.id, { name: 'Tags', type: 'multi_select', options: [{ name: 'a', color: 'red' }, { name: 'b' }, { name: 'c' }] });
    const montant = (await addProp(ed, b.id, { name: 'Montant', type: 'number' })).id;
    const date = (await addProp(ed, b.id, { name: 'Date', type: 'date' })).id;
    const resp = (await addProp(ed, b.id, { name: 'Responsable', type: 'person' })).id;
    const [todo, doing, done] = statut.options.map((o) => o.id) as [string, string, string];
    const [ta, tb, tc] = tags.options.map((o) => o.id) as [string, string, string];
    await addRow(ed, b.id, { [b.nom]: 'r1', [statut.id]: done, [tags.id]: [ta, tb], [montant]: 10, [date]: '2026-01-15', [resp]: 'ed1' });
    await addRow(ed, b.id, { [b.nom]: 'r2', [statut.id]: done, [tags.id]: [ta], [montant]: 30, [date]: '2026-01-20', [resp]: 'ed2' });
    await addRow(ed, b.id, { [b.nom]: 'r3', [statut.id]: todo, [tags.id]: [tc], [montant]: 5, [date]: '2025-12-01' });
    await addRow(ed, b.id, { [b.nom]: 'r4', [montant]: 1 });
    return { ed, ...b, statut, tags, montant, date, resp, todo, doing, done, ta, tb, tc };
  }
  const view = async (s: S, base: string, config: object, status = 201) => {
    const res = await call(s, 'POST', `/api/v3/bases/${base}/views`, { name: 'Graphique', config: { type: 'chart', ...config } });
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as { id: string; config: Record<string, unknown> };
  };
  const chart = async (s: S, base: string, v: string, status = 200) => {
    const res = await call(s, 'GET', `/api/v3/bases/${base}/views/${v}/chart`);
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };

  it('configuration validée, valeurs par défaut', async () => {
    const t = await setup();
    expect((await view(t.ed, t.id, { groupBy: t.statut.id })).config).toEqual({ type: 'chart', groupBy: t.statut.id, chart: 'bar', metric: 'count', limit: 20, sort: [], filters: [], hidden: [] });
    expect((await view(t.ed, t.id, { groupBy: t.date, chart: 'line', metric: 'sum', valueId: t.montant })).config)
      .toEqual({ type: 'chart', groupBy: t.date, chart: 'line', bucket: 'month', metric: 'sum', valueId: t.montant, limit: 20, sort: [], filters: [], hidden: [] });
    for (const config of [
      {}, { groupBy: t.montant }, { groupBy: 'inconnue' }, { groupBy: t.statut.id, metric: 'sum' }, { groupBy: t.statut.id, metric: 'sum', valueId: t.date },
      { groupBy: t.statut.id, bucket: 'month' }, { groupBy: t.statut.id, limit: 4 }, { groupBy: t.statut.id, limit: 51 }, { groupBy: t.statut.id, chart: 'pie' },
      { groupBy: t.statut.id, metric: 'median', valueId: t.montant },
    ]) await view(t.ed, t.id, config, 400);
    expect((await call(t.ed, 'POST', `/api/v3/bases/${t.id}/views`, { name: 'x', config: { type: 'table', chart: 'bar' } })).statusCode).toBe(400);
    expect((await call(t.ed, 'POST', `/api/v3/bases/${t.id}/views`, { name: 'x', config: { type: 'table', groupBy: t.statut.id } })).statusCode).toBe(400);
  });

  it('compte par statut dans l’ordre des options, couleurs, « Sans valeur » en dernier ; somme et moyenne', async () => {
    const t = await setup();
    const v = await view(t.ed, t.id, { groupBy: t.statut.id });
    const res = await chart(t.ed, t.id, v.id);
    expect(res).toEqual({
      buckets: [
        { key: t.todo, label: 'À faire', color: 'gray', value: 1, count: 1 },
        { key: t.done, label: 'Terminé', color: 'green', value: 2, count: 2 },
        { key: '', label: 'Sans valeur', value: 1, count: 1 },
      ],
      total: 4, truncated: false,
    });
    const sum = await view(t.ed, t.id, { groupBy: t.statut.id, metric: 'sum', valueId: t.montant });
    expect((await chart(t.ed, t.id, sum.id)).buckets.map((x: { value: number }) => x.value)).toEqual([5, 40, 1]);
    const avg = await view(t.ed, t.id, { groupBy: t.statut.id, metric: 'avg', valueId: t.montant });
    const a = await chart(t.ed, t.id, avg.id);
    expect(a.buckets.map((x: { value: number }) => x.value)).toEqual([5, 20, 1]);
    expect(a.total).toBe(11.5);
  });

  it('Sélection multiple : une ligne par option ; dates chronologiques par mois ; limite et « Autres »', async () => {
    const t = await setup();
    const m = await chart(t.ed, t.id, (await view(t.ed, t.id, { groupBy: t.tags.id })).id);
    expect(m.buckets).toEqual([
      { key: t.ta, label: 'a', color: 'red', value: 2, count: 2 },
      { key: t.tb, label: 'b', color: 'gray', value: 1, count: 1 },
      { key: t.tc, label: 'c', color: 'gray', value: 1, count: 1 },
      { key: '', label: 'Sans valeur', value: 1, count: 1 },
    ]);
    expect(m.total).toBe(4);
    const d = await chart(t.ed, t.id, (await view(t.ed, t.id, { groupBy: t.date })).id);
    expect(d.buckets.map((x: { key: string; label: string; count: number }) => [x.key, x.label, x.count])).toEqual([['2025-12', 'décembre 2025', 1], ['2026-01', 'janvier 2026', 2], ['', 'Sans valeur', 1]]);
    const w = await chart(t.ed, t.id, (await view(t.ed, t.id, { groupBy: t.date, bucket: 'week' })).id);
    expect(w.buckets.map((x: { key: string }) => x.key)).toEqual(['2025-12-01', '2026-01-12', '2026-01-19', '']);
    expect(w.buckets[1].label).toBe('Semaine du 12/01/2026');
    // Texte : 6 groupes distincts, limite 5 : le plus petit part dans « Autres ».
    for (const n of ['r1', 'r1', 'x', 'y']) await addRow(t.ed, t.id, { [t.nom]: n });
    const txt = await chart(t.ed, t.id, (await view(t.ed, t.id, { groupBy: t.nom, limit: 5 })).id);
    expect(txt.buckets).toHaveLength(5);
    expect(txt.buckets[0]).toEqual({ key: 'r1', label: 'r1', value: 3, count: 3 });
    expect(txt.truncated).toBe(true);
    expect(txt.other).toEqual({ value: 1, count: 1 });
  });

  it('filtres de la vue appliqués ; droits et visibilité du lecteur ; aucune donnée de ligne', async () => {
    const t = await setup();
    const v = await view(t.ed, t.id, { groupBy: t.resp, filters: [{ propertyId: t.montant, op: 'gt', value: 2 }] });
    const res = await chart(t.ed, t.id, v.id);
    expect(res.buckets).toEqual([
      { key: 'ed2', label: 'Nom ed2', value: 1, count: 1 },
      { key: 'ed1', label: 'Nom ed1', value: 1, count: 1 },
      { key: '', label: 'Sans valeur', value: 1, count: 1 },
    ].sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label, 'fr'))));
    expect(JSON.stringify(res)).not.toMatch(/r1|r2|r3/);
    // Lecteur : lit le graphique ; personne sans compte : 404 ; jeton sans portée read : refusé.
    expect((await chart(await login('rd'), t.id, v.id)).total).toBe(3);
    expect((await call(null, 'GET', `/api/v3/bases/${t.id}/views/${v.id}/chart`)).statusCode).toBe(401);
    // ed2 perd l'accès à la base : son nom n'est plus montré, la ligne passe dans « Sans valeur ».
    await restrict(t.id, [{ userId: 'ed1', level: 'write' }, { userId: 'rd', level: 'read' }]);
    const after = await chart(await login('rd'), t.id, v.id);
    expect(after.buckets).toEqual([{ key: 'ed1', label: 'Nom ed1', value: 1, count: 1 }, { key: '', label: 'Sans valeur', value: 2, count: 2 }]);
    expect((await call(await login('ed2'), 'GET', `/api/v3/bases/${t.id}/views/${v.id}/chart`)).statusCode).toBe(404);
    // Vue d'une autre nature ou inconnue.
    await chart(t.ed, t.id, t.view, 400);
    await chart(t.ed, t.id, 'inconnue', 404);
  });

  it('colonne supprimée : regroupement perdu = tableau, valeur perdue = comptage', async () => {
    const t = await setup();
    const v1 = await view(t.ed, t.id, { groupBy: t.statut.id, metric: 'sum', valueId: t.montant });
    const v2 = await view(t.ed, t.id, { groupBy: t.tags.id });
    expect((await call(t.ed, 'DELETE', `/api/v3/bases/${t.id}/properties/${t.montant}`)).statusCode).toBe(204);
    expect((await call(t.ed, 'DELETE', `/api/v3/bases/${t.id}/properties/${t.tags.id}`)).statusCode).toBe(204);
    const views = (await getBase(t.ed, t.id)).views;
    expect(views.find((x) => x.id === v1.id)!.config).toEqual({ type: 'chart', groupBy: t.statut.id, chart: 'bar', metric: 'count', limit: 20, sort: [], filters: [], hidden: [] });
    expect(views.find((x) => x.id === v2.id)!.config.type).toBe('table');
  });

  it('Plage de dates, case à cocher et créé le comme regroupements', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed);
    const pl = (await addProp(ed, b.id, { name: 'Plage', type: 'date_range' })).id;
    const ok = (await addProp(ed, b.id, { name: 'OK', type: 'checkbox' })).id;
    const ct = (await addProp(ed, b.id, { name: 'Créé', type: 'created_time' })).id;
    await addRow(ed, b.id, { [pl]: { start: '2026-03-02', end: '2026-04-01' }, [ok]: true });
    await addRow(ed, b.id, { [pl]: { start: '2025-03-02' } });
    const y = await chart(ed, b.id, (await view(ed, b.id, { groupBy: pl, bucket: 'year' })).id);
    expect(y.buckets.map((x: { key: string }) => x.key)).toEqual(['2025', '2026']);
    const c = await chart(ed, b.id, (await view(ed, b.id, { groupBy: ok })).id);
    expect(c.buckets.map((x: { label: string; count: number }) => [x.label, x.count])).toEqual([['Non', 1], ['Oui', 1]]);
    const d = await chart(ed, b.id, (await view(ed, b.id, { groupBy: ct, bucket: 'day' })).id);
    expect(d.buckets).toHaveLength(1);
    expect(d.buckets[0].count).toBe(2);
  });
});
