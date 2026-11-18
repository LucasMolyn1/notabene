// Connexion avec Google (second fournisseur OIDC) : parcours complet contre un fournisseur simulé (découverte, jeton
// signé RS256, JWKS), politique d'accès, séparation des fournisseurs, configuration et réglages.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { GOOGLE_ISSUER, googleDecision, oidcProviderOfSub } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { SecretBox } from '../src/lib/crypto.js';
import { RuntimeSettings } from '../src/lib/runtime-settings.js';
import { externalIdSchema } from '../src/lib/scim.js';

const PUBLIC = 'https://wiki.example.org';
const PRINCIPAL = 'https://auth.example.com/application/o/notabene/';
const GOOGLE_ID = 'gid-123.apps.googleusercontent.com';
const GOOGLE_SECRET = 'GOCSPX-tres-secret-0123456789';
const base = { NODE_ENV: 'test', PUBLIC_URL: PUBLIC, ENCRYPTION_KEY: randomBytes(32).toString('base64'), SEED_DEMO: 'false' };
const principalEnv = { OIDC_ISSUER: PRINCIPAL, OIDC_CLIENT_ID: 'wiki', OIDC_CLIENT_SECRET: 'principal-secret', OIDC_EDITOR_GROUPS: 'wiki-editors' };
const googleEnv = { GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: GOOGLE_SECRET, GOOGLE_DEFAULT_ROLE: 'reader', GOOGLE_ALLOWED_DOMAINS: 'exemple.fr,gmail.com' };

// ---- Fournisseurs simulés -------------------------------------------------------------------------
const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const jwt = (payload: object) => {
  const head = `${b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  return `${head}.${b64(sign('sha256', Buffer.from(head), keys.privateKey))}`;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Op { issuer: string; clientId: string; secret: string; tokenUrl: string; endSession?: string }
const OPS: Op[] = [
  { issuer: GOOGLE_ISSUER, clientId: GOOGLE_ID, secret: GOOGLE_SECRET, tokenUrl: 'https://oauth2.googleapis.com/token' },
  { issuer: PRINCIPAL, clientId: 'wiki', secret: 'principal-secret', tokenUrl: 'https://auth.example.com/application/o/token/', endSession: 'https://auth.example.com/application/o/notabene/end-session/' },
];

// Demandes d'autorisation émises (par state) et claims que le fournisseur mettra dans le prochain id_token.
const pending = new Map<string, { nonce: string; challenge: string; issuer: string }>();
let nextClaims: Record<string, unknown> = {};
let tokenStatus = 200;

const fakeFetch = async (url: string, options: { body?: unknown; headers?: unknown }) => {
  const u = new URL(url);
  for (const op of OPS) {
    if (url === `${op.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) {
      return json({
        issuer: op.issuer, authorization_endpoint: `${new URL(op.issuer).origin}/authorize`, token_endpoint: op.tokenUrl,
        jwks_uri: `${new URL(op.tokenUrl).origin}/jwks/${encodeURIComponent(op.issuer)}`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], ...(op.endSession ? { end_session_endpoint: op.endSession } : {}),
      });
    }
    if (u.pathname.startsWith('/jwks/')) return json({ keys: [jwk] });
    if (url === op.tokenUrl) {
      if (tokenStatus !== 200) return json({ error: 'invalid_client' }, tokenStatus);
      const body = new URLSearchParams(String(options.body));
      if (body.get('client_secret') !== op.secret || body.get('client_id') !== op.clientId) return json({ error: 'invalid_client' }, 401);
      const code = body.get('code') ?? '';
      const req = pending.get(code);
      if (!req || req.issuer !== op.issuer) return json({ error: 'invalid_grant' }, 400);
      // PKCE : le vérificateur doit correspondre au challenge de la demande.
      if (b64(createHash('sha256').update(body.get('code_verifier') ?? '').digest()) !== req.challenge) return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: jwt({ iss: op.issuer, aud: op.clientId, iat: now, exp: now + 300, nonce: req.nonce, ...nextClaims }) });
    }
  }
  return json({ error: 'inconnu' }, 404);
};

let app: FastifyInstance;
let db: DB;
let logs = '';

