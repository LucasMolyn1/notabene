// Configuration lue depuis l'environnement et validée au démarrage.
// Principe : une configuration dangereuse empêche le serveur de démarrer.
import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z.enum(['true', 'false', '1', '0']).default(def).transform((v) => v === 'true' || v === '1');

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
    TRUST_PROXY: bool('false'),
    ALLOW_INSECURE_HTTP: bool('false'),
    WEBHOOK_ALLOW_PRIVATE: bool('false'),

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
    if (!c.DEV_LOGIN && !(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID et OIDC_CLIENT_SECRET sont requis' });
    }
    if (c.NODE_ENV === 'production' && !c.PUBLIC_URL.startsWith('https://') && !c.ALLOW_INSECURE_HTTP) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'doit être en https en production (ou ALLOW_INSECURE_HTTP=true, déconseillé)' });
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
