// Configuration lue depuis l'environnement et validée au démarrage.
// Principe : une configuration dangereuse empêche le serveur de démarrer.
import { isIP } from 'node:net';
import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z.enum(['true', 'false', '1', '0']).default(def).transform((v) => v === 'true' || v === '1');

// TRUST_PROXY : à qui faire confiance pour l'adresse du client (en-tête X-Forwarded-For).
//   false (défaut)  personne : l'adresse est celle de la connexion ;
//   2               un nombre de sauts de confiance (1 = un seul proxy devant l'application, 2 = deux, comme HAProxy puis Cloudflare) ;
//   10.0.0.0/8,…    des adresses ou réseaux (CIDR) de proxys de confiance ;
//   true            tous les sauts : déconseillé, un client peut alors falsifier son adresse avec X-Forwarded-For.
// Le nombre de sauts et la liste lisent l'adresse du client en partant de la droite : une valeur ajoutée par le client, à gauche, est ignorée.
const trustProxy = z.string().default('false').transform((raw, ctx): boolean | number | string => {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d{1,2}$/.test(v)) return Number(v);
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = (item: string) => {
    const [addr = '', bits, extra] = item.split('/');
    const kind = isIP(addr);
    if (!kind || extra !== undefined) return false;
    return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (kind === 4 ? 32 : 128));
  };
  if (!items.length || !items.every(valid)) {
    ctx.addIssue({ code: 'custom', message: 'attendu : false, true, un nombre de sauts (ex. 2) ou une liste d’adresses / réseaux CIDR séparés par des virgules' });
    return z.NEVER;
  }
  return items.join(',');
});

