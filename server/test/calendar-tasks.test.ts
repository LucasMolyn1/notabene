// Bases (P4, P9) : vue calendrier, flux iCalendar par adresse secrète, « Mes tâches » et progression.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { backupTo } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { escapeText, foldLine, MAX_ICAL_EVENTS } from '../src/lib/base-ical.js';
import { MAX_TASK_BASES, MAX_TASKS } from '../src/lib/base-tasks.js';
import { addProperty, calendarColumns, createBase, propertiesOf } from '../src/lib/bases.js';
import { maskShareToken } from '../src/lib/shares.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
const logs: string[] = [];

const sessions = new Map<string, S>();
async function boot(logger = false) {
  sessions.clear();
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent', ...(logger ? { logger: { level: 'info', stream: { write: (s: string) => { logs.push(s); } } } } : {}) });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
}
beforeEach(async () => { logs.length = 0; await boot(); });
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
const bearerOf = async (who: string, scopes: string[]) => {
  const res = await call(await login(who), 'POST', '/api/v3/tokens', { name: 'outil', scopes, expiresInDays: 7 });
  expect(res.statusCode, res.body).toBe(201);
  return { authorization: `Bearer ${res.json().token as string}` };
};
const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
const enableSharing = async (on = true) => expect((await call(await login('admin'), 'PUT', '/api/v3/admin/sharing', { enabled: on })).statusCode).toBe(200);

interface Prop { id: string; options: { id: string; name: string }[] }
async function newBase(s: S, title = 'Tâches', spaceId = teamSpace()) {
  const res = await call(s, 'POST', '/api/v3/bases', { spaceId, title });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json() as { page: { id: string }; properties: Prop[]; views: { id: string }[] };
  return { id: b.page.id, nom: b.properties[0]!.id, view: b.views[0]!.id };
}
const addProp = async (s: S, base: string, body: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Prop;
};
const addRow = async (s: S, base: string, values: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/rows`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
};
const restrict = async (page: string, entries: { userId: string; level: 'read' | 'write' }[]) =>
  expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${page}/permissions`, { entries })).statusCode).toBe(200);

/** Base « Planning » : Nom, Début, Fin, Responsable, Statut ; deux lignes datées, une sans date. */
async function planning() {
  const ed = await login('ed1');
  const b = await newBase(ed, 'Planning');
  const debut = (await addProp(ed, b.id, { name: 'Début', type: 'date' })).id;
  const fin = (await addProp(ed, b.id, { name: 'Fin', type: 'date' })).id;
  const resp = (await addProp(ed, b.id, { name: 'Responsable', type: 'person' })).id;
  const statut = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
  const r1 = await addRow(ed, b.id, { [b.nom]: 'Réunion', [debut]: '2026-11-10', [fin]: '2026-11-12', [resp]: 'ed1', [statut.id]: statut.options[1]!.id });
  const r2 = await addRow(ed, b.id, { [b.nom]: 'Livraison', [debut]: '2026-12-01' });
  await addRow(ed, b.id, { [b.nom]: 'Sans date' });
  return { ed, ...b, debut, fin, resp, statut, r1, r2 };
}
const createFeed = async (s: S | { authorization: string }, base: string, status = 201, body?: object) => {
  const res = 'cookies' in s ? await call(s, 'POST', `/api/v3/bases/${base}/ical`, body) : await app.inject({ method: 'POST', url: `/api/v3/bases/${base}/ical`, headers: s, payload: body });
  expect(res.statusCode, res.body).toBe(status);
  return res;
};
const tokenOf = (url: string) => /\/ical\/([A-Za-z0-9_-]{32})\.ics$/.exec(url)![1]!;
const feed = (token: string) => app.inject({ method: 'GET', url: `/ical/${token}.ics` });
const unfold = (body: string) => body.replace(/\r\n /g, '');

