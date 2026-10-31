// Partage public par lien (lot 7) : activation, lecture sans compte, contenu assaini, révocation et fermetures.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
const doc = (...content: object[]) => JSON.stringify({ type: 'doc', content });
const para = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string, marks?: object[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
let app: FastifyInstance;
let db: DB;
let clientDir: string;
const logs: string[] = [];

async function boot(logger = false) {
  clientDir = mkdtempSync(join(tmpdir(), 'nb-share-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><head><title>Notabene</title></head><body><main id="main"></main></body></html>');
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir, ...(logger ? { logger: { level: 'info', stream: { write: (s: string) => { logs.push(s); } } } } : {}) });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit')").run();
  const page = (id: string, parent: string | null, title: string, content: string) =>
    db.prepare('INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, position) VALUES (?, \'sp\', ?, ?, ?, ?, 1, 1, 0)').run(id, parent, title, content, title);
  page('root', null, 'Racine', doc(
    para(text('Bonjour '), { type: 'mention', attrs: { id: 'ed1' } }, text(' voir '), { type: 'pageLink', attrs: { id: 'ailleurs' } }, text(' et '), { type: 'pageLink', attrs: { id: 'enfant' } }),
    para(text('texte commenté', [{ type: 'commentAnchor', attrs: { id: 'fil1' } }]))));
  page('enfant', 'root', 'Enfant', doc(para(text('contenu enfant'))));
  page('petit', 'enfant', 'Petit-enfant', doc(para(text('contenu petit'))));
  page('secret', 'root', 'Secret', doc(para(text('contenu secret'))));
  page('sous-secret', 'secret', 'Sous-secret', doc(para(text('contenu sous-secret'))));
  page('ailleurs', null, 'Page privée ailleurs', doc(para(text('hors partage'))));
  db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('secret', 'ed2', 'write')").run();
}
beforeEach(async () => { logs.length = 0; sessions.clear(); await boot(); });
afterEach(async () => { await app.close(); db.close(); });