const csv = (def = '') =>
  z.string().default(def).transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v.replace(/\/+$/, '') : undefined))
  .pipe(z.string().url().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: z.string().url().transform((v) => v.replace(/\/+$/, '')),
    DATA_DIR: z.string().default('./data'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    TRUST_PROXY: trustProxy,
    ALLOW_INSECURE_HTTP: bool('false'),
    WEBHOOK_ALLOW_PRIVATE: bool('false'),
    // Autorise le fournisseur IA à viser un réseau privé (Ollama, LM Studio…). Variable d'environnement seulement : jamais modifiable depuis l'interface.
    AI_ALLOW_PRIVATE: bool('false'),
    // Fige la configuration des fournisseurs et de l'intégration : seules les variables d'environnement comptent,
    // les réglages saisis dans l'interface sont ignorés (et non modifiables).
    CONFIG_LOCKED: bool('false'),

    // Clé maîtresse (32 octets en base64) : chiffre les secrets stockés en base (clé LLM…).
    ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'doit contenir 32 octets encodés en base64 (openssl rand -base64 32)',
    }),

    OIDC_ISSUER: optionalUrl,
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    OIDC_ADMIN_GROUPS: csv('notabene-admins'),
    OIDC_EDITOR_GROUPS: csv('notabene-editors'),
    OIDC_READER_GROUPS: csv(''),
    // Rôle des utilisateurs authentifiés qui ne sont dans aucun groupe : « none » refuse l'accès.
    OIDC_DEFAULT_ROLE: z.enum(['reader', 'none']).default('none'),
    SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(12),
    // Connexions et opérations sensibles d'authentification : tentatives par minute et par adresse IP (défaut 10).
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
    // Une session sans aucune requête pendant cette durée est fermée (en plus de la durée absolue ci-dessus).
    // Conservation (jours ; 0 = jamais purgé) : corbeille, notifications lues, adresses IP et entrées du journal d'audit.
    TRASH_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
    NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
    AUDIT_IP_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(365),
    SESSION_IDLE_MINUTES: z.coerce.number().min(5).max(24 * 60).default(120),
    // Documentation interactive de l'API : auth (connectés seulement, défaut), public, off.
    API_DOCS: z.enum(['auth', 'public', 'off']).default('auth'),

    // Comptes locaux (e-mail + mot de passe, MFA TOTP) : alternative ou complément à OIDC.
    AUTH_LOCAL: bool('false'),
    // Impose la double authentification : comptes locaux (TOTP obligatoire) et OIDC (claim `amr` exigé).
    LOCAL_REQUIRE_MFA: bool('false'),
    // Co-édition temps réel (WebSocket Yjs) pour les rédacteurs.
    COLLAB_ENABLED: bool('true'),
    OIDC_REQUIRE_MFA: bool('false'),

    // LDAP / Active Directory : authentification par liaison (bind) avec le compte de l'annuaire.
    LDAP_URL: z.string().regex(/^ldaps?:\/\/[^\s]+$/, 'doit commencer par ldap:// ou ldaps://').optional(),
    LDAP_STARTTLS: bool('false'),
    LDAP_TLS_CA_FILE: z.string().optional(),
    // Autorité de certification au format PEM (alternative au fichier, configurable depuis l'interface).
    LDAP_TLS_CA: z.string().optional(),
    LDAP_BIND_DN: z.string().optional(),
    LDAP_BIND_PASSWORD: z.string().optional(),
    LDAP_BASE_DN: z.string().optional(),
    LDAP_USER_FILTER: z.string().default('(|(sAMAccountName={username})(uid={username})(mail={username}))'),
    LDAP_GROUP_ATTRIBUTE: z.string().default('memberOf'),
    LDAP_NAME_ATTRIBUTE: z.string().default('displayName'),
    LDAP_EMAIL_ATTRIBUTE: z.string().default('mail'),
    LDAP_ADMIN_GROUPS: csv(''),
    LDAP_EDITOR_GROUPS: csv(''),
    LDAP_READER_GROUPS: csv(''),
    LDAP_DEFAULT_ROLE: z.enum(['reader', 'none']).default('none'),

    // SAML 2.0 (SP-initiated uniquement) : assertion signée obligatoire.
    SAML_ENTRY_POINT: optionalUrl,
    SAML_IDP_CERT: z.string().optional(),
    SAML_IDP_CERT_FILE: z.string().optional(),
    SAML_ISSUER: z.string().optional(),
    SAML_WANT_RESPONSE_SIGNED: bool('false'),
    SAML_GROUPS_ATTRIBUTE: z.string().default('groups'),
    SAML_EMAIL_ATTRIBUTE: z.string().default('email'),
    SAML_NAME_ATTRIBUTE: z.string().default('name'),
    SAML_ADMIN_GROUPS: csv(''),
    SAML_EDITOR_GROUPS: csv(''),
    SAML_READER_GROUPS: csv(''),
    SAML_DEFAULT_ROLE: z.enum(['reader', 'none']).default('none'),

    // Envoi d'e-mails (réinitialisation de mot de passe, invitations, alertes). Désactivé sans SMTP_HOST.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    // starttls : connexion en clair puis chiffrement obligatoire ; tls : TLS dès la connexion (port 465).
    SMTP_MODE: z.enum(['starttls', 'tls']).default('starttls'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    // Connexion de développement sans IdP. Interdite en production.
    DEV_LOGIN: bool('false'),

    DRAWIO_URL: optionalUrl,
    EMBED_ALLOWED_ORIGINS: csv(''),
    SEED_DEMO: bool('true'),
  })
  .superRefine((c, ctx) => {
    if (c.DEV_LOGIN && c.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN'], message: 'interdit quand NODE_ENV=production' });
    }
    if (!c.DEV_LOGIN && !c.AUTH_LOCAL && !c.LDAP_URL && !c.SAML_ENTRY_POINT && !(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID et OIDC_CLIENT_SECRET sont requis' });
    }
    if (c.NODE_ENV === 'production' && !c.PUBLIC_URL.startsWith('https://') && !c.ALLOW_INSECURE_HTTP) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'doit être en https en production (ou ALLOW_INSECURE_HTTP=true, déconseillé)' });
    }
    if (c.LDAP_URL) {
      for (const k of ['LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN'] as const) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'requis quand LDAP_URL est défini' });
      }
      if (!c.LDAP_USER_FILTER.includes('{username}')) ctx.addIssue({ code: 'custom', path: ['LDAP_USER_FILTER'], message: 'doit contenir {username}' });
      if (c.NODE_ENV === 'production' && c.LDAP_URL.startsWith('ldap://') && !c.LDAP_STARTTLS) {
        ctx.addIssue({ code: 'custom', path: ['LDAP_URL'], message: 'ldap:// en clair interdit en production : utilisez ldaps:// ou LDAP_STARTTLS=true' });
      }
    }
    if (c.SAML_ENTRY_POINT) {
      if (!c.SAML_IDP_CERT && !c.SAML_IDP_CERT_FILE) ctx.addIssue({ code: 'custom', path: ['SAML_IDP_CERT'], message: 'SAML_IDP_CERT ou SAML_IDP_CERT_FILE requis' });
      if (c.NODE_ENV === 'production' && !c.SAML_ENTRY_POINT.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['SAML_ENTRY_POINT'], message: 'doit être en https en production' });
      }
    }
    for (const origin of c.EMBED_ALLOWED_ORIGINS) {
      if (!/^https?:\/\/[^/\s*]+$/.test(origin)) {
        ctx.addIssue({ code: 'custom', path: ['EMBED_ALLOWED_ORIGINS'], message: `origine invalide : ${origin}` });
      }
    }
  });

export type Config = z.output<typeof schema> & { secureCookies: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'} : ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join('\n')}`);
  }
  return { ...parsed.data, secureCookies: parsed.data.PUBLIC_URL.startsWith('https://') };
}