async function boot(extra: Record<string, string> = {}, env: Record<string, string> = { ...principalEnv, ...googleEnv }) {
  db = openDb(':memory:');
  logs = '';
  const stream = new Writable({ write(chunk, _enc, cb) { logs += String(chunk); cb(); } });
  app = await buildApp({ config: loadConfig({ ...base, ...env, ...extra }), db, clientDir: '/nonexistent', logger: { level: 'debug', stream }, oidcOptions: { fetch: fakeFetch as never } });
}
afterEach(async () => { await app?.close(); db?.close(); nextClaims = {}; tokenStatus = 200; pending.clear(); });

// Départ : renvoie l'URL d'autorisation et le cookie de liaison ; le « code » rendu par le fournisseur est le state.
async function start(path = '/auth/oidc/google/login', query = '') {
  const res = await app.inject({ method: 'GET', url: `${path}${query}` });
  expect(res.statusCode).toBe(302);
  const loc = new URL(res.headers.location as string);
  const binding = res.cookies.find((c) => c.name === '__Host-nb_login')!;
  const state = loc.searchParams.get('state')!;
  const issuer = loc.origin === 'https://accounts.google.com' ? GOOGLE_ISSUER : PRINCIPAL;
  pending.set(state, { nonce: loc.searchParams.get('nonce')!, challenge: loc.searchParams.get('code_challenge')!, issuer });
  return { loc, binding, state };
}
const callback = (path: string, state: string, binding?: string) =>
  app.inject({ method: 'GET', url: `${path}?code=${state}&state=${state}`, cookies: binding ? { '__Host-nb_login': binding } : {} });

async function googleLogin(claims: Record<string, unknown>) {
  nextClaims = claims;
  const { state, binding } = await start();
  return callback('/auth/oidc/google/callback', state, binding.value);
}
const gClaims = (over: Record<string, unknown> = {}) => ({ sub: '1001', email: 'Alice@Exemple.fr', email_verified: true, hd: 'exemple.fr', name: 'Alice', ...over });
const user = (sub: string) => db.prepare('SELECT id, sub, email, role FROM users WHERE sub = ?').get(sub) as { id: string; sub: string; email: string; role: string } | undefined;
const sessionOf = (res: Awaited<ReturnType<typeof callback>>) => res.cookies.find((c) => c.name === '__Host-nb_session')?.value;

