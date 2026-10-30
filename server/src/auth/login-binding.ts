// Lie une tentative de connexion SSO au navigateur qui l'a lancée.
// Sans cela, `state`, `nonce` et PKCE protègent contre le rejeu mais pas contre la substitution de navigateur :
// un attaquant qui a lancé une connexion pourrait faire consommer son URL de retour par une victime, qui se
// retrouverait connectée au compte de l'attaquant. Un cookie à courte durée, dont seul le hash est stocké, comble ce trou.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BINDING_TTL_SECONDS = 600;
export const bindingCookieName = (secure: boolean) => (secure ? '__Host-nb_login' : 'nb_login');

const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');

export function newBinding() {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: fingerprint(token) };
}

// `expected` est le hash stocké avec la tentative ; null = liaison non posée (SAML sans HTTPS, voir sso.ts).
export function bindingMatches(expected: string | null, token: string | undefined): boolean {
  if (expected === null) return true;
  if (!token) return false;
  const a = Buffer.from(fingerprint(token));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
