import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sanitizeDoc } from '../src/lib/content.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor'], ['ed3@example.com', 'editor'], ['rd@example.com', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, `Nom ${email.split('@')[0]}`, role, Date.now(), await hashPassword(PASS));
  }
  const team = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
  const now = Date.now();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('pagelibre001', ?, 'Page libre', ?, 'texte', ?, ?)")
    .run(team, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bonjour le monde' }] }] }), now, now);
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: { ...(s?.headers ?? {}), ...headers } });

const PAGE = 'pagelibre001';
const notifs = (userId: string) => db.prepare('SELECT type, page_id AS pageId, actor_id AS actor FROM notifications WHERE user_id = ? ORDER BY created_at').all(userId);
const comment = (s: S, body: object, page = PAGE) => call(s, 'POST', `/api/v3/pages/${page}/comments`, body);
const mentionDoc = (...ids: string[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: ids.flatMap((id) => [{ type: 'text', text: 'Salut ' }, { type: 'mention', attrs: { id } }]) }] });
async function restrictTo(...ids: string[]) {
  const admin = await login('admin@example.com');
  const res = await call(admin, 'PUT', `/api/v3/pages/${PAGE}/permissions`, { entries: ids.map((userId) => ({ userId, level: 'write' })) });
  expect(res.statusCode).toBe(200);
  return admin;
}

describe('contenu : marque et nœud autorisés', () => {
  it('garde un commentAnchor et une mention valides, retire les invalides', () => {
    const doc = sanitizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a', marks: [{ type: 'commentAnchor', attrs: { id: 'fil1' } }] },
      { type: 'text', text: 'b', marks: [{ type: 'commentAnchor', attrs: { id: '<x>' } }] },
      { type: 'mention', attrs: { id: 'ed1', label: 'Nom copié dans la page' } },
      { type: 'mention', attrs: { id: '../x', label: 'Piège' } },
      { type: 'mention', attrs: { id: 'ed2' } },
    ] }] });
    const [a, b, m1, m2] = doc.content![0]!.content!;
    expect(a!.marks).toEqual([{ type: 'commentAnchor', attrs: { id: 'fil1' } }]);
    expect(b!.marks).toBeUndefined();
    // Le nom n'est jamais enregistré dans la page : il disparaît avec le compte.
    expect(m1).toEqual({ type: 'mention', attrs: { id: 'ed1' } });
    expect(m2).toEqual({ type: 'mention', attrs: { id: 'ed2' } });
    expect(doc.content![0]!.content).toHaveLength(4);
  });
});

