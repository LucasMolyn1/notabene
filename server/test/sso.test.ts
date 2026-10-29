import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { roleFromGroupList } from '../src/auth/external.js';
import { LdapDirectory, type LdapLike, escapeFilter } from '../src/auth/ldap.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const base = { NODE_ENV: 'test', API_LEGACY_VERSIONS: 'v1,v2', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), SEED_DEMO: 'false' };

describe('groupes et rôles', () => {
  const cfg = { admin: ['cn=wiki-admins,ou=groups,dc=ex,dc=org', 'Staff'], editor: ['wiki-editors'], reader: [], defaultRole: 'none' as const };
  it('fait correspondre DN complet ou CN, sans tenir compte de la casse', () => {
    expect(roleFromGroupList(['CN=Wiki-Admins,OU=Groups,DC=ex,DC=org'], cfg)).toBe('admin');
    expect(roleFromGroupList(['cn=wiki-editors,ou=x,dc=y'], cfg)).toBe('editor');
    expect(roleFromGroupList('staff', cfg)).toBe('admin');
    expect(roleFromGroupList(['cn=autres,dc=y'], cfg)).toBeNull();
    expect(roleFromGroupList(undefined, { ...cfg, defaultRole: 'reader' })).toBe('reader');
  });
});

describe('LDAP', () => {
  it('échappe les caractères spéciaux des filtres (RFC 4515)', () => {
    expect(escapeFilter('a*)(uid=*))(|(x=*')).toBe('a\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28x=\\2a');
  });

  const cfg = loadConfig({ ...base, DEV_LOGIN: 'true', LDAP_URL: 'ldaps://ldap.example.org', LDAP_BIND_DN: 'cn=svc', LDAP_BIND_PASSWORD: 'x', LDAP_BASE_DN: 'dc=example,dc=org' });
  const fake = (opts: { entries?: Record<string, unknown>[]; userPassword?: string; log?: string[] }) => (): LdapLike => {
    let bound = '';
    return {
      async bind(dn, pw) {
        bound = dn;
        if (dn !== 'cn=svc' && pw !== opts.userPassword) throw new Error('invalid credentials');
        opts.log?.push(`bind:${dn}`);
      },
      async search(_b, o) { opts.log?.push(`filter:${o.filter}`); return { searchEntries: opts.entries ?? [] }; },
      async unbind() { void bound; },
    };
  };
  const alice = { dn: 'uid=alice,ou=people,dc=example,dc=org', uid: 'alice', displayName: 'Alice', mail: 'alice@example.org', memberOf: ['cn=wiki-editors,ou=groups,dc=example,dc=org'] };

  it('authentifie via une liaison avec le DN de l’utilisateur', async () => {
    const log: string[] = [];
    const dir = new LdapDirectory(cfg, fake({ entries: [alice], userPassword: 'secret', log }));
    const user = await dir.authenticate('alice', 'secret');
    expect(user).toMatchObject({ username: 'alice', name: 'Alice', email: 'alice@example.org', groups: alice.memberOf });
    expect(log).toContain(`bind:${alice.dn}`);
  });

  it('refuse mot de passe vide, mauvais mot de passe, inconnu et ambigu', async () => {
    expect(await new LdapDirectory(cfg, fake({ entries: [alice], userPassword: 'secret' })).authenticate('alice', '')).toBeNull();
    expect(await new LdapDirectory(cfg, fake({ entries: [alice], userPassword: 'secret' })).authenticate('alice', 'mauvais')).toBeNull();
    expect(await new LdapDirectory(cfg, fake({ entries: [] })).authenticate('zoe', 'x')).toBeNull();
    expect(await new LdapDirectory(cfg, fake({ entries: [alice, alice], userPassword: 'secret' })).authenticate('alice', 'secret')).toBeNull();
  });

  it('injecte l’identifiant échappé dans le filtre', async () => {
    const log: string[] = [];
    await new LdapDirectory(cfg, fake({ entries: [], log })).authenticate('*)(uid=*', 'x');
    expect(log.find((l) => l.startsWith('filter:'))).toContain('\\2a\\29\\28uid=\\2a');
  });

  it('crée une session via la route et applique les groupes', async () => {
    const db = openDb(':memory:');
    const c = loadConfig({ ...base, LDAP_URL: 'ldaps://ldap.example.org', LDAP_BIND_DN: 'cn=svc', LDAP_BIND_PASSWORD: 'x', LDAP_BASE_DN: 'dc=example,dc=org', LDAP_EDITOR_GROUPS: 'wiki-editors' });
    const app = await buildApp({ config: c, db, clientDir: '/nonexistent', ldap: new LdapDirectory(c, fake({ entries: [alice], userPassword: 'secret' })) });
    expect((await app.inject({ method: 'POST', url: '/auth/ldap/login', payload: { username: 'alice', password: 'bad' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/auth/ldap/login', payload: { username: 'alice', password: 'secret' } });
    expect(ok.statusCode).toBe(200);
    const cookies = { nb_session: ok.cookies.find((x) => x.name === 'nb_session')!.value };
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies })).json().user).toMatchObject({ name: 'Alice', role: 'editor' });
    await app.close();
    db.close();
  });

  it('refuse un utilisateur sans groupe autorisé', async () => {
    const db = openDb(':memory:');
    const c = loadConfig({ ...base, LDAP_URL: 'ldaps://ldap.example.org', LDAP_BIND_DN: 'cn=svc', LDAP_BIND_PASSWORD: 'x', LDAP_BASE_DN: 'dc=example,dc=org', LDAP_EDITOR_GROUPS: 'autre-groupe' });
    const app = await buildApp({ config: c, db, clientDir: '/nonexistent', ldap: new LdapDirectory(c, fake({ entries: [alice], userPassword: 'secret' })) });
    expect((await app.inject({ method: 'POST', url: '/auth/ldap/login', payload: { username: 'alice', password: 'secret' } })).statusCode).toBe(403);
    await app.close();
    db.close();
  });

  it('exige LDAPS ou STARTTLS en production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://wiki.example.org', LDAP_URL: 'ldap://ldap', LDAP_BIND_DN: 'c', LDAP_BIND_PASSWORD: 'x', LDAP_BASE_DN: 'd' })).toThrow(/ldaps/);
  });
});