describe('vue calendrier', () => {
  it('se crée au mois par défaut, avec des colonnes Date de la base, distinctes', async () => {
    const p = await planning();
    const views = `/api/v3/bases/${p.id}/views`;
    const v = await call(p.ed, 'POST', views, { name: 'Calendrier', config: { type: 'calendar' } });
    expect(v.statusCode, v.body).toBe(201);
    expect(v.json().config).toEqual({ type: 'calendar', mode: 'month', sort: [], filters: [], hidden: [] });
    const w = await call(p.ed, 'POST', views, { name: 'Semaine', config: { type: 'calendar', mode: 'week', dateId: p.debut, endId: p.fin } });
    expect(w.json().config).toEqual({ type: 'calendar', mode: 'week', dateId: p.debut, endId: p.fin, sort: [], filters: [], hidden: [] });
    for (const config of [
      { type: 'calendar', dateId: p.nom }, // colonne texte
      { type: 'calendar', endId: p.resp },
      { type: 'calendar', dateId: 'inconnue' },
      { type: 'calendar', dateId: p.debut, endId: p.debut },
      { type: 'calendar', mode: 'year' },
      { type: 'calendar', groupBy: p.statut.id },
      { type: 'calendar', scale: 'week' },
      { type: 'table', mode: 'month' },
      { type: 'timeline', dateId: p.debut },
      { type: 'calendar', start: p.debut },
    ]) expect((await call(p.ed, 'POST', views, { name: 'x', config })).statusCode, JSON.stringify(config)).toBe(400);
    // Modification : mêmes règles.
    expect((await call(p.ed, 'PATCH', `${views}/${w.json().id as string}`, { config: { type: 'calendar', dateId: p.nom } })).statusCode).toBe(400);
  });

  it('supprimer une colonne de date nettoie la vue, la copie de base suit les nouvelles colonnes', async () => {
    const p = await planning();
    const v = (await call(p.ed, 'POST', `/api/v3/bases/${p.id}/views`, { name: 'Cal', config: { type: 'calendar', dateId: p.debut, endId: p.fin } })).json() as { id: string };
    expect((await call(p.ed, 'DELETE', `/api/v3/bases/${p.id}/properties/${p.fin}`)).statusCode).toBe(204);
    const after = (await call(p.ed, 'GET', `/api/v3/bases/${p.id}`)).json() as { views: { id: string; config: Record<string, unknown> }[] };
    expect(after.views.find((x) => x.id === v.id)!.config).toEqual({ type: 'calendar', mode: 'month', dateId: p.debut, sort: [], filters: [], hidden: [] });
    const dup = await call(p.ed, 'POST', `/api/v3/pages/${p.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const copy = (await call(p.ed, 'GET', `/api/v3/bases/${dup.json().id as string}`)).json() as { properties: { id: string; name: string }[]; views: { config: Record<string, unknown> }[] };
    const cal = copy.views.find((x) => x.config.type === 'calendar')!;
    expect(cal.config.dateId).toBe(copy.properties.find((x) => x.name === 'Début')!.id);
  });

  it('colonnes par défaut : celles de la vue, sinon les réglages, sinon la première colonne Date', () => {
    const props = [{ id: 'a', type: 'date' }, { id: 'b', type: 'date' }, { id: 't', type: 'text' }] as Parameters<typeof calendarColumns>[0];
    const none = { startPropertyId: null, endPropertyId: null };
    expect(calendarColumns(props, none)).toEqual({ dateId: 'a', endId: null });
    expect(calendarColumns(props, { startPropertyId: 'b', endPropertyId: 'a' })).toEqual({ dateId: 'b', endId: 'a' });
    expect(calendarColumns(props, { startPropertyId: 'b', endPropertyId: 'a' }, { dateId: 'a', endId: 'b' })).toEqual({ dateId: 'a', endId: 'b' });
    expect(calendarColumns(props, none, { dateId: 't' })).toEqual({ dateId: 'a', endId: null });
    expect(calendarColumns(props, { startPropertyId: null, endPropertyId: 'a' })).toEqual({ dateId: 'a', endId: null });
    expect(calendarColumns([], none)).toEqual({ dateId: null, endId: null });
  });
});

describe('flux iCalendar : gestion', () => {
  it('migration v33 additive depuis v32', () => {
    const file = oldDb(32);
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect((up.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(0);
    up.close();
  });

  it('demande le partage public, rend l’adresse une seule fois et ne garde que l’empreinte du jeton', async () => {
    const p = await planning();
    await createFeed(p.ed, p.id, 403); // partage public coupé à l'instance
    await enableSharing();
    const state0 = (await call(p.ed, 'GET', `/api/v3/bases/${p.id}/ical`)).json();
    expect(state0).toEqual({ available: true, active: false, createdAt: null });
    const res = await createFeed(p.ed, p.id);
    const url = res.json().url as string;
    expect(Object.keys(res.json())).toEqual(['url']);
    expect(url).toMatch(/^http:\/\/localhost:3000\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
    const token = tokenOf(url);
    const state = await call(p.ed, 'GET', `/api/v3/bases/${p.id}/ical`);
    expect(state.json()).toMatchObject({ available: true, active: true });
    expect(typeof state.json().createdAt).toBe('number');
    expect(state.body).not.toContain(token);
    // Jamais stocké ni journalisé : ni dans la table du flux, ni dans l'audit.
    const stored = JSON.stringify(db.prepare('SELECT * FROM base_ical_feeds').all());
    expect(stored).not.toContain(token);
    expect(stored).toContain(createHashHex(token));
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(token);
    const actions = (db.prepare("SELECT action, target FROM audit_log WHERE action LIKE 'base.ical.%'").all() as { action: string; target: string }[]);
    expect(actions).toEqual([{ action: 'base.ical.create', target: p.id }]);
  });

  it('droits : écriture sur la base ; état et création en session web, révocation aussi par jeton write ; base illisible = 404', async () => {
    const p = await planning();
    await enableSharing();
    expect((await call(await login('rd'), 'POST', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(403);
    expect((await call(await login('rd'), 'GET', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(403);
    expect((await call(null, 'GET', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(401);
    const writeToken = await bearerOf('ed1', ['read', 'write']);
    await createFeed(await bearerOf('ed1', ['read']), p.id, 403);
    await createFeed(writeToken, p.id, 403);
    expect((await app.inject({ method: 'GET', url: `/api/v3/bases/${p.id}/ical`, headers: writeToken })).statusCode).toBe(403);
    const token = tokenOf((await createFeed(p.ed, p.id)).json().url as string);
    expect((await app.inject({ method: 'DELETE', url: `/api/v3/bases/${p.id}/ical`, headers: await bearerOf('ed1', ['read']) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v3/bases/${p.id}/ical`, headers: writeToken })).statusCode).toBe(204);
    expect((await feed(token)).statusCode).toBe(404);
    await createFeed(p.ed, p.id);
    await restrict(p.id, [{ userId: 'ed1', level: 'write' }, { userId: 'rd', level: 'read' }]);
    expect((await call(await login('ed2'), 'POST', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(404);
    expect((await call(await login('ed2'), 'DELETE', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(404);
    expect((await call(await login('rd'), 'DELETE', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(403);
    // Une page qui n'est pas une base : 404.
    const page = (db.prepare("SELECT id FROM pages WHERE kind = 'doc' AND space_id = ? LIMIT 1").get(teamSpace()) as { id: string }).id;
    expect((await call(p.ed, 'POST', `/api/v3/bases/${page}/ical`)).statusCode).toBe(404);
  });

  it('un espace personnel ou sans partage public ne crée pas de flux', async () => {
    await enableSharing();
    const ed = await login('ed1');
    db.prepare('UPDATE spaces SET sharing_enabled = 0 WHERE id = ?').run(teamSpace());
    const b = await newBase(ed);
    await createFeed(ed, b.id, 403);
    expect((await call(ed, 'GET', `/api/v3/bases/${b.id}/ical`)).json()).toMatchObject({ available: false, active: false });
  });

  it('rotation : l’ancienne adresse cesse aussitôt ; révocation : plus rien', async () => {
    const p = await planning();
    await enableSharing();
    const t1 = tokenOf((await createFeed(p.ed, p.id)).json().url as string);
    expect((await feed(t1)).statusCode).toBe(200);
    const t2 = tokenOf((await createFeed(p.ed, p.id, 200)).json().url as string);
    expect(t2).not.toBe(t1);
    expect((await feed(t1)).statusCode).toBe(404);
    expect((await feed(t2)).statusCode).toBe(200);
    expect((await call(p.ed, 'DELETE', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(204);
    expect((await feed(t2)).statusCode).toBe(404);
    expect((await call(p.ed, 'GET', `/api/v3/bases/${p.id}/ical`)).json()).toMatchObject({ active: false, createdAt: null });
    expect((await call(p.ed, 'DELETE', `/api/v3/bases/${p.id}/ical`)).statusCode).toBe(204); // idempotent
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'base.ical.%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['base.ical.create', 'base.ical.rotate', 'base.ical.revoke']);
  });
});

// Même empreinte que le serveur (SHA-256 hexadécimal), recalculée ici pour vérifier ce qui est stocké.
const createHashHex = (token: string) => createHash('sha256').update(token).digest('hex');

describe('flux iCalendar : lecture publique', () => {
  const ready = async () => {
    const p = await planning();
    await enableSharing();
    return { ...p, token: tokenOf((await createFeed(p.ed, p.id)).json().url as string) };
  };

  it('contenu minimal, dates de fin exclusives, en-têtes durcis', async () => {
    const p = await ready();
    const res = await feed(p.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers.location).toBeUndefined();
    const body = res.body;
    expect(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(body).toContain(`UID:${p.r1.id}@localhost\r\n`);
    // Sans vue calendrier ni réglages : première colonne Date, pas de fin (événement d'un jour).
    expect(body).toContain('DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261111\r\n');
    expect(body).toContain('DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\n');
    expect(body).toContain('SUMMARY:Réunion\r\n');
    // Ni personne, ni statut, ni lien vers l'application, ni titre de la base, ni ligne sans date.
    for (const absent of ['Nom ed1', 'ed1', 'En cours', 'localhost:3000', 'Planning', 'Sans date', 'ATTENDEE', 'ORGANIZER', 'URL', 'DESCRIPTION']) expect(body).not.toContain(absent);
  });

  it('colonnes : celles de la première vue calendrier, sinon les réglages', async () => {
    const p = await ready();
    expect((await call(p.ed, 'PATCH', `/api/v3/bases/${p.id}/settings`, { startPropertyId: p.debut, endPropertyId: p.fin })).statusCode).toBe(200);
    expect((await feed(p.token)).body).toContain('DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261113\r\n');
    // Vue calendrier sur Fin seule : la ligne 1 commence et finit le 12, la ligne 2 (sans fin) disparaît.
    expect((await call(p.ed, 'POST', `/api/v3/bases/${p.id}/views`, { name: 'Cal', config: { type: 'calendar', dateId: p.fin } })).statusCode).toBe(201);
    const body = (await feed(p.token)).body;
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(body).toContain('DTSTART;VALUE=DATE:20261112\r\nDTEND;VALUE=DATE:20261113\r\n');
  });

  it('échappement RFC 5545, aucune injection de ligne, pliage à 75 octets', async () => {
    const p = await ready();
    await addRow(p.ed, p.id, { [p.nom]: 'a,b;c\\d\r\nATTENDEE:mailto:x@example.com\nEND:VEVENT', [p.debut]: '2026-11-20' });
    await addRow(p.ed, p.id, { [p.nom]: 'é'.repeat(120), [p.debut]: '2026-11-21' });
    await addRow(p.ed, p.id, { [p.nom]: '   ', [p.debut]: '2026-11-22' });
    const body = (await feed(p.token)).body;
    for (const line of body.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(body.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))).toEqual([]);
    expect(body.match(/^END:VEVENT$/gm)).toHaveLength(5);
    const flat = unfold(body);
    expect(flat).toContain('SUMMARY:a\\,b\\;c\\\\d\\nATTENDEE:mailto:x@example.com\\nEND:VEVENT\r\n');
    expect(flat).toContain(`SUMMARY:${'é'.repeat(120)}\r\n`);
    expect(flat).toContain('SUMMARY:Sans titre\r\n');
    // Fonctions seules.
    expect(escapeText('x\u0007y\tz')).toBe('xy\tz');
    expect(foldLine('a'.repeat(160)).split('\r\n').map((l) => l.length)).toEqual([75, 75, 12]);
  });

  it(`au plus ${MAX_ICAL_EVENTS} événements`, async () => {
    const p = await ready();
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    db.transaction(() => { for (let i = 0; i < MAX_ICAL_EVENTS + 5; i++) ins.run(`r${i}`, p.id, 100 + i, JSON.stringify({ [p.debut]: '2027-01-01' })); })();
    expect((await feed(p.token)).body.match(/BEGIN:VEVENT/g)).toHaveLength(MAX_ICAL_EVENTS);
  });

  it('404 uniforme : jeton inconnu ou mal formé, partage coupé, espace fermé, restriction changée, corbeille', async () => {
    const p = await ready();
    const ref = await feed('A'.repeat(32));
    expect(ref.statusCode).toBe(404);
    expect(ref.headers['cache-control']).toBe('no-store');
    const same = (r: Awaited<ReturnType<typeof feed>>) => { expect(r.statusCode).toBe(404); expect(r.body).toBe(ref.body); expect(r.headers['content-type']).toBe(ref.headers['content-type']); };
    for (const url of [`/ical/${p.token}x.ics`, `/ical/${p.token.slice(1)}.ics`, `/ical/${p.token}`, `/ical/${p.token}.ICS`, '/ical/..%2F..%2Fetc.ics']) same(await app.inject({ method: 'GET', url }));
    // Espace sans partage public.
    db.prepare('UPDATE spaces SET sharing_enabled = 0 WHERE id = ?').run(teamSpace());
    same(await feed(p.token));
    db.prepare('UPDATE spaces SET sharing_enabled = 1 WHERE id = ?').run(teamSpace());
    expect((await feed(p.token)).statusCode).toBe(200);
    // Restriction posée après la création : muet ; nouvelle création : servi de nouveau, puis restriction retirée : muet.
    await restrict(p.id, [{ userId: 'ed1', level: 'write' }]);
    same(await feed(p.token));
    // Base restreinte : confirmation demandée (409), puis plus pour la même restriction.
    const refused = (await createFeed(p.ed, p.id, 409)).json();
    expect(refused.detail).toContain('permissions restreintes');
    expect(refused.code).toBe('restricted');
    await createFeed(p.ed, p.id, 409, { confirmRestricted: false });
    const t2 = tokenOf((await createFeed(p.ed, p.id, 200, { confirmRestricted: true })).json().url as string);
    expect((await feed(t2)).statusCode).toBe(200);
    const t2b = tokenOf((await createFeed(p.ed, p.id, 200)).json().url as string);
    expect((await feed(t2)).statusCode).toBe(404);
    expect((await feed(t2b)).statusCode).toBe(200);
    await restrict(p.id, [{ userId: 'ed1', level: 'write' }, { userId: 'ed2', level: 'read' }]);
    same(await feed(t2b));
    await createFeed(p.ed, p.id, 409); // restriction changée : nouvelle confirmation
    await restrict(p.id, []);
    same(await feed(t2));
    const t3 = tokenOf((await createFeed(p.ed, p.id, 200)).json().url as string);
    // Corbeille : flux supprimé, la restauration ne le rouvre pas.
    expect((await call(p.ed, 'DELETE', `/api/v3/pages/${p.id}`)).statusCode).toBe(204);
    same(await feed(t3));
    expect(db.prepare('SELECT 1 FROM base_ical_feeds WHERE base_id = ?').get(p.id)).toBeUndefined();
    expect((await call(p.ed, 'POST', `/api/v3/pages/${p.id}/restore`)).statusCode).toBe(200);
    same(await feed(t3));
  });

  it('couper le partage public de l’instance retire les flux', async () => {
    const p = await ready();
    await enableSharing(false);
    expect((await feed(p.token)).statusCode).toBe(404);
    await enableSharing(true);
    expect((await feed(p.token)).statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(0);
  });

  it('couper le partage d’un espace ou y déplacer la base retire le flux', async () => {
    const p = await ready();
    const admin = await login('admin');
    const other = await call(admin, 'POST', '/api/v3/spaces', { name: 'Autre', access: 'everyone' });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json().id as string;
    expect((await call(p.ed, 'POST', `/api/v3/pages/${p.id}/move`, { parentId: null, spaceId: otherId })).statusCode).toBe(200);
    expect((await feed(p.token)).statusCode).toBe(404);
    expect(db.prepare('SELECT 1 FROM base_ical_feeds WHERE base_id = ?').get(p.id)).toBeUndefined();
    const t = tokenOf((await createFeed(p.ed, p.id)).json().url as string);
    expect((await call(admin, 'PATCH', `/api/v3/spaces/${otherId}`, { sharing: false })).statusCode).toBe(200);
    expect((await call(admin, 'PATCH', `/api/v3/spaces/${otherId}`, { sharing: true })).statusCode).toBe(200);
    expect((await feed(t)).statusCode).toBe(404);
    expect(db.prepare('SELECT 1 FROM base_ical_feeds WHERE base_id = ?').get(p.id)).toBeUndefined();
  });

  it('compte désactivé ou supprimé : ses flux sont révoqués', async () => {
    const p = await ready();
    const other = await newBase(await login('ed2'), 'Autre');
    const t2 = tokenOf((await createFeed(await login('ed2'), other.id)).json().url as string);
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run('ed1');
    expect((await feed(p.token)).statusCode).toBe(404);
    expect((await feed(t2)).statusCode).toBe(200);
    db.prepare('DELETE FROM users WHERE id = ?').run('ed2');
    expect((await feed(t2)).statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(0);
  });

  it('suppression définitive de la base : flux supprimé (cascade)', async () => {
    const p = await ready();
    db.prepare('DELETE FROM pages WHERE id = ?').run(p.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(0);
  });

  it('ni copié avec la base, ni gardé dans une sauvegarde', async () => {
    const p = await ready();
    const dup = await call(p.ed, 'POST', `/api/v3/pages/${p.id}/duplicate`);
    expect(dup.statusCode).toBe(201);
    expect((await call(p.ed, 'GET', `/api/v3/bases/${dup.json().id as string}/ical`)).json()).toMatchObject({ active: false });
    const dir = mkdtempSync(join(tmpdir(), 'nb-ical-'));
    try {
      const file = join(dir, 'b.db');
      await backupTo(db, file);
      const copy = new Database(file, { readonly: true });
      expect((copy.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(0);
      copy.close();
      expect((db.prepare('SELECT COUNT(*) AS n FROM base_ical_feeds').get() as { n: number }).n).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('un en-tête Authorization ou une session ne change rien à la lecture du flux', async () => {
    const p = await ready();
    expect((await app.inject({ method: 'GET', url: `/ical/${p.token}.ics`, headers: { authorization: 'Basic eDp5' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/ical/${p.token}.ics`, headers: { authorization: 'Bearer invalide' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/ical/${p.token}.ics`, cookies: p.ed.cookies })).statusCode).toBe(200);
  });

  it('limite de débit stricte par adresse IP', async () => {
    const p = await ready();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await feed(p.token)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('le jeton n’apparaît jamais dans les journaux', async () => {
    await app.close(); db.close();
    await boot(true);
    const p = await ready();
    await feed(p.token);
    await app.inject({ method: 'GET', url: `/ical/${p.token}.ics?x=1` });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(p.token);
    expect(logs.join('\n')).toContain('/ical/[jeton]');
    expect(maskShareToken(`/ical/${p.token}.ics`)).toBe('/ical/[jeton]');
  });
});

interface Task { baseId: string; baseTitle: string; spaceId: string; rowId: string; title: string; due: string | null; status: { name: string; color: string; done: boolean } | null; done: boolean }
const tasksOf = async (s: S | null, query = '') => {
  const res = await call(s, 'GET', `/api/v3/my-tasks${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { tasks: Task[]; truncated: boolean };
};

describe('mes tâches', () => {
  it('lignes où une colonne Personne me désigne, triées : en retard, échéance, sans échéance', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed, 'Projet A');
    const debut = (await addProp(ed, b.id, { name: 'Début', type: 'date' })).id;
    const fin = (await addProp(ed, b.id, { name: 'Échéance', type: 'date' })).id;
    const qui = (await addProp(ed, b.id, { name: 'Qui', type: 'person' })).id;
    const aide = (await addProp(ed, b.id, { name: 'Aide', type: 'person' })).id;
    const st = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    const [todo, doing, done] = st.options.map((o) => o.id) as [string, string, string];
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/settings`, { startPropertyId: debut, endPropertyId: fin })).statusCode).toBe(200);
    const futur = await addRow(ed, b.id, { [b.nom]: 'Futur', [debut]: '2000-01-01', [fin]: '2999-01-01', [qui]: 'ed1', [st.id]: todo });
    const retard = await addRow(ed, b.id, { [b.nom]: 'Retard', [fin]: '2001-05-05', [aide]: 'ed1', [st.id]: doing });
    const fini = await addRow(ed, b.id, { [b.nom]: 'Fini', [fin]: '2000-02-02', [qui]: 'ed1', [st.id]: done });
    const libre = await addRow(ed, b.id, { [qui]: 'ed1' });
    await addRow(ed, b.id, { [b.nom]: 'Autre', [qui]: 'ed2', [fin]: '2000-01-01' });
    await addRow(ed, b.id, { [b.nom]: 'Personne' });

    const all = await tasksOf(ed);
    expect(all.truncated).toBe(false);
    expect(all.tasks.map((t) => t.rowId)).toEqual([retard.id, fini.id, futur.id, libre.id]);
    expect(all.tasks[0]).toEqual({
      baseId: b.id, baseTitle: 'Projet A', spaceId: teamSpace(), rowId: retard.id, title: 'Retard', due: '2001-05-05',
      status: { name: 'En cours', color: 'blue', done: false }, done: false,
    });
    expect(all.tasks[1]).toMatchObject({ title: 'Fini', status: { name: 'Terminé', done: true }, done: true });
    expect(all.tasks[3]).toMatchObject({ title: '', due: null, status: null, done: false });
    expect((await tasksOf(ed, '?done=true')).tasks).toHaveLength(4);
    expect((await tasksOf(ed, '?done=false')).tasks.map((t) => t.rowId)).toEqual([retard.id, futur.id, libre.id]);
    expect((await call(ed, 'GET', '/api/v3/my-tasks?done=peut-etre')).statusCode).toBe(400);
    // ed2 ne voit que sa ligne ; personne sans compte : 401.
    expect((await tasksOf(await login('ed2'))).tasks.map((t) => t.title)).toEqual(['Autre']);
    expect((await call(null, 'GET', '/api/v3/my-tasks')).statusCode).toBe(401);
  });

  it('case à cocher sans statut, échéance par défaut sur la première colonne Date', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed, 'Liste');
    const quand = (await addProp(ed, b.id, { name: 'Quand', type: 'date' })).id;
    const qui = (await addProp(ed, b.id, { name: 'Qui', type: 'person' })).id;
    const ok = (await addProp(ed, b.id, { name: 'Fait', type: 'checkbox' })).id;
    await addRow(ed, b.id, { [b.nom]: 'Coché', [qui]: 'ed1', [ok]: true, [quand]: '2030-01-01' });
    await addRow(ed, b.id, { [b.nom]: 'Pas coché', [qui]: 'ed1', [quand]: '2030-01-02' });
    const t = (await tasksOf(ed)).tasks;
    expect(t.map((x) => [x.title, x.due, x.done, x.status])).toEqual([['Coché', '2030-01-01', true, null], ['Pas coché', '2030-01-02', false, null]]);
    expect((await tasksOf(ed, '?done=false')).tasks.map((x) => x.title)).toEqual(['Pas coché']);
  });

  it('seulement les bases lisibles : restreinte, à la corbeille, espace non lisible', async () => {
    const ed = await login('ed1');
    const a = await newBase(ed, 'Visible');
    const qa = (await addProp(ed, a.id, { name: 'Qui', type: 'person' })).id;
    await addRow(ed, a.id, { [a.nom]: 'ok', [qa]: 'ed1' });
    const r = await newBase(ed, 'Restreinte');
    const qr = (await addProp(ed, r.id, { name: 'Qui', type: 'person' })).id;
    await addRow(ed, r.id, { [r.nom]: 'cachée', [qr]: 'ed1' });
    await restrict(r.id, [{ userId: 'ed2', level: 'write' }]);
    const t = await newBase(ed, 'Corbeille');
    const qt = (await addProp(ed, t.id, { name: 'Qui', type: 'person' })).id;
    await addRow(ed, t.id, { [t.nom]: 'jetée', [qt]: 'ed1' });
    expect((await call(ed, 'DELETE', `/api/v3/pages/${t.id}`)).statusCode).toBe(204);
    // Espace sans membres : ed1 n'y lit rien, même si une cellule le désigne (écrite directement).
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('ferme', 'Fermé', 0, 0)").run();
    const f = createBase(db, { spaceId: 'ferme', title: 'Fermée' }, 'admin');
    const qf = addProperty(db, f.id, { name: 'Qui', type: 'person' }).id;
    const nf = propertiesOf(db, f.id)[0]!.id;
    db.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES ('rf', ?, 0, ?, 0, 0)").run(f.id, JSON.stringify({ [nf]: 'fermée', [qf]: 'ed1' }));
    expect((await tasksOf(ed)).tasks.map((x) => x.title)).toEqual(['ok']);
    // Un jeton de portée read suffit ; il ne voit pas plus que la personne.
    const res = await app.inject({ method: 'GET', url: '/api/v3/my-tasks', headers: await bearerOf('ed1', ['read']) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tasks: Task[] }).tasks.map((x) => x.title)).toEqual(['ok']);
    // L'administrateur, qui lit l'espace fermé, voit la ligne si elle le désigne : ici non.
    expect((await tasksOf(await login('admin'))).tasks).toEqual([]);
  });

  it('limite de débit : 30 par minute', async () => {
    const ed = await login('ed1');
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await call(ed, 'GET', '/api/v3/my-tasks')).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it(`plafonds : ${MAX_TASKS} tâches, ${MAX_TASK_BASES} bases parcourues`, async () => {
    const ed = await login('ed1');
    const b = await newBase(ed, 'Grosse');
    const qui = (await addProp(ed, b.id, { name: 'Qui', type: 'person' })).id;
    const ins = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    db.transaction(() => { for (let i = 0; i < MAX_TASKS + 10; i++) ins.run(`g${i}`, b.id, i, JSON.stringify({ [qui]: 'ed1' })); })();
    const big = await tasksOf(ed);
    expect(big.tasks).toHaveLength(MAX_TASKS);
    expect(big.truncated).toBe(true);
    db.prepare('DELETE FROM base_rows WHERE base_id = ?').run(b.id);
    expect((await tasksOf(ed)).truncated).toBe(false);
    db.transaction(() => {
      for (let i = 0; i < MAX_TASK_BASES + 1; i++) addProperty(db, createBase(db, { spaceId: teamSpace(), title: `B${i}` }, 'ed1').id, { name: 'Qui', type: 'person' });
    })();
    expect((await tasksOf(ed)).truncated).toBe(true);
  });
});

describe('progression', () => {
  it('statut (dernière option), sinon case à cocher, sinon null ; visible de tout lecteur', async () => {
    const ed = await login('ed1');
    const b = await newBase(ed, 'Suivi');
    const get = async (s: S) => (await call(s, 'GET', `/api/v3/bases/${b.id}`)).json().progress as unknown;
    expect(await get(ed)).toBeNull();
    const ok = (await addProp(ed, b.id, { name: 'Fait', type: 'checkbox' })).id;
    await addRow(ed, b.id, { [ok]: true });
    await addRow(ed, b.id, {});
    expect(await get(ed)).toEqual({ propertyId: ok, kind: 'checkbox', done: 1, total: 2 });
    const st = await addProp(ed, b.id, { name: 'Statut', type: 'status' });
    await addRow(ed, b.id, { [st.id]: st.options[2]!.id });
    await addRow(ed, b.id, { [st.id]: st.options[0]!.id });
    expect(await get(ed)).toEqual({ propertyId: st.id, kind: 'status', done: 1, total: 4 });
    expect(await get(await login('rd'))).toEqual({ propertyId: st.id, kind: 'status', done: 1, total: 4 });
    // Statut sans option : rien n'est terminé.
    expect((await call(ed, 'PATCH', `/api/v3/bases/${b.id}/properties/${st.id}`, { options: [] })).statusCode).toBe(200);
    expect(await get(ed)).toEqual({ propertyId: st.id, kind: 'status', done: 0, total: 4 });
  });
});
