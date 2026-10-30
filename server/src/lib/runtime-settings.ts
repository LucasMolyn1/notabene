// Réglages modifiables à chaud depuis l'interface (fournisseurs d'identité, SMTP, intégration portfolio).
// Modèle hybride : l'environnement donne les valeurs de départ, un réglage enregistré en base les remplace
// section par section. CONFIG_LOCKED=true ignore la base. Les secrets sont chiffrés (AES-256-GCM) et jamais renvoyés.
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { SecretBox } from './crypto.js';
import { normalizeEmbedHost, selfHost } from './embed.js';

export type SectionName = 'embed' | 'embeds' | 'oidc' | 'ldap' | 'saml' | 'smtp';
export const SECTION_NAMES: SectionName[] = ['embed', 'embeds', 'oidc', 'ldap', 'saml', 'smtp'];

const list = z.array(z.string().trim().min(1).max(200)).max(50).default([]);
const role = z.enum(['reader', 'none']).default('none');
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional().transform((v) => v || undefined);
const httpsUrl = (what: string, devOk: boolean) =>
  z.string().trim().max(500).refine((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || (devOk && url.protocol === 'http:');
    } catch { return false; }
  }, `${what} : URL https requise`);

interface SectionSpec {
  // Schéma des champs en clair (le booléen `enabled` est ajouté pour toutes les sections).
  schema: (env: Config) => z.ZodType<Record<string, unknown>>;
  // Champs secrets (jamais renvoyés ; undefined = inchangé, chaîne vide = supprimé).
  secrets: string[];
  // Champ désignant la destination réseau : s'il change, les secrets doivent être ressaisis.
  endpoint?: string;
  toEnv: (v: Record<string, unknown>, secrets: Record<string, string | undefined>) => Partial<Config>;
  fromEnv: (c: Config) => { enabled: boolean; values: Record<string, unknown> };
}

const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

