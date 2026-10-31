import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { csvCell, MAX_ROWS, presentRows, propertiesOf } from '../src/lib/bases.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

const sessions = new Map<string, Awaited<ReturnType<typeof makeSession>>>();
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

async function makeSession(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
async function login(email: string) {
  if (!sessions.has(email)) sessions.set(email, await makeSession(email));
  return sessions.get(email)!;
}
type S = Awaited<ReturnType<typeof makeSession>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });

const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
const publicSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'public'").get() as { id: string }).id;
const doc = () => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
function insertPage(id: string, spaceId: string, title: string, text = '') {
  db.prepare('INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, spaceId, title, doc(), text, Date.now(), Date.now());
}

async function newBase(s: S, title = 'Tâches', spaceId = teamSpace()) {
  const res = await call(s, 'POST', '/api/v3/bases', { spaceId, title });
  expect(res.statusCode).toBe(201);
  return res.json() as { page: { id: string }; properties: { id: string; name: string }[]; views: { id: string }[]; rows: unknown[] };
}
const addProp = async (s: S, base: string, body: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/properties`, body);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; options: { id: string; name: string }[] };
};
const get = async (s: S | null, base: string) => (await call(s, 'GET', `/api/v3/bases/${base}`)).json() as {
  properties: { id: string; name: string }[]; rows: { id: string; values: Record<string, unknown> }[]; views: { id: string; config: { sort: unknown[]; filters: unknown[]; hidden: string[] } }[]; canWrite: boolean;
};

describe('création et lecture', () => {
  it('crée une base avec une colonne « Nom » et une vue', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    expect(b.properties.map((p) => p.name)).toEqual(['Nom']);
    expect(b.views).toHaveLength(1);
    expect(b.rows).toEqual([]);
    expect((db.prepare('SELECT kind FROM pages WHERE id = ?').get(b.page.id) as { kind: string }).kind).toBe('base');
  });

  it('un lecteur ne crée pas de base', async () => {
    expect((await call(await login('rd@example.com'), 'POST', '/api/v3/bases', { spaceId: teamSpace(), title: 'x' })).statusCode).toBe(403);
  });

  it('une page ordinaire n’est pas une base', async () => {
    insertPage('pageordinaire', teamSpace(), 'Texte');
    expect((await call(await login('ed1@example.com'), 'GET', '/api/v3/bases/pageordinaire')).statusCode).toBe(404);
  });

  it('le type d’une page ne change jamais', async () => {
    const b = await newBase(await login('ed1@example.com'));
    expect(() => db.prepare("UPDATE pages SET kind = 'doc' WHERE id = ?").run(b.page.id)).toThrow(/type d'une page/);
    insertPage('pageordinaire', teamSpace(), 'Texte');
    expect(() => db.prepare("UPDATE pages SET kind = 'base' WHERE id = ?").run('pageordinaire')).toThrow(/type d'une page/);
  });

  it('le contenu d’éditeur d’une base ne se modifie pas', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const version = (db.prepare('SELECT version FROM pages WHERE id = ?').get(b.page.id) as { version: number }).version;
    const res = await app.inject({ method: 'PATCH', url: `/api/v3/pages/${b.page.id}`, payload: { content: JSON.parse(doc()) }, cookies: ed.cookies, headers: { ...ed.headers, 'if-match': `"${version}"` } });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('lignes');
    const titre = await call(ed, 'PATCH', `/api/v3/pages/${b.page.id}`, { title: 'Renommée' });
    expect(titre.statusCode).toBe(200);
  });

  it('la liste des pages dit quelles pages sont des bases', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const list = (await call(ed, 'GET', `/api/v3/pages?spaceId=${teamSpace()}`)).json() as { items?: { id: string; kind: string }[] } | { id: string; kind: string }[];
    const items = Array.isArray(list) ? list : list.items!;
    expect(items.find((p) => p.id === b.page.id)?.kind).toBe('base');
  });
});

describe('droits', () => {
  it('une base d’une page restreinte reste invisible de qui n’y a pas accès, dans la lecture, l’écriture, l’export et la recherche', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const b = await newBase(ed1, 'Budget secret');
    const nom = b.properties[0]!.id;
    await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [nom]: 'licornes confidentielles' } });
    const lock = await call(await login('admin@example.com'), 'PUT', `/api/v3/pages/${b.page.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
    expect(lock.statusCode).toBe(200);
    for (const [method, url] of [['GET', ''], ['GET', '/export'], ['POST', '/rows'], ['POST', '/properties'], ['POST', '/views'], ['POST', '/rows/delete']] as const) {
      expect((await call(ed2, method, `/api/v3/bases/${b.page.id}${url}`, method === 'POST' ? { values: {}, name: 'x', type: 'text', ids: ['a'] } : undefined)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(JSON.stringify((await call(ed2, 'GET', '/api/v3/search?q=licornes')).json())).not.toContain(b.page.id);
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/search?q=licornes')).json())).toContain(b.page.id);
  });

  it('un lecteur lit mais ne modifie rien', async () => {
    const ed = await login('ed1@example.com');
    const rd = await login('rd@example.com');
    const b = await newBase(ed);
    expect((await get(rd, b.page.id)).canWrite).toBe(false);
    expect((await call(rd, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: {} })).statusCode).toBe(403);
    expect((await call(rd, 'POST', `/api/v3/bases/${b.page.id}/properties`, { name: 'x', type: 'text' })).statusCode).toBe(403);
    expect((await call(rd, 'GET', `/api/v3/bases/${b.page.id}/export`)).statusCode).toBe(200);
  });

  it('une permission de page en lecture seule empêche d’écrire', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const b = await newBase(ed1);
    await call(await login('admin@example.com'), 'PUT', `/api/v3/pages/${b.page.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }, { userId: 'ed2', level: 'read' }] });
    expect((await get(ed2, b.page.id)).canWrite).toBe(false);
    expect((await call(ed2, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: {} })).statusCode).toBe(403);
  });

  it('une base n’est jamais lisible sans compte, même dans un espace public', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed, 'Publique ?', publicSpace());
    expect((await call(null, 'GET', `/api/v3/bases/${b.page.id}`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/api/v3/bases/${b.page.id}/export`)).statusCode).toBe(404);
    // Absente du plan du site et de l'index des moteurs.
    expect((await call(null, 'GET', '/sitemap.xml')).body).not.toContain(b.page.id);
  });

  it('une base à la corbeille n’est plus lisible', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    expect((await call(ed, 'DELETE', `/api/v3/pages/${b.page.id}`)).statusCode).toBe(204);
    expect((await call(ed, 'GET', `/api/v3/bases/${b.page.id}`)).statusCode).toBe(404);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: {} })).statusCode).toBe(404);
  });

  it('une base ne se partage pas par lien public et les sous-pages bases sont écartées d’un partage', async () => {
    const ed = await login('ed1@example.com');
    const admin = await login('admin@example.com');
    await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: true });
    const b = await newBase(ed);
    const res = await call(ed, 'PUT', `/api/v3/pages/${b.page.id}/share`, {});
    expect(res.statusCode).toBe(409);
    // Une base placée sous une page partagée avec ses sous-pages n'est pas servie.
    insertPage('parentpartage', teamSpace(), 'Parent');
    db.prepare("UPDATE pages SET parent_id = 'parentpartage' WHERE id = ?").run(b.page.id);
    const shared = await call(ed, 'PUT', '/api/v3/pages/parentpartage/share', { includeChildren: true });
    expect(shared.statusCode).toBe(201);
    const token = (shared.json() as { url: string }).url.split('/share/')[1]!;
    const tree = await call(null, 'GET', `/api/v3/public/shares/${token}`);
    expect(tree.statusCode).toBe(200);
    expect(JSON.stringify(tree.json())).toContain('Parent');
    expect(JSON.stringify(tree.json())).not.toContain(b.page.id);
    expect((await call(null, 'GET', `/api/v3/public/shares/${token}/pages/${b.page.id}`)).statusCode).toBe(404);
  });

  it('défense en profondeur : un partage qui existerait sur une base ne serait pas servi, et les noms ne vont qu’aux comptes connectés', async () => {
    const ed = await login('ed1@example.com');
    await call(await login('admin@example.com'), 'PUT', '/api/v3/admin/sharing', { enabled: true });
    const b = await newBase(ed);
    db.prepare("INSERT INTO page_shares (id, page_id, token, include_children, indexing, created_at, updated_at) VALUES ('sh1', ?, 'T'||hex(randomblob(20)), 0, 0, 0, 0)").run(b.page.id);
    const token = (db.prepare('SELECT token FROM page_shares WHERE id = ?').get('sh1') as { token: string }).token;
    expect((await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}` })).statusCode).toBe(404);

    const who = (await addProp(ed, b.page.id, { name: 'R', type: 'person' })).id;
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [who]: 'ed1' } });
    const props = propertiesOf(db, b.page.id);
    const ctx = { db, auth: null, spaces: new Set<string>(), baseId: b.page.id };
    expect(presentRows(ctx, props, true)[0]!.values[who]).toEqual({ id: 'ed1', name: 'Nom ed1' });
    expect(presentRows(ctx, props, false)[0]!.values[who]).toBeUndefined();
  });
});

describe('colonnes et valeurs', () => {
  it('chaque type de colonne valide ses valeurs', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const id = b.page.id;
    const txt = b.properties[0]!.id;
    const num = (await addProp(ed, id, { name: 'Prix', type: 'number' })).id;
    const date = (await addProp(ed, id, { name: 'Échéance', type: 'date' })).id;
    const check = (await addProp(ed, id, { name: 'Fait', type: 'checkbox' })).id;
    const sel = await addProp(ed, id, { name: 'Priorité', type: 'select', options: [{ name: 'Haute', color: 'red' }, { name: 'Basse' }] });
    const multi = await addProp(ed, id, { name: 'Tags', type: 'multi_select', options: [{ name: 'a' }, { name: 'b' }] });
    const status = await addProp(ed, id, { name: 'Statut', type: 'status' });
    expect(status.options.map((o) => o.name)).toEqual(['À faire', 'En cours', 'Terminé']);
    const post = async (values: object) => call(ed, 'POST', `/api/v3/bases/${id}/rows`, { values });

    expect((await post({ [txt]: 'ok', [num]: 12.5, [date]: '2026-12-31', [check]: true, [sel.id]: sel.options[0]!.id, [multi.id]: multi.options.map((o) => o.id), [status.id]: status.options[1]!.id })).statusCode).toBe(201);

    const bad: [string, object][] = [
      ['texte non chaîne', { [txt]: 12 }],
      ['texte trop long', { [txt]: 'x'.repeat(2001) }],
      ['nombre en chaîne', { [num]: '12' }],
      ['nombre infini', { [num]: 1e300 }],
      ['date impossible', { [date]: '2026-02-30' }],
      ['date mal formée', { [date]: '31/12/2026' }],
      ['case non booléenne', { [check]: 'oui' }],
      ['option inconnue', { [sel.id]: 'ffffffffff' }],
      ['option d’une autre colonne', { [sel.id]: multi.options[0]!.id }],
      ['multi non tableau', { [multi.id]: multi.options[0]!.id }],
      ['multi option inconnue', { [multi.id]: ['ffffffffff'] }],
      ['colonne inconnue', { nimportequoi: 'x' }],
      ['clé de prototype', JSON.parse('{"__proto__": "x"}')],
    ];
    for (const [label, values] of bad) expect((await post(values)).statusCode, label).toBe(400);
    expect((await get(ed, id)).rows).toHaveLength(1);
  });

  it('null efface une cellule et les modifications de deux personnes sur des cellules différentes se cumulent', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const b = await newBase(ed1);
    const a = b.properties[0]!.id;
    const n = (await addProp(ed1, b.page.id, { name: 'N', type: 'number' })).id;
    const row = (await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [a]: 'un' } })).json() as { id: string };
    await call(ed1, 'PATCH', `/api/v3/bases/${b.page.id}/rows/${row.id}`, { values: { [a]: 'deux' } });
    await call(ed2, 'PATCH', `/api/v3/bases/${b.page.id}/rows/${row.id}`, { values: { [n]: 5 } });
    expect((await get(ed1, b.page.id)).rows[0]!.values).toEqual({ [a]: 'deux', [n]: 5 });
    await call(ed2, 'PATCH', `/api/v3/bases/${b.page.id}/rows/${row.id}`, { values: { [a]: null } });
    expect((await get(ed1, b.page.id)).rows[0]!.values).toEqual({ [n]: 5 });
    expect((await call(ed1, 'PATCH', `/api/v3/bases/${b.page.id}/rows/inconnue`, { values: {} })).statusCode).toBe(404);
  });

  it('les noms d’options sont uniques et les identifiants ne s’inventent pas', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/properties`, { name: 'S', type: 'select', options: [{ name: 'A' }, { name: 'a' }] })).statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/properties`, { name: 'S', type: 'text', options: [{ name: 'A' }] })).statusCode).toBe(400);
    const p = await addProp(ed, b.page.id, { name: 'S', type: 'select', options: [{ name: 'A', id: 'aaaaaaaaaa' } as never] });
    expect(p.options[0]!.id).not.toBe('aaaaaaaaaa');
    expect(p.options[0]!.id).toMatch(/^[0-9a-f]{10}$/);
  });

  it('retirer une option efface sa valeur dans les lignes ; supprimer une colonne efface ses cellules et ses références de vue', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const id = b.page.id;
    const sel = await addProp(ed, id, { name: 'S', type: 'select', options: [{ name: 'A' }, { name: 'B' }] });
    const multi = await addProp(ed, id, { name: 'M', type: 'multi_select', options: [{ name: 'x' }, { name: 'y' }] });
    const [oa, ob] = sel.options as [{ id: string }, { id: string }];
    const [ox, oy] = multi.options as [{ id: string }, { id: string }];
    await call(ed, 'POST', `/api/v3/bases/${id}/rows`, { values: { [sel.id]: oa.id, [multi.id]: [ox.id, oy.id] } });
    await call(ed, 'POST', `/api/v3/bases/${id}/rows`, { values: { [sel.id]: ob.id } });
    const patched = await call(ed, 'PATCH', `/api/v3/bases/${id}/properties/${sel.id}`, { options: [{ id: ob.id, name: 'B' }] });
    expect(patched.statusCode).toBe(200);
    await call(ed, 'PATCH', `/api/v3/bases/${id}/properties/${multi.id}`, { options: [{ id: oy.id, name: 'y' }] });
    const rows = (await get(ed, id)).rows;
    expect(rows[0]!.values[sel.id]).toBeUndefined();
    expect(rows[0]!.values[multi.id]).toEqual([oy.id]);
    expect(rows[1]!.values[sel.id]).toBe(ob.id);

    const view = (await get(ed, id)).views[0]!;
    await call(ed, 'PATCH', `/api/v3/bases/${id}/views/${view.id}`, { config: { sort: [{ propertyId: sel.id, dir: 'asc' }], filters: [{ propertyId: sel.id, op: 'eq', value: ob.id }], hidden: [multi.id] } });
    expect((await call(ed, 'DELETE', `/api/v3/bases/${id}/properties/${sel.id}`)).statusCode).toBe(204);
    expect((await call(ed, 'DELETE', `/api/v3/bases/${id}/properties/${multi.id}`)).statusCode).toBe(204);
    const after = await get(ed, id);
    expect(JSON.stringify(after.rows)).not.toContain(ob.id);
    expect(after.views[0]!.config).toEqual({ sort: [], filters: [], hidden: [] });
    expect((db.prepare('SELECT vals FROM base_rows WHERE base_id = ?').all(id) as { vals: string }[]).map((r) => r.vals).join('')).not.toContain(sel.id);
    // La dernière colonne reste.
    expect((await call(ed, 'DELETE', `/api/v3/bases/${id}/properties/${b.properties[0]!.id}`)).statusCode).toBe(409);
  });

  it('le nombre de colonnes et de lignes est plafonné', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    for (let i = 1; i < 50; i++) await addProp(ed, b.page.id, { name: `c${i}`, type: 'text' });
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/properties`, { name: 'de trop', type: 'text' })).statusCode).toBe(409);
    const ins = db.prepare("INSERT INTO base_rows (id, base_id, position, vals, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)");
    db.transaction(() => { for (let i = 0; i < MAX_ROWS; i++) ins.run(`r${i}`, b.page.id, i); })();
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: {} })).statusCode).toBe(409);
  });
});

