import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createApiToken } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { type Mail, Mailer } from '../src/lib/mail.js';
import { createNotifier } from '../src/lib/notifications.js';
import { hashPassword } from '../src/lib/password.js';
import { exportUserData } from '../src/lib/personal-data.js';
import { DAY, remindVerifications, statusOf } from '../src/lib/verifications.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
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
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, ...s });
const bearer = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const pageId = () => (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur BeNote'").get() as { id: string }).id;
const url = (suffix = '') => `/api/v3/pages/${pageId()}/verification${suffix}`;
// Restreint la page à `ids` (permission fine en écriture).
const restrict = (ids: string[]) => { for (const id of ids) db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, 'write')").run(pageId(), id); };
const notifier = () => createNotifier(db, app.bus, mailer, () => app.rt.get());
const notifs = (userId: string) => db.prepare("SELECT type, page_id FROM notifications WHERE user_id = ? AND type LIKE 'verification.%' ORDER BY created_at, rowid").all(userId) as { type: string; page_id: string }[];

describe('vérification de page : configuration et droits', () => {
  it('statut absent, puis configuration par un éditeur ; lecteur sans droit de configurer', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    expect((await call(rd, 'GET', url())).json()).toMatchObject({ status: 'none', configured: false, verifiers: [], canVerify: false, canConfigure: false });
    expect((await call(rd, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 })).statusCode).toBe(403);
    const res = await call(ed1, 'PUT', url(), { verifierIds: ['rd', 'ed2'], intervalDays: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending', configured: true, intervalDays: 30, verifiedAt: null, verifiedBy: null, expiresAt: null, modifiedSinceVerification: false,
      verifiers: [{ id: 'ed2', name: 'Nom ed2' }, { id: 'rd', name: 'Nom rd' }], isVerifier: false, canVerify: false, canConfigure: true,
    });
    // Aucune adresse e-mail exposée.
    expect(JSON.stringify(res.json())).not.toContain('@example.com');
    expect((await call(rd, 'GET', url())).json()).toMatchObject({ status: 'pending', isVerifier: true, canVerify: true, canConfigure: false });
    expect(db.prepare("SELECT meta FROM audit_log WHERE action = 'verification.set'").get()).toEqual({ meta: JSON.stringify({ verifiers: 2, intervalDays: 30, created: true }) });
  });

  it('valide les entrées : bornes, doublons, nombre de vérificateurs', async () => {
    const ed1 = await login('ed1');
    for (const body of [
      { verifierIds: [], intervalDays: 30 },
      { verifierIds: ['rd', 'rd'], intervalDays: 30 },
      { verifierIds: ['rd'], intervalDays: 0 },
      { verifierIds: ['rd'], intervalDays: 3651 },
      { verifierIds: ['rd'], intervalDays: 1.5 },
      { verifierIds: ['rd'] },
      { verifierIds: Array.from({ length: 11 }, (_, i) => `u${i}`), intervalDays: 30 },
      { verifierIds: ['../x'], intervalDays: 30 },
    ]) expect((await call(ed1, 'PUT', url(), body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: null })).json()).toMatchObject({ intervalDays: null });
    expect((await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 3650 })).json()).toMatchObject({ intervalDays: 3650 });
  });

  it('refuse un vérificateur inconnu, désactivé ou sans accès, avec la même réponse', async () => {
    const ed1 = await login('ed1');
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed2'").run();
    restrict(['ed1']);
    for (const id of ['inconnu', 'ed2', 'rd']) {
      const res = await call(ed1, 'PUT', url(), { verifierIds: [id], intervalDays: 30 });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ detail: 'Chaque vérificateur doit être un compte actif qui peut lire cette page', refused: [id] });
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_verifications').get()).toEqual({ n: 0 });
    // Un administrateur lit toutes les pages partagées : il peut être désigné.
    expect((await call(ed1, 'PUT', url(), { verifierIds: ['admin'], intervalDays: 30 })).statusCode).toBe(200);
  });

  it('page illisible : 404 sur toutes les routes', async () => {
    const [ed1, ed2] = [await login('ed1'), await login('ed2')];
    await call(ed1, 'PUT', url(), { verifierIds: ['ed1'], intervalDays: 30 });
    restrict(['ed1']);
    expect((await call(ed2, 'GET', url())).statusCode).toBe(404);
    expect((await call(ed2, 'PUT', url(), { verifierIds: ['ed2'], intervalDays: 30 })).statusCode).toBe(404);
    expect((await call(ed2, 'DELETE', url())).statusCode).toBe(404);
    expect((await call(ed2, 'POST', url('/verify'))).statusCode).toBe(404);
    expect((await call(ed2, 'GET', '/api/v3/pages/inconnue/verification')).statusCode).toBe(404);
    // Sans session : 401.
    expect((await app.inject({ method: 'GET', url: url() })).statusCode).toBe(401);
  });

  it('marquer vérifiée : vérificateur désigné (même lecteur) ou administrateur, pas un autre éditeur', async () => {
    const [ed1, ed2, rd, admin] = [await login('ed1'), await login('ed2'), await login('rd'), await login('admin')];
    expect((await call(rd, 'POST', url('/verify'))).statusCode).toBe(409); // rien de configuré
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    expect((await call(ed2, 'POST', url('/verify'))).statusCode).toBe(403);
    expect((await call(ed1, 'POST', url('/verify'))).statusCode).toBe(403); // configurer ne suffit pas
    const before = Date.now();
    const res = await call(rd, 'POST', url('/verify'));
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v).toMatchObject({ status: 'verified', verifiedBy: { id: 'rd', name: 'Nom rd' }, modifiedSinceVerification: false });
    expect(v.expiresAt - v.verifiedAt).toBe(30 * DAY);
    expect(v.verifiedAt).toBeGreaterThanOrEqual(before);
    expect((await call(admin, 'POST', url('/verify'))).json()).toMatchObject({ verifiedBy: { id: 'admin' } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'verification.verify' AND target = ?").get(pageId())).toEqual({ n: 2 });
  });

  it('sans intervalle, la vérification n’expire pas ; changer l’intervalle recalcule l’échéance', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: null });
    const v = (await call(rd, 'POST', url('/verify'))).json();
    expect(v).toMatchObject({ status: 'verified', expiresAt: null });
    const again = (await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 5 })).json();
    expect(again).toMatchObject({ status: 'expiring', verifiedAt: v.verifiedAt, expiresAt: v.verifiedAt + 5 * DAY });
  });

  it('modifier la page n’invalide pas la vérification mais le signale', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    await call(rd, 'POST', url('/verify'));
    db.prepare('UPDATE pages SET updated_at = updated_at + 1000 WHERE id = ?').run(pageId());
    expect((await call(rd, 'GET', url())).json()).toMatchObject({ status: 'verified', modifiedSinceVerification: true });
    expect((await call(rd, 'POST', url('/verify'))).json()).toMatchObject({ modifiedSinceVerification: false });
  });

  it('un vérificateur qui perd l’accès n’est plus montré et ne peut plus vérifier', async () => {
    const [ed1, ed2] = [await login('ed1'), await login('ed2')];
    await call(ed1, 'PUT', url(), { verifierIds: ['ed1', 'ed2'], intervalDays: 30 });
    restrict(['ed1']);
    expect((await call(ed1, 'GET', url())).json().verifiers).toEqual([{ id: 'ed1', name: 'Nom ed1' }]);
    expect((await call(ed2, 'POST', url('/verify'))).statusCode).toBe(404);
    expect((await call(ed2, 'GET', '/api/v3/verifications')).json().items).toEqual([]);
  });

  it('retrait par un éditeur, journalisé ; lecteur refusé', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    expect((await call(rd, 'DELETE', url())).statusCode).toBe(403);
    expect((await call(ed1, 'DELETE', url())).statusCode).toBe(204);
    expect((await call(ed1, 'GET', url())).json()).toMatchObject({ status: 'none' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_verifiers').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'verification.clear'").get()).toEqual({ n: 1 });
    expect((await call(ed1, 'DELETE', url())).statusCode).toBe(204); // idempotent, sans nouvelle entrée
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'verification.clear'").get()).toEqual({ n: 1 });
  });

  it('jetons d’API : portées respectées', async () => {
    const ed1 = await login('ed1');
    await call(ed1, 'PUT', url(), { verifierIds: ['ed2'], intervalDays: 30 });
    const readOnly = createApiToken(db, 'ed2', { name: 'l', scopes: ['read'], expiresInDays: 30 }).token;
    const write = createApiToken(db, 'ed2', { name: 'e', scopes: ['read', 'write'], expiresInDays: 30 }).token;
    const ai = createApiToken(db, 'ed2', { name: 'i', scopes: ['ai'], expiresInDays: 30 }).token;
    expect((await bearer(ai, 'GET', url())).statusCode).toBe(403);
    expect((await bearer(readOnly, 'GET', url())).json()).toMatchObject({ isVerifier: true, canVerify: false, canConfigure: false });
    expect((await bearer(readOnly, 'POST', url('/verify'))).statusCode).toBe(403);
    expect((await bearer(readOnly, 'PUT', url(), { verifierIds: ['ed2'], intervalDays: 30 })).statusCode).toBe(403);
    expect((await bearer(write, 'POST', url('/verify'))).statusCode).toBe(200);
    expect((await bearer(write, 'PUT', url(), { verifierIds: ['ed2'], intervalDays: 10 })).statusCode).toBe(200);
  });

  it('publie un événement sans contenu', async () => {
    const ed1 = await login('ed1');
    const seen: { type: string; pageId?: string }[] = [];
    const off = app.bus.subscribe((e) => { if (e.type === 'page.verification') seen.push(e); });
    await call(ed1, 'PUT', url(), { verifierIds: ['ed1'], intervalDays: 30 });
    await call(ed1, 'POST', url('/verify'));
    await call(ed1, 'DELETE', url());
    off();
    expect(seen.map((e) => e.pageId)).toEqual([pageId(), pageId(), pageId()]);
  });
});