describe('connexion Google : parcours complet', () => {
  it('URL d’autorisation : PKCE S256, state, nonce, redirection propre au fournisseur, aucun secret', async () => {
    await boot();
    const { loc, binding } = await start('/auth/oidc/google/login', '?returnTo=/p/abc');
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/authorize');
    expect(loc.searchParams.get('client_id')).toBe(GOOGLE_ID);
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/oidc/google/callback`);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toBe('openid email profile');
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(loc.searchParams.get('hd')).toBeNull(); // deux domaines : pas d'indication
    expect(loc.href).not.toContain(GOOGLE_SECRET);
    expect(binding).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect((db.prepare('SELECT provider FROM login_states').get() as { provider: string }).provider).toBe('google');
  });

  it('crée le compte google:<sub> au rôle configuré, sans le rattacher à un compte existant de même adresse', async () => {
    await boot();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('loc', 'local:alice@exemple.fr', 'alice@exemple.fr', 'Alice locale', 'admin', 0)").run();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('prin', 'abc', 'alice@exemple.fr', 'Alice SSO', 'editor', 0)").run();
    const res = await googleLogin(gClaims());
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(sessionOf(res)).toBeTruthy();
    const u = user('google:1001')!;
    expect(u).toMatchObject({ email: 'alice@exemple.fr', role: 'reader' });
    expect(u.id).not.toBe('loc');
    expect(u.id).not.toBe('prin');
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(3);
    // Deuxième connexion : même compte.
    await googleLogin(gClaims({ name: 'Alice B.' }));
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE sub = 'google:1001'").get() as { n: number }).n).toBe(1);
    const audits = db.prepare("SELECT meta FROM audit_log WHERE action = 'auth.login'").all() as { meta: string }[];
    expect(audits.every((a) => JSON.parse(a.meta).method === 'google')).toBe(true);
    // /me : fournisseur « google », jamais d'id_token conservé.
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { '__Host-nb_session': sessionOf(res)! } })).json();
    expect(me.provider).toBe('google');
    expect(me.permissions).toMatchObject({ read: true, write: false, admin: false });
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_token IS NOT NULL').get() as { n: number }).n).toBe(0);
  });

  it('refuse un e-mail non vérifié (y compris la chaîne « true ») ou absent', async () => {
    await boot();
    for (const over of [{ email_verified: false }, { email_verified: 'true' }, { email_verified: undefined }, { email: undefined }]) {
      const res = await googleLogin(gClaims(over));
      expect(res.headers.location).toBe('/?auth_error=email_unverified');
      expect(sessionOf(res)).toBeUndefined();
    }
    expect(user('google:1001')).toBeUndefined();
    const denied = db.prepare("SELECT target, meta FROM audit_log WHERE action = 'auth.denied'").all() as { target: string; meta: string }[];
    expect(denied).toHaveLength(4);
    expect(denied.every((d) => d.target === 'google:1001' && JSON.parse(d.meta).reason === 'email_unverified')).toBe(true);
  });

  it('domaines : hd autorisé, gmail.com listé sans hd ; domaine d’entreprise sans hd ou hd étranger refusés', async () => {
    await boot();
    expect((await googleLogin(gClaims({ sub: 'g1', email: 'bob@gmail.com', hd: undefined }))).headers.location).toBe('/');
    expect((await googleLogin(gClaims({ sub: 'g2', hd: undefined }))).headers.location).toBe('/?auth_error=forbidden');
    expect((await googleLogin(gClaims({ sub: 'g3', email: 'eve@autre.fr', hd: 'autre.fr' }))).headers.location).toBe('/?auth_error=forbidden');
    expect(user('google:g1')).toBeTruthy();
    expect(user('google:g2')).toBeUndefined();
    expect(user('google:g3')).toBeUndefined();
  });

  it('un seul domaine Workspace : indiqué à Google (hd), contrôlé au retour', async () => {
    await boot({ GOOGLE_ALLOWED_DOMAINS: 'exemple.fr' });
    const { loc } = await start();
    expect(loc.searchParams.get('hd')).toBe('exemple.fr');
  });

  it('rôle « none » (défaut) : aucun compte créé', async () => {
    await boot({ GOOGLE_DEFAULT_ROLE: 'none' });
    expect((await googleLogin(gClaims())).headers.location).toBe('/?auth_error=forbidden');
    expect(user('google:1001')).toBeUndefined();
  });

  it('compte Google désactivé : pas de session', async () => {
    await boot();
    await googleLogin(gClaims());
    db.prepare("UPDATE users SET disabled = 1 WHERE sub = 'google:1001'").run();
    const res = await googleLogin(gClaims());
    expect(res.headers.location).toBe('/?auth_error=forbidden');
    expect(sessionOf(res)).toBeUndefined();
  });

  it('state à usage unique, lié au navigateur et au fournisseur émetteur', async () => {
    await boot();
    nextClaims = gClaims();
    // Sans le cookie de liaison : refusé (et le state est consommé).
    let s = await start();
    expect((await callback('/auth/oidc/google/callback', s.state)).headers.location).toBe('/?auth_error=callback');
    expect((await callback('/auth/oidc/google/callback', s.state, s.binding.value)).headers.location).toBe('/?auth_error=callback');
    // Présenté sur la route du fournisseur principal : refusé, sans consommer la tentative Google.
    s = await start();
    expect((await callback('/auth/callback', s.state, s.binding.value)).headers.location).toBe('/?auth_error=callback');
    expect((await callback('/auth/oidc/google/callback', s.state, s.binding.value)).headers.location).toBe('/');
    // Rejeu : refusé.
    expect((await callback('/auth/oidc/google/callback', s.state, s.binding.value)).headers.location).toBe('/?auth_error=callback');
    // Inversement, une tentative du principal n'est pas acceptée sur la route Google.
    const p = await start('/auth/login');
    expect(p.loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/callback`);
    expect((await callback('/auth/oidc/google/callback', p.state, p.binding.value)).headers.location).toBe('/?auth_error=callback');
  });

  it('erreur du fournisseur relayée sans contenu arbitraire ; secrets absents des journaux', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/auth/oidc/google/callback?error=access_denied<script>' })).headers.location).toBe('/?auth_error=access_deniedscript');
    tokenStatus = 401;
    expect((await googleLogin(gClaims())).headers.location).toBe('/?auth_error=callback');
    expect(logs).toContain('échec du callback OIDC (google)');
    expect(logs).not.toContain(GOOGLE_SECRET);
    expect(logs).not.toContain('principal-secret');
  });

  it('déconnexion : un compte Google n’est pas envoyé vers la déconnexion du fournisseur principal', async () => {
    await boot();
    const g = await googleLogin(gClaims());
    const gs = sessionOf(g)!;
    const csrf = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { '__Host-nb_session': gs } })).json().csrf;
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { '__Host-nb_session': gs }, headers: { 'x-csrf-token': csrf } });
    expect(out.json().redirect).toBe('/');
    // Compte du fournisseur principal : redirection vers sa page de déconnexion (comportement inchangé).
    nextClaims = { sub: 'p1', email: 'p@example.org', groups: ['wiki-editors'] };
    const p = await start('/auth/login');
    const res = await callback('/auth/callback', p.state, p.binding.value);
    expect(res.headers.location).toBe('/');
    expect(user('p1')).toMatchObject({ role: 'editor' });
    const ps = sessionOf(res)!;
    const csrf2 = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { '__Host-nb_session': ps } })).json().csrf;
    const out2 = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { '__Host-nb_session': ps }, headers: { 'x-csrf-token': csrf2 } });
    expect(out2.json().redirect).toMatch(/^https:\/\/auth\.example\.com\/application\/o\/notabene\/end-session\/\?/);
  });
});

