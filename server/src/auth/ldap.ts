// LDAP / Active Directory : recherche de l'utilisateur avec un compte de service, puis liaison (bind)
// avec son propre mot de passe. Aucun mot de passe d'annuaire n'est stocké.
import { readFileSync } from 'node:fs';
import { Client } from 'ldapts';
import type { Config } from '../config.js';

export interface DirectoryUser { dn: string; username: string; name: string; email: string | null; groups: string[] }

// Échappement d'une valeur dans un filtre LDAP (RFC 4515) : empêche l'injection de filtre.
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export interface LdapLike {
  bind(dn: string, password: string): Promise<void>;
  startTLS?(options?: object): Promise<void>;
  search(base: string, options: { scope: 'sub'; filter: string; attributes: string[]; sizeLimit: number }): Promise<{ searchEntries: Record<string, unknown>[] }>;
  unbind(): Promise<void>;
}
export type ClientFactory = () => LdapLike;

const first = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : Buffer.isBuffer(x) ? x.toString('utf8') : null;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => first(x)).filter((x): x is string => !!x);

export class LdapDirectory {
  constructor(private readonly cfg: Config, private readonly factory: ClientFactory = () => defaultClient(cfg)) {}

  // Renvoie l'utilisateur si l'identifiant existe de façon unique et que le mot de passe est correct, sinon null.
  async authenticate(username: string, password: string): Promise<DirectoryUser | null> {
    // Un mot de passe vide ferait une « liaison anonyme » réussie sur beaucoup d'annuaires : refusé d'emblée.
    if (!username || username.length > 128 || !password || password.length > 256) return null;
    const c = this.cfg;
    const search = this.factory();
    let entry: Record<string, unknown> | undefined;
    try {
      if (c.LDAP_STARTTLS && search.startTLS) await search.startTLS(tlsOptions(c));
      await search.bind(c.LDAP_BIND_DN!, c.LDAP_BIND_PASSWORD!);
      const { searchEntries } = await search.search(c.LDAP_BASE_DN!, {
        scope: 'sub',
        filter: c.LDAP_USER_FILTER.replaceAll('{username}', escapeFilter(username)),
        attributes: ['dn', c.LDAP_NAME_ATTRIBUTE, c.LDAP_EMAIL_ATTRIBUTE, c.LDAP_GROUP_ATTRIBUTE, 'uid', 'sAMAccountName'],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return null; // inconnu ou ambigu
      entry = searchEntries[0];
    } finally {
      await search.unbind().catch(() => undefined);
    }
    const dn = first(entry?.dn);
    if (!entry || !dn) return null;

    const userClient = this.factory();
    try {
      if (c.LDAP_STARTTLS && userClient.startTLS) await userClient.startTLS(tlsOptions(c));
      await userClient.bind(dn, password);
    } catch {
      return null;
    } finally {
      await userClient.unbind().catch(() => undefined);
    }
    return {
      dn,
      username: first(entry.sAMAccountName) ?? first(entry.uid) ?? username,
      name: first(entry[c.LDAP_NAME_ATTRIBUTE]) ?? username,
      email: first(entry[c.LDAP_EMAIL_ATTRIBUTE])?.slice(0, 200) ?? null,
      groups: list(entry[c.LDAP_GROUP_ATTRIBUTE]),
    };
  }
}

const tlsOptions = (c: Config) => ({ ...(c.LDAP_TLS_CA_FILE ? { ca: readFileSync(c.LDAP_TLS_CA_FILE) } : {}), rejectUnauthorized: true });

function defaultClient(c: Config): LdapLike {
  const client = new Client({ url: c.LDAP_URL!, timeout: 5000, connectTimeout: 5000, tlsOptions: tlsOptions(c) });
  return client as unknown as LdapLike;
}