describe('SAML', () => {
  let dir: string;
  let key: string;
  let cert: string;
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  const callback = 'http://localhost:3000/auth/saml/callback';
  const issuer = 'http://localhost:3000/auth/saml/metadata';

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'nb-saml-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(dir, 'k.pem'), '-out', resolve(dir, 'c.pem'), '-subj', '/CN=idp-test', '-days', '2'], { stdio: 'ignore' });
    key = readFileSync(resolve(dir, 'k.pem'), 'utf8');
    cert = readFileSync(resolve(dir, 'c.pem'), 'utf8');
    db = openDb(':memory:');
    const c = loadConfig({ ...base, SAML_ENTRY_POINT: 'https://idp.example.org/sso', SAML_IDP_CERT: cert, SAML_ADMIN_GROUPS: 'wiki-admins' });
    app = await buildApp({ config: c, db, clientDir: '/nonexistent' });
  });
  afterAll(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  // Démarre une connexion et renvoie l'ID de la requête et le RelayState.
  async function start() {
    const res = await app.inject({ method: 'GET', url: '/auth/saml/login' });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { requestId: /ID="([^"]+)"/.exec(xml)![1]!, relay: url.searchParams.get('RelayState')! };
  }

  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  function response(requestId: string, opts: { sign?: boolean; groups?: string[]; audience?: string; id?: string; signKey?: string } = {}) {
    const id = opts.id ?? `_a${randomBytes(6).toString('hex')}`;
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>idp-test</saml:Issuer><saml:Subject><saml:NameID>bob@example.org</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${callback}" InResponseTo="${requestId}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? issuer}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>bob@example.org</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>Bob</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups">${(opts.groups ?? ['wiki-admins']).map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
    let signed = assertion;
    if (opts.sign !== false) {
      const sig = new SignedXml({ privateKey: opts.signKey ?? key, publicCert: cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
      sig.addReference({ xpath: `//*[@ID='${id}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
      sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
      signed = sig.getSignedXml();
    }
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(4).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}" Destination="${callback}" InResponseTo="${requestId}"><saml:Issuer>idp-test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
    return Buffer.from(xml).toString('base64');
  }

  const post = (SAMLResponse: string, RelayState: string) =>
    app.inject({ method: 'POST', url: '/auth/saml/callback', payload: new URLSearchParams({ SAMLResponse, RelayState }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  it('accepte une assertion signée et crée la session avec le rôle des groupes', async () => {
    const { requestId, relay } = await start();
    const res = await post(response(requestId), relay);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = { nb_session: res.cookies.find((c) => c.name === 'nb_session')!.value };
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies })).json().user).toMatchObject({ name: 'Bob', role: 'admin' });
  });

  it('refuse une assertion non signée', async () => {
    const { requestId, relay } = await start();
    const res = await post(response(requestId, { sign: false }), relay);
    expect(res.headers.location).toContain('auth_error=callback');
    expect(res.cookies.find((c) => c.name === 'nb_session')).toBeUndefined();
  });

  it('refuse une signature faite avec une autre clé', async () => {
    const other = execFileSync('openssl', ['genrsa', '2048'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const { requestId, relay } = await start();
    expect((await post(response(requestId, { signKey: other }), relay)).headers.location).toContain('auth_error=callback');
  });

  it('refuse une mauvaise audience, un InResponseTo inconnu et un RelayState inconnu', async () => {
    const a = await start();
    expect((await post(response(a.requestId, { audience: 'https://autre.example.org' }), a.relay)).headers.location).toContain('auth_error=callback');
    const b = await start();
    expect((await post(response('_inconnu'), b.relay)).headers.location).toContain('auth_error=callback');
    const c = await start();
    expect((await post(response(c.requestId), 'relay-inconnu')).headers.location).toContain('auth_error=callback');
  });

  it('refuse le rejeu de la même réponse', async () => {
    const { requestId, relay } = await start();
    const saml = response(requestId);
    expect((await post(saml, relay)).headers.location).toBe('/');
    const again = await start();
    expect((await post(saml, again.relay)).headers.location).toContain('auth_error=callback');
  });

  it('refuse un utilisateur sans groupe autorisé', async () => {
    const { requestId, relay } = await start();
    const res = await post(response(requestId, { groups: ['autres'] }), relay);
    expect(res.headers.location).toContain('auth_error=forbidden');
  });

  it('publie les métadonnées du fournisseur de service', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/saml/metadata' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(callback);
  });
});
