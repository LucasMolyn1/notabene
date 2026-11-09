// Format stable des évènements du journal d'audit, commun à la liste paginée, à l'export, au SIEM et à la sortie standard.
// Documenté dans docs/AUDIT.md : tout changement incompatible exige un nouveau numéro de schéma.
// Rien d'autre que ce que contient déjà `audit_log` ne sort ; `meta` est en plus filtré (aucun secret ni texte de page).
import { z } from 'zod';
import type { DB } from '../db.js';

export const AUDIT_SCHEMA = 'notabene.audit/1';

// Famille d'actions du journal d'audit : « auth », « auth.local », « settings »… (un point final est toléré).
export const auditFamily = z.string().trim().toLowerCase().max(100).regex(/^[a-z0-9_-][a-z0-9_.-]*$/, 'famille d’actions invalide (ex. auth, settings)').refine((v) => !v.includes('..'), 'famille d’actions invalide').transform((v) => v.replace(/\.$/, ''));

export interface AuditEvent {
  schema: typeof AUDIT_SCHEMA;
  id: number;
  timestamp: string;
  action: string;
  outcome: 'success' | 'failure';
  // `via` : jeton d'API utilisé quand l'action vient d'un outil (absent pour une session navigateur). Ajout compatible du schéma 1.
  actor: { id: string; name: string | null; via?: { type: 'token'; id: string; name: string | null } } | null;
  target: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
}

export interface AuditRow { id: number; at: number; user_id: string | null; user_name: string | null; action: string; target: string | null; ip: string | null; meta: string | null; token_id?: string | null; token_name?: string | null }

// Échec : refus d'accès et actions terminées par `.failed` (connexion, ressaisie, test de configuration…).
export const outcomeOf = (action: string): AuditEvent['outcome'] => (action === 'auth.denied' || action.endsWith('.failed') ? 'failure' : 'success');

// Clés dont la valeur textuelle n'est jamais transmise : secrets, identifiants de connexion, chemins, et tout ce qui
// pourrait reprendre un texte de page. Recherche n'importe où dans le nom (pluriels et composés compris : `tokens`,
// `clientSecret`, `filePaths`…). Un booléen ou un nombre reste (ex. `password: true` dans user.update : « mot de passe changé »).
const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|key|hash|otp|authori[sz]ation|cookie|credential|content|body|html|markdown|text|prompt|message|title|path|filename|username/i;
const MAX_DEPTH = 3;
const MAX_STRING = 200;
const MAX_ITEMS = 50;

function clean(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (SENSITIVE_KEY.test(k) && typeof v !== 'boolean' && typeof v !== 'number') continue;
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

export function sanitizeMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return clean(parsed, 0) as Record<string, unknown>;
}

export const toAuditEvent = (r: AuditRow): AuditEvent => ({
  schema: AUDIT_SCHEMA,
  id: r.id,
  timestamp: new Date(r.at).toISOString(),
  action: r.action,
  outcome: outcomeOf(r.action),
  actor: r.user_id ? { id: r.user_id, name: r.user_name ?? null, ...(r.token_id ? { via: { type: 'token' as const, id: r.token_id, name: r.token_name ?? null } } : {}) } : null,
  target: r.target,
  ip: r.ip,
  meta: sanitizeMeta(r.meta),
});

// Une famille (« auth ») couvre l'action du même nom et toutes celles qui commencent par « auth. ».
export const matchesFamily = (action: string, families: readonly string[]) =>
  !families.length || families.map((f) => f.replace(/\.$/, '')).some((f) => action === f || action.startsWith(`${f}.`));

// ---- Filtres -------------------------------------------------------------------------------------
// Date seule (AAAA-MM-JJ, en UTC) ou date et heure ISO 8601 avec fuseau. `from` inclus, `to` exclu ; une date seule
// en `to` couvre toute la journée.
const dateParam = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const auditFilters = z.object({
  // Action exacte (auth.login) ou famille terminée par un point (auth.) : préfixe.
  action: z.string().trim().max(100).regex(/^[a-z0-9_-][a-z0-9_.-]*$/i, 'action invalide').refine((v) => !v.includes('..'), 'action invalide').optional(),
  userId: z.string().trim().min(1).max(100).optional(),
  target: z.string().trim().min(1).max(300).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
});
export type AuditFilters = z.output<typeof auditFilters>;

