// Jetons d'API limités à certains espaces : création, application par toutes les familles de routes (tests négatifs
// systématiques avec un jeton limité à l'espace A), suppression d'un espace, non-régression d'un jeton sans limite.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { newBlockId } from '../src/lib/synced-blocks.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', AI_ALLOW_PRIVATE: 'true' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let provider: Server;
let providerUrl: string;
const received: string[] = [];

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const doc = (...content: object[]) => ({ type: 'doc', content });

beforeEach(async () => {
  received.length = 0;
  // Faux fournisseur compatible OpenAI : enregistre le corps reçu (pour vérifier qu'aucun extrait hors périmètre ne sort).
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Réponse' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['adm', 'admin'], ['ed', 'editor'], ['ed2', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  const space = (id: string, name: string, visibility = 'private', kind = 'shared', owner: string | null = null) =>
    db.prepare('INSERT INTO spaces (id, name, visibility, kind, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)').run(id, name, visibility, kind, owner);
  space('sA', 'Espace A'); space('sB', 'Espace B'); space('sC', 'Espace C'); space('sP', 'Public', 'public');
  space('sPers', 'Perso ed', 'private', 'personal', 'ed'); space('sPers2', 'Perso ed2', 'private', 'personal', 'ed2');
  for (const s of ['sA', 'sB']) db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, 'ed', 'edit')").run(s);
  const page = (id: string, spaceId: string, title: string, text: string) =>
    db.prepare('INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
      .run(id, spaceId, title, JSON.stringify(doc(para(text))), text);
  page('pA', 'sA', 'Page A', 'zebre alpha');
  page('pB', 'sB', 'Page B', 'zebre bravo secretB');
  page('pP', 'sP', 'Page publique', 'zebre public secretP');
  page('pPers', 'sPers', 'Page perso', 'zebre perso secretPerso');
});
afterEach(async () => {
  await app.close();
  db.close();
  await new Promise<void>((ok) => provider.close(() => ok()));
});

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const call = (s: S, method: Method, url: string, payload?: object) => app.inject({ method, url, payload, cookies: s.cookies, headers: s.headers });

async function token(s: S, body: object) {
  const res = await call(s, 'POST', '/api/v3/tokens', { name: 'outil', scopes: ['read', 'write', 'ai'], ...body });
  return res;
}
async function limitedToken(spaceIds = ['sA']) {
  const res = await token(await login('ed'), { spaceIds });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}
