import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword, passwordProblem, verifyPassword } from '../src/lib/password.js';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../src/lib/totp.js';

describe('TOTP et mots de passe', () => {
  it('respecte le vecteur de test RFC 6238 (SHA1, t=59)', () => {
    expect(totpCode(Buffer.from('12345678901234567890'), 1, 8)).toBe('94287082');
  });
  it('encode et décode en base32', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
  it('refuse le rejeu d’un pas déjà utilisé', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 59_000;
    const code = totpCode(Buffer.from('12345678901234567890'), 1);
    const step = verifyTotp(secret, code, null, now);
    expect(step).toBe(1);
    expect(verifyTotp(secret, code, step, now)).toBeNull();
  });
  it('hache et vérifie avec scrypt', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(passwordProblem('court')).not.toBeNull();
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).not.toBeNull();
  });
});

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
});
afterEach(async () => { await app.close(); db.close(); });

const post = (url: string, payload: object, cookie?: string, csrf?: string) =>
  app.inject({ method: 'POST', url, payload, cookies: cookie ? { nb_session: cookie } : undefined, headers: csrf ? { 'x-csrf-token': csrf } : undefined });

async function createAdmin() {
  // Contourne le code d'installation : crée directement l'admin comme le ferait la route de setup.
  const id = 'adm1';
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'local:admin@example.com', 'admin@example.com', 'Admin', 'admin', Date.now(), await hashPassword('Sup3r-secret-pass'));
}
const loginOk = async (email: string, password: string, code?: string) => {
  const res = await post('/auth/local/login', { email, password, code });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')?.value;
  return { res, cookie };
};

describe('connexion locale', () => {
  it('refuse l’installation sans le bon code', async () => {
    const res = await post('/auth/local/setup', { code: 'nope', email: 'a@example.com', name: 'A', password: 'Sup3r-secret-pass' });
    expect(res.statusCode).toBe(403);
  });

  it('indique setupRequired tant qu’aucun admin local n’existe', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().auth).toMatchObject({ local: true, setupRequired: true });
    await createAdmin();
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().auth.setupRequired).toBe(false);
  });

  it('se connecte, et refuse un mauvais mot de passe sans distinguer le compte', async () => {
    await createAdmin();
    const { res, cookie } = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    expect(res.statusCode).toBe(200);
    expect(cookie).toBeTruthy();
    const bad = await post('/auth/local/login', { email: 'admin@example.com', password: 'x' });
    const unknown = await post('/auth/local/login', { email: 'nobody@example.com', password: 'x' });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().message).toBe(unknown.json().message);
  });

  it('verrouille le compte après 5 échecs', async () => {
    await createAdmin();
    for (let i = 0; i < 5; i++) await post('/auth/local/login', { email: 'admin@example.com', password: 'wrong' });
    const locked = await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass' });
    expect(locked.statusCode).toBe(429);
  });

  it('refuse un compte désactivé et ses sessions', async () => {
    await createAdmin();
    const { cookie } = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    db.prepare('UPDATE users SET disabled = 1').run();
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie! } })).json().user).toBeNull();
    expect((await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass' })).statusCode).toBe(401);
  });

  it('active le MFA, l’exige à la connexion et accepte un code de secours une seule fois', async () => {
    await createAdmin();
    const { cookie } = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie! } })).json();
    const setup = (await post('/auth/mfa/setup', {}, cookie, me.csrf)).json();
    const now = Date.now();
    const enable = await post('/auth/mfa/enable', { code: totpCode(base32Decode(setup.secret), Math.floor(now / 30_000)) }, cookie, me.csrf);
    expect(enable.statusCode).toBe(200);
    const [recovery] = enable.json().recoveryCodes as string[];

    const noCode = await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass' });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().mfaRequired).toBe(true);
    expect((await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass', code: '000000' })).statusCode).toBe(401);

    expect((await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass', code: recovery })).statusCode).toBe(200);
    expect((await post('/auth/local/login', { email: 'admin@example.com', password: 'Sup3r-secret-pass', code: recovery })).statusCode).toBe(401);
  });

  it('change le mot de passe et ferme les autres sessions', async () => {
    await createAdmin();
    const a = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    const b = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: a.cookie! } })).json();
    expect((await post('/auth/local/password', { current: 'bad', next: 'Another-long-pass-1' }, a.cookie, me.csrf)).statusCode).toBe(403);
    expect((await post('/auth/local/password', { current: 'Sup3r-secret-pass', next: 'short' }, a.cookie, me.csrf)).statusCode).toBe(400);
    expect((await post('/auth/local/password', { current: 'Sup3r-secret-pass', next: 'Another-long-pass-1' }, a.cookie, me.csrf)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: b.cookie! } })).json().user).toBeNull();
    expect((await loginOk('admin@example.com', 'Another-long-pass-1')).res.statusCode).toBe(200);
  });

  it('un admin crée un compte local, un lecteur ne le peut pas', async () => {
    await createAdmin();
    const { cookie } = await loginOk('admin@example.com', 'Sup3r-secret-pass');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie! } })).json();
    const made = await post('/api/v1/admin/local-users', { email: 'bob@example.com', name: 'Bob', role: 'reader', password: 'Bob-has-a-long-pass' }, cookie, me.csrf);
    expect(made.statusCode).toBe(201);
    const bob = await loginOk('bob@example.com', 'Bob-has-a-long-pass');
    const bobMe = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: bob.cookie! } })).json();
    expect((await post('/api/v1/admin/local-users', { email: 'x@example.com', name: 'X', role: 'admin', password: 'Some-long-pass-123' }, bob.cookie, bobMe.csrf)).statusCode).toBe(403);
    const self = await app.inject({ method: 'PATCH', url: '/api/v1/admin/local-users/adm1', payload: { disabled: true }, cookies: { nb_session: cookie! }, headers: { 'x-csrf-token': me.csrf } });
    expect(self.statusCode).toBe(400);
  });
});

