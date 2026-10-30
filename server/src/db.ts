// Base SQLite (better-sqlite3) et migrations versionnées via PRAGMA user_version.
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    sub           TEXT NOT NULL UNIQUE,
    email         TEXT,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'reader')),
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf         TEXT NOT NULL,
    id_token     TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE login_states (
    state         TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    return_to     TEXT NOT NULL,
    expires_at    INTEGER NOT NULL
  );

  CREATE TABLE spaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE pages (
    seq        INTEGER PRIMARY KEY,
    id         TEXT NOT NULL UNIQUE,
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES pages(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,
    title      TEXT NOT NULL DEFAULT '',
    icon       TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    full_width INTEGER NOT NULL DEFAULT 0,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    deleted_at INTEGER,
    trash_root TEXT
  );
  CREATE INDEX pages_tree ON pages(space_id, parent_id);

  CREATE VIRTUAL TABLE pages_fts USING fts5(
    title, text, content='pages', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, text) VALUES (new.seq, new.title, new.text);
  END;
  CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.seq, old.title, old.text);
  END;
  CREATE TRIGGER pages_au AFTER UPDATE OF title, text ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.seq, old.title, old.text);
    INSERT INTO pages_fts(rowid, title, text) VALUES (new.seq, new.title, new.text);
  END;

  CREATE TABLE favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, page_id)
  );

  CREATE TABLE page_versions (
    id            INTEGER PRIMARY KEY,
    page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    session_start INTEGER NOT NULL
  );
  CREATE INDEX page_versions_page ON page_versions(page_id, id);

  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    user_id TEXT,
    action  TEXT NOT NULL,
    target  TEXT,
    ip      TEXT,
    meta    TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  `,
  `
  CREATE TABLE webhooks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    events      TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    last_status INTEGER,
    last_at     INTEGER,
    failures    INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  ALTER TABLE users ADD COLUMN password_hash  TEXT;
  ALTER TABLE users ADD COLUMN totp_secret    TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT;
  ALTER TABLE users ADD COLUMN failed_logins  INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until   INTEGER;
  ALTER TABLE users ADD COLUMN disabled       INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE page_ydocs (
    page_id      TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    state        BLOB NOT NULL,
    epoch        TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  `,
  `
  -- Jetons à usage unique (réinitialisation de mot de passe, invitation) : seul le hash est stocké.
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('reset', 'invite')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX password_resets_user ON password_resets(user_id);
  `,
  `
  -- Permissions fines par page : dès qu'une page (ou un ancêtre) a des entrées, seuls les utilisateurs listés y accèdent.
  CREATE TABLE page_acl (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level   TEXT NOT NULL CHECK (level IN ('read', 'write')),
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX page_acl_user ON page_acl(user_id);

  -- Commentaires de page : fils à un niveau, suppression logique.
  CREATE TABLE page_comments (
    id          TEXT PRIMARY KEY,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES page_comments(id) ON DELETE CASCADE,
    author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    deleted_at  INTEGER
  );
  CREATE INDEX page_comments_page ON page_comments(page_id, created_at);
  `,
  `
  -- Notifications : suivi de pages, boîte de réception, préférences d'e-mail.
  CREATE TABLE page_watch (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    last_emailed_at INTEGER,
    PRIMARY KEY (user_id, page_id)
  );
  CREATE INDEX page_watch_page ON page_watch(page_id);

  CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'page.updated')),
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

  CREATE TABLE notification_prefs (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email_comments INTEGER NOT NULL DEFAULT 1,
    email_changes  INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- Tentative de connexion SSO liée au navigateur (empreinte du cookie posé au départ).
  ALTER TABLE login_states ADD COLUMN binding_hash TEXT;
  `,
  `
  -- Dernière preuve d'identité (mot de passe) donnée dans cette session : ouvre une fenêtre de réauthentification.
  ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
  `,
  // v10 : photo de profil (une image par personne, supprimée avec le compte).
  `
  CREATE TABLE user_avatars (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    data       BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v11 : libellés de page. Le nom est stocké normalisé (voir lib/labels.ts) ; il n'existe aucune liste globale des
  // libellés, donc un libellé n'est jamais visible que par ceux qui peuvent lire au moins une page qui le porte.
  `
  CREATE TABLE page_labels (
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    created_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (page_id, name)
  );
  CREATE INDEX page_labels_name ON page_labels(name);
  `,
  // v12 : modèles de pages. Table à part, jamais dans `pages` : un modèle n'apparaît donc ni dans l'arborescence, ni dans la
  // recherche, ni dans les pages publiques, ni dans le contexte de l'IA. Le contenu est déjà assaini (voir lib/content.ts).
  `
  CREATE TABLE page_templates (
    id         TEXT PRIMARY KEY,
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    icon       TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX page_templates_space ON page_templates(space_id);
  `,
];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`La base est au schéma v${current}, ce serveur ne connaît que v${MIGRATIONS.length} : mettez Notabene à jour, ou restaurez une sauvegarde compatible avec cette version.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export interface Retention { trashDays: number; notificationDays: number; auditIpDays: number; auditDays: number }
export const DEFAULT_RETENTION: Retention = { trashDays: 30, notificationDays: 90, auditIpDays: 90, auditDays: 365 };

// Purge périodique : données expirées, puis limitation de la conservation (0 jour = jamais purgé).
export function cleanup(db: DB, retention: Retention = DEFAULT_RETENTION) {
  const now = Date.now();
  const before = (days: number) => now - days * 86_400_000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM login_states WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
  if (retention.auditDays > 0) db.prepare('DELETE FROM audit_log WHERE at < ?').run(before(retention.auditDays));
  if (retention.auditIpDays > 0) db.prepare('UPDATE audit_log SET ip = NULL WHERE ip IS NOT NULL AND at < ?').run(before(retention.auditIpDays));
  if (retention.notificationDays > 0) db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').run(before(retention.notificationDays));
  if (retention.trashDays > 0) {
    // Racines de corbeille seulement : leurs sous-pages suivent (ON DELETE CASCADE).
    const { changes } = db.prepare('DELETE FROM pages WHERE trash_root = id AND deleted_at < ?').run(before(retention.trashDays));
    if (changes) db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (?, NULL, ?, NULL, NULL, ?)').run(now, 'trash.purge', JSON.stringify({ count: changes }));
  }
}
