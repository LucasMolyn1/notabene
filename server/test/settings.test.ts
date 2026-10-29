import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LdapLike } from '../src/auth/ldap.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { Mailer, type Mail } from '../src/lib/mail.js';
import { hashPassword } from '../src/lib/password.js';

const env = { NODE_ENV: 'test', API_LEGACY_VERSIONS: 'v1,v2', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

class FakeMailer extends Mailer {
  sent: Mail[] = [];
  fail = false;
  constructor() { super(() => { throw new Error('inutilisé'); }); }
  override get enabled() { return true; }
  override async verify() { if (this.fail) throw new Error('535 authentification refusée'); }
  override async send(mail: Mail) { if (this.fail) throw new Error('boom'); this.sent.push(mail); }
}

let app: FastifyInstance;
let db: DB;
let mailer: FakeMailer;
let ldapBinds: string[];

const ldapFactory = (): LdapLike => ({
  async bind(dn, pw) { ldapBinds.push(`${dn}:${pw}`); if (pw !== 'service-pass') throw new Error('invalid credentials'); },
  async search() { return { searchEntries: [{ dn: 'dc=example,dc=org' }] }; },
  async unbind() { /* rien */ },
});

async function boot(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  mailer = new FakeMailer();
  ldapBinds = [];
  app = await buildApp({ config: loadConfig({ ...env, ...extra }), db, clientDir: '/nonexistent', mailer, ldapFactory });
}
beforeEach(() => boot());
afterEach(async () => { await app.close(); db.close(); });

async function addUser(email: string, role: 'admin' | 'editor' | 'reader', password = PASS) {
  const id = `u-${email}`;
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${email}`, email, email, role, Date.now(), await hashPassword(password));
  return id;
}
async function login(email: string, password = PASS) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
const api = (s: Awaited<ReturnType<typeof login>>, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, payload, ...s });

const ldapConfig = { enabled: true, url: 'ldaps://ldap.example.org', bindDn: 'cn=svc,dc=example,dc=org', baseDn: 'dc=example,dc=org', adminGroups: ['wiki-admins'] };
const reauth = { password: PASS };

describe('réglages modifiables à chaud', () => {
  it('réserve les réglages aux administrateurs', async () => {
    await addUser('ed@example.com', 'editor');
    const ed = await login('ed@example.com');
    expect((await api(ed, 'GET', '/admin/settings')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })).statusCode).toBe(401);
  });

  it('exige la ressaisie du mot de passe', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const body = { config: { enabled: true, origins: ['https://portfolio.example.com'] }, reauth: { password: 'mauvais' } };
    expect((await api(s, 'PUT', '/admin/settings/embed', body)).statusCode).toBe(401);
    expect((await api(s, 'PUT', '/admin/settings/embed', { ...body, reauth: {} })).statusCode).toBe(401);
  });

  it('modifie l’intégration portfolio sans redémarrage (CSP frame-ancestors)', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const csp = async () => String((await app.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy']);
    expect(await csp()).toMatch(/frame-ancestors 'self'(;|$)/);
    const res = await api(s, 'PUT', '/admin/settings/embed', { config: { enabled: true, origins: ['https://portfolio.example.com', 'https://portfolio.example.com'] }, reauth });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.origins).toEqual(['https://portfolio.example.com']);
    expect(await csp()).toMatch(/frame-ancestors 'self' https:\/\/portfolio\.example\.com/);
    const reset = await api(s, 'POST', '/admin/settings/embed/reset', { reauth });
    expect(reset.statusCode).toBe(200);
    expect(await csp()).toMatch(/frame-ancestors 'self'(;|$)/);
  });

  it('refuse les origines dangereuses', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    for (const bad of ['*', 'https://*.example.com', 'https://a.example.com/chemin', 'javascript:alert(1)', 'https://a.com; script-src *']) {
      const res = await api(s, 'PUT', '/admin/settings/embed', { config: { enabled: true, origins: [bad] }, reauth });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('exige un test réussi avant d’enregistrer LDAP, chiffre le secret et active le fournisseur', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().auth.ldap).toBe(false);
    const body = { config: ldapConfig, secrets: { bindPassword: 'service-pass' }, reauth };

    expect((await api(s, 'PUT', '/admin/settings/ldap', body)).statusCode).toBe(409); // pas de test

    const bad = await api(s, 'POST', '/admin/settings/ldap/test', { ...body, secrets: { bindPassword: 'faux' } });
    expect(bad.json()).toMatchObject({ ok: false });

    const t = (await api(s, 'POST', '/admin/settings/ldap/test', body)).json();
    expect(t.ok).toBe(true);
    // Un test ne vaut que pour la configuration testée.
    expect((await api(s, 'PUT', '/admin/settings/ldap', { ...body, config: { ...ldapConfig, baseDn: 'dc=autre' }, testId: t.testId })).statusCode).toBe(409);

    const saved = await api(s, 'PUT', '/admin/settings/ldap', { ...body, testId: t.testId });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain('service-pass');
    expect(saved.json().secrets.bindPassword).toEqual({ set: true, hint: '…pass' });
    // Rejouer le même test ne marche pas deux fois.
    expect((await api(s, 'PUT', '/admin/settings/ldap', { ...body, testId: t.testId })).statusCode).toBe(409);

    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'cfg:ldap'").get() as { value: string }).value;
    expect(stored).not.toContain('service-pass');
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().auth.ldap).toBe(true);
    expect(app.rt.get().LDAP_BIND_PASSWORD).toBe('service-pass');
    const view = (await api(s, 'GET', '/admin/settings')).json();
    expect(JSON.stringify(view)).not.toContain('service-pass');
    expect(view.sections.ldap.source).toBe('db');
  });

  it('impose de ressaisir le secret quand l’adresse du serveur change', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const body = { config: ldapConfig, secrets: { bindPassword: 'service-pass' }, reauth };
    const t = (await api(s, 'POST', '/admin/settings/ldap/test', body)).json();
    await api(s, 'PUT', '/admin/settings/ldap', { ...body, testId: t.testId });
    const moved = { config: { ...ldapConfig, url: 'ldaps://evil.example.net' }, reauth };
    const res = await api(s, 'POST', '/admin/settings/ldap/test', moved);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/ressaisissez/i);
    expect(ldapBinds.every((b) => b.endsWith('service-pass'))).toBe(true);
    expect(ldapBinds.some((b) => b.includes('evil'))).toBe(false);
  });

  it('applique les règles de production (ldap:// en clair refusé)', async () => {
    await app.close(); db.close();
    await boot({ NODE_ENV: 'production', PUBLIC_URL: 'https://wiki.example.com' });
    expect(() => app.rt.validate('ldap', { ...ldapConfig, url: 'ldap://ldap.example.org' })).toThrow(/interdit en production/);
    expect(() => app.rt.validate('ldap', { ...ldapConfig, url: 'ldap://ldap.example.org', startTls: true })).not.toThrow();
    expect(() => app.rt.validate('oidc', { enabled: true, issuer: 'http://idp.example.com', clientId: 'x' })).toThrow(/https/);
  });

  it('CONFIG_LOCKED fige la configuration', async () => {
    await app.close(); db.close();
    await boot({ CONFIG_LOCKED: 'true' });
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    expect((await api(s, 'GET', '/admin/settings')).json().locked).toBe(true);
    const res = await api(s, 'PUT', '/admin/settings/embed', { config: { enabled: true, origins: ['https://a.example.com'] }, reauth });
    expect(res.statusCode).toBe(409);
  });

  it('SMTP : test de connexion, mot de passe chiffré, e-mail de test', async () => {
    const id = await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const body = { config: { enabled: true, host: 'smtp.example.org', port: 587, mode: 'starttls', user: 'bot', from: 'Notabene <wiki@example.org>' }, secrets: { password: 'smtp-pass' }, reauth };
    mailer.fail = true;
    expect((await api(s, 'POST', '/admin/settings/smtp/test', body)).json()).toMatchObject({ ok: false, message: expect.stringContaining('535') });
    mailer.fail = false;
    const t = (await api(s, 'POST', '/admin/settings/smtp/test', body)).json();
    expect(t.ok).toBe(true);
    const saved = await api(s, 'PUT', '/admin/settings/smtp', { ...body, testId: t.testId });
    expect(saved.statusCode).toBe(200);
    expect((db.prepare("SELECT value FROM settings WHERE key = 'cfg:smtp'").get() as { value: string }).value).not.toContain('smtp-pass');
    expect(app.rt.get().SMTP_PASSWORD).toBe('smtp-pass');
    expect((await api(s, 'POST', '/admin/settings/smtp/send-test', { reauth })).statusCode).toBe(200);
    expect(mailer.sent.at(-1)?.to).toBe('a@example.com');
    expect(id).toBeTruthy();
    const audit = db.prepare("SELECT action, meta FROM audit_log WHERE action = 'settings.smtp'").get() as { meta: string };
    expect(audit.meta).not.toContain('smtp-pass');
  });

  it('refuse une configuration invalide (en-têtes injectés dans l’expéditeur)', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const res = await api(s, 'POST', '/admin/settings/smtp/test', { config: { enabled: true, host: 'smtp.example.org', from: 'a@example.org\r\nBcc: x@evil.com' }, secrets: { password: 'p' }, reauth });
    expect(res.statusCode).toBe(400);
  });
});

describe('mot de passe oublié et invitations', () => {
  const tokenFrom = (mail: Mail) => /#\/reset\/([\w-]+)/.exec(mail.text)![1]!;

  it('réinitialise le mot de passe avec un lien à usage unique', async () => {
    await addUser('u@example.com', 'editor');
    const forgot = await app.inject({ method: 'POST', url: '/auth/local/forgot', payload: { email: 'u@example.com' } });
    expect(forgot.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(mailer.sent).toHaveLength(1);
    const token = tokenFrom(mailer.sent[0]!);
    expect(db.prepare('SELECT token_hash FROM password_resets').get()).not.toMatchObject({ token_hash: token });

    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token, password: 'court' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token, password: 'Nouveau-mot-de-passe-9' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token, password: 'Encore-un-autre-mdp-1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'u@example.com', password: PASS } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'u@example.com', password: 'Nouveau-mot-de-passe-9' } })).statusCode).toBe(200);
    expect(mailer.sent.at(-1)?.subject).toMatch(/alerte/);
  });

  it('répond pareil pour un compte inconnu et limite la fréquence', async () => {
    await addUser('u@example.com', 'editor');
    const a = await app.inject({ method: 'POST', url: '/auth/local/forgot', payload: { email: 'inconnu@example.com' } });
    const b = await app.inject({ method: 'POST', url: '/auth/local/forgot', payload: { email: 'u@example.com' } });
    expect([a.statusCode, a.body]).toEqual([b.statusCode, b.body]);
    await app.inject({ method: 'POST', url: '/auth/local/forgot', payload: { email: 'u@example.com' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(mailer.sent).toHaveLength(1);
  });

  it('refuse un jeton expiré ou inventé', async () => {
    const id = await addUser('u@example.com', 'editor');
    await app.inject({ method: 'POST', url: '/auth/local/forgot', payload: { email: 'u@example.com' } });
    await new Promise((r) => setTimeout(r, 10));
    const token = tokenFrom(mailer.sent[0]!);
    db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, id);
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token, password: 'Nouveau-mot-de-passe-9' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token: 'x'.repeat(43), password: 'Nouveau-mot-de-passe-9' } })).statusCode).toBe(400);
  });

  it('invite un utilisateur par e-mail sans connaître son mot de passe', async () => {
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/local-users', payload: { email: 'new@example.com', name: 'Nouvelle', role: 'editor', invite: true }, ...s });
    expect(res.statusCode).toBe(201);
    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toBe('new@example.com');
    const done = await app.inject({ method: 'POST', url: '/auth/local/reset', payload: { token: tokenFrom(mail), password: 'Mon-propre-mot-de-passe-7' } });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'new@example.com', password: 'Mon-propre-mot-de-passe-7' } })).statusCode).toBe(200);
    // Échec d'envoi : le compte n'est pas créé.
    mailer.fail = true;
    const failed = await app.inject({ method: 'POST', url: '/api/v1/admin/local-users', payload: { email: 'x@example.com', name: 'X', role: 'reader', invite: true }, ...s });
    expect(failed.statusCode).toBe(502);
    expect(db.prepare("SELECT 1 FROM users WHERE email = 'x@example.com'").get()).toBeUndefined();
  });
});
