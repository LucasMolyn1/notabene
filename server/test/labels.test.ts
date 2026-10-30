import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { MAX_LABELS_PER_PAGE, normalizeLabel } from '../src/lib/labels.js';
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
});
afterEach(async () => { await app.close(); db.close(); });

beforeEach(() => {
  const team = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
  const now = Date.now();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('pagelibre001', ?, 'Page libre', ?, 'texte libre sur le deploiement', ?, ?)")
    .run(team, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }), now, now);
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });

const pageId = (title: string) => (db.prepare('SELECT id FROM pages WHERE title = ?').get(title) as { id: string }).id;
const secret = () => pageId('Onboarding');
// Page de l'espace d'équipe hors de l'arborescence d'« Onboarding » (dont les sous-pages héritent de ses restrictions).
const open = () => pageId('Page libre');
const add = (s: S | null, id: string, name: string) => call(s, 'POST', `/api/v3/pages/${id}/labels`, { name });
const names = (res: { json: () => unknown }) => (res.json() as { items: string[] }).items;
const counts = (res: { json: () => unknown }) => (res.json() as { items: { name: string; count: number }[] }).items;

async function restrictToEd1() {
  const admin = await login('admin@example.com');
  const res = await call(admin, 'PUT', `/api/v3/pages/${secret()}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
  expect(res.statusCode).toBe(200);
  return admin;
}

describe('normalisation des libellés', () => {
  it('met en minuscules, remplace les espaces et accepte les accents', () => {
    expect(normalizeLabel('  Mise en Production ')).toBe('mise-en-production');
    expect(normalizeLabel('Équipe_2')).toBe('équipe_2');
  });

  it('refuse ce qui sort de la liste blanche', () => {
    for (const bad of ['', '   ', '-debut', '_x', 'a'.repeat(41), 'a/b', 'a<b>', 'a"b', "a'b", 'a%00', 'a\u0000b', '<script>', 'a.b', 'a:b', '😀']) {
      expect(() => normalizeLabel(bad), JSON.stringify(bad)).toThrow();
    }
    expect(normalizeLabel('a'.repeat(40))).toHaveLength(40);
  });
});

describe('API v3 : libellés', () => {
  it('pose, relit, ne duplique pas et retire un libellé', async () => {
    const ed1 = await login('ed1@example.com');
    expect(names(await add(ed1, open(), 'Procédure'))).toEqual(['procédure']);
    expect(names(await add(ed1, open(), 'procédure'))).toEqual(['procédure']);
    expect(names(await add(ed1, open(), 'urgent'))).toEqual(['procédure', 'urgent']);
    expect(names(await call(ed1, 'GET', `/api/v3/pages/${open()}/labels`))).toEqual(['procédure', 'urgent']);
    expect((await call(ed1, 'GET', `/api/v3/pages/${open()}`)).json().labels).toEqual(['procédure', 'urgent']);
    expect(names(await call(ed1, 'DELETE', `/api/v3/pages/${open()}/labels/${encodeURIComponent('Procédure')}`))).toEqual(['urgent']);
    // Retirer un libellé absent n'est pas une erreur.
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${open()}/labels/absent`)).statusCode).toBe(200);
  });

  it('refuse un nom invalide, y compris dans l’adresse', async () => {
    const ed1 = await login('ed1@example.com');
    expect((await add(ed1, open(), '<img src=x onerror=alert(1)>')).statusCode).toBe(400);
    expect((await add(ed1, open(), '../x')).statusCode).toBe(400);
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${open()}/labels/${encodeURIComponent('a/b')}`)).statusCode).toBe(400);
    expect((await call(ed1, 'POST', `/api/v3/pages/${open()}/labels`, { name: 12 })).statusCode).toBe(400);
    expect((await call(ed1, 'POST', `/api/v3/pages/${open()}/labels`, {})).statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) AS n FROM page_labels').get()).toEqual({ n: 0 });
  });

  it(`plafonne à ${MAX_LABELS_PER_PAGE} libellés par page`, async () => {
    const ed1 = await login('ed1@example.com');
    for (let i = 0; i < MAX_LABELS_PER_PAGE; i++) expect((await add(ed1, open(), `l${i}`)).statusCode).toBe(200);
    expect((await add(ed1, open(), 'trop')).statusCode).toBe(400);
    expect((await add(ed1, open(), 'l0')).statusCode, 'déjà posé : sans effet').toBe(200);
  });

  it('exige le droit d’écriture : lecteur, anonyme et permission en lecture seule sont refusés', async () => {
    const rd = await login('rd@example.com');
    expect((await add(rd, open(), 'x')).statusCode).toBe(403);
    expect((await call(rd, 'DELETE', `/api/v3/pages/${open()}/labels/x`)).statusCode).toBe(403);
    expect([401, 403]).toContain((await add(null, open(), 'x')).statusCode);

    const ed1 = await login('ed1@example.com');
    await add(ed1, secret(), 'prive');
    const admin = await login('admin@example.com');
    await call(admin, 'PUT', `/api/v3/pages/${secret()}/permissions`, { entries: [{ userId: 'ed1', level: 'read' }] });
    expect((await add(ed1, secret(), 'autre')).statusCode).toBe(403);
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${secret()}/labels/prive`)).statusCode).toBe(403);
    expect(names(await call(ed1, 'GET', `/api/v3/pages/${secret()}/labels`))).toEqual(['prive']);
  });

  it('exige le jeton CSRF pour écrire avec une session', async () => {
    const ed1 = await login('ed1@example.com');
    const res = await app.inject({ method: 'POST', url: `/api/v3/pages/${open()}/labels`, payload: { name: 'x' }, cookies: ed1.cookies });
    expect(res.statusCode).toBe(403);
    expect(db.prepare('SELECT count(*) AS n FROM page_labels').get()).toEqual({ n: 0 });
  });

  it('journalise l’ajout et le retrait', async () => {
    const ed1 = await login('ed1@example.com');
    await add(ed1, open(), 'audit');
    await add(ed1, open(), 'audit');
    await call(ed1, 'DELETE', `/api/v3/pages/${open()}/labels/audit`);
    const rows = db.prepare("SELECT action, target FROM audit_log WHERE action LIKE 'page.label.%' ORDER BY id").all();
    expect(rows).toEqual([{ action: 'page.label.add', target: open() }, { action: 'page.label.remove', target: open() }]);
  });
});

