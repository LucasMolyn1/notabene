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
  // 29 : provisionnement SCIM 2.0 (routes/scim.ts). `scim_tokens` : jetons dédiés du fournisseur d'identité (hachés, révocables,
  // sans lien avec les jetons d'API). `scim_users` : comptes gérés par SCIM (nom d'utilisateur SCIM, identifiant externe) ; le
  // compte lui-même reste dans `users`. `scim_groups` : groupes gérés par SCIM (provenance), stockés dans `groups` avec la source
  // `local` : la contrainte CHECK de `groups` n'est pas modifiée, ce qui évite de reconstruire une table référencée.
  // Aucune donnée existante modifiée. Retour arrière : DROP TABLE scim_groups; DROP TABLE scim_users; DROP TABLE scim_tokens;
  `
  CREATE TABLE scim_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );

  -- disabled_by_scim : le compte a été désactivé par SCIM (seul cas où SCIM peut le réactiver). deleted_at : supprimé par SCIM
  -- (compte désactivé, ressource invisible) ; la ligne est gardée pour qu'un nouveau provisionnement sache qui l'a désactivé.
  CREATE TABLE scim_users (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    user_name        TEXT NOT NULL COLLATE NOCASE,
    external_id      TEXT,
    disabled_by_scim INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    deleted_at       INTEGER
  );
  CREATE UNIQUE INDEX scim_users_name ON scim_users(user_name) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX scim_users_external ON scim_users(external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE scim_groups (
    group_id    TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    external_id TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX scim_groups_external ON scim_groups(external_id) WHERE external_id IS NOT NULL;
  `,
  // 30 : blocs synchronisés (lib/synced-blocks.ts). Index des sources : un identifiant de bloc désigne au plus une page, celle qui
  // l'a enregistré en premier. `removed_at` : source retirée du contenu de sa page (l'identifiant reste réservé à cette page, une
  // annulation le retrouve). `page_id` NULL : page supprimée définitivement ; l'identifiant reste réservé et ne désigne plus rien.
  // `space_id` : espace de la page, tenu à jour au déplacement (information ; les droits sont toujours lus sur la page).
  // Aucune donnée personnelle ni contenu. Aucune donnée existante modifiée (aucun bloc synchronisé ne pouvait exister avant).
  // Retour arrière : DROP TABLE synced_blocks;
  `
  CREATE TABLE synced_blocks (
    block_id   TEXT PRIMARY KEY,
    page_id    TEXT REFERENCES pages(id) ON DELETE SET NULL,
    space_id   TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE INDEX synced_blocks_page ON synced_blocks(page_id) WHERE page_id IS NOT NULL;
  `,
  // v31 : le journal d'audit retient le jeton d'API qui a agi (identifiant et nom donné par la personne), en plus du compte.
  // Additive ; retour arrière : les colonnes sont simplement ignorées par une version antérieure.
  `
  ALTER TABLE audit_log ADD COLUMN token_id TEXT;
  ALTER TABLE audit_log ADD COLUMN token_name TEXT;
  `,
  // v32 : relations, cumuls, sous-éléments, dépendances et réglages de base (lib/base-links.ts, lib/base-project.ts).
  // - base_properties est refaite (SQLite ne modifie pas un CHECK) pour accepter `relation` et `rollup`, avec `config` (JSON validé
  //   par le serveur : jamais de JSON libre). Une relation ne garde que des identifiants de lignes ; les droits sont relus à chaque lecture.
  // - base_rows.parent_id : sous-élément d'une ligne de la même base (profondeur et cycles vérifiés par le serveur).
  // - base_row_deps : « bloqué par », entre lignes de la même base.
  // - base_settings : options de la base (sous-éléments, dépendances, colonnes de début et de fin).
  // Aucune donnée existante modifiée. Retour arrière : restaurer la sauvegarde prise avant la mise à jour (le serveur précédent
  // refuse un schéma plus récent que le sien).
  `
  CREATE TABLE base_properties_v32 (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'formula', 'relation', 'rollup')),
    options    TEXT NOT NULL DEFAULT '[]',
    position   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    formula    TEXT,
    config     TEXT NOT NULL DEFAULT '{}',
    CHECK ((type = 'formula') = (formula IS NOT NULL))
  );
  INSERT INTO base_properties_v32 (id, base_id, name, type, options, position, created_at, formula)
    SELECT id, base_id, name, type, options, position, created_at, formula FROM base_properties;
  DROP TABLE base_properties;
  ALTER TABLE base_properties_v32 RENAME TO base_properties;
  CREATE INDEX base_properties_base ON base_properties(base_id, position);
  CREATE INDEX base_properties_relation ON base_properties(json_extract(config, '$.targetId')) WHERE type = 'relation';

  ALTER TABLE base_rows ADD COLUMN parent_id TEXT REFERENCES base_rows(id) ON DELETE CASCADE;
  CREATE INDEX base_rows_parent ON base_rows(parent_id) WHERE parent_id IS NOT NULL;

  CREATE TABLE base_row_deps (
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    row_id     TEXT NOT NULL REFERENCES base_rows(id) ON DELETE CASCADE,
    blocker_id TEXT NOT NULL REFERENCES base_rows(id) ON DELETE CASCADE,
    PRIMARY KEY (row_id, blocker_id),
    CHECK (row_id != blocker_id)
  ) WITHOUT ROWID;
  CREATE INDEX base_row_deps_base ON base_row_deps(base_id);
  CREATE INDEX base_row_deps_blocker ON base_row_deps(blocker_id);

  CREATE TABLE base_settings (
    base_id           TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    subitems          INTEGER NOT NULL DEFAULT 0 CHECK (subitems IN (0, 1)),
    dependencies      INTEGER NOT NULL DEFAULT 0 CHECK (dependencies IN (0, 1)),
    start_property_id TEXT REFERENCES base_properties(id) ON DELETE SET NULL,
    end_property_id   TEXT REFERENCES base_properties(id) ON DELETE SET NULL
  );
  `,
  // v33 : flux iCalendar en lecture d'une base, par adresse secrète (lib/base-ical.ts). Seule l'empreinte SHA-256 du jeton est
  // gardée (le jeton n'est montré qu'une fois). `restricted_key` : empreinte de la restriction de la base à la création ; le flux
  // n'est servi que tant qu'elle est identique. Le flux suit la base (ON DELETE CASCADE) et disparaît à sa mise à la corbeille.
  // Additive. Retour arrière : DROP TABLE base_ical_feeds (ses déclencheurs suivent ; aucune autre donnée touchée), ou restaurer la sauvegarde.
  `
  CREATE TABLE base_ical_feeds (
    base_id        TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    token_hash     TEXT NOT NULL UNIQUE,
    restricted_key TEXT,
    created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL
  );
  -- Un compte désactivé ou supprimé ne laisse aucun flux ouvert derrière lui (toutes les voies : administration, SCIM, annuaire).
  CREATE TRIGGER base_ical_feeds_user_disabled AFTER UPDATE OF disabled ON users WHEN NEW.disabled = 1 AND OLD.disabled = 0
    BEGIN DELETE FROM base_ical_feeds WHERE created_by = NEW.id; END;
  CREATE TRIGGER base_ical_feeds_user_deleted BEFORE DELETE ON users
    BEGIN DELETE FROM base_ical_feeds WHERE created_by = OLD.id; END;
  `,
  // v34 : nouveaux types de colonnes (url, email, phone, created_time, updated_time, created_by, updated_by, unique_id, date_range)
  // et modèles de ligne (lib/base-templates.ts).
  // - base_properties est refaite comme en v32 (SQLite ne modifie pas un CHECK). Supprimer l'ancienne table déclencherait le
  //   ON DELETE SET NULL de base_settings : les colonnes de début et de fin sont mises de côté puis remises.
  // - base_row_templates : valeurs de cellules validées par type, jamais de colonne calculée ni de relation.
  // - base_settings.unique_id_next : compteur des ID uniques de la base.
  // Aucune donnée existante modifiée. Retour arrière : restaurer la sauvegarde prise avant la mise à jour (le serveur précédent
  // refuse un schéma plus récent que le sien).
  `
  CREATE TEMP TABLE base_settings_v34 AS SELECT base_id, start_property_id, end_property_id FROM base_settings;
  CREATE TABLE base_properties_v34 (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'formula', 'relation', 'rollup',
                                             'url', 'email', 'phone', 'created_time', 'updated_time', 'created_by', 'updated_by', 'unique_id', 'date_range')),
    options    TEXT NOT NULL DEFAULT '[]',
    position   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    formula    TEXT,
    config     TEXT NOT NULL DEFAULT '{}',
    CHECK ((type = 'formula') = (formula IS NOT NULL))
  );
  INSERT INTO base_properties_v34 (id, base_id, name, type, options, position, created_at, formula, config)
    SELECT id, base_id, name, type, options, position, created_at, formula, config FROM base_properties;
  DROP TABLE base_properties;
  ALTER TABLE base_properties_v34 RENAME TO base_properties;
  CREATE INDEX base_properties_base ON base_properties(base_id, position);
  CREATE INDEX base_properties_relation ON base_properties(json_extract(config, '$.targetId')) WHERE type = 'relation';
  -- Une seule colonne « ID unique » par base.
  CREATE UNIQUE INDEX base_properties_unique_id ON base_properties(base_id) WHERE type = 'unique_id';
  UPDATE base_settings SET
    start_property_id = (SELECT b.start_property_id FROM base_settings_v34 b WHERE b.base_id = base_settings.base_id),
    end_property_id = (SELECT b.end_property_id FROM base_settings_v34 b WHERE b.base_id = base_settings.base_id);
  DROP TABLE base_settings_v34;

  -- Compteur des ID uniques au niveau de la base : il survit à la suppression de la colonne (jamais de numéro réutilisé).
  ALTER TABLE base_settings ADD COLUMN unique_id_next INTEGER NOT NULL DEFAULT 1 CHECK (unique_id_next >= 1);

  CREATE TABLE base_row_templates (
    id         TEXT PRIMARY KEY,
    base_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    vals       TEXT NOT NULL DEFAULT '{}',
    position   REAL NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX base_row_templates_base ON base_row_templates(base_id, position);
  `,
  // v35 : automatisations et boutons de ligne des bases (lib/base-automations.ts).
  // - base_automations : déclencheur et actions en JSON validé par le serveur (identifiants et opérateurs fermés, jamais
  //   d'expression libre) ; adresse et secret du webhook chiffrés (SecretBox), jamais rendus en clair ; `author_id` : personne
  //   dont les droits sont revérifiés à chaque exécution ; `status` : état posé par le serveur (coupe-circuit, droits, colonne
  //   disparue) ; fenêtres de comptage pour le coupe-circuit de fréquence. Suit la base (ON DELETE CASCADE).
  // - base_automation_runs : historique borné des exécutions (codes fermés, nombre de lignes ; jamais de contenu de ligne).
  // - notifications refaite (SQLite ne modifie pas un CHECK) pour accepter le type `automation`, avec `emailed_at` (dernier
  //   e-mail envoyé pour cette notification : plafond d'un e-mail d'automatisation par personne, par base et par heure).
  // Additive (aucune donnée existante modifiée, aucun accès nouveau). Retour arrière : DROP TABLE base_automation_runs;
  // DROP TABLE base_automations (ses déclencheurs suivent) ; DELETE FROM notifications WHERE type = 'automation' puis refaire
  // `notifications` avec la contrainte v27, ou restaurer la sauvegarde prise avant la mise à jour.
  `
  CREATE TABLE base_automations (
    id             TEXT PRIMARY KEY,
    base_id        TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('row_added', 'property_changed', 'recurrence', 'button')),
    trigger        TEXT NOT NULL,
    actions        TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'suspended', 'broken')),
    status_reason  TEXT CHECK (status_reason IS NULL OR status_reason IN ('errors', 'frequency', 'author', 'access', 'config')),
    author_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    webhook_url    TEXT,
    webhook_secret TEXT,
    failures       INTEGER NOT NULL DEFAULT 0,
    minute_start   INTEGER NOT NULL DEFAULT 0,
    minute_runs    INTEGER NOT NULL DEFAULT 0,
    hour_start     INTEGER NOT NULL DEFAULT 0,
    hour_runs      INTEGER NOT NULL DEFAULT 0,
    next_run_at    INTEGER,
    last_run_at    INTEGER,
    position       REAL NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX base_automations_base ON base_automations(base_id, position);
  CREATE INDEX base_automations_due ON base_automations(next_run_at) WHERE kind = 'recurrence' AND enabled = 1 AND status = 'active';
  CREATE INDEX base_automations_author ON base_automations(author_id) WHERE author_id IS NOT NULL;
  -- Auteur désactivé ou supprimé : ses automatisations (hors boutons, qui agissent avec les droits de la personne qui clique)
  -- sont suspendues aussitôt, par toutes les voies (administration, SCIM, annuaire). L'exécution le revérifie de toute façon.
  CREATE TRIGGER base_automations_user_disabled AFTER UPDATE OF disabled ON users WHEN NEW.disabled = 1 AND OLD.disabled = 0
    BEGIN UPDATE base_automations SET status = 'suspended', status_reason = 'author' WHERE author_id = NEW.id AND kind != 'button'; END;
  CREATE TRIGGER base_automations_user_deleted BEFORE DELETE ON users
    BEGIN UPDATE base_automations SET status = 'suspended', status_reason = 'author' WHERE author_id = OLD.id AND kind != 'button'; END;

  CREATE TABLE base_automation_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_id TEXT NOT NULL REFERENCES base_automations(id) ON DELETE CASCADE,
    base_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    at            INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    code          TEXT NOT NULL,
    rows          INTEGER NOT NULL DEFAULT 0,
    actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX base_automation_runs_automation ON base_automation_runs(automation_id, id);
  CREATE INDEX base_automation_runs_base ON base_automation_runs(base_id, at);
  CREATE INDEX base_automation_runs_actor ON base_automation_runs(actor_id) WHERE actor_id IS NOT NULL;

  CREATE TABLE notifications_v35 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'page.updated', 'mention', 'verification.expiring', 'verification.expired', 'automation')),
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    read_at    INTEGER,
    emailed_at INTEGER
  );
  INSERT INTO notifications_v35 (id, user_id, type, page_id, actor_id, count, created_at, read_at)
    SELECT id, user_id, type, page_id, actor_id, count, created_at, read_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_v35 RENAME TO notifications;
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
  `,
  // v36 : formulaires des bases (lib/base-forms.ts).
  // - spaces.forms_enabled : formulaires permis dans l'espace, désactivé par défaut (réglage d'administrateur ; toujours 0 pour
  //   un espace personnel).
  // - base_forms : configuration d'un formulaire (questions en JSON validé par le serveur : colonne, libellé, obligatoire),
  //   mode `accounts` (par défaut) ou `anonymous` ; `token_hash` : empreinte SHA-256 du jeton du lien public (jamais le jeton),
  //   NULL = aucun lien, révoqué si le compte qui l'a créé (`link_by`) est désactivé ou supprimé ; `restricted_key` : restriction de la base confirmée ; `author_id` : dernière personne qui a configuré
  //   le formulaire (destinataire de la notification facultative) ; fenêtre horaire pour le plafond de réponses. Suit la base.
  // - notifications refaite (SQLite ne modifie pas un CHECK) pour accepter le type `form` ; l'auteur des notifications
  //   d'automatisation est effacé (il n'est plus enregistré pour les types `automation` et `form`).
  // Additive : aucune donnée existante modifiée, aucun accès nouveau (tout est désactivé). Retour arrière : DROP TABLE base_forms ;
  // ALTER TABLE spaces DROP COLUMN forms_enabled ; DELETE FROM notifications WHERE type = 'form' puis refaire `notifications`
  // avec la contrainte v35, ou restaurer la sauvegarde prise avant la mise à jour.
  `
  ALTER TABLE spaces ADD COLUMN forms_enabled INTEGER NOT NULL DEFAULT 0 CHECK (forms_enabled IN (0, 1));

  CREATE TABLE base_forms (
    id                 TEXT PRIMARY KEY,
    base_id            TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    thanks             TEXT NOT NULL DEFAULT '',
    questions          TEXT NOT NULL,
    mode               TEXT NOT NULL DEFAULT 'accounts' CHECK (mode IN ('accounts', 'anonymous')),
    notify             INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
    token_hash         TEXT,
    link_created_at    INTEGER,
    link_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
    restricted_key     TEXT,
    author_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
    hour_start         INTEGER NOT NULL DEFAULT 0,
    hour_count         INTEGER NOT NULL DEFAULT 0,
    responses          INTEGER NOT NULL DEFAULT 0,
    last_response_at   INTEGER,
    position           REAL NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX base_forms_base ON base_forms(base_id, position);
  CREATE UNIQUE INDEX base_forms_token ON base_forms(token_hash) WHERE token_hash IS NOT NULL;
  CREATE INDEX base_forms_author ON base_forms(author_id) WHERE author_id IS NOT NULL;
  CREATE INDEX base_forms_link_by ON base_forms(link_by) WHERE link_by IS NOT NULL;
  -- Compte qui a créé (ou renouvelé) le lien désactivé ou supprimé : le lien est révoqué aussitôt, par toutes les voies
  -- (administration, SCIM, annuaire), comme un flux iCalendar. La configuration reste.
  CREATE TRIGGER base_forms_user_disabled AFTER UPDATE OF disabled ON users WHEN NEW.disabled = 1 AND OLD.disabled = 0
    BEGIN UPDATE base_forms SET token_hash = NULL, link_created_at = NULL WHERE link_by = NEW.id; END;
  CREATE TRIGGER base_forms_user_deleted BEFORE DELETE ON users
    BEGIN UPDATE base_forms SET token_hash = NULL, link_created_at = NULL WHERE link_by = OLD.id; END;

  CREATE TABLE notifications_v36 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'page.updated', 'mention', 'verification.expiring', 'verification.expired', 'automation', 'form')),
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    read_at    INTEGER,
    emailed_at INTEGER
  );
  INSERT INTO notifications_v36 (id, user_id, type, page_id, actor_id, count, created_at, read_at, emailed_at)
    SELECT id, user_id, type, page_id, CASE WHEN type = 'automation' THEN NULL ELSE actor_id END, count, created_at, read_at, emailed_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_v36 RENAME TO notifications;
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
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