describe('statut calculé', () => {
  it('pending, verified, expiring (7 jours ou moins), expired', () => {
    const now = 1_000 * DAY;
    expect(statusOf(undefined, now)).toBe('none');
    expect(statusOf({ verified_at: null, expires_at: null }, now)).toBe('pending');
    expect(statusOf({ verified_at: now, expires_at: null }, now)).toBe('verified');
    expect(statusOf({ verified_at: now, expires_at: now + 8 * DAY }, now)).toBe('verified');
    expect(statusOf({ verified_at: now, expires_at: now + 7 * DAY }, now)).toBe('expiring');
    expect(statusOf({ verified_at: now, expires_at: now + 1 }, now)).toBe('expiring');
    expect(statusOf({ verified_at: now, expires_at: now }, now)).toBe('expired');
    expect(statusOf({ verified_at: now, expires_at: now - DAY }, now)).toBe('expired');
  });
});

describe('pages à revoir', () => {
  // Crée une seconde page dans le même espace que la page d'accueil.
  const otherPage = (title: string) => {
    const p = db.prepare('SELECT space_id FROM pages WHERE id = ?').get(pageId()) as { space_id: string };
    const id = `pg${title}`;
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, '{}', '', ?, ?)").run(id, p.space_id, title, Date.now(), Date.now());
    return id;
  };
  const setRow = (id: string, verifiedAt: number | null, expiresAt: number | null, verifiers: string[], createdAt = Date.now()) => {
    db.prepare('INSERT INTO page_verifications (page_id, interval_days, verified_at, expires_at, created_at, updated_at) VALUES (?, 30, ?, ?, ?, ?)').run(id, verifiedAt, expiresAt, createdAt, createdAt);
    for (const u of verifiers) db.prepare('INSERT INTO page_verifiers (page_id, user_id) VALUES (?, ?)').run(id, u);
  };

  it('mine, all (administrateurs), tri par urgence, filtre et pagination, lisibilité', async () => {
    const now = Date.now();
    const [rd, ed2, admin] = [await login('rd'), await login('ed2'), await login('admin')];
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(otherPage);
    setRow(a!, now - 40 * DAY, now - 10 * DAY, ['rd']); // expirée depuis 10 jours
    setRow(b!, now - 40 * DAY, now - DAY, ['rd']); // expirée hier
    setRow(c!, now - 25 * DAY, now + 3 * DAY, ['rd']); // bientôt
    setRow(d!, null, null, ['rd', 'ed2']); // jamais vérifiée
    setRow(e!, now, now + 30 * DAY, ['rd']); // à jour : absente
    const res = (await call(rd, 'GET', '/api/v3/verifications')).json();
    expect(res.items.map((i: { page: { id: string }; status: string }) => [i.page.id, i.status])).toEqual([[a, 'expired'], [b, 'expired'], [c, 'expiring'], [d, 'pending']]);
    expect(res.items[0]).toEqual({ page: { id: a, title: 'A', icon: '', spaceId: expect.any(String) }, status: 'expired', intervalDays: 30, verifiedAt: now - 40 * DAY, expiresAt: now - 10 * DAY, modifiedSinceVerification: false });
    expect(res.nextCursor).toBeNull();
    // Pagination.
    const p1 = (await call(rd, 'GET', '/api/v3/verifications?limit=3')).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await call(rd, 'GET', `/api/v3/verifications?limit=3&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((i: { page: { id: string } }) => i.page.id)).toEqual([d]);
    expect(p2.nextCursor).toBeNull();
    expect((await call(rd, 'GET', '/api/v3/verifications?cursor=forge')).statusCode).toBe(400);
    // Filtre par statut.
    expect((await call(rd, 'GET', '/api/v3/verifications?status=expiring')).json().items.map((i: { page: { id: string } }) => i.page.id)).toEqual([c]);
    // mine : seulement là où je suis vérificateur.
    expect((await call(ed2, 'GET', '/api/v3/verifications')).json().items.map((i: { page: { id: string } }) => i.page.id)).toEqual([d]);
    // all : administrateurs seulement.
    expect((await call(ed2, 'GET', '/api/v3/verifications?scope=all')).statusCode).toBe(403);
    expect((await call(admin, 'GET', '/api/v3/verifications?scope=all')).json().items).toHaveLength(4);
    expect((await call(admin, 'GET', '/api/v3/verifications')).json().items).toHaveLength(0);
    // Page devenue illisible : ni elle ni son titre n'apparaissent.
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, 'ed1', 'write')").run(d);
    const after = await call(ed2, 'GET', '/api/v3/verifications');
    expect(after.json().items).toEqual([]);
    expect(after.body).not.toContain('"D"');
    // Corbeille : exclue.
    db.prepare('UPDATE pages SET deleted_at = ? WHERE id = ?').run(now, a);
    expect((await call(rd, 'GET', '/api/v3/verifications')).json().items.map((i: { page: { id: string } }) => i.page.id)).toEqual([b, c]);
    // Validation de la requête.
    expect((await call(rd, 'GET', '/api/v3/verifications?scope=autre')).statusCode).toBe(400);
  });
});

describe('rappels', () => {
  it('une notification par transition, aux vérificateurs qui lisent la page, sans contenu', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd', 'ed2'], intervalDays: 30 });
    const verifiedAt = (await call(rd, 'POST', url('/verify'))).json().verifiedAt as number;
    const n = notifier();
    expect(remindVerifications(db, n, verifiedAt + 20 * DAY)).toBe(0);
    // Passage en « expiring » : une notification chacun, une seule fois.
    expect(remindVerifications(db, n, verifiedAt + 24 * DAY)).toBe(2);
    expect(remindVerifications(db, n, verifiedAt + 25 * DAY)).toBe(0);
    expect(notifs('rd')).toEqual([{ type: 'verification.expiring', page_id: pageId() }]);
    // ed2 perd l'accès : plus aucun rappel pour lui.
    restrict(['rd']);
    expect(remindVerifications(db, n, verifiedAt + 31 * DAY)).toBe(1);
    expect(remindVerifications(db, n, verifiedAt + 60 * DAY)).toBe(0);
    expect(notifs('rd').map((x) => x.type)).toEqual(['verification.expiring', 'verification.expired']);
    expect(notifs('ed2').map((x) => x.type)).toEqual(['verification.expiring']);
    // E-mails : titre et lien seulement.
    const mails = mailer.sent.filter((m) => m.to === 'rd@example.com');
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject).toContain('Bienvenue sur BeNote');
    expect(mails[1]!.text).toContain(`/p/${pageId()}`);
    // Boîte de réception : type exposé, aucun auteur.
    const inbox = (await call(rd, 'GET', '/api/v3/notifications')).json();
    // Deux notifications créées dans la même milliseconde : l'ordre entre elles n'est pas garanti, on cherche par type.
    expect(inbox.items.find((n: { type: string }) => n.type === 'verification.expired')).toMatchObject({ actor: null, page: { id: pageId() } });
    // Nouvelle vérification : les rappels sont réarmés.
    db.prepare('UPDATE page_verifications SET verified_at = ?, expires_at = ?, notified_state = ? WHERE page_id = ?').run(verifiedAt + 60 * DAY, verifiedAt + 90 * DAY, 'none', pageId());
    expect(remindVerifications(db, n, verifiedAt + 85 * DAY)).toBe(1);
  });

  it('expirée d’emblée : seul le rappel « expired » ; échéance repoussée : état redescendu sans notification', async () => {
    const [ed1, rd] = [await login('ed1'), await login('rd')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    const verifiedAt = (await call(rd, 'POST', url('/verify'))).json().verifiedAt as number;
    const n = notifier();
    expect(remindVerifications(db, n, verifiedAt + 40 * DAY)).toBe(1);
    expect(notifs('rd').map((x) => x.type)).toEqual(['verification.expired']);
    // Intervalle allongé : l'échéance est à J+50, donc « expiring » à J+45, sans nouveau rappel puisqu'on redescend.
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 50 });
    expect(remindVerifications(db, n, verifiedAt + 45 * DAY)).toBe(0);
    expect(db.prepare('SELECT notified_state FROM page_verifications').get()).toEqual({ notified_state: 'expiring' });
    expect(remindVerifications(db, n, verifiedAt + 51 * DAY)).toBe(1);
    // Page à la corbeille : aucun rappel.
    db.prepare('UPDATE page_verifications SET notified_state = ? WHERE page_id = ?').run('none', pageId());
    db.prepare('UPDATE pages SET deleted_at = 1 WHERE id = ?').run(pageId());
    expect(remindVerifications(db, n, verifiedAt + 51 * DAY)).toBe(0);
  });

  it('page jamais vérifiée ou sans échéance : aucun rappel', async () => {
    const ed1 = await login('ed1');
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: null });
    expect(remindVerifications(db, notifier(), Date.now() + 10_000 * DAY)).toBe(0);
    expect(notifs('rd')).toEqual([]);
  });
});

describe('données personnelles', () => {
  it('export et effacement du compte', async () => {
    const [ed1, rd, admin] = [await login('ed1'), await login('rd'), await login('admin')];
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    await call(rd, 'POST', url('/verify'));
    const data = exportUserData(db, 'rd')!;
    expect(data.verifierOf).toEqual([{ id: pageId(), title: 'Bienvenue sur BeNote' }]);
    expect(data.verificationsPerformed).toEqual([{ pageId: pageId(), title: 'Bienvenue sur BeNote', verifiedAt: expect.any(Number) }]);
    // Page devenue illisible : absente de l'export.
    restrict(['ed1']);
    expect(exportUserData(db, 'rd')!.verifierOf).toEqual([]);
    db.prepare('DELETE FROM page_acl').run();
    expect((await call(admin, 'POST', '/api/v3/admin/users/rd/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM page_verifiers WHERE user_id = 'rd'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT verified_by, verified_at IS NOT NULL AS kept FROM page_verifications').get()).toEqual({ verified_by: null, kept: 1 });
    expect((await call(ed1, 'GET', url())).json()).toMatchObject({ status: 'verified', verifiers: [], verifiedBy: null });
    // Effacement de l'auteur de la configuration.
    expect((await call(admin, 'POST', '/api/v3/admin/users/ed1/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(db.prepare('SELECT created_by FROM page_verifications').get()).toEqual({ created_by: null });
  });

  it('suppression définitive de la page : configuration supprimée', async () => {
    const ed1 = await login('ed1');
    await call(ed1, 'PUT', url(), { verifierIds: ['rd'], intervalDays: 30 });
    db.prepare('DELETE FROM pages WHERE id = ?').run(pageId());
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_verifications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_verifiers').get()).toEqual({ n: 0 });
  });
});

describe('migration v27', () => {
  it('ajoute les tables et garde les notifications existantes', () => {
    const file = oldDb(26, (old) => {
      old.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n1', 'u1', 'mention', 'p1', 5)").run();
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare("SELECT id, type, created_at FROM notifications WHERE id = 'n1'").get()).toEqual({ id: 'n1', type: 'mention', created_at: 5 });
    up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n2', 'u1', 'verification.expired', 'p1', 6)").run();
    expect(() => up.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n3', 'u1', 'autre', 'p1', 6)").run()).toThrow();
    up.prepare("INSERT INTO page_verifications (page_id, interval_days, created_by, created_at, updated_at) VALUES ('p1', 30, 'u1', 0, 0)").run();
    up.prepare("INSERT INTO page_verifiers (page_id, user_id) VALUES ('p1', 'u1')").run();
    expect(() => up.prepare("UPDATE page_verifications SET interval_days = 0 WHERE page_id = 'p1'").run()).toThrow();
    expect(() => up.prepare("UPDATE page_verifications SET notified_state = 'x' WHERE page_id = 'p1'").run()).toThrow();
    up.prepare("UPDATE page_verifications SET verified_by = 'u1' WHERE page_id = 'p1'").run();
    up.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_verifiers').get()).toEqual({ n: 0 });
    expect(up.prepare('SELECT verified_by, created_by FROM page_verifications').get()).toEqual({ verified_by: null, created_by: null });
    up.prepare("DELETE FROM pages WHERE id = 'p1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM page_verifications').get()).toEqual({ n: 0 });
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