describe('MFA imposée', () => {
  it('bloque l’API tant que le compte local n’a pas de MFA, puis libère l’accès', async () => {
    const strictDb = openDb(':memory:');
    const strict = await buildApp({ config: loadConfig({ ...env, LOCAL_REQUIRE_MFA: 'true' }), db: strictDb, clientDir: '/nonexistent' });
    strictDb.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run('u1', 'local:a@example.com', 'a@example.com', 'A', 'admin', Date.now(), await hashPassword('Sup3r-secret-pass'));
    const login = await strict.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'a@example.com', password: 'Sup3r-secret-pass' } });
    const cookies = { nb_session: login.cookies.find((c) => c.name === 'nb_session')!.value };
    const me = (await strict.inject({ method: 'GET', url: '/api/v1/me', cookies })).json();
    expect(me.mfaSetupRequired).toBe(true);
    const blocked = await strict.inject({ method: 'GET', url: '/api/v1/spaces', cookies });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().mfaSetupRequired).toBe(true);

    const h = { 'x-csrf-token': me.csrf };
    const setup = (await strict.inject({ method: 'POST', url: '/auth/mfa/setup', cookies, headers: h, payload: {} })).json();
    const code = totpCode(base32Decode(setup.secret), Math.floor(Date.now() / 30_000));
    expect((await strict.inject({ method: 'POST', url: '/auth/mfa/enable', cookies, headers: h, payload: { code } })).statusCode).toBe(200);
    expect((await strict.inject({ method: 'GET', url: '/api/v1/spaces', cookies })).statusCode).toBe(200);
    await strict.close();
    strictDb.close();
  });
});

describe('MFA côté OIDC', () => {
  it('reconnaît les valeurs amr qui prouvent un second facteur', async () => {
    const { hasMfaClaim } = await import('../src/auth/oidc.js');
    expect(hasMfaClaim({ amr: ['pwd', 'otp'] })).toBe(true);
    expect(hasMfaClaim({ amr: ['mfa'] })).toBe(true);
    expect(hasMfaClaim({ amr: ['pwd'] })).toBe(false);
    expect(hasMfaClaim({})).toBe(false);
    expect(hasMfaClaim({ amr: 'mfa' })).toBe(false);
  });
});