const SPECS: Record<SectionName, SectionSpec> = {
  embed: {
    secrets: [],
    schema: (env) => z.object({
      origins: z.array(z.string().trim().max(200)).max(20).superRefine((all, ctx) => {
        for (const o of all) {
          const ok = /^https?:\/\/[^/\s*?#]+$/.test(o)
            && (o.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(o) || env.NODE_ENV !== 'production');
          if (!ok) ctx.addIssue({ code: 'custom', message: `origine invalide : ${o} (https://domaine, sans chemin ni joker)` });
        }
      }).transform((all) => [...new Set(all)]).default([]),
    }),
    toEnv: (v) => ({ EMBED_ALLOWED_ORIGINS: arr(v.origins) }),
    fromEnv: (c) => ({ enabled: true, values: { origins: c.EMBED_ALLOWED_ORIGINS } }),
  },

  // Contenus intégrés (iframe) : liste d'hôtes autorisés, vide par défaut. Alimente la directive CSP `frame-src`.
  embeds: {
    secrets: [],
    schema: (env) => z.object({
      hosts: z.array(z.string().trim().max(253)).max(20).superRefine((all, ctx) => {
        for (const raw of all) {
          const host = normalizeEmbedHost(raw);
          if (!host) ctx.addIssue({ code: 'custom', message: `hôte invalide : ${raw} (nom de domaine, sans https://, chemin, port ni joker)` });
          else if (host === selfHost(env.PUBLIC_URL)) ctx.addIssue({ code: 'custom', message: `${host} est l'hôte de Notabene : il ne peut pas s'intégrer lui-même` });
        }
      }).transform((all) => [...new Set(all.map((h) => normalizeEmbedHost(h)!))]).default([]),
    }),
    toEnv: (v) => ({ CONTENT_EMBED_HOSTS: arr(v.hosts) }),
    fromEnv: (c) => ({ enabled: c.CONTENT_EMBED_HOSTS.length > 0, values: { hosts: c.CONTENT_EMBED_HOSTS } }),
  },

  oidc: {
    secrets: ['clientSecret'],
    endpoint: 'issuer',
    schema: (env) => z.object({
      issuer: httpsUrl('Émetteur', env.NODE_ENV !== 'production'),
      clientId: text(200).min(1),
      scopes: text(200).default('openid profile email'),
      adminGroups: list, editorGroups: list, readerGroups: list,
      defaultRole: role,
      requireMfa: z.boolean().default(false),
    }),
    toEnv: (v, s) => ({
      OIDC_ISSUER: String(v.issuer).replace(/\/+$/, ''), OIDC_CLIENT_ID: String(v.clientId), OIDC_CLIENT_SECRET: s.clientSecret,
      OIDC_SCOPES: String(v.scopes), OIDC_ADMIN_GROUPS: arr(v.adminGroups), OIDC_EDITOR_GROUPS: arr(v.editorGroups), OIDC_READER_GROUPS: arr(v.readerGroups),
      OIDC_DEFAULT_ROLE: v.defaultRole as 'reader' | 'none', OIDC_REQUIRE_MFA: !!v.requireMfa,
    }),
    fromEnv: (c) => ({
      enabled: !!(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
      values: { issuer: c.OIDC_ISSUER ?? '', clientId: c.OIDC_CLIENT_ID ?? '', scopes: c.OIDC_SCOPES, adminGroups: c.OIDC_ADMIN_GROUPS, editorGroups: c.OIDC_EDITOR_GROUPS, readerGroups: c.OIDC_READER_GROUPS, defaultRole: c.OIDC_DEFAULT_ROLE, requireMfa: c.OIDC_REQUIRE_MFA },
    }),
  },

  ldap: {
    secrets: ['bindPassword'],
    endpoint: 'url',
    schema: (env) => z.object({
      url: text(300).regex(/^ldaps?:\/\/[^\s]+$/, 'doit commencer par ldap:// ou ldaps://'),
      startTls: z.boolean().default(false),
      tlsCa: optText(20_000),
      bindDn: text(500).min(1),
      baseDn: text(500).min(1),
      userFilter: text(500).default('(|(sAMAccountName={username})(uid={username})(mail={username}))'),
      groupAttribute: text(100).default('memberOf'), nameAttribute: text(100).default('displayName'), emailAttribute: text(100).default('mail'),
      adminGroups: list, editorGroups: list, readerGroups: list,
      defaultRole: role,
    }).superRefine((v, ctx) => {
      if (!v.userFilter.includes('{username}')) ctx.addIssue({ code: 'custom', path: ['userFilter'], message: 'doit contenir {username}' });
      if (env.NODE_ENV === 'production' && v.url.startsWith('ldap://') && !v.startTls) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: 'ldap:// en clair interdit en production : utilisez ldaps:// ou STARTTLS' });
      }
      if (v.tlsCa && !/-----BEGIN CERTIFICATE-----/.test(v.tlsCa)) ctx.addIssue({ code: 'custom', path: ['tlsCa'], message: 'certificat PEM attendu' });
    }),
    toEnv: (v, s) => ({
      LDAP_URL: String(v.url), LDAP_STARTTLS: !!v.startTls, LDAP_TLS_CA: v.tlsCa as string | undefined, LDAP_TLS_CA_FILE: undefined,
      LDAP_BIND_DN: String(v.bindDn), LDAP_BIND_PASSWORD: s.bindPassword, LDAP_BASE_DN: String(v.baseDn), LDAP_USER_FILTER: String(v.userFilter),
      LDAP_GROUP_ATTRIBUTE: String(v.groupAttribute), LDAP_NAME_ATTRIBUTE: String(v.nameAttribute), LDAP_EMAIL_ATTRIBUTE: String(v.emailAttribute),
      LDAP_ADMIN_GROUPS: arr(v.adminGroups), LDAP_EDITOR_GROUPS: arr(v.editorGroups), LDAP_READER_GROUPS: arr(v.readerGroups), LDAP_DEFAULT_ROLE: v.defaultRole as 'reader' | 'none',
    }),
    fromEnv: (c) => ({
      enabled: !!c.LDAP_URL,
      values: { url: c.LDAP_URL ?? '', startTls: c.LDAP_STARTTLS, tlsCa: c.LDAP_TLS_CA ?? '', bindDn: c.LDAP_BIND_DN ?? '', baseDn: c.LDAP_BASE_DN ?? '', userFilter: c.LDAP_USER_FILTER, groupAttribute: c.LDAP_GROUP_ATTRIBUTE, nameAttribute: c.LDAP_NAME_ATTRIBUTE, emailAttribute: c.LDAP_EMAIL_ATTRIBUTE, adminGroups: c.LDAP_ADMIN_GROUPS, editorGroups: c.LDAP_EDITOR_GROUPS, readerGroups: c.LDAP_READER_GROUPS, defaultRole: c.LDAP_DEFAULT_ROLE },
    }),
  },

  saml: {
    secrets: [],
    endpoint: 'entryPoint',
    schema: (env) => z.object({
      entryPoint: httpsUrl('Point d’entrée', env.NODE_ENV !== 'production'),
      idpCert: text(20_000).refine((c) => /-----BEGIN CERTIFICATE-----/.test(c), 'certificat PEM attendu'),
      issuer: optText(300),
      wantResponseSigned: z.boolean().default(false),
      groupsAttribute: text(200).default('groups'), emailAttribute: text(200).default('email'), nameAttribute: text(200).default('name'),
      adminGroups: list, editorGroups: list, readerGroups: list,
      defaultRole: role,
    }),
    toEnv: (v) => ({
      SAML_ENTRY_POINT: String(v.entryPoint), SAML_IDP_CERT: String(v.idpCert), SAML_IDP_CERT_FILE: undefined, SAML_ISSUER: v.issuer as string | undefined,
      SAML_WANT_RESPONSE_SIGNED: !!v.wantResponseSigned, SAML_GROUPS_ATTRIBUTE: String(v.groupsAttribute), SAML_EMAIL_ATTRIBUTE: String(v.emailAttribute), SAML_NAME_ATTRIBUTE: String(v.nameAttribute),
      SAML_ADMIN_GROUPS: arr(v.adminGroups), SAML_EDITOR_GROUPS: arr(v.editorGroups), SAML_READER_GROUPS: arr(v.readerGroups), SAML_DEFAULT_ROLE: v.defaultRole as 'reader' | 'none',
    }),
    fromEnv: (c) => ({
      enabled: !!c.SAML_ENTRY_POINT,
      values: { entryPoint: c.SAML_ENTRY_POINT ?? '', idpCert: c.SAML_IDP_CERT ?? '', issuer: c.SAML_ISSUER ?? '', wantResponseSigned: c.SAML_WANT_RESPONSE_SIGNED, groupsAttribute: c.SAML_GROUPS_ATTRIBUTE, emailAttribute: c.SAML_EMAIL_ATTRIBUTE, nameAttribute: c.SAML_NAME_ATTRIBUTE, adminGroups: c.SAML_ADMIN_GROUPS, editorGroups: c.SAML_EDITOR_GROUPS, readerGroups: c.SAML_READER_GROUPS, defaultRole: c.SAML_DEFAULT_ROLE },
    }),
  },

  smtp: {
    secrets: ['password'],
    endpoint: 'host',
    schema: () => z.object({
      host: text(255).regex(/^[A-Za-z0-9.-]+$/, 'nom d’hôte invalide'),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      mode: z.enum(['starttls', 'tls']).default('starttls'),
      user: optText(255),
      from: text(320).min(3).regex(/^[^\r\n<>]*(<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/, 'adresse d’expédition invalide'),
    }),
    toEnv: (v, s) => ({ SMTP_HOST: String(v.host), SMTP_PORT: Number(v.port), SMTP_MODE: v.mode as 'starttls' | 'tls', SMTP_USER: v.user as string | undefined, SMTP_PASSWORD: s.password, SMTP_FROM: String(v.from) }),
    fromEnv: (c) => ({ enabled: !!c.SMTP_HOST, values: { host: c.SMTP_HOST ?? '', port: c.SMTP_PORT, mode: c.SMTP_MODE, user: c.SMTP_USER ?? '', from: c.SMTP_FROM ?? '' } }),
  },
};