const bearer = (tok: string, method: Method, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok}`, ...headers } });

describe('jeton limité : création', () => {
  it('enregistre les espaces, les renvoie avec leur nom et les journalise sans secret', async () => {
    const s = await login('ed');
    const res = await token(s, { spaceIds: ['sA', 'sB', 'sA'] });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; token: string; spaces: { id: string; name: string }[] };
    expect(body.spaces).toEqual([{ id: 'sA', name: 'Espace A' }, { id: 'sB', name: 'Espace B' }]);
    const list = (await call(s, 'GET', '/api/v3/tokens')).json() as { id: string; spaces: unknown }[];
    expect(list.find((t) => t.id === body.id)!.spaces).toEqual([{ id: 'sA', name: 'Espace A' }, { id: 'sB', name: 'Espace B' }]);
    const log = db.prepare("SELECT meta FROM audit_log WHERE action = 'token.create'").get() as { meta: string };
    expect(JSON.parse(log.meta).spaceIds).toEqual(['sA', 'sB']);
    expect(log.meta).not.toContain(body.token);
    // Le nom suit l'espace.
    db.prepare("UPDATE spaces SET name = 'A renommé' WHERE id = 'sA'").run();
    expect(((await call(s, 'GET', '/api/v3/tokens')).json() as { id: string; spaces: { name: string }[] }[]).find((t) => t.id === body.id)!.spaces[0]!.name).toBe('A renommé');
  });

  it('sans espaces (champ absent) : spaces null ; un tableau vide est refusé (ambigu)', async () => {
    const s = await login('ed');
    const res = await token(s, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().spaces).toBeNull();
    expect((await token(s, { spaceIds: [] })).statusCode).toBe(400);
    expect(((await call(s, 'GET', '/api/v3/tokens')).json() as { spaces: unknown }[]).every((t) => t.spaces === null)).toBe(true);
  });

  it('espace inconnu, illisible ou personnel d’autrui : 404 ; portée admin : 400', async () => {
    const s = await login('ed');
    for (const id of ['inconnu', 'sC', 'sPers2']) expect((await token(s, { spaceIds: ['sA', id] })).statusCode).toBe(404);
    // Son propre espace personnel peut être choisi explicitement.
    expect((await token(s, { spaceIds: ['sPers'] })).statusCode).toBe(201);
    const adm = await login('adm');
    const res = await call(adm, 'POST', '/api/v3/tokens', { name: 'x', scopes: ['read', 'admin'], spaceIds: ['sA'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail ?? res.json().message).toContain('admin');
    expect((db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get('adm') as { n: number }).n).toBe(0);
    // Un administrateur limite son jeton à un espace dont il n'est pas membre (il lit tout), jamais à un espace personnel d'autrui.
    expect((await call(adm, 'POST', '/api/v3/tokens', { name: 'x', scopes: ['read'], spaceIds: ['sC'] })).statusCode).toBe(201);
    expect((await call(adm, 'POST', '/api/v3/tokens', { name: 'x', scopes: ['read'], spaceIds: ['sPers'] })).statusCode).toBe(404);
  });

  it('un jeton ne crée pas de jeton ; la portée admin est retirée à la vérification si la base la contenait', async () => {
    const tok = await limitedToken();
    expect((await bearer(tok, 'POST', '/api/v3/tokens', { name: 'x', scopes: ['read'] })).statusCode).toBe(403);
    // Ligne altérée à la main : le jeton limité n'obtient jamais la portée admin.
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', 'ed');
    db.prepare("UPDATE api_tokens SET scopes = '[\"read\",\"admin\"]'").run();
    expect((await bearer(tok, 'GET', '/api/v3/admin/users')).statusCode).toBe(403);
    expect((await bearer(tok, 'GET', '/api/v3/me')).json().permissions.admin).toBe(false);
  });
});

describe('jeton limité à A : garde l’accès à A', () => {
  it('lit, liste, cherche, écrit, commente et crée dans A', async () => {
    const tok = await limitedToken();
    expect(((await bearer(tok, 'GET', '/api/v3/spaces')).json() as { id: string }[]).map((s) => s.id)).toEqual(['sA']);
    const page = await bearer(tok, 'GET', '/api/v3/pages/pA');
    expect(page.statusCode).toBe(200);
    expect((await bearer(tok, 'PATCH', '/api/v3/pages/pA', { title: 'A modifiée' })).statusCode).toBe(200);
    expect((await bearer(tok, 'POST', '/api/v3/pages', { spaceId: 'sA', title: 'Nouvelle', parentId: 'pA' })).statusCode).toBe(201);
    expect((await bearer(tok, 'POST', '/api/v3/pages/pA/comments', { body: 'Bien' })).statusCode).toBe(201);
    const found = (await bearer(tok, 'GET', '/api/v3/search?q=zebre')).json() as { items: { id: string }[] };
    expect(found.items.map((i) => i.id)).toEqual(['pA']);
    expect((await bearer(tok, 'GET', '/api/v3/spaces/sA/export/zip')).statusCode).toBe(200);
  });
});

describe('jeton limité à A : rien hors de A (404)', () => {
  it('lecture directe : page d’un autre espace, d’un espace public, de son espace personnel', async () => {
    const tok = await limitedToken();
    for (const id of ['pB', 'pP', 'pPers']) {
      for (const url of [`/api/v3/pages/${id}`, `/api/v3/pages/${id}/export`, `/api/v3/pages/${id}/versions`, `/api/v3/pages/${id}/backlinks`,
        `/api/v3/pages/${id}/comments`, `/api/v3/pages/${id}/labels`, `/api/v3/pages/${id}/attachments`, `/api/v3/pages/${id}/watch`,
        `/api/v3/pages/${id}/verification`, `/api/v3/pages/${id}/read-receipt`, `/api/v3/pages/${id}/permissions`, `/api/v3/pages/${id}/mentionable?q=no`]) {
        const res = await bearer(tok, 'GET', url);
        expect(res.statusCode, `${url} ${res.body}`).toBe(404);
        expect(res.body).not.toContain('secret');
      }
    }
  });

  it('listes, recherche, libellés, modèles, corbeille, mes tâches', async () => {
    const tok = await limitedToken();
    const ed = await login('ed');
    db.prepare("INSERT INTO page_labels (page_id, name, created_at) VALUES ('pB', 'etiquetteb', 0), ('pA', 'etiquettea', 0)").run();
    db.prepare("INSERT INTO page_templates (id, space_id, name, content, created_at, updated_at) VALUES ('tB', 'sB', 'Modèle B', '{\"type\":\"doc\",\"content\":[]}', 0, 0)").run();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, deleted_at, trash_root) VALUES ('pBt', 'sB', 'Corbeille B', '{}', '', 1, 1, 2, 'pBt')").run();
    // Base de B où une colonne Personne désigne la personne.
    const base = (await call(ed, 'POST', '/api/v3/bases', { spaceId: 'sB', title: 'Tâches B' })).json() as { page: { id: string } };
    const qui = (await call(ed, 'POST', `/api/v3/bases/${base.page.id}/properties`, { name: 'Qui', type: 'person' })).json() as { id: string };
    expect((await call(ed, 'POST', `/api/v3/bases/${base.page.id}/rows`, { values: { [qui.id]: 'ed' } })).statusCode).toBe(201);
    expect(((await call(ed, 'GET', '/api/v3/my-tasks')).json() as { tasks: unknown[] }).tasks).toHaveLength(1);

    const ids = (r: { json: () => unknown }) => ((r.json() as { items: { id: string }[] }).items ?? []).map((i) => i.id);
    expect(ids(await bearer(tok, 'GET', '/api/v3/pages'))).toEqual(['pA']);
    expect(ids(await bearer(tok, 'GET', '/api/v3/pages?spaceId=sB'))).toEqual([]);
    expect(ids(await bearer(tok, 'GET', '/api/v3/pages?spaceId=sP'))).toEqual([]);
    expect(ids(await bearer(tok, 'GET', '/api/v3/search?q=zebre'))).toEqual(['pA']);
    expect(ids(await bearer(tok, 'GET', '/api/v3/search?q=zebre&spaceId=sB'))).toEqual([]);
    expect((await bearer(tok, 'GET', '/api/v3/labels')).json().items.map((l: { name: string }) => l.name)).toEqual(['etiquettea']);
    expect(ids(await bearer(tok, 'GET', '/api/v3/pages?label=etiquetteb'))).toEqual([]);
    expect((await bearer(tok, 'GET', '/api/v3/templates')).body).not.toContain('Modèle B');
    expect((await bearer(tok, 'GET', '/api/v3/templates/tB')).statusCode).toBe(404);
    expect((await bearer(tok, 'GET', '/api/v3/trash')).body).not.toContain('pBt');
    expect((await bearer(tok, 'POST', '/api/v3/pages/pBt/restore')).statusCode).toBe(404);
    expect(((await bearer(tok, 'GET', '/api/v3/my-tasks')).json() as { tasks: unknown[] }).tasks).toEqual([]);
    expect((await bearer(tok, 'GET', `/api/v3/bases/${base.page.id}`)).statusCode).toBe(404);
    expect((await bearer(tok, 'GET', `/api/v3/bases/${base.page.id}/rows`)).statusCode).toBe(404);
    expect((await bearer(tok, 'GET', `/api/v3/bases/${base.page.id}/export`)).statusCode).toBe(404);
    expect((await bearer(tok, 'POST', `/api/v3/bases/${base.page.id}/rows`, { values: {} })).statusCode).toBe(404);
    expect((await bearer(tok, 'GET', '/api/v3/verifications')).body).not.toContain('pB');
  });

  it('écriture : modifier, créer, supprimer, commenter, étiqueter, suivre, favori, versions, modèle, partage', async () => {
    const tok = await limitedToken();
    const before = db.prepare("SELECT title, version, deleted_at FROM pages WHERE id = 'pB'").get();
    const attempts: [Method, string, object?][] = [
      ['PATCH', '/api/v3/pages/pB', { title: 'piratée' }],
      ['POST', '/api/v3/pages', { spaceId: 'sB', title: 'x' }],
      ['POST', '/api/v3/pages', { spaceId: 'sP', title: 'x' }],
      ['POST', '/api/v3/pages', { spaceId: 'sPers', title: 'x' }],
      ['POST', '/api/v3/pages', { spaceId: 'sA', title: 'x', parentId: 'pB' }],
      ['DELETE', '/api/v3/pages/pB'],
      ['POST', '/api/v3/pages/pB/comments', { body: 'x' }],
      ['POST', '/api/v3/pages/pB/labels', { name: 'x' }],
      ['PUT', '/api/v3/pages/pB/watch'],
      ['PUT', '/api/v3/pages/pB/favorite'],
      ['POST', '/api/v3/pages/pB/duplicate'],
      ['POST', '/api/v3/pages/pB/versions/1/restore'],
      ['POST', '/api/v3/templates', { pageId: 'pB' }],
      ['POST', '/api/v3/bases', { spaceId: 'sB', title: 'x' }],
      ['POST', '/api/v3/pages/pB/read-receipt/ack'],
      ['PUT', '/api/v3/pages/pB/verification', { verifierIds: ['ed'], intervalDays: 30 }],
    ];
    for (const [m, url, body] of attempts) {
      const res = await bearer(tok, m, url, body);
      expect(res.statusCode, `${m} ${url} ${res.body}`).toBe(404);
    }
    expect(db.prepare("SELECT title, version, deleted_at FROM pages WHERE id = 'pB'").get()).toEqual(before);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pages WHERE space_id != 'sA' AND title = 'x'").get() as { n: number }).n).toBe(0);
    // Le partage public se règle en session web seulement (même réponse pour toute page).
    expect((await bearer(tok, 'PUT', '/api/v3/pages/pB/share', { includeChildren: false })).statusCode).toBe(403);
    expect((await bearer(tok, 'PUT', '/api/v3/pages/pA/share', { includeChildren: false })).statusCode).toBe(403);
  });

  it('ne touche pas aux favoris, au suivi ni aux notifications d’un autre espace', async () => {
    const tok = await limitedToken();
    db.prepare("INSERT INTO favorites (user_id, page_id) VALUES ('ed', 'pB')").run();
    db.prepare("INSERT INTO page_watch (user_id, page_id, created_at) VALUES ('ed', 'pB', 0)").run();
    expect((await bearer(tok, 'DELETE', '/api/v3/pages/pB/favorite')).statusCode).toBe(204);
    expect((await bearer(tok, 'DELETE', '/api/v3/pages/pB/watch')).statusCode).toBe(200);
    expect(db.prepare("SELECT 1 FROM favorites WHERE page_id = 'pB'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM page_watch WHERE page_id = 'pB'").get()).toBeTruthy();

    const notif = db.prepare("INSERT INTO notifications (id, user_id, type, page_id, actor_id, created_at) VALUES (?, 'ed', 'comment', ?, 'ed2', ?)");
    notif.run('nA', 'pA', 1); notif.run('nB', 'pB', 2);
    const inbox = (await bearer(tok, 'GET', '/api/v3/notifications')).json() as { items: { id: string }[] };
    expect(inbox.items.map((i) => i.id)).toEqual(['nA']);
    expect((await bearer(tok, 'GET', '/api/v3/notifications/unread-count')).json().unread).toBe(1);
    expect((await bearer(tok, 'POST', '/api/v3/notifications/read', { ids: ['nB'] })).json().updated).toBe(0);
    expect((await bearer(tok, 'POST', '/api/v3/notifications/read', { all: true })).json().updated).toBe(1);
    expect((db.prepare("SELECT read_at FROM notifications WHERE id = 'nB'").get() as { read_at: number | null }).read_at).toBeNull();
  });

  it('copie et déplacement : ni vers un autre espace, ni depuis, ni sous une page d’un autre espace', async () => {
    const tok = await limitedToken();
    const attempts: [string, object][] = [
      ['/api/v3/pages/pA/move', { parentId: null, spaceId: 'sB' }],
      ['/api/v3/pages/pA/move', { parentId: null, spaceId: 'sP' }],
      ['/api/v3/pages/pA/move', { parentId: 'pB' }],
      ['/api/v3/pages/pB/move', { parentId: null, spaceId: 'sA' }],
      ['/api/v3/pages/pA/copy', { spaceId: 'sB' }],
      ['/api/v3/pages/pA/copy', { spaceId: 'sPers' }],
      ['/api/v3/pages/pA/copy', { spaceId: 'sA', parentId: 'pB' }],
      ['/api/v3/pages/pB/copy', { spaceId: 'sA' }],
    ];
    for (const [url, body] of attempts) {
      const res = await bearer(tok, 'POST', url, body);
      expect(res.statusCode, `${url} ${JSON.stringify(body)} ${res.body}`).toBe(404);
    }
    expect(db.prepare("SELECT space_id, parent_id FROM pages WHERE id = 'pA'").get()).toEqual({ space_id: 'sA', parent_id: null });
    expect((db.prepare("SELECT COUNT(*) AS n FROM pages WHERE space_id = 'sB'").get() as { n: number }).n).toBe(1);
  });

  it('export et import : ni page, ni espace hors de A', async () => {
    const tok = await limitedToken();
    for (const url of ['/api/v3/pages/pB/export/zip', '/api/v3/spaces/sB/export/zip', '/api/v3/spaces/sP/export/zip', '/api/v3/pages/pB/export?format=json']) {
      expect((await bearer(tok, 'GET', url)).statusCode, url).toBe(404);
    }
    const pdf = await app.inject({ method: 'POST', url: '/api/v3/spaces/sB/import/document?filename=a.pdf&dryRun=false', payload: Buffer.from('%PDF-1.4\n'), headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/pdf' } });
    expect(pdf.statusCode).toBe(404);
    const zip = await app.inject({ method: 'POST', url: '/api/v3/spaces/sB/import/notion?dryRun=false', payload: Buffer.from('PK'), headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/zip' } });
    expect(zip.statusCode).toBe(404);
    // L'export d'une page de A ne nomme pas une page de B citée en lien.
    db.prepare("UPDATE pages SET content = ? WHERE id = 'pA'").run(JSON.stringify(doc({ type: 'paragraph', content: [{ type: 'text', text: 'voir', marks: [{ type: 'link', attrs: { href: '/p/pB' } }] }, { type: 'pageMention', attrs: { id: 'pB' } }] })));
    const md = await bearer(tok, 'GET', '/api/v3/pages/pA/export');
    expect(md.statusCode).toBe(200);
    expect(md.body).not.toContain('Page B');
  });

  it('pièces jointes et blocs synchronisés d’un autre espace : introuvables', async () => {
    const tok = await limitedToken();
    db.prepare("INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES ('attBattBattBattBattB01', 'pB', 'ed', 'b.pdf', 'application/pdf', 3, ?, 0)").run('a'.repeat(64));
    expect((await bearer(tok, 'GET', '/api/v3/attachments/attBattBattBattBattB01')).statusCode).toBe(404);
    expect((await bearer(tok, 'DELETE', '/api/v3/attachments/attBattBattBattBattB01')).statusCode).toBe(404);
    const ed = await login('ed');
    const block = newBlockId();
    const created = await call(ed, 'POST', '/api/v3/pages', { spaceId: 'sB', title: 'Source' });
    expect(created.statusCode).toBe(201);
    const set = await app.inject({ method: 'PATCH', url: `/api/v3/pages/${created.json().id}`, cookies: ed.cookies, headers: { ...ed.headers, 'if-match': '"1"' },
      payload: { content: doc({ type: 'syncedSource', attrs: { blockId: block }, content: [para('bloc secret')] }) } });
    expect(set.statusCode, set.body).toBe(200);
    expect((await call(ed, 'GET', `/api/v3/synced-blocks/${block}`)).statusCode).toBe(200);
    const res = await bearer(tok, 'GET', `/api/v3/synced-blocks/${block}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('bloc secret');
  });

  it('création d’espace refusée, partagé comme personnel', async () => {
    const tok = await limitedToken();
    expect((await bearer(tok, 'POST', '/api/v3/spaces', { name: 'Nouveau' })).statusCode).toBe(403);
    db.prepare("DELETE FROM spaces WHERE id = 'sPers'").run();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('personal_spaces', '{\"enabled\":true}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    expect((await bearer(tok, 'POST', '/api/v3/spaces/personal')).statusCode).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'personal' AND owner_id = 'ed'").get() as { n: number }).n).toBe(0);
  });

  it('iCalendar : la gestion du flux reste réservée à la session web', async () => {
    const tok = await limitedToken();
    const ed = await login('ed');
    const base = (await call(ed, 'POST', '/api/v3/bases', { spaceId: 'sB', title: 'Agenda B' })).json() as { page: { id: string } };
    for (const m of ['GET', 'POST'] as const) {
      const res = await bearer(tok, m, `/api/v3/bases/${base.page.id}/ical`, m === 'POST' ? {} : undefined);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('/ical/');
    }
  });

  it('MCP : mêmes refus que l’API REST', async () => {
    const tok = await limitedToken();
    const rpc = (name: string, args: object) => bearer(tok, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream' });
    const text = async (name: string, args: object) => (await rpc(name, args)).json().result as { isError?: boolean; content: { text: string }[] };
    expect(JSON.parse((await text('list_spaces', {})).content[0]!.text).map((s: { id: string }) => s.id)).toEqual(['sA']);
    const found = await text('search_pages', { query: 'zebre' });
    expect(found.content[0]!.text).not.toContain('pB');
    expect(found.content[0]!.text).toContain('pA');
    for (const [name, args] of [['get_page', { id: 'pB' }], ['get_page_info', { id: 'pB' }], ['create_page', { spaceId: 'sB', title: 'X' }], ['move_page', { id: 'pA', parentId: null, spaceId: 'sB' }], ['trash_page', { id: 'pB' }], ['list_comments', { id: 'pB' }]] as const) {
      const r = await text(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text).not.toContain('secret');
    }
  });

  it('recherche IA : aucun extrait d’un autre espace n’est envoyé au fournisseur', async () => {
    const tok = await limitedToken();
    const adm = await login('adm');
    expect((await call(adm, 'PUT', '/api/v3/admin/ai', { enabled: true, provider: 'openai', baseUrl: providerUrl, model: 'test-model', apiKey: 'cle-secrete-0001', reauth: { password: PASS } })).statusCode).toBe(200);
    const res = await bearer(tok, 'POST', '/api/v3/ai/ask', { question: 'zebre bravo public perso ?' });
    expect(res.statusCode).toBe(200);
    const sources = JSON.parse(/^event: sources\ndata: (.+)$/m.exec(res.body)![1]!) as { id: string }[];
    expect(sources.map((s) => s.id)).toEqual(['pA']);
    expect(received.join('\n')).not.toMatch(/secretB|secretP|secretPerso/);
    // Assistant de rédaction : page d'un autre espace introuvable, rien n'est envoyé.
    const n = received.length;
    expect((await bearer(tok, 'POST', '/api/v3/ai/assist', { pageId: 'pB', action: 'improve', text: 'Bonjour.' })).statusCode).toBe(404);
    expect(received.length).toBe(n);
  });

  it('flux d’évènements : rien d’un autre espace', async () => {
    const tok = await limitedToken();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v3/events`;
    const controller = new AbortController();
    const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` }, signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    const pump = (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; text += new TextDecoder().decode(r.value); } } catch { /* coupé */ } })();
    await new Promise((r) => setTimeout(r, 50));
    app.bus.publish({ type: 'page.updated', spaceId: 'sB', pageId: 'pB', version: 2 });
    app.bus.publish({ type: 'page.updated', spaceId: 'sP', pageId: 'pP', version: 2 });
    app.bus.publish({ type: 'page.updated', pageId: 'pB', version: 3 });
    app.bus.publish({ type: 'space.changed', spaceId: 'sB' });
    app.bus.publish({ type: 'page.updated', spaceId: 'sA', pageId: 'pA', version: 2 });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pump;
    expect(text).toContain('"pageId":"pA"');
    expect(text).not.toContain('pB');
    expect(text).not.toContain('pP');
    expect(text).not.toContain('"spaceId":"sB"');
  });
});

