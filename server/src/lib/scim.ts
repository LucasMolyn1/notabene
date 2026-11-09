// Provisionnement SCIM 2.0 (RFC 7643, RFC 7644) : réglage d'instance, jetons dédiés, filtres et mise en forme des ressources.
// Les routes sont dans routes/scim.ts (protocole) et routes/scim-admin.ts (administration depuis l'interface).
//
// Règles de sécurité :
//  - le jeton SCIM est propre à SCIM (préfixe `nbscim_`, table `scim_tokens`) : il n'ouvre aucune autre route, et ni une
//    session ni un jeton d'API n'ouvrent /scim ;
//  - un compte administrateur n'est jamais visible ni modifiable par SCIM, et SCIM n'attribue jamais le rôle « admin » ;
//  - SCIM ne définit aucun mot de passe et ne supprime aucun contenu : « supprimer » un compte le désactive.
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { newId } from './http.js';

export const SCIM_TOKEN_PATTERN = /^nbscim_[A-Za-z0-9_-]{43}$/;
export const MAX_SCIM_TOKENS = 10;
export const SCIM_MAX_RESULTS = 200;
export const SCIM_BODY_LIMIT = 1024 * 1024;

export const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  spc: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

export type ScimRole = 'reader' | 'editor';

// Erreur au format SCIM (RFC 7644, section 3.12). `detail` ne reprend jamais une valeur reçue.
export class ScimError extends Error {
  constructor(readonly status: number, readonly scimType: string | null, detail: string) {
    super(detail);
  }
}

export const scimError = (status: number, detail: string, scimType: string | null = null) => ({
  schemas: [SCHEMA.error],
  status: String(status),
  ...(scimType ? { scimType } : {}),
  detail,
});

// ---- Réglage d'instance -----------------------------------------------------------------------------
const KEY = 'scim';
const stored = z.object({ enabled: z.boolean(), defaultRole: z.enum(['reader', 'editor']) });

export interface ScimSettings { enabled: boolean; defaultRole: ScimRole; source: 'env' | 'db'; locked: boolean }

export function scimSettings(db: DB, config: Pick<Config, 'SCIM_ENABLED' | 'SCIM_DEFAULT_ROLE' | 'CONFIG_LOCKED'>): ScimSettings {
  const env = { enabled: config.SCIM_ENABLED, defaultRole: config.SCIM_DEFAULT_ROLE };
  if (config.CONFIG_LOCKED) return { ...env, source: 'env', locked: true };
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return { ...env, source: 'env', locked: false };
  // Valeur illisible : SCIM reste coupé (refus par défaut).
  try { return { ...stored.parse(JSON.parse(row.value)), source: 'db', locked: false }; } catch { return { enabled: false, defaultRole: 'reader', source: 'db', locked: false }; }
}

export function saveScimSettings(db: DB, value: { enabled: boolean; defaultRole: ScimRole }, userId: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify(stored.parse(value)), Date.now(), userId);
}

// ---- Jetons ------------------------------------------------------------------------------------------
interface TokenRow { id: string; name: string; token_hash: string; prefix: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }

