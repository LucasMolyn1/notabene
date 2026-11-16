// Jetons d'API personnels : affichés une seule fois, stockés hachés (SHA-256),
// limités dans le temps et par portées, révocables.
import type { DB } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { newId } from '../lib/http.js';
import { type Auth, type Role, type Scope, ALL_SCOPES } from './context.js';

export const TOKEN_PATTERN = /^nb_[A-Za-z0-9_-]{43}$/;

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  space_limited: number;
  request_count: number;
}

/** Espaces autorisés d'un jeton : null = tous ceux de la personne ; une liste (éventuellement vide si ses espaces ont été supprimés) sinon. */
export type TokenSpaces = { id: string; name: string }[] | null;

/**
 * `spaceIds` : espaces autorisés (déjà vérifiés par l'appelant : existants et lisibles par la personne). Absent ou vide = tous les
 * espaces de la personne, comme avant.
 */
export function createApiToken(db: DB, userId: string, input: { name: string; scopes: Scope[]; expiresInDays: number; spaceIds?: string[] }) {
  const token = `nb_${randomToken(32)}`;
  const id = newId();
  const now = Date.now();
  const expiresAt = now + input.expiresInDays * 86_400_000;
  const spaceIds = [...new Set(input.spaceIds ?? [])];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at, space_limited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, input.name, sha256(token), token.slice(0, 10), JSON.stringify(input.scopes), now, expiresAt, spaceIds.length ? 1 : 0);
    const link = db.prepare('INSERT INTO api_token_spaces (token_id, space_id) VALUES (?, ?)');
    for (const s of spaceIds) link.run(id, s);
  })();
  return { id, token, prefix: token.slice(0, 10), expiresAt };
}

/** Espaces autorisés de plusieurs jetons, avec le nom actuel de chaque espace (une requête). */
export function tokenSpaces(db: DB, rows: Pick<TokenRow, 'id' | 'space_limited'>[]): Map<string, TokenSpaces> {
  const out = new Map<string, TokenSpaces>(rows.map((r) => [r.id, r.space_limited ? [] : null]));
  const limited = rows.filter((r) => r.space_limited).map((r) => r.id);
  if (!limited.length) return out;
  for (const r of db.prepare(
    `SELECT ts.token_id, s.id, s.name FROM api_token_spaces ts JOIN spaces s ON s.id = ts.space_id
     WHERE ts.token_id IN (SELECT value FROM json_each(?)) ORDER BY s.name COLLATE NOCASE, s.id`,
  ).all(JSON.stringify(limited)) as { token_id: string; id: string; name: string }[]) out.get(r.token_id)!.push({ id: r.id, name: r.name });
  return out;
}

export function verifyApiToken(db: DB, token: string): Auth | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = db.prepare(
    `SELECT t.id, t.name AS token_name, t.scopes, t.expires_at, t.revoked_at, t.last_used_at, t.space_limited, u.id AS user_id, u.name, u.email, u.role
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0`,
  ).get(sha256(token)) as (TokenRow & { email: string | null; role: Role; token_name: string }) | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  // Jeton limité : liste relue à chaque requête (un espace supprimé disparaît par la cascade). Défense en profondeur : un jeton
  // limité ne porte jamais la portée « admin », même si la ligne en base la contenait.
  const spaceIds = row.space_limited
    ? new Set((db.prepare('SELECT space_id FROM api_token_spaces WHERE token_id = ?').all(row.id) as { space_id: string }[]).map((r) => r.space_id))
    : null;
  const scopes = (JSON.parse(row.scopes) as string[])
    .filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s))
    .filter((s) => !spaceIds || s !== 'admin');
  return {
    user: { id: row.user_id, name: row.name, email: row.email, role: row.role },
    via: 'token',
    scopes: new Set(scopes),
    tokenId: row.id,
    tokenName: row.token_name,
    spaceIds,
  };
}

/** `pending` : requêtes comptées en mémoire, pas encore écrites (lib/token-activity.ts). */
export function listApiTokens(db: DB, userId: string, pending: (tokenId: string) => number = () => 0) {
  const rows = db.prepare(
    `SELECT id, name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at, space_limited, request_count
     FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(userId) as TokenRow[];
  const spaces = tokenSpaces(db, rows);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes) as Scope[],
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    requestCount: r.request_count + pending(r.id),
    revokedAt: r.revoked_at,
    spaces: spaces.get(r.id) ?? null,
  }));
}

export function revokeApiToken(db: DB, userId: string, id: string) {
  return db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, userId).changes > 0;
}