describe('espace supprimé, jeton sans limite', () => {
  it('le jeton perd l’espace supprimé et ne redevient jamais « tous les espaces »', async () => {
    const tok = await limitedToken(['sA']);
    const adm = await login('adm');
    expect((await call(adm, 'DELETE', '/api/v3/spaces/sA')).statusCode).toBe(204);
    expect((await bearer(tok, 'GET', '/api/v3/spaces')).json()).toEqual([]);
    expect((await bearer(tok, 'GET', '/api/v3/pages')).json().items).toEqual([]);
    expect((await bearer(tok, 'GET', '/api/v3/pages/pB')).statusCode).toBe(404);
    expect((await bearer(tok, 'GET', '/api/v3/search?q=zebre')).json().items).toEqual([]);
    const list = (await call(await login('ed'), 'GET', '/api/v3/tokens')).json() as { spaces: unknown }[];
    expect(list[0]!.spaces).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_token_spaces').get()).toEqual({ n: 0 });
  });

  it('un jeton sans espaces garde tous les espaces de la personne', async () => {
    const res = await token(await login('ed'), {});
    const tok = res.json().token as string;
    expect(((await bearer(tok, 'GET', '/api/v3/spaces')).json() as { id: string }[]).map((s) => s.id).sort()).toEqual(['sA', 'sB', 'sP', 'sPers']);
    expect(((await bearer(tok, 'GET', '/api/v3/search?q=zebre')).json() as { items: { id: string }[] }).items.map((i) => i.id).sort()).toEqual(['pA', 'pB', 'pP', 'pPers']);
    expect((await bearer(tok, 'GET', '/api/v3/pages/pB')).statusCode).toBe(200);
    expect((await bearer(tok, 'POST', '/api/v3/pages/pA/copy', { spaceId: 'sB' })).statusCode).toBe(201);
  });

  it('la révocation d’un jeton supprime ses espaces avec lui quand le jeton est effacé', async () => {
    await limitedToken(['sA', 'sB']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_token_spaces').get()).toEqual({ n: 2 });
    db.prepare('DELETE FROM api_tokens').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_token_spaces').get()).toEqual({ n: 0 });
  });

  it('un jeton limité ne crée ni ne modifie d’automatisation (elle s’exécuterait avec les droits du compte)', async () => {
    const ed = await login('ed');
    const base = (await call(ed, 'POST', '/api/v3/bases', { spaceId: 'sA', title: 'Base A' })).json() as { page: { id: string } };
    const tok = await limitedToken();
    const body = { name: 'auto', trigger: { type: 'row_added' }, actions: [{ type: 'set_property', propertyId: 'x', value: 'a' }] };
    expect((await bearer(tok, 'POST', `/api/v3/bases/${base.page.id}/automations`, body)).statusCode).toBe(403);
    expect((await bearer(tok, 'PATCH', `/api/v3/bases/${base.page.id}/automations/inconnue`, { enabled: true })).statusCode).toBe(403);
  });
});
