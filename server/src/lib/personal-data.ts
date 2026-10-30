// Données personnelles d'un compte : export (droit d'accès et de portabilité) et effacement par anonymisation.
// L'export n'inclut jamais de secret (hash de mot de passe, secret TOTP, hash de jeton ou de session) ni de page
// que la personne ne peut plus lire.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { filterReadable } from './page-acl.js';

interface UserRow {
  id: string; sub: string; email: string | null; name: string; role: 'admin' | 'editor' | 'reader';
  created_at: number; last_login_at: number | null; disabled: number; totp_enabled: number; is_local: number;
}

export function exportUserData(db: DB, userId: string) {
  const u = db.prepare(
    `SELECT id, sub, email, name, role, created_at, last_login_at, disabled, totp_enabled, (password_hash IS NOT NULL) AS is_local FROM users WHERE id = ?`,
  ).get(userId) as UserRow | undefined;
  if (!u) return null;
  const subject: Auth = { user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set(['read']) };
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

  const titled = filterReadable(db, subject, all<{ id: string; title: string; at: number }>(
    'SELECT id, title, created_at AS at FROM pages WHERE created_by = ? AND deleted_at IS NULL ORDER BY created_at', userId));
  const prefs = db.prepare('SELECT email_comments AS c, email_changes AS g FROM notification_prefs WHERE user_id = ?').get(userId) as { c: number; g: number } | undefined;

  return {
    format: 'notabene-personal-data/1',
    generatedAt: new Date().toISOString(),
    profile: {
      id: u.id, name: u.name, email: u.email, role: u.role, identity: u.is_local ? 'compte local' : 'fournisseur externe (SSO, LDAP)',
      createdAt: u.created_at, lastLoginAt: u.last_login_at, disabled: !!u.disabled, mfaEnabled: !!u.totp_enabled,
    },
    tokens: all<{ name: string; prefix: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }>(
      'SELECT name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at', userId)
      .map((t) => ({ name: t.name, prefix: t.prefix, scopes: t.scopes, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at })),
    sessions: all<{ created_at: number; last_seen_at: number; expires_at: number }>('SELECT created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ?', userId)
      .map((s) => ({ createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at })),
    notificationPreferences: { emailComments: prefs ? !!prefs.c : true, emailChanges: prefs ? !!prefs.g : false },
    favorites: filterReadable(db, subject, all<{ id: string; title: string }>(
      'SELECT p.id, p.title FROM favorites f JOIN pages p ON p.id = f.page_id WHERE f.user_id = ? AND p.deleted_at IS NULL', userId)),
    watchedPages: filterReadable(db, subject, all<{ id: string; title: string }>(
      'SELECT p.id, p.title FROM page_watch w JOIN pages p ON p.id = w.page_id WHERE w.user_id = ? AND p.deleted_at IS NULL', userId)),
    pagesCreated: titled.map((p) => ({ id: p.id, title: p.title, createdAt: p.at })),
    contributions: {
      pagesEdited: one<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE updated_by = ?', userId).n,
      versionsAuthored: one<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE created_by = ?', userId).n,
    },
    comments: all<{ id: string; page_id: string; body: string; created_at: number }>(
      'SELECT id, page_id, body, created_at FROM page_comments WHERE author_id = ? AND deleted_at IS NULL ORDER BY created_at', userId)
      .map((c) => ({ id: c.id, pageId: c.page_id, body: c.body, createdAt: c.created_at })),
    notifications: all<{ type: string; page_id: string; created_at: number; read_at: number | null }>(
      'SELECT type, page_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', userId)
      .map((n) => ({ type: n.type, pageId: n.page_id, createdAt: n.created_at, readAt: n.read_at })),
    auditTrail: all<{ at: number; action: string; ip: string | null }>('SELECT at, action, ip FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1000', userId),
  };
}

// Effacement : le compte et ce qui lui est propre disparaissent ; ce qu'il a écrit reste mais sans auteur.
// (Les clés étrangères en cascade retirent sessions, jetons, favoris, suivis, notifications, permissions et préférences.)
export function eraseUser(db: DB, userId: string): boolean {
  return db.transaction(() => {
    const u = db.prepare('SELECT sub FROM users WHERE id = ?').get(userId) as { sub: string } | undefined;
    if (!u) return false;
    db.prepare('UPDATE pages SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE pages SET updated_by = NULL WHERE updated_by = ?').run(userId);
    db.prepare('UPDATE page_versions SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE settings SET updated_by = NULL WHERE updated_by = ?').run(userId);
    // Le journal garde la trace des actions, sans la personne ni son adresse IP.
    db.prepare('UPDATE audit_log SET user_id = NULL, ip = NULL WHERE user_id = ?').run(userId);
    // Les connexions sont journalisées avant que l'identité soit posée sur la requête : la personne n'y figure que comme cible.
    db.prepare('UPDATE audit_log SET target = NULL, meta = NULL, ip = NULL WHERE target IN (?, ?)').run(userId, u.sub);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return true;
  })();
}
