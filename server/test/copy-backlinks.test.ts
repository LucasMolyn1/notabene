import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { stripCommentAnchors } from '../src/lib/page-copy.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let team: string;
let docs: string;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor'], ['rd@example.com', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, `Nom ${email.split('@')[0]}`, role, Date.now(), await hashPassword(PASS));
  }
  team = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
  docs = (db.prepare("SELECT id FROM spaces WHERE visibility = 'public'").get() as { id: string }).id;
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });

const para = (text: string, marks?: object[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const doc = (...content: object[]) => ({ type: 'doc', content });
async function mk(s: S, title: string, space: string, parent: string | null = null, content?: object) {
  const res = await call(s, 'POST', '/api/v3/pages', { spaceId: space, parentId: parent, title, ...(content ? { content } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
const titles = (res: { json: () => unknown }) => ((res.json() as { items: { title: string }[] }).items).map((p) => p.title).sort();
const listTitles = async (s: S, space: string) => ((await call(s, 'GET', `/api/v3/pages?spaceId=${space}&limit=200`)).json().items as { title: string }[]).map((p) => p.title).sort();

describe('copie vers un autre espace', () => {
  it('copie la page et ses sous-pages dans l’ordre, l’original reste en place', async () => {
    const ed1 = await login('ed1@example.com');
    const root = await mk(ed1, 'Racine', team, null, doc(para('contenu racine')));
    await mk(ed1, 'Enfant A', team, root, doc(para('a')));
    const b = await mk(ed1, 'Enfant B', team, root, doc(para('b')));
    await mk(ed1, 'Petit-enfant', team, b);
    const res = await call(ed1, 'POST', `/api/v3/pages/${root}/copy`, { spaceId: docs });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ count: 4, skipped: 0 });
    expect(res.json().page.spaceId).toBe(docs);
    const copied = (await call(ed1, 'GET', `/api/v3/pages?spaceId=${docs}&limit=200`)).json().items as { id: string; title: string; parentId: string | null; position: number }[];
    const copyRoot = copied.find((p) => p.id === res.json().page.id)!;
    expect(copyRoot.title).toBe('Racine');
    const kids = copied.filter((p) => p.parentId === copyRoot.id).sort((x, y) => x.position - y.position).map((p) => p.title);
    expect(kids).toEqual(['Enfant A', 'Enfant B']);
    expect(copied.find((p) => p.title === 'Petit-enfant')!.parentId).toBe(copied.find((p) => p.title === 'Enfant B')!.id);
    expect(await listTitles(ed1, team)).toContain('Racine'); // l'original est toujours là
    expect(JSON.stringify((await call(ed1, 'GET', `/api/v3/pages/${copyRoot.id}`)).json().content)).toContain('contenu racine');
  });

  it('peut copier sous une page de destination et dans le même espace', async () => {
    const ed1 = await login('ed1@example.com');
    const a = await mk(ed1, 'A', team);
    const dest = await mk(ed1, 'Destination', docs);
    const res = await call(ed1, 'POST', `/api/v3/pages/${a}/copy`, { spaceId: docs, parentId: dest });
    expect(res.json().page.parentId).toBe(dest);
    expect((await call(ed1, 'POST', `/api/v3/pages/${a}/copy`, { spaceId: team, parentId: a })).statusCode).toBe(201);
  });

  it('écarte les sous-pages que la personne ne peut pas lire, sans les copier ni les compter dans les titres', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    const root = await mk(admin, 'Racine', team);
    await mk(admin, 'Visible', team, root);
    const hidden = await mk(admin, 'Cachée', team, root, doc(para('secret absolu')));
    await mk(admin, 'Sous la cachée', team, hidden);
    expect((await call(admin, 'PUT', `/api/v3/pages/${hidden}/permissions`, { entries: [{ userId: 'ed2', level: 'write' }] })).statusCode).toBe(200);
    const res = await call(ed1, 'POST', `/api/v3/pages/${root}/copy`, { spaceId: docs });
    expect(res.json()).toMatchObject({ count: 2, skipped: 1 });
    expect(await listTitles(admin, docs)).toEqual(expect.arrayContaining(['Racine', 'Visible']));
    expect(await listTitles(admin, docs)).not.toContain('Cachée');
    expect(await listTitles(admin, docs)).not.toContain('Sous la cachée');
    expect(JSON.stringify(db.prepare('SELECT content FROM pages WHERE space_id = ?').all(docs))).not.toContain('secret absolu');
  });

  it('la copie reste aussi restreinte que la source, y compris quand la restriction vient d’un ancêtre', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const parent = await mk(admin, 'Parent restreint', team);
    const child = await mk(admin, 'Enfant hérité', team, parent, doc(para('réservé')));
    await call(admin, 'PUT', `/api/v3/pages/${parent}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
    const res = await call(ed1, 'POST', `/api/v3/pages/${child}/copy`, { spaceId: docs });
    expect(res.statusCode).toBe(201);
    const copyId = res.json().page.id as string;
    expect((await call(ed2, 'GET', `/api/v3/pages/${copyId}`)).statusCode).toBe(404);
    expect(await listTitles(ed2, docs)).not.toContain('Enfant hérité');
    expect((await call(ed1, 'GET', `/api/v3/pages/${copyId}`)).statusCode).toBe(200);
  });

  it('refuse un lecteur, une page ou un espace introuvable, et un parent en lecture seule', async () => {
    const ed1 = await login('ed1@example.com');
    const a = await mk(ed1, 'A', team);
    expect((await call(await login('rd@example.com'), 'POST', `/api/v3/pages/${a}/copy`, { spaceId: docs })).statusCode).toBe(403);
    expect((await call(ed1, 'POST', '/api/v3/pages/inexistante01/copy', { spaceId: docs })).statusCode).toBe(404);
    expect((await call(ed1, 'POST', `/api/v3/pages/${a}/copy`, { spaceId: 'espaceinconnu' })).statusCode).toBe(404);
    const admin = await login('admin@example.com');
    const locked = await mk(admin, 'Verrou', docs);
    await call(admin, 'PUT', `/api/v3/pages/${locked}/permissions`, { entries: [{ userId: 'ed1', level: 'read' }] });
    expect((await call(ed1, 'POST', `/api/v3/pages/${a}/copy`, { spaceId: docs, parentId: locked })).statusCode).toBe(403);
    // Une page invisible pour la personne est introuvable.
    const secret = await mk(admin, 'Secrète', team);
    await call(admin, 'PUT', `/api/v3/pages/${secret}/permissions`, { entries: [{ userId: 'ed2', level: 'write' }] });
    expect((await call(ed1, 'POST', `/api/v3/pages/${secret}/copy`, { spaceId: docs })).statusCode).toBe(404);
  });

  it('copie les libellés, ne renotifie pas les mentions et retire les ancres de commentaires', async () => {
    const ed1 = await login('ed1@example.com');
    const src = await mk(ed1, 'Source', team, null, doc({ type: 'paragraph', content: [
      { type: 'text', text: 'ancré', marks: [{ type: 'commentAnchor', attrs: { id: 'filsource' } }, { type: 'bold' }] },
      { type: 'mention', attrs: { id: 'ed2' } },
    ] }));
    await call(ed1, 'POST', `/api/v3/pages/${src}/labels`, { name: 'copié' });
    expect(db.prepare('SELECT user_id FROM page_mentions WHERE page_id = ?').all(src)).toEqual([{ user_id: 'ed2' }]); // enregistrée à la création, sans notification
    const res = await call(ed1, 'POST', `/api/v3/pages/${src}/copy`, { spaceId: docs });
    const id = res.json().page.id as string;
    expect((await call(ed1, 'GET', `/api/v3/pages/${id}/labels`)).json().items).toEqual(['copié']);
    expect(db.prepare('SELECT user_id FROM page_mentions WHERE page_id = ?').all(id)).toEqual([{ user_id: 'ed2' }]);
    const content = JSON.stringify((await call(ed1, 'GET', `/api/v3/pages/${id}`)).json().content);
    expect(content).not.toContain('commentAnchor');
    expect(content).toContain('"type":"bold"');
    expect(db.prepare("SELECT count(*) AS n FROM notifications WHERE type = 'mention'").get()).toEqual({ n: 0 });
  });

  it('plafonne à 500 pages et exige le jeton CSRF', async () => {
    const ed1 = await login('ed1@example.com');
    const root = await mk(ed1, 'Grosse', team);
    const insert = db.prepare("INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, 'x', '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}', '', 0, 0)");
    for (let i = 0; i < 500; i++) insert.run(`p${String(i).padStart(10, '0')}`, team, root);
    expect((await call(ed1, 'POST', `/api/v3/pages/${root}/copy`, { spaceId: docs })).statusCode).toBe(413);
    expect(await listTitles(ed1, docs)).not.toContain('Grosse');
    const res = await app.inject({ method: 'POST', url: `/api/v3/pages/${root}/copy`, payload: { spaceId: docs }, cookies: ed1.cookies });
    expect(res.statusCode).toBe(403);
  });

  it('stripCommentAnchors ne touche ni au reste des marques ni au texte', () => {
    const out = stripCommentAnchors({ type: 'text', text: 't', marks: [{ type: 'commentAnchor', attrs: { id: 'x' } }] });
    expect(out).toEqual({ type: 'text', text: 't' });
  });
});

describe('rétroliens', () => {
  const link = (id: string) => ({ type: 'paragraph', content: [{ type: 'pageLink', attrs: { id } }] });

  it('listent les pages qui renvoient vers celle-ci, une seule fois, sans elle-même ni la corbeille', async () => {
    const ed1 = await login('ed1@example.com');
    const target = await mk(ed1, 'Cible', team);
    const a = await mk(ed1, 'Lien A', team, null, doc(link(target), link(target)));
    await mk(ed1, 'Sans lien', team, null, doc(para('rien')));
    await mk(ed1, 'Lien B', docs, null, doc(link(target)));
    const trashed = await mk(ed1, 'Lien supprimé', team, null, doc(link(target)));
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(JSON.stringify(doc(link(target))), target); // un lien vers soi-même
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${trashed}`)).statusCode).toBeLessThan(300);
    const res = await call(ed1, 'GET', `/api/v3/pages/${target}/backlinks`);
    expect(titles(res)).toEqual(['Lien A', 'Lien B']);
    expect((res.json().items as { id: string }[]).some((p) => p.id === a)).toBe(true);
  });

  it('ne montrent jamais une page restreinte à une personne qui n’y a pas accès, ni son titre', async () => {
    const admin = await login('admin@example.com');
    const ed2 = await login('ed2@example.com');
    const target = await mk(admin, 'Cible', team);
    const secret = await mk(admin, 'Titre confidentiel', team, null, doc(link(target)));
    await mk(admin, 'Lien public', team, null, doc(link(target)));
    await call(admin, 'PUT', `/api/v3/pages/${secret}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
    const seen = await call(ed2, 'GET', `/api/v3/pages/${target}/backlinks`);
    expect(titles(seen)).toEqual(['Lien public']);
    expect(JSON.stringify(seen.json())).not.toContain('confidentiel');
    expect(titles(await call(await login('ed1@example.com'), 'GET', `/api/v3/pages/${target}/backlinks`))).toEqual(['Lien public', 'Titre confidentiel']);
  });

  it('une page invisible n’a pas de rétroliens consultables, et un visiteur ne voit que les espaces publics', async () => {
    const ed1 = await login('ed1@example.com');
    const pub = await mk(ed1, 'Cible publique', docs);
    await mk(ed1, 'Lien depuis l’équipe', team, null, doc(link(pub)));
    await mk(ed1, 'Lien public', docs, null, doc(link(pub)));
    expect(titles(await call(null, 'GET', `/api/v3/pages/${pub}/backlinks`))).toEqual(['Lien public']);
    const admin = await login('admin@example.com');
    const hidden = await mk(admin, 'Cible cachée', team);
    await call(admin, 'PUT', `/api/v3/pages/${hidden}/permissions`, { entries: [{ userId: 'ed2', level: 'write' }] });
    expect((await call(ed1, 'GET', `/api/v3/pages/${hidden}/backlinks`)).statusCode).toBe(404);
  });
});