const toMs = (v: string, end: boolean) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00Z`) + (end ? 86_400_000 : 0);
  return Date.parse(v);
};

export class FilterError extends Error {}

// Clause WHERE paramétrée (alias `a` pour audit_log). Aucune valeur n'est concaténée dans le SQL.
export function auditWhere(f: AuditFilters): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (f.action) {
    if (f.action.endsWith('.')) { parts.push('substr(a.action, 1, ?) = ?'); args.push(f.action.length, f.action); }
    else { parts.push('a.action = ?'); args.push(f.action); }
  }
  if (f.userId) { parts.push('a.user_id = ?'); args.push(f.userId); }
  if (f.target) { parts.push('a.target = ?'); args.push(f.target); }
  if (f.outcome) {
    const failure = "(a.action = 'auth.denied' OR substr(a.action, -7) = '.failed')";
    parts.push(f.outcome === 'failure' ? failure : `NOT ${failure}`);
  }
  const from = f.from ? toMs(f.from, false) : null;
  const to = f.to ? toMs(f.to, true) : null;
  if (from !== null && to !== null && from >= to) throw new FilterError('La date de début doit précéder la date de fin');
  if (from !== null) { parts.push('a.at >= ?'); args.push(from); }
  if (to !== null) { parts.push('a.at < ?'); args.push(to); }
  return { sql: parts.length ? parts.join(' AND ') : '1', args };
}

const SELECT = `SELECT a.id, a.at, a.user_id, u.name AS user_name, a.action, a.target, a.ip, a.meta, a.token_id, a.token_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;

// Lignes plus anciennes que `beforeId` (exclu), de la plus récente à la plus ancienne.
export function auditPage(db: DB, f: AuditFilters, beforeId: number | null, limit: number): AuditRow[] {
  const w = auditWhere(f);
  return db.prepare(`${SELECT} WHERE ${w.sql}${beforeId !== null ? ' AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`)
    .all(...w.args, ...(beforeId !== null ? [beforeId] : []), limit) as AuditRow[];
}

// Familles d'actions en SQL : « auth » couvre `auth` et `auth.*` (comparaison de préfixe, sans LIKE ni concaténation de valeur).
export function familyWhere(families: readonly string[]): { sql: string; args: unknown[] } {
  const list = [...new Set(families.map((f) => f.replace(/\.$/, '')).filter(Boolean))];
  if (!list.length) return { sql: '1', args: [] };
  return { sql: `(${list.map(() => '(a.action = ? OR substr(a.action, 1, ?) = ?)').join(' OR ')})`, args: list.flatMap((f) => [f, f.length + 1, `${f}.`]) };
}

// Lignes plus récentes que `afterId` (exclu), dans l'ordre d'écriture (envoi au SIEM et sortie standard), éventuellement
// limitées à des familles et à un identifiant maximal (instantané).
export function auditAfter(db: DB, afterId: number, limit: number, opts: { families?: readonly string[]; upTo?: number } = {}): AuditRow[] {
  const fam = familyWhere(opts.families ?? []);
  const upTo = opts.upTo ?? Number.MAX_SAFE_INTEGER;
  return db.prepare(`${SELECT} WHERE a.id > ? AND a.id <= ? AND ${fam.sql} ORDER BY a.id ASC LIMIT ?`).all(afterId, upTo, ...fam.args, limit) as AuditRow[];
}

export const auditCountAfter = (db: DB, afterId: number, families: readonly string[]) => {
  const fam = familyWhere(families);
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_log a WHERE a.id > ? AND ${fam.sql}`).get(afterId, ...fam.args) as { n: number }).n;
};

// Taille maximale d'un évènement sérialisé : au-delà, `meta` est remplacé par un marqueur et les textes sont coupés.
// Un évènement n'empêche donc jamais un lot de partir.
export const MAX_EVENT_BYTES = 64_000;
const clip = (v: string | null, n = 300) => (v && v.length > n ? `${v.slice(0, n)}…` : v);
export function eventJson(e: AuditEvent): string {
  const json = JSON.stringify(e);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  return JSON.stringify({
    ...e, action: clip(e.action)!, target: clip(e.target), ip: clip(e.ip, 64),
    actor: e.actor ? { id: clip(e.actor.id)!, name: clip(e.actor.name), ...(e.actor.via ? { via: { type: 'token' as const, id: clip(e.actor.via.id)!, name: clip(e.actor.via.name) } } : {}) } : null, meta: { truncated: true },
  });
}

export const auditMaxId = (db: DB) => (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').get() as { n: number }).n;

// ---- Export CSV ----------------------------------------------------------------------------------
export const CSV_COLUMNS = ['id', 'timestamp', 'action', 'outcome', 'actor_id', 'actor_name', 'target', 'ip', 'meta', 'via_token'] as const;

// Cellule CSV (RFC 4180, toujours entre guillemets). Une valeur qui commence par = + - @, une tabulation ou un retour
// chariot est préfixée d'une apostrophe : un tableur ne l'exécute pas comme une formule (injection CSV).
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '""';
  let s = typeof v === 'string' ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvLine = (e: AuditEvent) =>
  [e.id, e.timestamp, e.action, e.outcome, e.actor?.id, e.actor?.name, e.target, e.ip, e.meta ? JSON.stringify(e.meta) : null, e.actor?.via?.name].map(csvCell).join(',');