// Clés d'environnement mises à undefined quand une section est désactivée.
const DISABLE: Record<SectionName, Partial<Config>> = {
  embed: { EMBED_ALLOWED_ORIGINS: [] },
  embeds: { CONTENT_EMBED_HOSTS: [] },
  oidc: { OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined, OIDC_CLIENT_SECRET: undefined },
  ldap: { LDAP_URL: undefined },
  saml: { SAML_ENTRY_POINT: undefined },
  smtp: { SMTP_HOST: undefined },
};

interface Stored { enabled: boolean; values: Record<string, unknown>; secrets: Record<string, string>; hints: Record<string, string> }

export interface SectionView {
  section: SectionName;
  source: 'env' | 'db';
  locked: boolean;
  enabled: boolean;
  values: Record<string, unknown>;
  secrets: Record<string, { set: boolean; hint: string | null }>;
}

const aad = (section: SectionName, field: string) => `notabene:settings:${section}:${field}`;
const rowKey = (section: SectionName) => `cfg:${section}`;

export class RuntimeSettings {
  #cache: Config | null = null;
  readonly locked: boolean;

  constructor(private readonly env: Config, private readonly db: DB, private readonly box: SecretBox) {
    this.locked = env.CONFIG_LOCKED;
  }

  #read(section: SectionName): Stored | null {
    if (this.locked) return null;
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(rowKey(section)) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Stored) : null;
  }

  #secretsOf(section: SectionName, stored: Stored | null): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const f of SPECS[section].secrets) {
      const sealed = stored?.secrets[f];
      out[f] = sealed ? this.box.open(sealed, aad(section, f)) : undefined;
    }
    return out;
  }

  // Configuration effective : environnement + sections enregistrées en base.
  get(): Config {
    if (this.#cache) return this.#cache;
    let cfg: Config = { ...this.env };
    for (const section of SECTION_NAMES) {
      const stored = this.#read(section);
      if (stored) cfg = this.#apply(cfg, section, stored.enabled, stored.values, this.#secretsOf(section, stored));
    }
    return (this.#cache = cfg);
  }

  #apply(cfg: Config, section: SectionName, enabled: boolean, values: Record<string, unknown>, secrets: Record<string, string | undefined>): Config {
    return { ...cfg, ...(enabled ? SPECS[section].toEnv(values, secrets) : DISABLE[section]) };
  }

  validate(section: SectionName, input: unknown): { enabled: boolean; values: Record<string, unknown> } {
    const parsed = z.object({ enabled: z.boolean() }).passthrough().parse(input);
    const { enabled, ...rest } = parsed;
    if (!enabled) return { enabled, values: {} };
    const result = SPECS[section].schema(this.env).safeParse(rest);
    if (!result.success) throw new SettingsError(result.error.issues.map((i) => `${i.path.join('.') || section} : ${i.message}`).join(' ; '));
    return { enabled, values: result.data };
  }

  view(section: SectionName): SectionView {
    const stored = this.#read(section);
    const spec = SPECS[section];
    const fromEnv = spec.fromEnv(this.env);
    return {
      section,
      source: stored ? 'db' : 'env',
      locked: this.locked,
      enabled: stored ? stored.enabled : fromEnv.enabled,
      values: stored?.enabled ? stored.values : fromEnv.values,
      secrets: Object.fromEntries(spec.secrets.map((f) => [f, { set: stored ? !!stored.secrets[f] : !!this.#envSecret(section, f), hint: stored?.hints[f] ?? null }])),
    };
  }

  #envSecret(section: SectionName, field: string): string | undefined {
    const map: Record<string, keyof Config> = { 'oidc.clientSecret': 'OIDC_CLIENT_SECRET', 'ldap.bindPassword': 'LDAP_BIND_PASSWORD', 'smtp.password': 'SMTP_PASSWORD' };
    const key = map[`${section}.${field}`];
    return key ? (this.env[key] as string | undefined) : undefined;
  }

  // Configuration candidate (pour tester avant d'enregistrer) : secrets absents repris de l'existant.
  candidate(section: SectionName, input: unknown, secretsIn: Record<string, string | undefined>): Config {
    const { enabled, values } = this.validate(section, input);
    const spec = SPECS[section];
    const current = this.get();
    const stored = this.#read(section);
    const old = stored ? this.#secretsOf(section, stored) : Object.fromEntries(spec.secrets.map((f) => [f, this.#envSecret(section, f)]));
    this.#assertSecretsRetyped(section, values, secretsIn, current);
    const secrets: Record<string, string | undefined> = {};
    for (const f of spec.secrets) secrets[f] = secretsIn[f] === undefined ? old[f] : secretsIn[f] || undefined;
    return this.#apply({ ...current }, section, enabled, values, secrets);
  }

  // Si la destination (hôte, URL) change, un secret déjà enregistré ne doit pas partir vers la nouvelle cible sans être ressaisi.
  #assertSecretsRetyped(section: SectionName, values: Record<string, unknown>, secretsIn: Record<string, string | undefined>, current: Config) {
    const spec = SPECS[section];
    if (!spec.endpoint || !spec.secrets.length) return;
    const before = spec.fromEnv(current);
    const prev = String(before.values[spec.endpoint] ?? '');
    const next = String(values[spec.endpoint] ?? '').replace(/\/+$/, '');
    if (before.enabled && prev !== next && spec.secrets.some((f) => secretsIn[f] === undefined)) {
      throw new SettingsError('L’adresse du serveur change : ressaisissez le secret associé.');
    }
  }

  save(section: SectionName, input: unknown, secretsIn: Record<string, string | undefined>, userId: string): SectionView {
    if (this.locked) throw new SettingsError('Configuration verrouillée par l’environnement (CONFIG_LOCKED).', 409);
    const { enabled, values } = this.validate(section, input);
    const spec = SPECS[section];
    const prev = this.#read(section);
    if (enabled) this.#assertSecretsRetyped(section, values, secretsIn, this.get());
    const secrets: Record<string, string> = {};
    const hints: Record<string, string> = {};
    // Section désactivée : plus aucun secret conservé. Sinon, une section « éteinte » garderait un mot de passe scellé
    // qu'un test vers une autre adresse pourrait ensuite envoyer sans que l'admin ne le ressaisisse.
    for (const f of enabled ? spec.secrets : []) {
      const incoming = secretsIn[f];
      if (incoming === undefined) {
        const keep = prev?.secrets[f];
        if (keep) { secrets[f] = keep; hints[f] = prev!.hints[f] ?? ''; }
        else {
          // Premier enregistrement d'une section héritée de l'environnement : on reprend le secret en place.
          const fromEnv = this.#envSecret(section, f);
          if (fromEnv && !prev) { secrets[f] = this.box.seal(fromEnv, aad(section, f)); hints[f] = `…${fromEnv.slice(-4)}`; }
        }
      } else if (incoming.trim()) {
        secrets[f] = this.box.seal(incoming.trim(), aad(section, f));
        hints[f] = `…${incoming.trim().slice(-4)}`;
      }
    }
    if (enabled) for (const f of spec.secrets) if (!secrets[f]) throw new SettingsError(`${f} : valeur requise`);
    const next: Stored = { enabled, values, secrets, hints };
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(rowKey(section), JSON.stringify(next), Date.now(), userId);
    this.#cache = null;
    return this.view(section);
  }

  // Revient aux valeurs de l'environnement.
  reset(section: SectionName) {
    if (this.locked) throw new SettingsError('Configuration verrouillée par l’environnement (CONFIG_LOCKED).', 409);
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(rowKey(section));
    this.#cache = null;
  }
}

export class SettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
