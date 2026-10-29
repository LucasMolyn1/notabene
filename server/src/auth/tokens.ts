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
}

export function createApiToken(db: DB, userId: string, input: { name: string; scopes: Scope[]; expiresInDays: number }) {
  const token = `nb_${randomToken(32)}`;
  const id = newId();
  const now = Date.now();
  const expiresAt = now + input.expiresInDays * 86_400_000;
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.name, sha256(token), token.slice(0, 10), JSON.stringify(input.scopes), now, expiresAt);
  return { id, token, prefix: token.slice(0, 10), expiresAt };
}

export function verifyApiToken(db: DB, token: string): Auth | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = db.prepare(
    `SELECT t.id, t.scopes, t.expires_at, t.revoked_at, t.last_used_at, u.id AS user_id, u.name, u.email, u.role
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
  ).get(sha256(token)) as (TokenRow & { email: string | null; role: Role }) | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  const scopes = (JSON.parse(row.scopes) as string[]).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
  return {
    user: { id: row.user_id, name: row.name, email: row.email, role: row.role },
    via: 'token',
    scopes: new Set(scopes),
    tokenId: row.id,
  };
}

export function listApiTokens(db: DB, userId: string) {
  const rows = db.prepare(
    `SELECT id, name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at
     FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(userId) as TokenRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes) as Scope[],
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export function revokeApiToken(db: DB, userId: string, id: string) {
  return db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, userId).changes > 0;
}
