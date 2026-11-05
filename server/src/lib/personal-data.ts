// Données personnelles d'un compte : export (droit d'accès et de portabilité) et effacement par anonymisation.
// L'export n'inclut jamais de secret (hash de mot de passe, secret TOTP, hash de jeton ou de session) ni de page
// que la personne ne peut plus lire. Les pièces jointes qu'elle a envoyées y figurent (métadonnées dans le JSON, fichiers
// dans l'archive tar), sous la même règle : seulement celles des pages qu'elle peut encore lire.
import { createReadStream, statSync } from 'node:fs';
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { parseSources, readableSources } from '../ai/chat.js';
import { attachmentPath, sanitizeFilename } from './attachments.js';
import { zipEntryName, zipStream, type ZipEntry } from './zip.js';
import { filterReadable, keepPagesClosed, pagesOnlyOpenTo } from './page-acl.js';
import { inPersonalSpace } from './personal-spaces.js';

interface UserRow {
  id: string; sub: string; email: string | null; name: string; role: 'admin' | 'editor' | 'reader';
  created_at: number; last_login_at: number | null; disabled: number; totp_enabled: number; is_local: number;
}

// `requesterId` : qui demande l'export. Si ce n'est pas la personne concernée (un administrateur répondant à une demande d'accès),
// rien de son espace personnel n'est inclus : titres, commentaires et notifications de ses pages personnelles restent à elle.
export function exportUserData(db: DB, userId: string, requesterId: string = userId) {
  const u = db.prepare(
    `SELECT id, sub, email, name, role, created_at, last_login_at, disabled, totp_enabled, (password_hash IS NOT NULL) AS is_local FROM users WHERE id = ?`,
  ).get(userId) as UserRow | undefined;
  if (!u) return null;
  const subject: Auth = { user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set(['read']) };
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

  const titled = filterReadable(db, subject, all<{ id: string; title: string; at: number }>(
    'SELECT id, title, created_at AS at FROM pages WHERE created_by = ? AND deleted_at IS NULL ORDER BY created_at', userId));
  const hidden = (pageId: string) => requesterId !== userId && inPersonalSpace(db, pageId);
  const uploads = filterReadable(db, subject, all<{ id: string; att: string; name: string; mime: string; size: number; sha256: string; created_at: number }>(
    `SELECT a.page_id AS id, a.id AS att, a.name, a.mime, a.size, a.sha256, a.created_at FROM attachments a JOIN pages p ON p.id = a.page_id
     WHERE a.uploader_id = ? AND p.deleted_at IS NULL ORDER BY a.created_at, a.rowid`, userId)).filter((a) => !hidden(a.id));
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
    groups: all<{ name: string; source: string }>("SELECT g.name, g.source FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name", userId),
    spaceMemberships: all<{ name: string; role: string }>('SELECT s.name, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = ? ORDER BY s.name', userId),
    notificationPreferences: { emailComments: prefs ? !!prefs.c : true, emailChanges: prefs ? !!prefs.g : false },
    favorites: filterReadable(db, subject, all<{ id: string; title: string }>(
      'SELECT p.id, p.title FROM favorites f JOIN pages p ON p.id = f.page_id WHERE f.user_id = ? AND p.deleted_at IS NULL', userId)).filter((p) => !hidden(p.id)),
    watchedPages: filterReadable(db, subject, all<{ id: string; title: string }>(
      'SELECT p.id, p.title FROM page_watch w JOIN pages p ON p.id = w.page_id WHERE w.user_id = ? AND p.deleted_at IS NULL', userId)).filter((p) => !hidden(p.id)),
    pagesCreated: titled.filter((p) => !hidden(p.id)).map((p) => ({ id: p.id, title: p.title, createdAt: p.at })),
    contributions: {
      pagesEdited: one<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE updated_by = ?', userId).n,
      versionsAuthored: one<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE created_by = ?', userId).n,
      // Toutes ses pièces jointes, y compris sur des pages devenues illisibles pour elle (non détaillées ci-dessous).
      attachmentsUploaded: one<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE uploader_id = ?', userId).n,
    },
    // `file` : chemin du fichier dans l'archive de l'export (route …/export/archive).
    attachments: uploads.map((a) => ({
      id: a.att, pageId: a.id, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, createdAt: a.created_at, file: archiveName(a.att, a.name),
    })),
    comments: all<{ id: string; page_id: string; body: string; created_at: number }>(
      'SELECT id, page_id, body, created_at FROM page_comments WHERE author_id = ? AND deleted_at IS NULL ORDER BY created_at', userId)
      .filter((c) => !hidden(c.page_id)).map((c) => ({ id: c.id, pageId: c.page_id, body: c.body, createdAt: c.created_at })),
    notifications: all<{ type: string; page_id: string; created_at: number; read_at: number | null }>(
      'SELECT type, page_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', userId)
      .filter((n) => !hidden(n.page_id)).map((n) => ({ type: n.type, pageId: n.page_id, createdAt: n.created_at, readAt: n.read_at })),
    // Rapports d'import (20 au plus, supprimés avec le compte) : bilan seulement ; le détail se relit par /api/v3/imports/:id.
    importReports: all<{ id: string; space_id: string; source: string; dry_run: number; created_at: number; summary: string }>(
      'SELECT id, space_id, source, dry_run, created_at, summary FROM import_reports WHERE user_id = ? ORDER BY created_at DESC', userId)
      .map((r) => ({ id: r.id, spaceId: r.space_id, source: r.source, dryRun: !!r.dry_run, createdAt: r.created_at, summary: JSON.parse(r.summary) as unknown })),
    aiConversations: aiConversations(db, subject, requesterId === userId),
    auditTrail: all<{ at: number; action: string; ip: string | null }>('SELECT at, action, ip FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1000', userId),
  };
}