describe('commentaires ancrés', () => {
  it('enregistre le texte commenté, refuse l’ancre sur une réponse ou trop longue', async () => {
    const ed1 = await login('ed1@example.com');
    const root = await comment(ed1, { body: 'À revoir', anchorText: 'le monde' });
    expect(root.statusCode).toBe(201);
    expect(root.json()).toMatchObject({ anchored: true, anchorText: 'le monde', mentions: [] });
    expect((await comment(ed1, { body: 'Sans ancre' })).json()).toMatchObject({ anchored: false, anchorText: null });
    expect((await comment(ed1, { body: 'x', parentId: root.json().id, anchorText: 'non' })).statusCode).toBe(400);
    expect((await comment(ed1, { body: 'x', anchorText: 'a'.repeat(201) })).statusCode).toBe(400);
    const listed = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}/comments`)).json().items as { anchored: boolean }[];
    expect(listed.map((c) => c.anchored)).toEqual([true, false]);
  });

  it('la suppression efface le texte commenté', async () => {
    const ed1 = await login('ed1@example.com');
    const id = (await comment(ed1, { body: 'x', anchorText: 'secret', mentions: ['ed2'] })).json().id;
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${PAGE}/comments/${id}`)).statusCode).toBe(204);
    expect(db.prepare('SELECT anchor_text FROM page_comments WHERE id = ?').get(id)).toEqual({ anchor_text: null });
    expect(db.prepare('SELECT count(*) AS n FROM comment_mentions').get()).toEqual({ n: 0 });
    const item = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}/comments`)).json().items[0];
    expect(item).toMatchObject({ deleted: true, anchorText: null, mentions: [] });
  });
});

describe('mentions écrites en co-édition', () => {
  const save = (shared: boolean) => {
    const space = (db.prepare('SELECT space_id AS s FROM pages WHERE id = ?').get(PAGE) as { s: string }).s;
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(JSON.stringify(mentionDoc('ed2')), PAGE);
    app.bus.publish({ type: 'page.updated', spaceId: space, pageId: PAGE, version: 2, by: { id: 'ed1', name: 'Nom ed1' }, shared });
  };

  it('enregistrement d’une seule personne : la mention lui est attribuée', () => {
    save(false);
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
  });

  it('enregistrement regroupant plusieurs personnes : l’auteur n’est pas deviné (« quelqu’un »)', () => {
    save(true);
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: null }]);
  });
});

describe('mentions dans les commentaires', () => {
  it('notifient la personne mentionnée (« mention », pas « comment »), pas l’auteur', async () => {
    const ed1 = await login('ed1@example.com');
    db.prepare("INSERT INTO page_watch (user_id, page_id, created_at) VALUES ('ed2', ?, 0), ('ed3', ?, 0)").run(PAGE, PAGE);
    const res = await comment(ed1, { body: 'Salut @Nom ed2 et @Nom ed1', mentions: ['ed2', 'ed1'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().mentions.map((m: { id: string }) => m.id).sort()).toEqual(['ed1', 'ed2']);
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
    expect(notifs('ed3')).toEqual([{ type: 'comment', pageId: PAGE, actor: 'ed1' }]);
    expect(notifs('ed1')).toEqual([]);
  });

  it('une personne mentionnée et auteur du fil ne reçoit que « mention »', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const root = (await comment(ed2, { body: 'Question' })).json().id;
    await comment(ed1, { body: '@Nom ed2 réponse', parentId: root, mentions: ['ed2'] });
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
  });

  it('ignorent en silence une personne sans accès à la page restreinte, inconnue ou désactivée', async () => {
    await restrictTo('ed1', 'ed2');
    const ed1 = await login('ed1@example.com');
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'rd'").run();
    const res = await comment(ed1, { body: 'Salut', mentions: ['ed3', 'fantome', 'rd', 'ed2'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().mentions.map((m: { id: string }) => m.id)).toEqual(['ed2']);
    expect(notifs('ed3')).toEqual([]);
    expect(notifs('rd')).toEqual([]);
    expect(db.prepare('SELECT user_id FROM comment_mentions').all()).toEqual([{ user_id: 'ed2' }]);
  });

  it('plafonnent à 10 mentions et valident les identifiants', async () => {
    const ed1 = await login('ed1@example.com');
    expect((await comment(ed1, { body: 'x', mentions: Array.from({ length: 11 }, (_, i) => `u${i}`) })).statusCode).toBe(400);
    expect((await comment(ed1, { body: 'x', mentions: ['../x'] })).statusCode).toBe(400);
  });

  it('un lecteur ne peut pas commenter ni mentionner', async () => {
    const rd = await login('rd@example.com');
    expect((await comment(rd, { body: 'x', mentions: ['ed1'] })).statusCode).toBe(403);
    expect(notifs('ed1')).toEqual([]);
  });
});

describe('personnes mentionnables', () => {
  it('liste les personnes actives qui peuvent lire la page, par préfixe', async () => {
    const ed1 = await login('ed1@example.com');
    const all = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable`)).json().items as { id: string; name: string }[];
    expect(all.map((u) => u.id).sort()).toEqual(['admin', 'ed1', 'ed2', 'ed3', 'rd']);
    expect(Object.keys(all[0]!).sort()).toEqual(['id', 'name']);
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable?q=nom%20ed2`)).json().items).toEqual([{ id: 'ed2', name: 'Nom ed2' }]);
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable?q=%25`)).json().items).toEqual([]);
    // Début d'un mot du nom.
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable?q=ed3`)).json().items).toEqual([{ id: 'ed3', name: 'Nom ed3' }]);
  });

  it('exclut sur une page restreinte les personnes sans accès, mais garde les administrateurs', async () => {
    await restrictTo('ed1');
    const ed1 = await login('ed1@example.com');
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable`)).json().items.map((u: { id: string }) => u.id).sort()).toEqual(['admin', 'ed1']);
  });

  it('ne se limite pas aux 200 premiers comptes sur une page restreinte', async () => {
    const insert = db.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES (?, ?, ?, 'editor', 0)");
    for (let i = 0; i < 250; i++) insert.run(`aaa${i}`, `sub:aaa${i}`, `Aaa ${String(i).padStart(3, '0')}`);
    await restrictTo('ed1');
    const ed1 = await login('ed1@example.com');
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentionable`)).json().items.map((u: { id: string }) => u.id).sort()).toEqual(['admin', 'ed1']);
  });

  it('est refusé aux lecteurs, aux anonymes et pour une page invisible', async () => {
    expect((await call(await login('rd@example.com'), 'GET', `/api/v3/pages/${PAGE}/mentionable`)).statusCode).toBe(403);
    expect([401, 403]).toContain((await call(null, 'GET', `/api/v3/pages/${PAGE}/mentionable`)).statusCode);
    await restrictTo('ed1');
    expect((await call(await login('ed2@example.com'), 'GET', `/api/v3/pages/${PAGE}/mentionable`)).statusCode).toBe(404);
  });
});

describe('mentions dans une page', () => {
  it('notifient une seule fois la personne mentionnée, même si la page est modifiée plusieurs fois', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    const first = await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2', 'ed1') }, { 'if-match': etag });
    expect(first.statusCode).toBe(200);
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
    expect(notifs('ed1')).toEqual([]);
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2', 'ed1') }, { 'if-match': first.headers.etag as string });
    expect(notifs('ed2')).toHaveLength(1);
  });

  it('ne notifient pas une personne sans accès à une page restreinte', async () => {
    await restrictTo('ed1');
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed3') }, { 'if-match': etag });
    expect(notifs('ed3')).toEqual([]);
  });

  it('le contenu ne peut pas désigner un identifiant piégé', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('../x') }, { 'if-match': etag });
    expect(db.prepare('SELECT count(*) AS n FROM page_mentions').get()).toEqual({ n: 0 });
  });

  it('les noms des mentionnés sont lisibles par ceux qui lisent la page, pas par les autres', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2') }, { 'if-match': etag });
    expect((await call(await login('rd@example.com'), 'GET', `/api/v3/pages/${PAGE}/mentioned`)).json().items).toEqual([{ id: 'ed2', name: 'Nom ed2' }]);
    await restrictTo('ed1');
    expect((await call(await login('ed3@example.com'), 'GET', `/api/v3/pages/${PAGE}/mentioned`)).statusCode).toBe(404);
  });

  it('l’export Markdown et HTML affichent la mention comme texte', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'ed2', label: 'Ann <b>' } }] }] } }, { 'if-match': etag });
    expect((db.prepare('SELECT content FROM pages WHERE id = ?').get(PAGE) as { content: string }).content).not.toContain('Ann');
    // Connecté : nom actuel, comme texte. Visiteur : jamais de nom.
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/export`)).body).toContain('@Nom ed2');
    const publicPage = (db.prepare("SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id WHERE s.visibility = 'public' LIMIT 1").get() as { id: string }).id;
    const pubEtag = (await call(ed1, 'GET', `/api/v3/pages/${publicPage}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${publicPage}`, { content: mentionDoc('ed2') }, { 'if-match': pubEtag });
    const anon = (await call(null, 'GET', `/api/v3/pages/${publicPage}/export`)).body;
    expect(anon).toContain('@utilisateur');
    expect(anon).not.toContain('ed2');
    expect(anon).not.toContain('Nom ');
  });

  it('GET /mentioned : refusé aux visiteurs, et ne nomme ni un compte désactivé ni une personne sans accès', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2', 'ed3', 'rd', 'fantome') }, { 'if-match': etag });
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'rd'").run();
    await restrictTo('ed1', 'ed2');
    expect((await call(ed1, 'GET', `/api/v3/pages/${PAGE}/mentioned`)).json().items).toEqual([{ id: 'ed2', name: 'Nom ed2' }]);
    const publicPage = (db.prepare("SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id WHERE s.visibility = 'public' LIMIT 1").get() as { id: string }).id;
    expect([401, 403]).toContain((await call(null, 'GET', `/api/v3/pages/${publicPage}/mentioned`)).statusCode);
  });

  it('une page copiée ou créée avec des mentions ne les notifie pas, même quand on la modifie ensuite', async () => {
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2') }, { 'if-match': etag });
    expect(notifs('ed2')).toHaveLength(1);
    const space = (db.prepare("SELECT space_id AS s FROM pages WHERE id = ?").get(PAGE) as { s: string }).s;
    for (let i = 0; i < 3; i++) expect((await call(ed1, 'POST', `/api/v3/pages/${PAGE}/duplicate`)).statusCode).toBeLessThan(300);
    const fromApi = (await call(ed1, 'POST', '/api/v3/pages', { spaceId: space, title: 'Modèle', content: mentionDoc('ed3') })).json().id;
    const e2 = (await call(ed1, 'GET', `/api/v3/pages/${fromApi}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${fromApi}`, { title: 'Modèle 2', content: mentionDoc('ed3') }, { 'if-match': e2 });
    expect(notifs('ed2')).toHaveLength(1);
    expect(notifs('ed3')).toEqual([]);
  });

  it('une personne qui suit la page et est mentionnée ne reçoit que « mention »', async () => {
    const ed1 = await login('ed1@example.com');
    db.prepare("INSERT INTO page_watch (user_id, page_id, created_at) VALUES ('ed2', ?, 0)").run(PAGE);
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed2') }, { 'if-match': etag });
    expect(notifs('ed2')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
  });

  it('une personne mentionnée avant d’avoir accès est notifiée quand l’accès lui est donné', async () => {
    await restrictTo('ed1');
    const ed1 = await login('ed1@example.com');
    const etag = (await call(ed1, 'GET', `/api/v3/pages/${PAGE}`)).headers.etag as string;
    const first = await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed3') }, { 'if-match': etag });
    expect(notifs('ed3')).toEqual([]);
    await restrictTo('ed1', 'ed3');
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}`, { content: mentionDoc('ed3', 'ed1') }, { 'if-match': first.headers.etag as string });
    expect(notifs('ed3')).toEqual([{ type: 'mention', pageId: PAGE, actor: 'ed1' }]);
  });

  it('modifier un commentaire ne notifie personne de plus', async () => {
    const ed1 = await login('ed1@example.com');
    const id = (await comment(ed1, { body: 'v1', mentions: ['ed2'] })).json().id;
    expect(notifs('ed2')).toHaveLength(1);
    await call(ed1, 'PATCH', `/api/v3/pages/${PAGE}/comments/${id}`, { body: 'v2 @Nom ed3' });
    expect(notifs('ed2')).toHaveLength(1);
    expect(notifs('ed3')).toEqual([]);
  });
});

describe('migration v13', () => {
  it('recrée notifications sans perdre de ligne et accepte « mention »', () => {
    const file = oldDb(12, (old) => {
      old.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at, count) VALUES ('n1', 'u1', 'comment', 'p1', 5, 3)").run();
      old.prepare("INSERT INTO page_comments (id, page_id, author_id, body, created_at, updated_at) VALUES ('c1', 'p1', 'u1', 'ancien', 1, 1)").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(13);
    expect(up.prepare('SELECT id, type, count, created_at FROM notifications').all()).toEqual([{ id: 'n1', type: 'comment', count: 3, created_at: 5 }]);
    expect(up.prepare('SELECT body, anchor_text FROM page_comments').all()).toEqual([{ body: 'ancien', anchor_text: null }]);
    up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n2', 'u1', 'mention', 'p1', 6)").run();
    expect(() => up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n3', 'u1', 'autre', 'p1', 6)").run()).toThrow();
    expect(up.prepare("SELECT name FROM sqlite_master WHERE name = 'notifications_user'").get()).toBeTruthy();
    up.close();
  });
});
