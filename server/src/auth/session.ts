// Sessions navigateur : identifiant aléatoire en cookie HttpOnly, seul son hash est stocké.
import type { DB } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ALL_SCOPES, type Auth, type Role } from './context.js';

export const sessionCookieName = (secure: boolean) => (secure ? '__Host-nb_session' : 'nb_session');

export function createSession(db: DB, userId: string, idToken: string | null, ttlHours: number) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  const expiresAt = now + ttlHours * 3_600_000;
  db.prepare(
    'INSERT INTO sessions (id_hash, user_id, csrf, id_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), userId, csrf, idToken, now, expiresAt, now);
  return { token, csrf, expiresAt };
}

interface SessionRow {
  id_hash: string;
  csrf: string;
  expires_at: number;
  last_seen_at: number;
  user_id: string;
  name: string;
  email: string | null;
  role: Role;
}

export function sessionAuth(db: DB, token: string): Auth | null {
  if (!token || token.length > 128) return null;
  const row = db.prepare(
    `SELECT s.id_hash, s.csrf, s.expires_at, s.last_seen_at, u.id AS user_id, u.name, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  ).get(sha256(token)) as SessionRow | undefined;
  const now = Date.now();
  if (!row || row.expires_at <= now) return null;
  if (now - row.last_seen_at > 60_000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
  return {
    user: { id: row.user_id, name: row.name, email: row.email, role: row.role },
    via: 'session',
    scopes: new Set(ALL_SCOPES),
    csrf: row.csrf,
  };
}

// Supprime la session et renvoie l'id_token (pour la déconnexion côté IdP).
export function destroySession(db: DB, token: string): string | null {
  const hash = sha256(token);
  const row = db.prepare('SELECT id_token FROM sessions WHERE id_hash = ?').get(hash) as { id_token: string | null } | undefined;
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
  return row?.id_token ?? null;
}