describe('API v3 : libellés et pages restreintes (aucune fuite)', () => {
  it('une page restreinte est introuvable pour lire ou poser un libellé', async () => {
    await restrictToEd1();
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    await add(ed1, secret(), 'confidentiel');
    expect((await call(ed2, 'GET', `/api/v3/pages/${secret()}/labels`)).statusCode).toBe(404);
    expect((await add(ed2, secret(), 'x')).statusCode).toBe(404);
    expect((await call(ed2, 'DELETE', `/api/v3/pages/${secret()}/labels/confidentiel`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/api/v3/pages/${secret()}/labels`)).statusCode).toBe(404);
    expect(names(await call(ed1, 'GET', `/api/v3/pages/${secret()}/labels`))).toEqual(['confidentiel']);
  });

  it('le libellé d’une page restreinte n’apparaît ni dans la liste, ni dans les totaux, ni dans les filtres', async () => {
    await restrictToEd1();
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    await add(ed1, secret(), 'confidentiel');
    await add(ed1, secret(), 'commun');
    await add(ed1, open(), 'commun');

    expect(counts(await call(ed1, 'GET', '/api/v3/labels'))).toEqual([{ name: 'commun', count: 2 }, { name: 'confidentiel', count: 1 }]);
    // L'autre éditeur ne voit ni le nom réservé, ni la page dans le total.
    const seen = await call(ed2, 'GET', '/api/v3/labels');
    expect(counts(seen)).toEqual([{ name: 'commun', count: 1 }]);
    expect(JSON.stringify(seen.json())).not.toContain('confidentiel');
    // Même en cherchant le préfixe exact.
    expect(counts(await call(ed2, 'GET', '/api/v3/labels?q=confi'))).toEqual([]);

    const filtered = await call(ed2, 'GET', '/api/v3/pages?label=confidentiel');
    expect(filtered.json().items).toEqual([]);
    expect(JSON.stringify((await call(ed2, 'GET', '/api/v3/pages?label=commun')).json())).not.toContain('Onboarding');
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/pages?label=commun')).json())).toContain('Onboarding');
    expect(JSON.stringify((await call(ed2, 'GET', '/api/v3/search?q=onboarding&label=commun')).json())).not.toContain('Onboarding');
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/search?q=onboarding&label=commun')).json())).toContain('Onboarding');
    // Les administrateurs voient tout.
    expect(counts(await call(await login('admin@example.com'), 'GET', '/api/v3/labels')).map((l) => l.name)).toEqual(['commun', 'confidentiel']);
  });

  it('un anonyme ne voit que les libellés des espaces publics', async () => {
    const ed1 = await login('ed1@example.com');
    const publicPage = (db.prepare("SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id WHERE s.visibility = 'public' LIMIT 1").get() as { id: string }).id;
    await add(ed1, publicPage, 'public-ok');
    await add(ed1, open(), 'equipe-seulement');
    const anon = await call(null, 'GET', '/api/v3/labels');
    expect(anon.statusCode).toBe(200);
    expect(counts(anon).map((l) => l.name)).toEqual(['public-ok']);
    expect(names(await call(null, 'GET', `/api/v3/pages/${publicPage}/labels`))).toEqual(['public-ok']);
    expect((await call(null, 'GET', `/api/v3/pages/${open()}/labels`)).statusCode).toBe(404);
  });

  it('une page à la corbeille ne compte plus ; la restaurer rend le libellé', async () => {
    const ed1 = await login('ed1@example.com');
    await add(ed1, open(), 'temporaire');
    expect(counts(await call(ed1, 'GET', '/api/v3/labels')).map((l) => l.name)).toContain('temporaire');
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${open()}`)).statusCode).toBeLessThan(300);
    expect(counts(await call(ed1, 'GET', '/api/v3/labels')).map((l) => l.name)).not.toContain('temporaire');
    expect((await call(ed1, 'GET', '/api/v3/pages?label=temporaire')).json().items).toEqual([]);
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/search?q=deploiement&label=temporaire')).json())).not.toContain(open());
    expect((await call(ed1, 'POST', `/api/v3/pages/${open()}/restore`)).statusCode).toBeLessThan(300);
    expect(counts(await call(ed1, 'GET', '/api/v3/labels')).map((l) => l.name)).toContain('temporaire');
  });

  it('dupliquer une page copie ses libellés ; supprimer définitivement les efface', async () => {
    const ed1 = await login('ed1@example.com');
    await add(ed1, open(), 'copie');
    const dup = await call(ed1, 'POST', `/api/v3/pages/${open()}/duplicate`);
    expect(dup.statusCode).toBeLessThan(300);
    expect(names(await call(ed1, 'GET', `/api/v3/pages/${dup.json().id}/labels`))).toEqual(['copie']);
    db.prepare('DELETE FROM pages WHERE id = ?').run(dup.json().id);
    expect(db.prepare('SELECT count(*) AS n FROM page_labels WHERE page_id = ?').get(dup.json().id)).toEqual({ n: 0 });
  });
});