const sessions = new Map<string, Awaited<ReturnType<typeof newSession>>>();
async function login(id: string) {
  if (!sessions.has(id)) sessions.set(id, await newSession(id));
  return sessions.get(id)!;
}
async function newSession(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
const enable = async (on = true) => expect((await call(await login('admin'), 'PUT', '/api/v3/admin/sharing', { enabled: on })).statusCode).toBe(200);
const tokenOf = (url: string) => url.split('/share/')[1]!;
async function share(who: string, page: string, body: object = {}) {
  const res = await call(await login(who), 'PUT', `/api/v3/pages/${page}/share`, body);
  expect(res.statusCode, res.body).toBeLessThan(300);
  return tokenOf((res.json() as { url: string }).url);
}
const pub = (token: string, extra = '') => app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}${extra}` });

describe('activation et droits', () => {
  it('désactivé par défaut : rien ne se crée et rien ne se lit', async () => {
    const ed1 = await login('ed1');
    expect((await call(ed1, 'PUT', '/api/v3/pages/root/share', {})).statusCode).toBe(403);
    expect((await call(ed1, 'GET', '/api/v3/pages/root/share')).json().available).toBe(false);
    expect((await call(ed1, 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(403);
  });

  it('réservé à qui peut modifier la page et à la session web ; le lien ne se montre qu’à qui peut modifier', async () => {
    await enable();
    expect((await call(await login('rd'), 'PUT', '/api/v3/pages/root/share', {})).statusCode).toBe(403);
    expect((await call(null, 'PUT', '/api/v3/pages/root/share', {})).statusCode).toBe(401);
    const ed1 = await login('ed1');
    const tok = await call(ed1, 'POST', '/api/v3/tokens', { name: 'essai', scopes: ['read', 'write'], expiresInDays: 7 });
    const bearer = { authorization: `Bearer ${tok.json().token}` };
    expect((await app.inject({ method: 'PUT', url: '/api/v3/pages/root/share', headers: bearer, payload: {} })).statusCode).toBe(403);
    const created = await call(ed1, 'PUT', '/api/v3/pages/root/share', {});
    expect(created.statusCode).toBe(201);
    expect(created.json().url).toMatch(/^http:\/\/localhost:3000\/share\/[A-Za-z0-9_-]{32}$/);
    expect((await call(await login('rd'), 'GET', '/api/v3/pages/root/share')).json().share).toBeNull();
    expect((await call(ed1, 'GET', '/api/v3/pages/root/share')).json().share.url).toBe(created.json().url);
    // Un compte sans accès à la page (restreinte) ne peut pas la partager.
    expect((await call(await login('ed1'), 'PUT', '/api/v3/pages/secret/share', {})).statusCode).toBe(404);
  });
});

describe('lecture sans compte', () => {
  it('sert la page assainie : ni nom de personne, ni titre d’une page non partagée, ni ancre de commentaire', async () => {
    await enable();
    const token = await share('ed1', 'root');
    const res = await pub(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body).toContain('Bonjour');
    expect(res.body).not.toMatch(/Nom ed1|Page privée ailleurs|commentAnchor|"mention"|ed1/);
    expect(res.body).toContain('@personne');
    expect(res.body).toContain('page non partagée');
    expect(res.json().page.title).toBe('Racine');
  });

  it('jeton inconnu, mal formé ou d’une autre page : la même réponse 404, sans détail', async () => {
    await enable();
    const token = await share('ed1', 'root');
    const bodies = new Set<string>();
    for (const t of ['inconnu', 'x'.repeat(32), `${token}x`, token.slice(1), '../../etc/passwd', 'A'.repeat(90)]) {
      const res = await pub(encodeURIComponent(t));
      expect(res.statusCode, t).toBe(404);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect((await pub(token, '/pages/ailleurs')).statusCode).toBe(404);
  });

  it('les sous-pages n’en font partie que si le partage les inclut, et jamais celles qui ont leurs propres permissions', async () => {
    await enable();
    const token = await share('ed1', 'root');
    expect((await pub(token, '/pages/enfant')).statusCode).toBe(404);
    expect((await pub(token)).json().tree).toEqual([]);
    await share('ed1', 'root', { includeChildren: true });
    const root = (await pub(token)).json() as { tree: { id: string }[]; titles: Record<string, string> };
    expect(root.tree.map((t) => t.id).sort()).toEqual(['enfant', 'petit']);
    expect(JSON.stringify(root)).not.toMatch(/Secret|Sous-secret/);
    expect((await pub(token, '/pages/petit')).json().page.title).toBe('Petit-enfant');
    expect((await pub(token, '/pages/secret')).statusCode).toBe(404);
    expect((await pub(token, '/pages/sous-secret')).statusCode).toBe(404);
    expect((await pub(token)).body).not.toContain('contenu enfant');
  });

  it('retirer, régénérer, mettre à la corbeille ou déplacer : le lien cesse de répondre tout de suite', async () => {
    await enable();
    const ed1 = await login('ed1');
    const token = await share('ed1', 'root');
    const fresh = tokenOf((await call(ed1, 'PUT', '/api/v3/pages/root/share', { regenerate: true })).json().url);
    expect(fresh).not.toBe(token);
    expect((await pub(token)).statusCode).toBe(404);
    expect((await pub(fresh)).statusCode).toBe(200);
    db.prepare("UPDATE pages SET deleted_at = 5 WHERE id = 'root'").run();
    expect((await pub(fresh)).statusCode).toBe(404);
    db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').run('root');
    expect((await pub(fresh)).statusCode).toBe(200);
    expect((await call(ed1, 'DELETE', '/api/v3/pages/root/share')).statusCode).toBe(204);
    expect((await pub(fresh)).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'share.%'").get()).toEqual({ n: 3 });
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(fresh);
  });
});

describe('pages à permissions restreintes', () => {
  it('confirmation explicite à la création ; une page restreinte APRÈS le partage cesse d’être servie', async () => {
    await enable();
    const ed2 = await login('ed2');
    const refused = await call(ed2, 'PUT', '/api/v3/pages/secret/share', {});
    expect(refused.statusCode).toBe(409);
    expect((await call(ed2, 'GET', '/api/v3/pages/secret/share')).json().restricted).toBe(true);
    const ok = await call(ed2, 'PUT', '/api/v3/pages/secret/share', { confirmRestricted: true });
    expect(ok.statusCode).toBe(201);
    expect((await pub(tokenOf(ok.json().url))).statusCode).toBe(200);

    const token = await share('ed1', 'enfant');
    expect((await pub(token)).statusCode).toBe(200);
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('enfant', 'ed2', 'write')").run();
    expect((await pub(token)).statusCode).toBe(404); // restreinte depuis : jamais servie sans confirmation
  });
});

describe('fermetures', () => {
  it('le réglage d’instance est relu à chaque lecture, même sans passer par la route qui efface les partages', async () => {
    await enable();
    const token = await share('ed1', 'root');
    db.prepare("UPDATE settings SET value = '{\"enabled\":false}' WHERE key = 'public_sharing'").run();
    expect((await pub(token)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_shares').get()).toEqual({ n: 1 });
  });

  it('couper le partage de l’instance retire tous les partages, et le réactiver ne les ressuscite pas', async () => {
    await enable();
    const token = await share('ed1', 'root');
    await enable(false);
    expect((await pub(token)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_shares').get()).toEqual({ n: 0 });
    await enable();
    expect((await pub(token)).statusCode).toBe(404);
  });

  it('couper le partage d’un espace retire ses partages ; seul un administrateur le règle ; une page déplacée suit son nouvel espace', async () => {
    await enable();
    const token = await share('ed1', 'root');
    expect((await call(await login('ed1'), 'PATCH', '/api/v3/spaces/sp', { sharing: false })).statusCode).toBe(403);
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('sp', 'ed1', 'full')").run();
    expect((await call(await login('ed1'), 'PATCH', '/api/v3/spaces/sp', { sharing: false })).statusCode).toBe(403); // gestionnaire : non
    expect((await call(await login('ed1'), 'PATCH', '/api/v3/spaces/sp', { name: 'Renommé par le gestionnaire' })).statusCode).toBe(200);
    expect(db.prepare("SELECT sharing_enabled FROM spaces WHERE id = 'sp'").get()).toEqual({ sharing_enabled: 1 });
    db.prepare("INSERT INTO spaces (id, name, sharing_enabled, created_at, updated_at) VALUES ('ferme', 'Fermé', 0, 0, 0)").run();
    db.prepare("UPDATE pages SET space_id = 'ferme' WHERE id = 'root'").run();
    expect((await pub(token)).statusCode).toBe(404); // l'espace d'arrivée interdit le partage
    db.prepare("UPDATE pages SET space_id = 'sp' WHERE id = 'root'").run();
    expect((await pub(token)).statusCode).toBe(200);
    expect((await call(await login('admin'), 'PATCH', '/api/v3/spaces/sp', { sharing: false })).statusCode).toBe(200);
    expect((await pub(token)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_shares').get()).toEqual({ n: 0 });
    expect((await call(await login('ed1'), 'PUT', '/api/v3/pages/root/share', {})).statusCode).toBe(403);
    // Renommer l'espace ne touche pas à ce réglage.
    await call(await login('admin'), 'PATCH', '/api/v3/spaces/sp', { name: 'Autre nom' });
    expect(db.prepare("SELECT sharing_enabled FROM spaces WHERE id = 'sp'").get()).toEqual({ sharing_enabled: 0 });
  });
});

describe('liste et espaces personnels', () => {
  it('chacun ne voit que les partages qu’il peut gérer ; un administrateur ne voit pas ceux d’un espace personnel', async () => {
    await enable();
    await share('ed1', 'root');
    await share('ed2', 'secret', { confirmRestricted: true });
    const names = async (who: string) => ((await call(await login(who), 'GET', '/api/v3/shares')).json() as { items: { title: string }[] }).items.map((i) => i.title).sort();
    expect(await names('ed1')).toEqual(['Racine']);
    expect(await names('ed2')).toEqual(['Racine', 'Secret']);
    expect(await names('admin')).toEqual(['Racine', 'Secret']);
    // Espace personnel d'ed1.
    await call(await login('admin'), 'PUT', '/api/v3/admin/personal-spaces', { enabled: true });
    const ed1 = await login('ed1');
    const mine = (await call(ed1, 'POST', '/api/v3/spaces/personal')).json() as { id: string };
    const page = (await call(ed1, 'POST', '/api/v3/pages', { spaceId: mine.id, title: 'Note perso' })).json() as { id: string };
    expect((await call(ed1, 'PUT', `/api/v3/pages/${page.id}/share`, {})).statusCode).toBe(201);
    expect(await names('ed1')).toEqual(['Note perso', 'Racine']);
    expect(await names('admin')).not.toContain('Note perso');
    expect((await call(await login('admin'), 'DELETE', `/api/v3/pages/${page.id}/share`)).statusCode).toBe(404);
  });
});

describe('journaux et enveloppe de l’application', () => {
  it('le jeton n’apparaît jamais dans les journaux, et l’enveloppe /share est sans cache ni référent', async () => {
    await app.close(); db.close(); sessions.clear();
    await boot(true);
    await enable();
    const token = await share('ed1', 'root');
    const shell = await app.inject({ method: 'GET', url: `/share/${token}` });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['cache-control']).toBe('no-store');
    expect(shell.headers['referrer-policy']).toBe('no-referrer');
    expect(shell.headers['x-robots-tag']).toBe('noindex, nofollow');
    await pub(token);
    await pub(token, '/pages/enfant');
    await app.inject({ method: 'GET', url: `/share/${token}/p/enfant` });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).toContain('[jeton]');
  });

  it('un partage indexable le dit, un partage ordinaire non', async () => {
    await enable();
    const open = await share('ed1', 'root', { indexing: true });
    expect((await pub(open)).headers['x-robots-tag']).toBe('all');
    expect((await app.inject({ method: 'GET', url: `/share/${open}` })).headers['x-robots-tag']).toBe('all');
    const closed = await share('ed1', 'enfant');
    expect((await app.inject({ method: 'GET', url: `/share/${closed}` })).headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await app.inject({ method: 'GET', url: '/share/jeton-inconnu-0123456789abcdef0123456789' })).headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('migration v16', () => {
  it('les espaces existants autorisent le partage, qui reste fermé tant que l’instance ne l’active pas', async () => {
    const { oldDb } = await import('./migrations.js');
    const up = openDb(oldDb(15));
    expect(up.prepare('SELECT sharing_enabled FROM spaces').all()).toEqual([{ sharing_enabled: 1 }]);
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_shares').get()).toEqual({ n: 0 });
    up.close();
  });
});
