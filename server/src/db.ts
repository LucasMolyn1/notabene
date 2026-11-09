// Base SQLite (better-sqlite3) et migrations versionnées via PRAGMA user_version.
import Database from 'better-sqlite3';

export type DB = Database.Database;

export const MIGRATIONS: string[] = [
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
  // v13 : commentaires ancrés sur un texte, mentions (@personne) dans les commentaires et les pages.
  // La contrainte de `notifications.type` ne se modifie pas en place : la table est recréée avec le type « mention ».
  `
  ALTER TABLE page_comments ADD COLUMN anchor_text TEXT;

  CREATE TABLE comment_mentions (
    comment_id TEXT NOT NULL REFERENCES page_comments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE INDEX comment_mentions_user ON comment_mentions(user_id);

  -- Personnes déjà notifiées d'une mention dans le contenu d'une page : une seule notification par page et par personne.
  CREATE TABLE page_mentions (
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX page_mentions_user ON page_mentions(user_id);

  CREATE TABLE notifications_v13 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'page.updated', 'mention')),
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  INSERT INTO notifications_v13 (id, user_id, type, page_id, actor_id, count, created_at, read_at)
    SELECT id, user_id, type, page_id, actor_id, count, created_at, read_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_v13 RENAME TO notifications;
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
  `,
  // v14 : groupes et droits par espace.
  // `everyone` est un groupe système sans lignes d'adhésion : tous les comptes en font partie. Pour que personne ne gagne ni ne
  // perde d'accès à la mise à jour, il reçoit le droit d'édition sur chaque espace existant (le rôle global reste un plafond :
  // un lecteur n'a toujours que la lecture).
  `
  CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    -- source : local (créé à la main), system (everyone) ou le fournisseur d'identité dont l'adhésion est recopiée à la connexion.
    source      TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'system', 'oidc', 'ldap', 'saml')),
    external_id TEXT,
    created_at  INTEGER NOT NULL,
    CHECK ((source IN ('oidc', 'ldap', 'saml')) = (external_id IS NOT NULL))
  );
  -- Un groupe du fournisseur n'est lié qu'à un seul groupe local.
  CREATE UNIQUE INDEX groups_external ON groups(source, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members(user_id);

  CREATE TABLE space_members (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
    group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN ('view', 'edit', 'full')),
    CHECK ((user_id IS NULL) != (group_id IS NULL))
  );
  CREATE UNIQUE INDEX space_members_user ON space_members(space_id, user_id) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX space_members_group ON space_members(space_id, group_id) WHERE group_id IS NOT NULL;
  CREATE INDEX space_members_by_user ON space_members(user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX space_members_by_group ON space_members(group_id) WHERE group_id IS NOT NULL;

  -- Permissions de page accordées à un groupe (en plus de page_acl, qui vise une personne).
  CREATE TABLE page_acl_groups (
    page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    level    TEXT NOT NULL CHECK (level IN ('read', 'write')),
    PRIMARY KEY (page_id, group_id)
  );
  CREATE INDEX page_acl_groups_group ON page_acl_groups(group_id);

  INSERT INTO groups (id, name, description, source, external_id, created_at)
    VALUES ('everyone', 'Tout le monde', 'Tous les comptes de l''instance', 'system', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO space_members (space_id, group_id, role) SELECT id, 'everyone', 'edit' FROM spaces;
  `,
  // v15 : espaces personnels. Un espace `personal` n'a qu'un membre, son propriétaire : ni les administrateurs, ni les groupes, ni
  // « Tout le monde » n'y ont accès (space-access.ts). Si le compte est supprimé, l'espace devient orphelin (propriétaire nul) :
  // il reste invisible de tous jusqu'à ce qu'un administrateur le reprenne (action journalisée) ou le supprime.
  `
  ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('shared', 'personal'));
  ALTER TABLE spaces ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX spaces_one_personal ON spaces(owner_id) WHERE kind = 'personal' AND owner_id IS NOT NULL;
  -- Dernier rempart : un espace personnel n'est jamais public, quelle que soit la route qui écrit.
  CREATE TRIGGER spaces_personal_private_insert BEFORE INSERT ON spaces WHEN NEW.kind = 'personal' AND NEW.visibility != 'private'
    BEGIN SELECT RAISE(ABORT, 'un espace personnel est toujours privé'); END;
  CREATE TRIGGER spaces_personal_private_update BEFORE UPDATE ON spaces WHEN NEW.kind = 'personal' AND NEW.visibility != 'private'
    BEGIN SELECT RAISE(ABORT, 'un espace personnel est toujours privé'); END;
  `,
  // v16 : partage public d'une page par lien. Le jeton (192 bits) est le seul secret du lien ; le partage se vérifie à CHAQUE lecture
  // (réglage d'instance, réglage de l'espace, page hors corbeille, restriction de page), il n'a donc rien de définitif.
  `
  CREATE TABLE page_shares (
    id               TEXT PRIMARY KEY,
    page_id          TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
    token            TEXT NOT NULL UNIQUE,
    include_children INTEGER NOT NULL DEFAULT 0,
    indexing         INTEGER NOT NULL DEFAULT 0,
    -- Empreinte de la restriction de la page au moment où elle a été partagée en connaissance de cause (NULL : page non restreinte).
    -- Le lien n'est servi que tant que la restriction est exactement celle-là : elle change, il se tait jusqu'à une nouvelle confirmation.
    restricted_key   TEXT,
    created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  ALTER TABLE spaces ADD COLUMN sharing_enabled INTEGER NOT NULL DEFAULT 1;
  -- Les espaces personnels ne se partagent pas (aucun administrateur ne pourrait ni lister ni retirer ces liens).
  UPDATE spaces SET sharing_enabled = 0 WHERE kind = 'personal';
  `,
  // v17 : bases (tableaux). Une base est une page (`kind = 'base'`) : arborescence, corbeille, permissions et recherche sont ceux des pages,
  // aucun contrôle d'accès nouveau. Les cellules (JSON validé par type) sont dans base_rows ; les vues ne gardent que tri, filtres et colonnes.
  `
  ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc', 'base'));
  -- Une page ne change jamais de nature : sinon ses lignes deviendraient du contenu, ou l'inverse.
  CREATE TRIGGER pages_kind_fixed BEFORE UPDATE OF kind ON pages WHEN NEW.kind != OLD.kind
    BEGIN SELECT RAISE(ABORT, 'le type d''une page ne change pas'); END;

  CREATE TABLE base_properties (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link')),
    options    TEXT NOT NULL DEFAULT '[]',
    position   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX base_properties_base ON base_properties(base_id, position);

  CREATE TABLE base_rows (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,
    vals       TEXT NOT NULL DEFAULT '{}',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX base_rows_base ON base_rows(base_id, position);

  CREATE TABLE base_views (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL DEFAULT '{}',
    position   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX base_views_base ON base_views(base_id, position);
  `,
  // v18 : colonnes calculées (formules). La table des colonnes est refaite pour accepter le type `formula` (SQLite ne modifie pas un CHECK).
  // La formule est du texte analysé à la main au moment de la lecture (formula.ts) : jamais exécutée comme du code.
  `
  CREATE TABLE base_properties_v18 (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'formula')),
    options    TEXT NOT NULL DEFAULT '[]',
    position   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    formula    TEXT,
    CHECK ((type = 'formula') = (formula IS NOT NULL))
  );
  INSERT INTO base_properties_v18 (id, base_id, name, type, options, position, created_at) SELECT id, base_id, name, type, options, position, created_at FROM base_properties;
  DROP TABLE base_properties;
  ALTER TABLE base_properties_v18 RENAME TO base_properties;
  CREATE INDEX base_properties_base ON base_properties(base_id, position);
  `,
  // v19 : pièces jointes. Le fichier est sur disque (DATA_DIR/attachments/<id>), la ligne ne garde que les métadonnées ; le type est
  // celui reconnu sur les octets. Quand une ligne disparaît (pièce jointe, page ou espace supprimés, en cascade comprise), le
  // déclencheur inscrit son identifiant dans attachment_gc : le fichier est ensuite effacé du disque (lib/attachments.ts).
  // Retour arrière : DROP TABLE attachment_gc; DROP TABLE attachments; (les fichiers du dossier deviennent alors inutiles).
  `
  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/zip',
                  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/octet-stream')),
    size        INTEGER NOT NULL CHECK (size > 0),
    sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX attachments_page ON attachments(page_id, created_at);
  CREATE INDEX attachments_uploader ON attachments(uploader_id);

  CREATE TABLE attachment_gc (id TEXT PRIMARY KEY);
  CREATE TRIGGER attachments_ad AFTER DELETE ON attachments BEGIN
    INSERT OR IGNORE INTO attachment_gc (id) VALUES (old.id);
  END;
  `,
  // v20 : une pièce jointe appartient à une page OU à un modèle (copie faite à l'enregistrement du modèle, pour qu'il ne dépende
  // pas de la page d'origine) ; `unreferenced_since` date le premier constat qu'aucune version de la page ne la cite plus.
  // SQLite ne modifie ni NOT NULL ni CHECK en place : la table est refaite, avec ses index et son déclencheur.
  // Retour arrière : refaire la table v19 avec les lignes WHERE page_id IS NOT NULL (les fichiers des modèles deviennent orphelins).
  `
  CREATE TABLE attachments_v20 (
    id          TEXT PRIMARY KEY,
    page_id     TEXT REFERENCES pages(id) ON DELETE CASCADE,
    template_id TEXT REFERENCES page_templates(id) ON DELETE CASCADE,
    uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/zip',
                  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/octet-stream')),
    size        INTEGER NOT NULL CHECK (size > 0),
    sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at  INTEGER NOT NULL,
    unreferenced_since INTEGER,
    CHECK ((page_id IS NULL) != (template_id IS NULL))
  );
  INSERT INTO attachments_v20 (id, page_id, uploader_id, name, mime, size, sha256, created_at)
    SELECT id, page_id, uploader_id, name, mime, size, sha256, created_at FROM attachments ORDER BY rowid;
  DROP TABLE attachments;
  ALTER TABLE attachments_v20 RENAME TO attachments;
  CREATE INDEX attachments_page ON attachments(page_id, created_at);
  CREATE INDEX attachments_template ON attachments(template_id) WHERE template_id IS NOT NULL;
  CREATE INDEX attachments_uploader ON attachments(uploader_id);
  CREATE TRIGGER attachments_ad AFTER DELETE ON attachments BEGIN
    INSERT OR IGNORE INTO attachment_gc (id) VALUES (old.id);
  END;
  `,
  // v21 : origine d'une copie de pièce jointe. Une page qui cite le fichier d'une autre page en reçoit une copie à l'enregistrement ;
  // `copied_from` permet de réutiliser cette copie aux enregistrements suivants au lieu d'en refaire une à chaque fois.
  // Retour arrière : la colonne peut rester (ignorée), ou la table être refaite sans elle.
  `
  ALTER TABLE attachments ADD COLUMN copied_from TEXT;
  CREATE INDEX attachments_copied ON attachments(page_id, copied_from) WHERE copied_from IS NOT NULL;
  `,
  // v22 : journal de la conversion des images base64 en pièces jointes (lib/image-migration.ts). Une exécution (`runs`) au plus
  // est en cours à la fois (index unique partiel, valable aussi entre la commande en ligne et le serveur) ; `pages` garde, page par
  // page, ce qui a été fait ou ignoré et pourquoi ; `items` garde de quoi rétablir chaque image à l'identique (préfixe d'origine,
  // empreinte, et la chaîne d'origine seulement si son base64 n'était pas canonique). Pas de clé étrangère vers les pages : le
  // journal survit à leur suppression (le retour arrière les ignore alors). `server_presence` : signe de vie du serveur, pour que
  // la commande en ligne refuse de convertir pendant qu'il tourne (elle ne voit ni ses salles de co-édition ni ses écritures).
  // Retour arrière : DROP TABLE image_migration_items; DROP TABLE image_migration_pages; DROP TABLE image_migration_runs; DROP TABLE server_presence;
  `
  CREATE TABLE image_migration_runs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('convert', 'revert')),
    reverts      TEXT REFERENCES image_migration_runs(id),
    status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'interrupted', 'failed')),
    source       TEXT NOT NULL CHECK (source IN ('cli', 'api')),
    started_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    started_at   INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    finished_at  INTEGER,
    cursor       INTEGER NOT NULL DEFAULT 0,
    stats        TEXT NOT NULL DEFAULT '{}',
    error        TEXT
  );
  CREATE UNIQUE INDEX image_migration_one_running ON image_migration_runs(status) WHERE status = 'running';

  CREATE TABLE image_migration_pages (
    run_id     TEXT NOT NULL REFERENCES image_migration_runs(id) ON DELETE CASCADE,
    page_id    TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('converted', 'reverted', 'skipped')),
    reason     TEXT,
    images     INTEGER NOT NULL DEFAULT 0,
    bytes      INTEGER NOT NULL DEFAULT 0,
    before_sha TEXT,
    after_sha  TEXT,
    at         INTEGER NOT NULL,
    PRIMARY KEY (run_id, page_id)
  );

  CREATE TABLE image_migration_items (
    run_id        TEXT NOT NULL REFERENCES image_migration_runs(id) ON DELETE CASCADE,
    page_id       TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
    raw           TEXT,
    reverted_at   INTEGER,
    PRIMARY KEY (run_id, page_id, attachment_id)
  );
  CREATE INDEX image_migration_items_attachment ON image_migration_items(attachment_id);

  CREATE TABLE server_presence (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    pid        INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL
  );
  `,
  // v23 : rapports d'import (simulation ou import réel), relus ensuite par la personne qui a importé. Le rapport ne contient que
  // des chemins de l'archive, des titres et des motifs, jamais le contenu des fichiers. Supprimé avec le compte ou l'espace.
  // Retour arrière : DROP TABLE import_reports; (aucune autre table n'en dépend).
  `
  CREATE TABLE import_reports (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('notion')),
    dry_run    INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
    created_at INTEGER NOT NULL,
    summary    TEXT NOT NULL,
    items      TEXT NOT NULL
  );
  CREATE INDEX import_reports_user ON import_reports(user_id, created_at);
  `,
  // 24 : les rapports d'import couvrent aussi les documents Word et PDF (source 'docx' et 'pdf'). SQLite ne modifie pas une
  // contrainte CHECK : la table est reconstruite avec ses lignes. Retour arrière : restaurer la sauvegarde prise avant la mise à jour.
  `
  CREATE TABLE import_reports_new (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('notion', 'docx', 'pdf')),
    dry_run    INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
    created_at INTEGER NOT NULL,
    summary    TEXT NOT NULL,
    items      TEXT NOT NULL
  );
  INSERT INTO import_reports_new SELECT id, user_id, space_id, source, dry_run, created_at, summary, items FROM import_reports;
  DROP TABLE import_reports;
  ALTER TABLE import_reports_new RENAME TO import_reports;
  CREATE INDEX import_reports_user ON import_reports(user_id, created_at);
  `,
  // 25 : texte des pièces jointes pour la recherche. Une ligne par pièce jointe de page (PDF, document Word, texte) : état de
  // l'extraction (`pending` à traiter, `done`, `none` rien d'exploitable, `failed` après deux essais), nom copié et texte extrait.
  // Le texte est dérivé du fichier, il n'est jamais servi tel quel : seule la recherche le lit, et un résultat n'est montré que si
  // la page porteuse est lisible. Supprimé avec la pièce jointe (ON DELETE CASCADE). `attachments_fts` : index à contenu externe,
  // tenu à jour par les déclencheurs. Retour arrière : DROP TABLE attachments_fts; DROP TABLE attachment_text; et les déclencheurs
  // attachment_text_enqueue et attachment_text_* (le reste est inchangé).
  `
  CREATE TABLE attachment_text (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'done', 'none', 'failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    name          TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX attachment_text_pending ON attachment_text(seq) WHERE status = 'pending';
  CREATE VIRTUAL TABLE attachments_fts USING fts5(
    name, text, content='attachment_text', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER attachment_text_ai AFTER INSERT ON attachment_text BEGIN
    INSERT INTO attachments_fts(rowid, name, text) VALUES (new.seq, new.name, new.text);
  END;
  CREATE TRIGGER attachment_text_ad AFTER DELETE ON attachment_text BEGIN
    INSERT INTO attachments_fts(attachments_fts, rowid, name, text) VALUES ('delete', old.seq, old.name, old.text);
  END;
  CREATE TRIGGER attachment_text_au AFTER UPDATE OF name, text ON attachment_text BEGIN
    INSERT INTO attachments_fts(attachments_fts, rowid, name, text) VALUES ('delete', old.seq, old.name, old.text);
    INSERT INTO attachments_fts(rowid, name, text) VALUES (new.seq, new.name, new.text);
  END;
  CREATE TRIGGER attachment_text_enqueue AFTER INSERT ON attachments
    WHEN new.page_id IS NOT NULL AND (new.mime = 'application/pdf'
      OR (new.mime = 'application/zip' AND lower(new.name) LIKE '%.docx')
      OR (new.mime = 'application/octet-stream' AND (lower(new.name) LIKE '%.txt' OR lower(new.name) LIKE '%.md' OR lower(new.name) LIKE '%.markdown'
        OR lower(new.name) LIKE '%.csv' OR lower(new.name) LIKE '%.tsv' OR lower(new.name) LIKE '%.log' OR lower(new.name) LIKE '%.json'
        OR lower(new.name) LIKE '%.xml' OR lower(new.name) LIKE '%.yaml' OR lower(new.name) LIKE '%.yml' OR lower(new.name) LIKE '%.html'
        OR lower(new.name) LIKE '%.htm' OR lower(new.name) LIKE '%.ini' OR lower(new.name) LIKE '%.conf'))) BEGIN
    INSERT OR IGNORE INTO attachment_text (attachment_id, status, name, updated_at) VALUES (new.id, 'pending', new.name, new.created_at);
  END;
  INSERT OR IGNORE INTO attachment_text (attachment_id, status, name, updated_at)
    SELECT id, 'pending', name, created_at FROM attachments new
    WHERE page_id IS NOT NULL AND (new.mime = 'application/pdf'
      OR (new.mime = 'application/zip' AND lower(new.name) LIKE '%.docx')
      OR (new.mime = 'application/octet-stream' AND (lower(new.name) LIKE '%.txt' OR lower(new.name) LIKE '%.md' OR lower(new.name) LIKE '%.markdown'
        OR lower(new.name) LIKE '%.csv' OR lower(new.name) LIKE '%.tsv' OR lower(new.name) LIKE '%.log' OR lower(new.name) LIKE '%.json'
        OR lower(new.name) LIKE '%.xml' OR lower(new.name) LIKE '%.yaml' OR lower(new.name) LIKE '%.yml' OR lower(new.name) LIKE '%.html'
        OR lower(new.name) LIKE '%.htm' OR lower(new.name) LIKE '%.ini' OR lower(new.name) LIKE '%.conf'))) ORDER BY rowid;
  `,
  // 26 : conversations du chat IA, propres à chaque personne (jamais partagées). Supprimées avec le compte (ON DELETE CASCADE),
  // à la demande de la personne, ou par la purge de conservation (AI_CHAT_RETENTION_DAYS, d'après `updated_at`). `page_id` :
  // page depuis laquelle la conversation a été ouverte, remise à NULL si la page est supprimée définitivement. `sources` : JSON
  // des pages citées par une réponse de l'assistant. Retour arrière : DROP TABLE ai_messages; DROP TABLE ai_conversations;
  `
  CREATE TABLE ai_conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    page_id    TEXT REFERENCES pages(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ai_conversations_user ON ai_conversations(user_id, updated_at);
  CREATE INDEX ai_conversations_updated ON ai_conversations(updated_at);
  CREATE INDEX ai_conversations_page ON ai_conversations(page_id) WHERE page_id IS NOT NULL;
  CREATE TABLE ai_messages (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    sources         TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX ai_messages_conversation ON ai_messages(conversation_id, seq);
  `,
  // 27 : vérification de page. `page_verifications` : une configuration par page (intervalle en jours, ou NULL pour une
  // vérification sans échéance), dernière vérification (auteur, date, échéance, date de modification de la page à cet instant)
  // et `notified_state`, dernier rappel envoyé (none, expiring, expired) pour ne rappeler qu'une fois par changement d'état.
  // `page_verifiers` : personnes désignées. Supprimées avec la page (ON DELETE CASCADE) ; à la suppression d'un compte, la
  // désignation disparaît et l'auteur de la vérification devient NULL. La table des notifications est refaite pour accepter les
  // types `verification.expiring` et `verification.expired` (SQLite ne modifie pas une contrainte CHECK).
  // Retour arrière : DELETE FROM notifications WHERE type LIKE 'verification.%'; refaire `notifications` avec la contrainte v13 ;
  // DROP TABLE page_verifiers; DROP TABLE page_verifications;
  `
  CREATE TABLE page_verifications (
    page_id                     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    interval_days               INTEGER CHECK (interval_days IS NULL OR interval_days BETWEEN 1 AND 3650),
    verified_by                 TEXT REFERENCES users(id) ON DELETE SET NULL,
    verified_at                 INTEGER,
    expires_at                  INTEGER,
    verified_content_updated_at INTEGER,
    notified_state              TEXT NOT NULL DEFAULT 'none' CHECK (notified_state IN ('none', 'expiring', 'expired')),
    created_by                  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
  );
  CREATE INDEX page_verifications_expires ON page_verifications(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX page_verifications_verified_by ON page_verifications(verified_by) WHERE verified_by IS NOT NULL;

  CREATE TABLE page_verifiers (
    page_id TEXT NOT NULL REFERENCES page_verifications(page_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX page_verifiers_user ON page_verifiers(user_id);

  CREATE TABLE notifications_v27 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'page.updated', 'mention', 'verification.expiring', 'verification.expired')),
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  INSERT INTO notifications_v27 (id, user_id, type, page_id, actor_id, count, created_at, read_at)
    SELECT id, user_id, type, page_id, actor_id, count, created_at, read_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_v27 RENAME TO notifications;
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
  `,
  // 28 : accusé de lecture. `page_read_requests` : une demande par page (auteur de la demande, NULL si son compte est effacé).
  // `page_read_receipts` : accusés EXPLICITES (bouton « J'ai lu »), jamais un suivi d'ouverture ; date de l'accusé et date de
  // modification de la page à cet instant (pour signaler une page modifiée depuis). Un accusé n'existe pas sans demande :
  // supprimé avec la demande, donc avec la page (ON DELETE CASCADE), et avec le compte. Aucune purge automatique.
  // Retour arrière : DROP TABLE page_read_receipts; DROP TABLE page_read_requests;
  `
  CREATE TABLE page_read_requests (
    page_id      TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX page_read_requests_by ON page_read_requests(requested_by) WHERE requested_by IS NOT NULL;

  CREATE TABLE page_read_receipts (
    page_id         TEXT NOT NULL REFERENCES page_read_requests(page_id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acked_at        INTEGER NOT NULL,
    page_updated_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX page_read_receipts_user ON page_read_receipts(user_id);
  CREATE INDEX page_read_receipts_order ON page_read_receipts(page_id, acked_at DESC, user_id);
  `,
];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  // lower() de SQLite ne replie que l'ASCII : « Équipe » ne serait pas trouvé en tapant « équipe ». Pour les recherches de noms.
  db.function('lower_fr', { deterministic: true }, (v) => (typeof v === 'string' ? v.toLocaleLowerCase('fr') : v));
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`La base est au schéma v${current}, ce serveur ne connaît que v${MIGRATIONS.length} : mettez BeNote à jour, ou restaurez une sauvegarde compatible avec cette version.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// `aiChatDays` : conversations du chat IA sans activité depuis ce nombre de jours (toujours purgées, 90 jours par défaut).
export interface Retention { trashDays: number; notificationDays: number; auditIpDays: number; auditDays: number; aiChatDays?: number }
export const DEFAULT_RETENTION: Retention = { trashDays: 30, notificationDays: 90, auditIpDays: 90, auditDays: 365, aiChatDays: 90 };

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
  // Pas de « jamais » pour le chat : au moins un jour (les messages suivent par ON DELETE CASCADE).
  db.prepare('DELETE FROM ai_conversations WHERE updated_at < ?').run(before(Math.max(1, retention.aiChatDays ?? DEFAULT_RETENTION.aiChatDays!)));
  if (retention.trashDays > 0) {
    // Racines de corbeille seulement : leurs sous-pages suivent (ON DELETE CASCADE).
    const { changes } = db.prepare('DELETE FROM pages WHERE trash_root = id AND deleted_at < ?').run(before(retention.trashDays));
    if (changes) db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (?, NULL, ?, NULL, NULL, ?)').run(now, 'trash.purge', JSON.stringify({ count: changes }));
  }
}