export function createScimToken(db: DB, userId: string, input: { name: string; expiresInDays: number }) {
  const token = `nbscim_${randomToken(32)}`;
  const id = newId();
  const now = Date.now();
  const expiresAt = now + input.expiresInDays * 86_400_000;
  db.prepare('INSERT INTO scim_tokens (id, name, token_hash, prefix, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.name, sha256(token), token.slice(0, 12), userId, now, expiresAt);
  return { id, name: input.name, token, prefix: token.slice(0, 12), expiresAt };
}

export const activeScimTokens = (db: DB) =>
  (db.prepare('SELECT COUNT(*) AS n FROM scim_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(Date.now()) as { n: number }).n;

// Renvoie l'identifiant du jeton s'il est valide. Recherche par empreinte (index unique) puis comparaison à temps constant.
export function verifyScimToken(db: DB, token: string): string | null {
  if (!SCIM_TOKEN_PATTERN.test(token)) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT id, token_hash, expires_at, revoked_at, last_used_at FROM scim_tokens WHERE token_hash = ?').get(hash) as TokenRow | undefined;
  const now = Date.now();
  if (!row || !safeEqual(row.token_hash, hash) || row.revoked_at || row.expires_at <= now) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) db.prepare('UPDATE scim_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return row.id;
}

export function listScimTokens(db: DB) {
  return (db.prepare('SELECT id, name, prefix, created_at, expires_at, last_used_at, revoked_at FROM scim_tokens ORDER BY created_at DESC').all() as TokenRow[])
    .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
}

export const revokeScimToken = (db: DB, id: string) =>
  db.prepare('UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes > 0;

// ---- Filtres -----------------------------------------------------------------------------------------
// Seule forme acceptée : `attribut eq valeur` (chaîne JSON, true, false). Le SQL est choisi dans une liste fermée et la valeur
// passe toujours en paramètre : rien de la requête n'est concaténé.
export interface Filter { attr: string; value: string | boolean }

export function parseFilter(raw: string | undefined): Filter | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.length > 500) throw new ScimError(400, 'invalidFilter', 'Filtre trop long');
  const m = /^\s*([A-Za-z][A-Za-z0-9.:_-]{0,120})\s+eq\s+("(?:[^"\\]|\\.){0,400}"|true|false)\s*$/i.exec(raw);
  if (!m) throw new ScimError(400, 'invalidFilter', 'Filtre non pris en charge : seule la forme « attribut eq valeur » est acceptée');
  let value: string | boolean;
  if (m[2]!.startsWith('"')) {
    try { value = JSON.parse(m[2]!) as string; } catch { throw new ScimError(400, 'invalidFilter', 'Valeur de filtre invalide'); }
  } else value = m[2]!.toLowerCase() === 'true';
  return { attr: stripUrn(m[1]!).toLowerCase(), value };
}

// Retire le préfixe d'URN d'un chemin (« urn:…:core:2.0:User:userName » devient « userName »).
export function stripUrn(path: string): string {
  for (const urn of [SCHEMA.user, SCHEMA.group]) {
    if (path.length > urn.length && path.slice(0, urn.length + 1).toLowerCase() === `${urn.toLowerCase()}:`) return path.slice(urn.length + 1);
  }
  return path;
}

// Pagination (RFC 7644, 3.4.2.4) : startIndex commence à 1 ; une valeur hors bornes est ramenée dans les bornes.
export const listQuery = z.object({
  filter: z.string().max(500).optional(),
  startIndex: z.coerce.number().int().catch(1).default(1).transform((v) => Math.max(1, Math.min(v, 1_000_000_000))),
  count: z.coerce.number().int().catch(100).default(100).transform((v) => Math.max(0, Math.min(v, SCIM_MAX_RESULTS))),
  attributes: z.string().max(500).optional(),
  excludedAttributes: z.string().max(500).optional(),
});

export const excludes = (q: { excludedAttributes?: string }, attr: string) =>
  (q.excludedAttributes ?? '').split(',').some((a) => stripUrn(a.trim()).toLowerCase() === attr.toLowerCase());

// ---- Validation des valeurs -------------------------------------------------------------------------
const noControl = (v: string) => ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export const userNameSchema = z.string().trim().min(1).max(256).refine(noControl, 'caractères interdits');
// Identifiant externe : sert aussi d'identifiant OIDC (`sub`) du compte créé. Les préfixes internes (comptes locaux, LDAP,
// SAML, connexion de développement) sont refusés : SCIM ne doit jamais rattacher ni créer un compte de ce type.
export const externalIdSchema = z.string().trim().min(1).max(256).refine(noControl, 'caractères interdits')
  .refine((v) => !/^(local|ldap|saml|scim):/i.test(v) && !/^dev-/i.test(v), 'préfixe réservé');
export const emailSchema = z.string().trim().max(254).pipe(z.email());
const short = z.string().max(200);
export const nameSchema = z.object({ formatted: short.nullish(), givenName: short.nullish(), familyName: short.nullish(), middleName: short.nullish() });
// Nom de groupe : mêmes règles que les groupes locaux (routes/groups.ts).
export const displayNameSchema = z.string().trim().min(1).max(80).refine((n) => noControl(n) && !n.includes('<') && !n.includes('>'), 'caractères interdits');
export const groupExternalIdSchema = z.string().trim().min(1).max(256).refine(noControl, 'caractères interdits');

// Nom affiché du compte : displayName, puis nom formaté, puis prénom et nom, puis nom d'utilisateur (120 caractères au plus).
export function displayNameOf(u: { userName: string; displayName?: string | null; name?: z.output<typeof nameSchema> | null }): string {
  const parts = [u.name?.givenName, u.name?.familyName].map((p) => p?.trim()).filter(Boolean).join(' ');
  const pick = [u.displayName, u.name?.formatted, parts, u.userName].map((v) => v?.trim() ?? '').find((v) => v && noControl(v)) ?? u.userName;
  return pick.slice(0, 120);
}

// Adresse retenue : principale, sinon de type « work », sinon la première.
export function primaryEmail(emails: { value: string; type?: string | null; primary?: boolean | null }[] | null | undefined): string | null {
  if (!emails?.length) return null;
  const e = emails.find((x) => x.primary) ?? emails.find((x) => x.type?.toLowerCase() === 'work') ?? emails[0]!;
  return e.value;
}

export const iso = (ms: number) => new Date(ms).toISOString();
