// SAML 2.0 (SP-initiated) via @node-saml/node-saml : signature de l'assertion obligatoire,
// InResponseTo exigé (pas de SSO initié par l'IdP), anti-rejeu des assertions, audience contrôlée.
import { readFileSync } from 'node:fs';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import type { Config } from '../config.js';

export interface SamlUser { subject: string; email: string | null; name: string | null; groups: string[] }

const pem = (raw: string) => raw.replace(/\\n/g, '\n').trim();

let memo: { key: string; saml: SAML } | null = null;

// Instance partagée tant que la configuration ne change pas : elle garde en mémoire les requêtes en attente (InResponseTo).
export function samlFor(cfg: Config): SAML {
  const key = JSON.stringify([cfg.PUBLIC_URL, cfg.SAML_ENTRY_POINT, cfg.SAML_IDP_CERT, cfg.SAML_IDP_CERT_FILE, cfg.SAML_ISSUER, cfg.SAML_WANT_RESPONSE_SIGNED]);
  if (memo?.key !== key) memo = { key, saml: createSaml(cfg) };
  return memo.saml;
}

export function createSaml(cfg: Config): SAML {
  const cert = cfg.SAML_IDP_CERT ? pem(cfg.SAML_IDP_CERT) : pem(readFileSync(cfg.SAML_IDP_CERT_FILE!, 'utf8'));
  const issuer = cfg.SAML_ISSUER ?? `${cfg.PUBLIC_URL}/auth/saml/metadata`;
  return new SAML({
    callbackUrl: `${cfg.PUBLIC_URL}/auth/saml/callback`,
    entryPoint: cfg.SAML_ENTRY_POINT!,
    issuer,
    audience: issuer,
    idpCert: cert,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: cfg.SAML_WANT_RESPONSE_SIGNED,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    rejectReplayedAssertions: true,
    acceptedClockSkewMs: 5000,
    maxAssertionAgeMs: 10 * 60_000,
  });
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x): x is string => typeof x === 'string' && !!x);

export function userFromProfile(profile: Record<string, unknown>, cfg: Config): SamlUser | null {
  const nameID = profile.nameID;
  if (typeof nameID !== 'string' || !nameID) return null;
  const email = asList(profile[cfg.SAML_EMAIL_ATTRIBUTE])[0] ?? asList(profile.email)[0] ?? asList(profile.mail)[0] ?? asList(profile['urn:oid:0.9.2342.19200300.100.1.3'])[0] ?? null;
  return {
    subject: nameID,
    email: email ? email.slice(0, 200) : null,
    name: asList(profile[cfg.SAML_NAME_ATTRIBUTE])[0] ?? null,
    groups: asList(profile[cfg.SAML_GROUPS_ATTRIBUTE]),
  };
}
