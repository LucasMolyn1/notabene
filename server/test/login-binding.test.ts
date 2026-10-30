import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { bindingMatches, newBinding } from '../src/auth/login-binding.js';
import { OidcClient } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const base = { NODE_ENV: 'test', PUBLIC_URL: 'https://wiki.example.org', ENCRYPTION_KEY: randomBytes(32).toString('base64'), SEED_DEMO: 'false' };

describe('liaison de la connexion SSO au navigateur', () => {
  it('compare le cookie à l’empreinte stockée', () => {
    const b = newBinding();
    expect(bindingMatches(b.hash, b.token)).toBe(true);
    expect(bindingMatches(b.hash, newBinding().token)).toBe(false);
    expect(bindingMatches(b.hash, undefined)).toBe(false);
    expect(bindingMatches(null, undefined)).toBe(true); // liaison non posée (SAML sans HTTPS)
  });

  it('OIDC : refuse un retour qui ne vient pas du navigateur de départ, sans contacter le fournisseur', async () => {
    const db = openDb(':memory:');
    const cfg = loadConfig({ ...base, OIDC_ISSUER: 'https://idp.invalid', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y' });
    const client = new OidcClient(() => cfg, db);
    const mine = newBinding();
    const insert = (state: string, hash: string | null) =>
      db.prepare('INSERT INTO login_states (state, code_verifier, nonce, return_to, expires_at, binding_hash) VALUES (?, ?, ?, ?, ?, ?)').run(state, 'v', 'n', '/', Date.now() + 60_000, hash);
    const url = (state: string) => new URL(`https://wiki.example.org/auth/callback?state=${state}&code=abc`);

    insert('s1', mine.hash);
    await expect(client.handleCallback(url('s1'), newBinding().token)).rejects.toThrow(/autre navigateur/);
    insert('s2', mine.hash);
    await expect(client.handleCallback(url('s2'), undefined)).rejects.toThrow(/autre navigateur/);
    insert('s3', null); // état sans liaison : jamais accepté pour OIDC
    await expect(client.handleCallback(url('s3'), mine.token)).rejects.toThrow(/autre navigateur/);
    db.close();
  });
});

describe('SAML sur HTTPS : cookie de liaison', () => {
  let dir: string;
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'nb-bind-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(dir, 'k.pem'), '-out', resolve(dir, 'c.pem'), '-subj', '/CN=idp-test', '-days', '2'], { stdio: 'ignore' });
    db = openDb(':memory:');
    app = await buildApp({
      config: loadConfig({ ...base, SAML_ENTRY_POINT: 'https://idp.example.org/sso', SAML_IDP_CERT: readFileSync(resolve(dir, 'c.pem'), 'utf8'), SAML_ADMIN_GROUPS: 'wiki-admins' }),
      db, clientDir: '/nonexistent',
    });
  });
  afterAll(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = (RelayState: string, cookie?: string) => app.inject({
    method: 'POST', url: '/auth/saml/callback',
    payload: new URLSearchParams({ SAMLResponse: 'AAAA', RelayState }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie: `__Host-nb_login=${cookie}` } : {}) },
  });
  const start = async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/saml/login' });
    const set = res.cookies.find((c) => c.name === '__Host-nb_login')!;
    return { relay: new URL(res.headers.location as string).searchParams.get('RelayState')!, set };
  };

  it('pose un cookie SameSite=None;Secure et refuse un retour sans ce cookie', async () => {
    const { relay, set } = await start();
    expect(set).toMatchObject({ secure: true, httpOnly: true, sameSite: 'None', path: '/' });
    const res = await post(relay);
    expect(res.headers.location).toBe('/?auth_error=callback');
    const reasons = db.prepare("SELECT meta FROM audit_log WHERE action = 'auth.saml.failed'").all() as { meta: string | null }[];
    expect(reasons.some((r) => r.meta?.includes('binding'))).toBe(true);
  });

  it('refuse un cookie qui n’est pas celui de la tentative, et accepte le bon (la suite échoue sur l’assertion, pas sur la liaison)', async () => {
    const a = await start();
    const b = await start();
    db.prepare("DELETE FROM audit_log").run();
    await post(a.relay, b.set.value);
    expect((db.prepare("SELECT meta FROM audit_log WHERE action = 'auth.saml.failed'").get() as { meta: string | null }).meta).toContain('binding');
    db.prepare("DELETE FROM audit_log").run();
    const c = await start();
    await post(c.relay, c.set.value);
    const row = db.prepare("SELECT meta FROM audit_log WHERE action = 'auth.saml.failed'").get() as { meta: string | null } | undefined;
    expect(row?.meta ?? '').not.toContain('binding');
  });
});