describe('API v3 : recherche par libellé', () => {
  it('filtre la liste et la recherche, et traite % et _ comme du texte dans le préfixe', async () => {
    const ed1 = await login('ed1@example.com');
    await add(ed1, open(), 'alpha');
    await add(ed1, pageId('Onboarding'), 'beta');
    const list = (await call(ed1, 'GET', '/api/v3/pages?label=ALPHA')).json().items as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([open()]);
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/search?q=deploiement&label=alpha')).json())).toContain(open());
    expect(JSON.stringify((await call(ed1, 'GET', '/api/v3/search?q=deploiement&label=beta')).json())).not.toContain(open());
    expect(counts(await call(ed1, 'GET', '/api/v3/labels?q=%25')).length).toBe(0);
    expect(counts(await call(ed1, 'GET', '/api/v3/labels?q=_')).length).toBe(0);
    expect(counts(await call(ed1, 'GET', '/api/v3/labels?q=al')).map((l) => l.name)).toEqual(['alpha']);
    expect((await call(ed1, 'GET', '/api/v3/pages?label=%3Cx%3E')).statusCode).toBe(400);
  });
});

describe('effacement d’un compte', () => {
  it('les libellés posés restent, sans auteur', async () => {
    const ed1 = await login('ed1@example.com');
    await add(ed1, open(), 'reste');
    expect(eraseUser(db, 'ed1')).toBe(true);
    expect(db.prepare('SELECT name, created_by FROM page_labels').all()).toEqual([{ name: 'reste', created_by: null }]);
  });
});

describe('migration v11', () => {
  it('ajoute la table sans toucher aux données d’une base v10', () => {
    const upgraded = openDb(oldDb(10));
    expect(upgraded.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(11);
    expect(upgraded.prepare('SELECT title FROM pages').all()).toEqual([{ title: 'Page' }]);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'page_labels'").get()).toBeTruthy();
    upgraded.close();
  });
});
