import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { type Mail, Mailer } from '../src/lib/mail.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', API_LEGACY_VERSIONS: 'v1,v2', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

class FakeMailer extends Mailer {
  sent: Mail[] = [];
  constructor() { super(() => { throw new Error('inutilisé'); }); }
  override get enabled() { return true; }
  override async send(mail: Mail) { this.sent.push(mail); }
}

let app: FastifyInstance;
let db: DB;
let mailer: FakeMailer;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  mailer = new FakeMailer();
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent', mailer });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload, ...s });
const tick = () => new Promise((r) => setTimeout(r, 20));
const pageId = () => (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur Notabene'").get() as { id: string }).id;
const inbox = async (s: S, qs = '') => (await call(s, 'GET', `/api/v3/notifications${qs}`)).json() as { items: { id: string; type: string; count: number; read: boolean; actor: { id: string } | null; page: { title: string } }[]; nextCursor: string | null };

describe('notifications', () => {
  it('notifie les personnes qui suivent la page, pas l’auteur', async () => {
    const [ed1, ed2] = [await login('ed1@example.com'), await login('ed2@example.com')];
    expect((await call(ed2, 'PUT', `/api/v3/pages/${pageId()}/watch`)).json()).toEqual({ watching: true });
    await call(ed1, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'Texte secret du commentaire' });
    await tick();
    const mine = await inbox(ed2);
    expect(mine.items).toMatchObject([{ type: 'comment', read: false, actor: { id: 'ed1' }, page: { title: 'Bienvenue sur Notabene' } }]);
    expect((await inbox(ed1)).items).toHaveLength(0); // l'auteur ne se notifie pas
    // E-mail : titre, auteur et lien, jamais le contenu.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'ed2@example.com' });
    expect(mailer.sent[0]!.text).toContain(`/#/p/${pageId()}`);
    expect(mailer.sent[0]!.text).not.toContain('secret');
    expect((await call(ed2, 'GET', '/api/v3/notifications/unread-count')).json()).toEqual({ unread: 1 });
    // Marquer comme lu ; les notifications des autres restent inaccessibles.
    const id = mine.items[0]!.id;
    expect((await call(ed1, 'POST', '/api/v3/notifications/read', { ids: [id] })).json()).toEqual({ updated: 0 });
    expect((await call(ed2, 'POST', '/api/v3/notifications/read', { ids: [id] })).json()).toEqual({ updated: 1 });
    expect((await call(ed2, 'GET', '/api/v3/notifications/unread-count')).json()).toEqual({ unread: 0 });
    expect((await inbox(ed2, '?unread=true')).items).toHaveLength(0);
  });

  it('commenter suit la page ; une réponse notifie l’auteur du commentaire une seule fois', async () => {
    const [ed1, ed2] = [await login('ed1@example.com'), await login('ed2@example.com')];
    const c = (await call(ed1, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'Question' })).json();
    expect((await call(ed1, 'GET', `/api/v3/pages/${pageId()}/watch`)).json()).toEqual({ watching: true });
    await call(ed2, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'Réponse', parentId: c.id });
    await tick();
    expect((await inbox(ed1)).items.map((i) => i.type)).toEqual(['reply']);
  });

  it('respecte les préférences d’e-mail', async () => {
    const [ed1, ed2] = [await login('ed1@example.com'), await login('ed2@example.com')];
    expect((await call(ed2, 'GET', '/api/v3/notifications/preferences')).json()).toEqual({ emailComments: true, emailChanges: false, emailAvailable: true });
    await call(ed2, 'PUT', '/api/v3/notifications/preferences', { emailComments: false, emailChanges: false });
    await call(ed2, 'PUT', `/api/v3/pages/${pageId()}/watch`);
    await call(ed1, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'x' });
    await tick();
    expect(mailer.sent).toHaveLength(0);
    expect((await inbox(ed2)).items).toHaveLength(1); // la boîte de réception reste alimentée
  });

  it('regroupe les modifications et limite les e-mails à un par heure', async () => {
    const [ed1, ed2] = [await login('ed1@example.com'), await login('ed2@example.com')];
    await call(ed2, 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: true });
    const id = pageId();
    await call(ed2, 'PUT', `/api/v3/pages/${id}/watch`);
    for (const title of ['A', 'B', 'C']) await call(ed1, 'PATCH', `/api/v1/pages/${id}`, { title });
    await tick();
    const items = (await inbox(ed2)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'page.updated', count: 3 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('ne notifie pas, et masque, une page devenue restreinte', async () => {
    const [admin, ed1, ed2] = [await login('admin@example.com'), await login('ed1@example.com'), await login('ed2@example.com')];
    await call(ed2, 'PUT', `/api/v3/pages/${pageId()}/watch`);
    await call(ed1, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'avant' });
    await tick();
    expect((await inbox(ed2)).items).toHaveLength(1);
    mailer.sent.length = 0;
    // La page devient réservée à ed1 : ed2 ne voit plus sa notification et n'en reçoit plus.
    await call(admin, 'PUT', `/api/v3/pages/${pageId()}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
    expect((await inbox(ed2)).items).toHaveLength(0);
    expect((await call(ed2, 'GET', '/api/v3/notifications/unread-count')).json()).toEqual({ unread: 0 });
    await call(ed1, 'POST', `/api/v3/pages/${pageId()}/comments`, { body: 'après' });
    await tick();
    expect(mailer.sent).toHaveLength(0);
    expect((await call(ed2, 'GET', `/api/v3/pages/${pageId()}/watch`)).statusCode).toBe(404);
  });

  it('fait suivre automatiquement les pages qu’on crée', async () => {
    const ed1 = await login('ed1@example.com');
    const space = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
    const created = (await call(ed1, 'POST', '/api/v1/pages', { spaceId: space, title: 'Neuve' })).json();
    expect((await call(ed1, 'GET', `/api/v3/pages/${created.id}/watch`)).json()).toEqual({ watching: true });
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${created.id}/watch`)).json()).toEqual({ watching: false });
  });

  it('exige d’être connecté', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v3/notifications' })).statusCode).toBe(401);
  });
});