describe('confirmation d’une action sensible (reauth)', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const reauthLogin = async (claims: Record<string, unknown>, path = '/auth/oidc/google') => {
    nextClaims = claims;
    const s = await start(`${path === '/auth/oidc/google' ? '/auth/oidc/google/login' : '/auth/login'}`, '?reauth=1&returnTo=/parametres');
    return { s, res: await callback(path === '/auth/oidc/google' ? '/auth/oidc/google/callback' : '/auth/callback', s.state, s.binding.value) };
  };

  it('Google : max_age=0 demandé, tentative marquée, auth_time récent accepté', async () => {
    await boot();
    nextClaims = gClaims({ auth_time: now() });
    const s = await start('/auth/oidc/google/login', '?reauth=1&returnTo=/parametres');
    expect(s.loc.searchParams.get('max_age')).toBe('0');
    expect(s.loc.searchParams.get('prompt')).toBe('select_account');
    expect((db.prepare('SELECT reauth FROM login_states WHERE state = ?').get(s.state) as { reauth: number }).reauth).toBe(1);
    const res = await callback('/auth/oidc/google/callback', s.state, s.binding.value);
    expect(res.headers.location).toBe('/parametres');
    expect(sessionOf(res)).toBeTruthy();
    // Connexion ordinaire : ni max_age ni exigence d'auth_time.
    const plain = await start();
    expect(plain.loc.searchParams.get('max_age')).toBeNull();
    expect((db.prepare('SELECT reauth FROM login_states WHERE state = ?').get(plain.state) as { reauth: number }).reauth).toBe(0);
  });

  it('Google : auth_time absent, trop ancien ou dans le futur : confirmation refusée, aucune session', async () => {
    await boot();
    for (const auth_time of [undefined, now() - 600, now() + 600]) {
      const { res } = await reauthLogin(gClaims({ auth_time }));
      expect(res.headers.location).toBe('/?auth_error=reauth_failed');
      expect(sessionOf(res)).toBeUndefined();
    }
    expect(user('google:1001')).toBeUndefined();
    const denied = db.prepare("SELECT meta FROM audit_log WHERE action = 'auth.denied'").all() as { meta: string }[];
    expect(denied).toHaveLength(3);
    expect(denied.every((d) => JSON.parse(d.meta).reason === 'reauth' && JSON.parse(d.meta).method === 'google')).toBe(true);
  });

  it('fournisseur principal : prompt=login inchangé, sans exigence d’auth_time', async () => {
    await boot();
    const { s, res } = await reauthLogin({ sub: 'p1', groups: ['wiki-editors'] }, '/auth');
    expect(s.loc.searchParams.get('prompt')).toBe('login');
    expect(s.loc.searchParams.get('max_age')).toBeNull();
    expect(res.headers.location).toBe('/parametres');
  });
});