describe('personnes et liens vers des pages', () => {
  it('on ne désigne qu’une personne qui peut lire la base, et son nom n’est montré qu’à un compte connecté', async () => {
    const ed1 = await login('ed1@example.com');
    const b = await newBase(ed1);
    const who = (await addProp(ed1, b.page.id, { name: 'Responsable', type: 'person' })).id;
    await call(await login('admin@example.com'), 'PUT', `/api/v3/pages/${b.page.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }, { userId: 'rd', level: 'read' }] });
    // ed2 ne lit pas la base : même réponse qu'une personne qui n'existe pas.
    const refused = await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [who]: 'ed2' } });
    const absent = await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [who]: 'personne-inconnue' } });
    expect(refused.statusCode).toBe(400);
    expect(absent.statusCode).toBe(400);
    expect(refused.json()).toEqual(absent.json());
    const ok = await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [who]: 'rd' } });
    expect(ok.statusCode).toBe(201);
    expect((await get(ed1, b.page.id)).rows[0]!.values[who]).toEqual({ id: 'rd', name: 'Nom rd' });
    // Le compte désigné est désactivé : son nom disparaît de la base.
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'rd'").run();
    expect((await get(ed1, b.page.id)).rows[0]!.values[who]).toBeUndefined();
  });

  it('un lien vers une page illisible est refusé, et son titre disparaît pour qui ne peut plus la lire', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const b = await newBase(ed1);
    const link = (await addProp(ed1, b.page.id, { name: 'Page', type: 'page_link' })).id;
    insertPage('pagesecrete01', teamSpace(), 'Titre confidentiel');
    insertPage('pagelibre001', teamSpace(), 'Titre libre');
    await call(await login('admin@example.com'), 'PUT', '/api/v3/pages/pagesecrete01/permissions', { entries: [{ userId: 'ed1', level: 'write' }] });
    expect((await call(ed2, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [link]: 'pagesecrete01' } })).statusCode).toBe(400);
    expect((await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [link]: 'pagesecrete01' } })).statusCode).toBe(201);
    expect((await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [link]: 'pagelibre001' } })).statusCode).toBe(201);
    const vu1 = JSON.stringify((await call(ed1, 'GET', `/api/v3/bases/${b.page.id}`)).json());
    const vu2 = JSON.stringify((await call(ed2, 'GET', `/api/v3/bases/${b.page.id}`)).json());
    expect(vu1).toContain('Titre confidentiel');
    expect(vu2).not.toContain('Titre confidentiel');
    expect(vu2).not.toContain('pagesecrete01');
    expect(vu2).toContain('Titre libre');
    expect((await call(ed1, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [link]: 'inexistante' } })).statusCode).toBe(400);
  });
});

describe('vues', () => {
  it('une vue ne cite que des colonnes de la base, il en reste toujours une, au plus dix', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const nom = b.properties[0]!.id;
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: 'v', config: { sort: [{ propertyId: 'fantome', dir: 'asc' }] } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: 'v', config: { filters: [{ propertyId: nom, op: 'eval', value: 'x' }] } })).statusCode).toBe(400);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: 'v', config: { code: 'alert(1)' } })).statusCode).toBe(400);
    const ok = await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: 'Triée', config: { sort: [{ propertyId: nom, dir: 'desc' }] } });
    expect(ok.statusCode).toBe(201);
    for (let i = 0; i < 8; i++) expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: `v${i}` })).statusCode).toBe(201);
    expect((await call(ed, 'POST', `/api/v3/bases/${b.page.id}/views`, { name: 'onzième' })).statusCode).toBe(409);
    for (const v of (await get(ed, b.page.id)).views.slice(1)) expect((await call(ed, 'DELETE', `/api/v3/bases/${b.page.id}/views/${v.id}`)).statusCode).toBe(204);
    const last = (await get(ed, b.page.id)).views[0]!;
    expect((await call(ed, 'DELETE', `/api/v3/bases/${b.page.id}/views/${last.id}`)).statusCode).toBe(409);
  });
});

describe('export CSV', () => {
  it('neutralise les formules et protège les guillemets', async () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+33')).toBe("'+33");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    const ed = await login('ed1@example.com');
    const b = await newBase(ed, 'Mes données / 2026 ✓');
    const nom = b.properties[0]!.id;
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [nom]: '=HYPERLINK("http://x")' } });
    const res = await call(ed, 'GET', `/api/v3/bases/${b.page.id}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[\w.-]+\.csv"$/);
    expect(res.body).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('copie, recherche, événements, migration', () => {
  it('dupliquer une base copie colonnes, lignes et vues avec de nouveaux identifiants', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const sel = await addProp(ed, b.page.id, { name: 'S', type: 'select', options: [{ name: 'A' }] });
    const nom = b.properties[0]!.id;
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [nom]: 'ligne', [sel.id]: sel.options[0]!.id } });
    const view = (await get(ed, b.page.id)).views[0]!;
    await call(ed, 'PATCH', `/api/v3/bases/${b.page.id}/views/${view.id}`, { config: { sort: [{ propertyId: sel.id, dir: 'asc' }], filters: [], hidden: [] } });
    const dup = (await call(ed, 'POST', `/api/v3/pages/${b.page.id}/duplicate`)).json() as { id: string; kind: string };
    expect(dup.kind).toBe('base');
    const copy = await get(ed, dup.id);
    expect(copy.properties.map((p) => p.name)).toEqual(['Nom', 'S']);
    expect(copy.properties.map((p) => p.id)).not.toContain(nom);
    expect(copy.rows).toHaveLength(1);
    expect(Object.values(copy.rows[0]!.values)).toContain('ligne');
    expect((copy.views[0]!.config.sort[0] as { propertyId: string }).propertyId).toBe(copy.properties[1]!.id);
    // L'original n'a pas bougé.
    expect((await get(ed, b.page.id)).properties.map((p) => p.id)).toContain(nom);
  });

  it('copier un arbre vers un autre espace copie aussi les bases', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [b.properties[0]!.id]: 'ligne' } });
    const res = await call(ed, 'POST', `/api/v3/pages/${b.page.id}/copy`, { spaceId: publicSpace() });
    expect(res.statusCode).toBe(201);
    const root = (res.json() as { page: { id: string; kind: string } }).page;
    expect(root.kind).toBe('base');
    expect((await get(ed, root.id)).rows).toHaveLength(1);
  });

  it('la recherche trouve une base par ses cellules et ses colonnes, et suit les modifications', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed, 'Inventaire');
    const nom = b.properties[0]!.id;
    const row = (await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [nom]: 'tournevis cruciforme' } })).json() as { id: string };
    expect(JSON.stringify((await call(ed, 'GET', '/api/v3/search?q=tournevis')).json())).toContain(b.page.id);
    await call(ed, 'PATCH', `/api/v3/bases/${b.page.id}/rows/${row.id}`, { values: { [nom]: 'marteau' } });
    expect(JSON.stringify((await call(ed, 'GET', '/api/v3/search?q=tournevis')).json())).not.toContain(b.page.id);
    expect(JSON.stringify((await call(ed, 'GET', '/api/v3/search?q=marteau')).json())).toContain(b.page.id);
  });

  it('une écriture prévient les autres écrans, sans contenu de cellule', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    const seen: unknown[] = [];
    const off = app.bus.subscribe((e) => { if (e.type === 'base.changed') seen.push(e); });
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: { [b.properties[0]!.id]: 'secret de cellule' } });
    off();
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('secret de cellule');
    expect((seen[0] as { pageId: string }).pageId).toBe(b.page.id);
  });

  it('supprimer la base définitivement supprime colonnes, lignes et vues', async () => {
    const ed = await login('ed1@example.com');
    const b = await newBase(ed);
    await call(ed, 'POST', `/api/v3/bases/${b.page.id}/rows`, { values: {} });
    await call(ed, 'DELETE', `/api/v3/pages/${b.page.id}`);
    expect((await call(await login('admin@example.com'), 'DELETE', `/api/v3/pages/${b.page.id}/permanent`)).statusCode).toBe(204);
    for (const t of ['base_properties', 'base_rows', 'base_views']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE base_id = ?`).get(b.page.id) as { n: number }).n, t).toBe(0);
  });

  it('la migration v17 laisse les pages existantes en pages ordinaires', () => {
    const file = oldDb(16);
    const up = openDb(file);
    expect(up.prepare("SELECT kind FROM pages WHERE id = 'p1'").get()).toEqual({ kind: 'doc' });
    up.close();
    const raw = new Database(file);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('base_rows','base_properties','base_views') ORDER BY name").all()).toHaveLength(3);
    raw.close();
  });
});
