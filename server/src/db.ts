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
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// Purge périodique des données expirées.
export function cleanup(db: DB) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM login_states WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - 365 * 86_400_000);
}