describe('fournisseur principal : identifiants réservés', () => {
  it('refuse un sub du principal qui imite un compte local, LDAP, SAML, SCIM, Google ou de développement', async () => {
    await boot();
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('loc', 'local:admin@exemple.fr', 'admin@exemple.fr', 'Admin', 'admin', 0)").run();
    const subs = ['local:admin@exemple.fr', 'LOCAL:admin@exemple.fr', 'ldap:jdupont', 'saml:x', 'scim:x', 'google:1001', 'Google:1001', 'dev-admin'];
    for (const sub of subs) {
      nextClaims = { sub, groups: ['wiki-editors'] };
      const p = await start('/auth/login');
      const res = await callback('/auth/callback', p.state, p.binding.value);
      expect(res.headers.location).toBe('/?auth_error=forbidden');
      expect(sessionOf(res)).toBeUndefined();
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT role, name, last_login_at FROM users WHERE id = 'loc'").get()).toEqual({ role: 'admin', name: 'Admin', last_login_at: null });
    const denied = db.prepare("SELECT target, meta FROM audit_log WHERE action = 'auth.denied'").all() as { target: string | null; meta: string }[];
    expect(denied).toHaveLength(subs.length);
    expect(denied.every((d) => d.target === null && JSON.parse(d.meta).reason === 'reserved_sub')).toBe(true);
  });
});

describe('liste publique des fournisseurs', () => {
  it('expose identifiant, libellé et URL de départ, sans identifiant client ni secret', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v3/config' });
    const { auth } = res.json();
    expect(auth.oidc).toBe(true);
    expect(auth.providers).toEqual([
      { id: 'principal', label: 'SSO', loginUrl: '/auth/login' },
      { id: 'google', label: 'Google', loginUrl: '/auth/oidc/google/login' },
    ]);
    expect(res.body).not.toContain(GOOGLE_ID);
    expect(res.body).not.toContain(GOOGLE_SECRET);
    expect(res.body).not.toContain('principal-secret');
  });

  it('Google seul absent par défaut ; routes Google introuvables, fournisseur inconnu refusé', async () => {
    await boot({}, principalEnv);
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).json().auth.providers).toEqual([{ id: 'principal', label: 'SSO', loginUrl: '/auth/login' }]);
    expect((await app.inject({ method: 'GET', url: '/auth/oidc/google/login' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/oidc/google/callback?state=x&code=y' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/oidc/apple/login' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/auth/oidc/principal/login' })).statusCode).toBe(400);
  });

  it('Google avec comptes locaux, sans fournisseur principal', async () => {
    await boot({ AUTH_LOCAL: 'true' }, googleEnv);
    const { auth } = (await app.inject({ method: 'GET', url: '/api/v3/config' })).json();
    expect(auth.oidc).toBe(false);
    expect(auth.providers).toEqual([{ id: 'google', label: 'Google', loginUrl: '/auth/oidc/google/login' }]);
    expect((await googleLogin(gClaims())).headers.location).toBe('/');
  });
});

describe('politique Google (claims de l’id_token)', () => {
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...base, AUTH_LOCAL: 'true', ...googleEnv, ...extra });

  it('applique e-mail vérifié, domaines, MFA et rôle', () => {
    expect(googleDecision(gClaims(), cfg())).toEqual({ ok: true, sub: 'google:1001', email: 'alice@exemple.fr', role: 'reader' });
    expect(googleDecision(gClaims({ email: 'pas-une-adresse' }), cfg())).toEqual({ ok: false, reason: 'email_unverified' });
    expect(googleDecision(gClaims({ hd: 'EXEMPLE.FR' }), cfg())).toMatchObject({ ok: true });
    expect(googleDecision(gClaims({ email: 'x@googlemail.com', hd: undefined }), cfg())).toEqual({ ok: false, reason: 'domain' });
    // Liste vide (refusée par la configuration avec un rôle, mais la décision reste sûre) : pas de filtre de domaine.
    expect(googleDecision(gClaims({ hd: undefined, email: 'a@autre.fr' }), { ...cfg(), GOOGLE_ALLOWED_DOMAINS: [] })).toMatchObject({ ok: true });
    expect(googleDecision(gClaims(), cfg({ OIDC_REQUIRE_MFA: 'true' }))).toEqual({ ok: false, reason: 'mfa' });
    expect(googleDecision(gClaims({ amr: ['mfa'] }), cfg({ OIDC_REQUIRE_MFA: 'true' }))).toMatchObject({ ok: true });
    expect(googleDecision(gClaims(), cfg({ GOOGLE_DEFAULT_ROLE: 'editor' }))).toMatchObject({ ok: true, role: 'editor' });
    expect(googleDecision(gClaims(), cfg({ GOOGLE_DEFAULT_ROLE: 'none' }))).toEqual({ ok: false, reason: 'role' });
  });

  it('identifiants réservés et fournisseur d’un compte', () => {
    expect(oidcProviderOfSub('google:1')).toBe('google');
    expect(oidcProviderOfSub('abc')).toBe('principal');
    for (const s of ['local:a@b.c', 'ldap:x', 'saml:x', 'scim:x', 'dev-admin', 'Google:1', 'LDAP:x', 'DEV-admin']) expect(oidcProviderOfSub(s)).toBeNull();
    // SCIM ne peut ni créer ni rattacher un compte Google.
    expect(externalIdSchema.safeParse('google:1001').success).toBe(false);
    expect(externalIdSchema.safeParse('GOOGLE:1001').success).toBe(false);
  });
});

