import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { BUILTIN_TEMPLATES } from '../src/lib/builtin-templates.js';
import { sanitizeDoc } from '../src/lib/content.js';
import { hashPassword } from '../src/lib/password.js';
import { eraseUser } from '../src/lib/personal-data.js';
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
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor'], ['rd@example.com', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  }
  const team = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
  const now = Date.now();
  db.prepare("INSERT INTO pages (id, space_id, title, icon, content, text, created_at, updated_at) VALUES ('pagemodele01', ?, 'Fiche projet', 'file', ?, 'licorne rose', ?, ?)")
    .run(team, JSON.stringify({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Licorne rose' }] }, { type: 'paragraph' }] }), now, now);
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
const save = (s: S, name?: string, pageId = 'pagemodele01') => call(s, 'POST', '/api/v3/templates', { pageId, ...(name ? { name } : {}) });
const items = (res: { json: () => unknown }) => (res.json() as { items: { id: string; builtin: boolean; name: string; spaceId: string | null }[] }).items;

describe('modèles fournis', () => {
  it('sont des documents valides, que la sanitisation ne modifie pas', () => {
    for (const t of BUILTIN_TEMPLATES) expect(sanitizeDoc(t.content), t.id).toEqual(t.content);
  });

  it('se listent et se lisent pour toute personne connectée, y compris un lecteur', async () => {
    const rd = await login('rd@example.com');
    const list = items(await call(rd, 'GET', '/api/v3/templates'));
    expect(list.filter((t) => t.builtin).map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((t) => t.id));
    const one = await call(rd, 'GET', '/api/v3/templates/builtin-procedure');
    expect(one.statusCode).toBe(200);
    expect(one.json().content.type).toBe('doc');
  });

  it('exigent une connexion', async () => {
    expect([401, 403]).toContain((await call(null, 'GET', '/api/v3/templates')).statusCode);
    expect([401, 403]).toContain((await call(null, 'GET', '/api/v3/templates/builtin-procedure')).statusCode);
  });

  it('un identifiant inconnu ou piégé est refusé', async () => {
    const ed1 = await login('ed1@example.com');
    expect((await call(ed1, 'GET', '/api/v3/templates/builtin-inconnu')).statusCode).toBe(404);
    expect((await call(ed1, 'GET', `/api/v3/templates/${encodeURIComponent('../x')}`)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('enregistrer une page comme modèle', () => {
  it('copie le contenu, nomme le modèle et le garde hors des pages, de la recherche et de la corbeille', async () => {
    const ed1 = await login('ed1@example.com');
    const pagesBefore = db.prepare('SELECT count(*) AS n FROM pages').get();
    const created = await save(ed1);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Fiche projet', builtin: false, icon: 'file' });
    expect(db.prepare('SELECT count(*) AS n FROM pages').get()).toEqual(pagesBefore);
    const got = (await call(ed1, 'GET', `/api/v3/templates/${created.json().id}`)).json();
    expect(JSON.stringify(got.content)).toContain('Licorne rose');
    // Les deux seules pages où figure le mot restent les pages réelles.
    const found = (await call(ed1, 'GET', '/api/v3/search?q=licorne')).json().items as { id: string }[];
    expect(found.map((p) => p.id)).toEqual(['pagemodele01']);
    expect(items(await call(ed1, 'GET', '/api/v3/pages')).every((p) => (p as { id: string }).id !== created.json().id)).toBe(true);
  });

  it('refuse un lecteur, une page introuvable, un nom invalide et un nom vide', async () => {
    const rd = await login('rd@example.com');
    expect((await save(rd)).statusCode).toBe(403);
    const ed1 = await login('ed1@example.com');
    expect((await save(ed1, undefined, 'inexistante01')).statusCode).toBe(404);
    expect((await save(ed1, '   ')).statusCode).toBe(400);
    expect((await save(ed1, 'x'.repeat(81))).statusCode).toBe(400);
    expect((await call(ed1, 'POST', '/api/v3/templates', {})).statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) AS n FROM page_templates').get()).toEqual({ n: 0 });
  });

  it('refuse une page à permissions restreintes, même pour une personne qui peut l’écrire et pour un administrateur', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    expect((await call(admin, 'PUT', '/api/v3/pages/pagemodele01/permissions', { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    expect((await save(ed1)).statusCode).toBe(403);
    expect((await save(admin)).statusCode).toBe(403);
    // Une sous-page hérite de la restriction.
    const child = (await call(ed1, 'POST', '/api/v3/pages', { spaceId: (db.prepare("SELECT space_id AS s FROM pages WHERE id = 'pagemodele01'").get() as { s: string }).s, parentId: 'pagemodele01', title: 'Enfant' })).json().id;
    expect((await save(ed1, undefined, child)).statusCode).toBe(403);
    expect(db.prepare('SELECT count(*) AS n FROM page_templates').get()).toEqual({ n: 0 });
  });

  it('refuse une page en lecture seule pour la personne', async () => {
    const admin = await login('admin@example.com');
    const ed1 = await login('ed1@example.com');
    // Restriction sur le parent, ed1 en lecture seule sur une autre page : la restriction s'applique via la page restreinte la plus proche.
    await call(admin, 'PUT', '/api/v3/pages/pagemodele01/permissions', { entries: [{ userId: 'ed1', level: 'read' }] });
    expect((await save(ed1)).statusCode).toBe(403);
  });

  it(`plafonne à 50 modèles par espace`, async () => {
    const ed1 = await login('ed1@example.com');
    const space = (db.prepare("SELECT space_id AS s FROM pages WHERE id = 'pagemodele01'").get() as { s: string }).s;
    const insert = db.prepare("INSERT INTO page_templates (id, space_id, name, content, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)");
    for (let i = 0; i < 49; i++) insert.run(`m${i}`, space, `m${i}`);
    expect((await save(ed1, 'cinquantième')).statusCode).toBe(201);
    expect((await save(ed1, 'trop')).statusCode).toBe(400);
  });

  it('exige le jeton CSRF', async () => {
    const ed1 = await login('ed1@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/v3/templates', payload: { pageId: 'pagemodele01' }, cookies: ed1.cookies });
    expect(res.statusCode).toBe(403);
    expect(db.prepare('SELECT count(*) AS n FROM page_templates').get()).toEqual({ n: 0 });
  });
});

describe('renommer et supprimer', () => {
  it('réservé à l’auteur et aux administrateurs', async () => {
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    const admin = await login('admin@example.com');
    const id = (await save(ed1, 'Mon modèle')).json().id;
    expect((await call(ed2, 'PATCH', `/api/v3/templates/${id}`, { name: 'Volé' })).statusCode).toBe(403);
    expect((await call(ed2, 'DELETE', `/api/v3/templates/${id}`)).statusCode).toBe(403);
    expect(db.prepare('SELECT name FROM page_templates WHERE id = ?').get(id)).toEqual({ name: 'Mon modèle' });
    expect((await call(ed1, 'PATCH', `/api/v3/templates/${id}`, { name: 'Renommé' })).json().name).toBe('Renommé');
    expect((await call(admin, 'PATCH', `/api/v3/templates/${id}`, { name: 'Par admin' })).statusCode).toBe(200);
    expect((await call(admin, 'DELETE', `/api/v3/templates/${id}`)).statusCode).toBe(204);
    expect((await call(ed1, 'GET', `/api/v3/templates/${id}`)).statusCode).toBe(404);
  });

  it('un lecteur ne peut ni renommer ni supprimer, et les modèles fournis ne se suppriment pas', async () => {
    const ed1 = await login('ed1@example.com');
    const rd = await login('rd@example.com');
    const id = (await save(ed1)).json().id;
    expect((await call(rd, 'DELETE', `/api/v3/templates/${id}`)).statusCode).toBe(403);
    expect((await call(ed1, 'DELETE', '/api/v3/templates/builtin-procedure')).statusCode).toBe(404);
    expect((await call(ed1, 'PATCH', '/api/v3/templates/builtin-procedure', { name: 'x' })).statusCode).toBe(404);
  });

  it('journalise la création, le renommage et la suppression', async () => {
    const ed1 = await login('ed1@example.com');
    const id = (await save(ed1)).json().id;
    await call(ed1, 'PATCH', `/api/v3/templates/${id}`, { name: 'Autre' });
    await call(ed1, 'DELETE', `/api/v3/templates/${id}`);
    expect((db.prepare("SELECT action FROM audit_log WHERE action LIKE 'template.%' ORDER BY id").all() as { action: string }[]).map((r) => r.action))
      .toEqual(['template.create', 'template.rename', 'template.delete']);
  });
});

describe('cycle de vie', () => {
  it('l’effacement de l’auteur garde le modèle, sans auteur', async () => {
    const ed1 = await login('ed1@example.com');
    const id = (await save(ed1)).json().id;
    expect(eraseUser(db, 'ed1')).toBe(true);
    expect(db.prepare('SELECT created_by FROM page_templates WHERE id = ?').get(id)).toEqual({ created_by: null });
  });

  it('la suppression d’un espace emporte ses modèles', async () => {
    const ed1 = await login('ed1@example.com');
    await save(ed1);
    db.prepare("DELETE FROM spaces WHERE id = (SELECT space_id FROM pages WHERE id = 'pagemodele01')").run();
    expect(db.prepare('SELECT count(*) AS n FROM page_templates').get()).toEqual({ n: 0 });
  });

  it('migration v12 : ajoute la table à une base v11 sans toucher aux pages', () => {
    const upgraded = openDb(oldDb(11));
    expect(upgraded.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(12);
    expect(upgraded.prepare('SELECT title FROM pages').all()).toEqual([{ title: 'Page' }]);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'page_templates'").get()).toBeTruthy();
    upgraded.close();
  });
});