export type PersonalData = NonNullable<ReturnType<typeof exportUserData>>;

// Conversations du chat IA. Pour la personne elle-même : titres et messages complets, sources limitées aux pages qu'elle lit
// encore. Pour un administrateur qui répond à une demande d'accès : dates et nombre de messages seulement, car les messages
// peuvent reprendre le contenu de pages qu'il ne lit pas (espace personnel, pages restreintes).
function aiConversations(db: DB, subject: Auth, self: boolean) {
  const convs = db.prepare('SELECT id, title, page_id, created_at, updated_at FROM ai_conversations WHERE user_id = ? ORDER BY created_at, rowid')
    .all(subject.user.id) as { id: string; title: string; page_id: string | null; created_at: number; updated_at: number }[];
  const messages = db.prepare('SELECT role, content, sources, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY seq');
  return convs.map((c) => {
    const rows = messages.all(c.id) as { role: string; content: string; sources: string | null; created_at: number }[];
    if (!self) return { id: c.id, createdAt: c.created_at, updatedAt: c.updated_at, messageCount: rows.length };
    return {
      id: c.id, title: c.title, pageId: c.page_id, createdAt: c.created_at, updatedAt: c.updated_at,
      messages: rows.map((m) => ({
        role: m.role, content: m.content, createdAt: m.created_at,
        ...(m.role === 'assistant' ? { sources: readableSources(db, subject, parseSources(m.sources)).map((s) => ({ n: s.n, id: s.id, title: s.title })) } : {}),
      })),
    };
  });
}

// Nom d'un fichier dans l'archive : identifiant (unique) puis nom d'origine réduit à l'ASCII sûr, pour rester sous 100 octets.
// Nom de l'entrée : dossier fixe, identifiant (unique) puis nom d'origine assaini, sans chemin ; déjà sous la forme que garde l'archive.
function archiveName(id: string, name: string): string {
  return zipEntryName(`pieces-jointes/${id}-${sanitizeFilename(name)}`);
}
// Déjà compressés : stockés tels quels dans l'archive.
const STORED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/zip', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg']);

/**
 * Archive ZIP de l'export : `donnees.json` puis les fichiers des pièces jointes. Un fichier absent du disque, ou dont la taille
 * ne correspond plus, est signalé dans le JSON (`included: false`) au lieu d'être joint.
 */
export function personalDataArchive(data: PersonalData, filesDir: string): AsyncGenerator<Buffer> {
  const files = data.attachments.map((a) => {
    const path = attachmentPath(filesDir, a.id);
    let included = false;
    try { included = statSync(path).size === a.size; } catch { /* absent du disque */ }
    return { a, path, included };
  });
  const json = Buffer.from(JSON.stringify({ ...data, attachments: files.map(({ a, included }) => ({ ...a, included })) }, null, 2));
  const entries: ZipEntry[] = [
    { name: 'donnees.json', size: json.length, mtime: Date.now(), body: () => json },
    ...files.filter((f) => f.included).map((f) => ({ name: f.a.file, size: f.a.size, mtime: f.a.createdAt, store: STORED.has(f.a.mime), body: () => createReadStream(f.path) })),
  ];
  return zipStream(entries);
}

// Effacement : le compte et ce qui lui est propre disparaissent ; ce qu'il a écrit reste mais sans auteur.
// Pièces jointes : les fichiers restent rattachés à leur page (ils font partie du contenu, comme le texte), l'envoyeur est
// retiré. Elles ne comptent alors plus dans aucun quota personnel, toujours dans le plafond de l'instance.
// (Les clés étrangères en cascade retirent sessions, jetons, favoris, suivis, notifications, permissions, préférences et conversations du chat IA.)
export function eraseUser(db: DB, userId: string, closedBy: string | null = null): boolean {
  return db.transaction(() => {
    const u = db.prepare('SELECT sub FROM users WHERE id = ?').get(userId) as { sub: string } | undefined;
    if (!u) return false;
    // Une page réservée à cette seule personne reste fermée (entrée de l'administrateur qui efface) au lieu de s'ouvrir à l'espace.
    if (closedBy) keepPagesClosed(db, pagesOnlyOpenTo(db, { userId }), closedBy);
    db.prepare('UPDATE pages SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE pages SET updated_by = NULL WHERE updated_by = ?').run(userId);
    db.prepare('UPDATE page_versions SET created_by = NULL WHERE created_by = ?').run(userId);
    // Déjà fait par la clé étrangère (ON DELETE SET NULL) : écrit ici pour que la règle ne dépende pas du schéma.
    db.prepare('UPDATE attachments SET uploader_id = NULL WHERE uploader_id = ?').run(userId);
    db.prepare('UPDATE settings SET updated_by = NULL WHERE updated_by = ?').run(userId);
    // Conversations du chat IA (et leurs messages) : déjà retirées par la cascade, écrit ici pour la même raison.
    db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(userId);
    // Le journal garde la trace des actions, sans la personne ni son adresse IP.
    db.prepare('UPDATE audit_log SET user_id = NULL, ip = NULL WHERE user_id = ?').run(userId);
    // Les connexions sont journalisées avant que l'identité soit posée sur la requête : la personne n'y figure que comme cible.
    db.prepare('UPDATE audit_log SET target = NULL, meta = NULL, ip = NULL WHERE target IN (?, ?)').run(userId, u.sub);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return true;
  })();
}