describe('configuration Google', () => {
  const load = (extra: Record<string, string>) => () => loadConfig({ ...base, AUTH_LOCAL: 'true', ...extra });

  it('désactivée par défaut, variables OIDC_* inchangées', () => {
    const c = loadConfig({ ...base, ...principalEnv });
    expect(c.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(c.GOOGLE_DEFAULT_ROLE).toBe('none');
    expect(c.GOOGLE_ALLOWED_DOMAINS).toEqual([]);
    expect(c.OIDC_ISSUER).toBe(PRINCIPAL);
  });

  it('refuse une configuration incomplète ou dangereuse', () => {
    expect(load({ GOOGLE_CLIENT_ID: GOOGLE_ID })).toThrow(/GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET/);
    expect(load({ GOOGLE_CLIENT_SECRET: GOOGLE_SECRET })).toThrow(/GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET/);
    expect(load({ ...googleEnv, GOOGLE_DEFAULT_ROLE: 'admin' })).toThrow(/GOOGLE_DEFAULT_ROLE/);
    expect(load({ ...googleEnv, GOOGLE_DEFAULT_ROLE: 'editor', GOOGLE_ALLOWED_DOMAINS: '' })).toThrow(/editor/);
    // Lecteur sans domaines : tout compte Google au monde lirait le wiki, refusé de même.
    expect(load({ ...googleEnv, GOOGLE_DEFAULT_ROLE: 'reader', GOOGLE_ALLOWED_DOMAINS: '' })).toThrow(/« reader » exige une liste de domaines/);
    expect(load({ ...googleEnv, GOOGLE_DEFAULT_ROLE: 'reader', GOOGLE_ALLOWED_DOMAINS: ' , ' })).toThrow(/GOOGLE_DEFAULT_ROLE/);
    // Rôle « none » sans domaines : accepté (aucune connexion possible).
    expect(load({ ...googleEnv, GOOGLE_DEFAULT_ROLE: 'none', GOOGLE_ALLOWED_DOMAINS: '' })().GOOGLE_DEFAULT_ROLE).toBe('none');
    expect(load({ ...googleEnv, GOOGLE_ALLOWED_DOMAINS: '*.exemple.fr' })).toThrow(/domaine invalide/);
    expect(load({ ...googleEnv, GOOGLE_ALLOWED_DOMAINS: 'https://exemple.fr' })).toThrow(/domaine invalide/);
    expect(load({ ...googleEnv, GOOGLE_ALLOWED_DOMAINS: 'Exemple.FR, exemple.fr' })().GOOGLE_ALLOWED_DOMAINS).toEqual(['exemple.fr']);
  });

  it('les erreurs de configuration ne citent jamais le secret', () => {
    try { load({ GOOGLE_CLIENT_SECRET: GOOGLE_SECRET })(); } catch (err) { expect(String(err)).not.toContain(GOOGLE_SECRET); }
  });
});

describe('colonne login_states.provider, indépendante de la numérotation des migrations', () => {
  it('présente sur une base neuve, ajoutée si absente, sans toucher à user_version', () => {
    const d = openDb(':memory:');
    const cols = () => (d.prepare("SELECT name FROM pragma_table_info('login_states')").all() as { name: string }[]).map((c) => c.name);
    expect(cols()).toContain('provider');
    const version = d.pragma('user_version', { simple: true });
    d.close();
    // Base d'une autre branche ou antérieure : colonne absente, ajoutée à l'ouverture ; réouverture sans erreur.
    const dir = mkdtempSync(resolve(tmpdir(), 'nb-col-'));
    const file = resolve(dir, 'db.sqlite');
    openDb(file).close();
    const raw = new Database(file);
    raw.exec('ALTER TABLE login_states DROP COLUMN provider');
    raw.close();
    const again = openDb(file);
    expect((again.prepare("SELECT name FROM pragma_table_info('login_states')").all() as { name: string }[]).map((c) => c.name)).toContain('provider');
    expect(again.pragma('user_version', { simple: true })).toBe(version);
    again.close();
    openDb(file).close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('réglages de l’interface : section google', () => {
  const env = loadConfig({ ...base, AUTH_LOCAL: 'true' });
  const make = () => { const d = openDb(':memory:'); return { d, rt: new RuntimeSettings(env, d, new SecretBox(env.ENCRYPTION_KEY)) }; };

  it('enregistre, scelle le secret et ne le renvoie jamais', () => {
    const { d, rt } = make();
    expect(rt.view('google')).toMatchObject({ enabled: false, source: 'env', secrets: { clientSecret: { set: false } } });
    const view = rt.save('google', { enabled: true, clientId: GOOGLE_ID, allowedDomains: ['Exemple.fr'], defaultRole: 'editor' }, { clientSecret: GOOGLE_SECRET }, 'admin');
    expect(view).toMatchObject({ enabled: true, source: 'db', values: { clientId: GOOGLE_ID, allowedDomains: ['exemple.fr'], defaultRole: 'editor' }, secrets: { clientSecret: { set: true, hint: '…6789' } } });
    expect(JSON.stringify(view)).not.toContain(GOOGLE_SECRET);
    expect((d.prepare("SELECT value FROM settings WHERE key = 'cfg:google'").get() as { value: string }).value).not.toContain(GOOGLE_SECRET);
    expect(rt.get()).toMatchObject({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: GOOGLE_SECRET, GOOGLE_DEFAULT_ROLE: 'editor', GOOGLE_ALLOWED_DOMAINS: ['exemple.fr'] });
    rt.save('google', { enabled: false }, {}, 'admin');
    expect(rt.get().GOOGLE_CLIENT_SECRET).toBeUndefined();
    d.close();
  });

  it('valide la politique comme l’environnement', () => {
    const { d, rt } = make();
    expect(() => rt.validate('google', { enabled: true, clientId: GOOGLE_ID, defaultRole: 'editor' })).toThrow(/editor/);
    expect(() => rt.validate('google', { enabled: true, clientId: GOOGLE_ID, defaultRole: 'reader' })).toThrow(/defaultRole : le rôle « reader » exige/);
    expect(() => rt.validate('google', { enabled: true, clientId: GOOGLE_ID, defaultRole: 'reader', allowedDomains: [''] })).toThrow(/reader/);
    expect(rt.validate('google', { enabled: true, clientId: GOOGLE_ID, defaultRole: 'none' }).values).toMatchObject({ defaultRole: 'none', allowedDomains: [] });
    expect(() => rt.validate('google', { enabled: true, clientId: GOOGLE_ID, allowedDomains: ['exemple'] })).toThrow(/domaine invalide/);
    expect(() => rt.validate('google', { enabled: true, clientId: GOOGLE_ID, defaultRole: 'admin' })).toThrow();
    expect(() => rt.save('google', { enabled: true, clientId: GOOGLE_ID }, {}, 'admin')).toThrow(/clientSecret : valeur requise/);
    d.close();
  });

  it('activée depuis l’interface : proposée à la connexion, à chaud', async () => {
    await boot({ AUTH_LOCAL: 'true' }, principalEnv);
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).json().auth.providers.map((p: { id: string }) => p.id)).toEqual(['principal']);
    app.rt.save('google', { enabled: true, clientId: GOOGLE_ID, allowedDomains: ['exemple.fr'], defaultRole: 'reader' }, { clientSecret: GOOGLE_SECRET }, 'admin');
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).json().auth.providers.map((p: { id: string }) => p.id)).toEqual(['principal', 'google']);
    expect((await googleLogin(gClaims())).headers.location).toBe('/');
  });
});
