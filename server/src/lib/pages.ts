// Accès aux pages : arborescence, versions, corbeille, recherche plein texte.
// Toutes les requêtes sont préparées ; les contrôles d'accès se font dans les routes.
import type { DB } from '../db.js';
import { type DocNode, docText, emptyDoc, sanitizeDoc } from './content.js';
import { HttpError, newId } from './http.js';

const VERSION_WINDOW = 5 * 60_000;
const VERSION_MAX = 50;

export interface PageRow {
  seq: number;
  id: string;
  space_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string;
  content: string;
  text: string;
  full_width: number;
  version: number;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
  deleted_at: number | null;
  trash_root: string | null;
  updated_by_name?: string | null;
}

export const getPageRow = (db: DB, id: string) =>
  db.prepare(
    `SELECT p.*, u.name AS updated_by_name FROM pages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = ?`,
  ).get(id) as PageRow | undefined;

export function toMeta(row: PageRow, favorite = false) {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    position: row.position,
    title: row.title,
    icon: row.icon,
    fullWidth: !!row.full_width,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name ?? null,
    excerpt: row.text.slice(0, 200),
    deletedAt: row.deleted_at,
    trashRoot: row.trash_root,
    favorite,
  };
}

export const toPage = (row: PageRow, favorite = false) => ({
  ...toMeta(row, favorite),
  content: JSON.parse(row.content) as DocNode,
});

const favoritesOf = (db: DB, userId: string | null) =>
  new Set(userId ? (db.prepare('SELECT page_id FROM favorites WHERE user_id = ?').all(userId) as { page_id: string }[]).map((r) => r.page_id) : []);

export function listPages(db: DB, spaceIds: string[], userId: string | null, { trashed = false } = {}) {
  // Métadonnées seulement : ni le contenu JSON ni le texte complet ne sont lus (200 caractères d'extrait suffisent).
  const rows = db.prepare(
    `SELECT p.seq, p.id, p.space_id, p.parent_id, p.position, p.title, p.icon, '' AS content, substr(p.text, 1, 200) AS text,
            p.full_width, p.version, p.created_at, p.created_by, p.updated_at, p.updated_by, p.deleted_at, p.trash_root,
            u.name AS updated_by_name FROM pages p LEFT JOIN users u ON u.id = p.updated_by
     WHERE p.space_id IN (SELECT value FROM json_each(?)) AND ${trashed ? 'p.deleted_at IS NOT NULL AND p.trash_root = p.id' : 'p.deleted_at IS NULL'}
     ORDER BY p.space_id, p.parent_id, p.position, p.created_at`,
  ).all(JSON.stringify(spaceIds)) as PageRow[];
  const favs = favoritesOf(db, userId);
  return rows.map((r) => toMeta(r, favs.has(r.id)));
}

export const isFavorite = (db: DB, userId: string | null, pageId: string) =>
  !!userId && !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND page_id = ?').get(userId, pageId);

function siblings(db: DB, spaceId: string, parentId: string | null, excludeId?: string) {
  return (db.prepare(
    `SELECT id, position FROM pages WHERE space_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY position, created_at`,
  ).all(spaceId, parentId) as { id: string; position: number }[]).filter((s) => s.id !== excludeId);
}

function descendantIds(db: DB, id: string): string[] {
  return (db.prepare(
    `WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE parent_id = ? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id = t.id)
     SELECT id FROM tree`,
  ).all(id) as { id: string }[]).map((r) => r.id);
}

function assertParent(db: DB, spaceId: string, parentId: string | null, movingId?: string) {
  if (!parentId) return;
  const parent = getPageRow(db, parentId);
  if (!parent || parent.deleted_at) throw new HttpError(400, 'Page parente introuvable');
  if (parent.space_id !== spaceId) throw new HttpError(400, 'La page parente appartient à un autre espace');
  if (movingId && (parentId === movingId || descendantIds(db, movingId).includes(parentId))) {
    throw new HttpError(400, 'Impossible de déplacer une page dans l’une de ses sous-pages');
  }
}

function recordVersion(db: DB, row: PageRow, userId: string | null, force = false) {
  const now = Date.now();
  const last = db.prepare('SELECT id, created_by, session_start FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1')
    .get(row.id) as { id: number; created_by: string | null; session_start: number } | undefined;
  if (!force && last && last.created_by === userId && now - last.session_start < VERSION_WINDOW) {
    db.prepare('UPDATE page_versions SET title = ?, content = ?, created_at = ? WHERE id = ?').run(row.title, row.content, now, last.id);
  } else {
    db.prepare('INSERT INTO page_versions (page_id, title, content, created_at, created_by, session_start) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, row.content, now, userId, now);
    db.prepare(
      `DELETE FROM page_versions WHERE page_id = ? AND id NOT IN (SELECT id FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(row.id, row.id, VERSION_MAX);
  }
}

export interface CreatePageInput {
  spaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string;
  content?: unknown;
  afterId?: string | null;
}

export function createPage(db: DB, input: CreatePageInput, userId: string | null) {
  return db.transaction(() => {
    const parentId = input.parentId ?? null;
    assertParent(db, input.spaceId, parentId);
    const doc = input.content ? sanitizeDoc(input.content) : emptyDoc();
    const sibs = siblings(db, input.spaceId, parentId);
    let position = sibs.length ? sibs[sibs.length - 1].position + 1 : 0;
    const afterIdx = input.afterId ? sibs.findIndex((s) => s.id === input.afterId) : -1;
    if (afterIdx >= 0) {
      const shift = db.prepare('UPDATE pages SET position = ? WHERE id = ?');
      sibs.slice(afterIdx + 1).forEach((s, i) => shift.run(sibs[afterIdx].position + 2 + i, s.id));
      position = sibs[afterIdx].position + 1;
    }
    const now = Date.now();
    const id = newId();
    db.prepare(
      `INSERT INTO pages (id, space_id, parent_id, position, title, icon, content, text, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.spaceId, parentId, position, input.title ?? '', input.icon ?? '', JSON.stringify(doc), docText(doc), now, userId, now, userId);
    const row = getPageRow(db, id)!;
    recordVersion(db, row, userId, true);
    return row;
  })();
}

export interface UpdatePageInput {
  title?: string;
  icon?: string;
  content?: unknown;
  fullWidth?: boolean;
  baseVersion?: number;
}

export function updatePage(db: DB, id: string, input: UpdatePageInput, userId: string | null) {
  return db.transaction(() => {
    const current = getPageRow(db, id);
    if (!current || current.deleted_at) throw new HttpError(404, 'Page introuvable');
    if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
      throw new HttpError(409, 'La page a été modifiée entre-temps', {
        version: current.version,
        updatedAt: current.updated_at,
        updatedBy: current.updated_by_name ?? null,
      });
    }
    const next = { ...current };
    if (input.title !== undefined) next.title = input.title;
    if (input.icon !== undefined) next.icon = input.icon;
    if (input.fullWidth !== undefined) next.full_width = input.fullWidth ? 1 : 0;
    if (input.content !== undefined) {
      const doc = sanitizeDoc(input.content);
      next.content = JSON.stringify(doc);
      next.text = docText(doc);
    }
    const contentChanged = next.content !== current.content || next.title !== current.title;
    next.version = current.version + 1;
    next.updated_at = contentChanged ? Date.now() : current.updated_at;
    next.updated_by = contentChanged ? userId : current.updated_by;
    db.prepare(
      `UPDATE pages SET title = ?, icon = ?, content = ?, text = ?, full_width = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    ).run(next.title, next.icon, next.content, next.text, next.full_width, next.version, next.updated_at, next.updated_by, id);
    const row = getPageRow(db, id)!;
    if (contentChanged) recordVersion(db, row, userId);
    return row;
  })();
}

export function movePage(db: DB, id: string, input: { parentId: string | null; index?: number; spaceId?: string }) {
  return db.transaction(() => {
    const page = getPageRow(db, id);
    if (!page || page.deleted_at) throw new HttpError(404, 'Page introuvable');
    const spaceId = input.spaceId ?? (input.parentId ? getPageRow(db, input.parentId)?.space_id : page.space_id) ?? page.space_id;
    assertParent(db, spaceId, input.parentId, id);
    const sibs = siblings(db, spaceId, input.parentId, id);
    const index = Math.max(0, Math.min(input.index ?? sibs.length, sibs.length));
    sibs.splice(index, 0, { id, position: 0 });
    const setPos = db.prepare('UPDATE pages SET position = ? WHERE id = ?');
    sibs.forEach((s, i) => setPos.run(i, s.id));
    db.prepare('UPDATE pages SET parent_id = ?, version = version + 1 WHERE id = ?').run(input.parentId, id);
    if (spaceId !== page.space_id) {
      const ids = [id, ...descendantIds(db, id)];
      db.prepare('UPDATE pages SET space_id = ? WHERE id IN (SELECT value FROM json_each(?))').run(spaceId, JSON.stringify(ids));
    }
    return { row: getPageRow(db, id)!, fromSpaceId: page.space_id };
  })();
}

export function duplicatePage(db: DB, id: string, userId: string | null) {
  const src = getPageRow(db, id);
  if (!src || src.deleted_at) throw new HttpError(404, 'Page introuvable');
  return db.transaction(() => {
    const copy = createPage(db, {
      spaceId: src.space_id,
      parentId: src.parent_id,
      title: `${src.title || 'Sans titre'} (copie)`,
      icon: src.icon,
      content: JSON.parse(src.content),
      afterId: id,
    }, userId);
    // La copie reste aussi restreinte que la source : sinon dupliquer une page cachée la rendrait visible à tout le parent.
    db.prepare('INSERT INTO page_acl (page_id, user_id, level) SELECT ?, user_id, level FROM page_acl WHERE page_id = ?').run(copy.id, id);
    db.prepare('INSERT INTO page_acl_groups (page_id, group_id, level) SELECT ?, group_id, level FROM page_acl_groups WHERE page_id = ?').run(copy.id, id);
    db.prepare('INSERT INTO page_labels (page_id, name, created_at, created_by) SELECT ?, name, created_at, created_by FROM page_labels WHERE page_id = ?').run(copy.id, id);
    return copy;
  })();
}

export function trashPage(db: DB, id: string) {
  db.transaction(() => {
    const ids = [id, ...descendantIds(db, id)];
    db.prepare('UPDATE pages SET deleted_at = ?, trash_root = ? WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL')
      .run(Date.now(), id, JSON.stringify(ids));
  })();
}

export function restorePage(db: DB, id: string) {
  return db.transaction(() => {
    const root = getPageRow(db, id);
    if (!root || root.trash_root !== id) throw new HttpError(404, 'Page introuvable dans la corbeille');
    db.prepare('UPDATE pages SET deleted_at = NULL, trash_root = NULL WHERE trash_root = ?').run(id);
    const parent = root.parent_id ? getPageRow(db, root.parent_id) : null;
    const parentId = parent && !parent.deleted_at ? parent.id : null;
    const sibs = siblings(db, root.space_id, parentId, id);
    db.prepare('UPDATE pages SET parent_id = ?, position = ? WHERE id = ?')
      .run(parentId, sibs.length ? sibs[sibs.length - 1].position + 1 : 0, id);
    return getPageRow(db, id)!;
  })();
}

// Suppression définitive : uniquement depuis la corbeille. Les sous-pages suivent (ON DELETE CASCADE).
export function destroyPage(db: DB, id: string) {
  const root = getPageRow(db, id);
  if (!root || root.trash_root !== id) throw new HttpError(409, 'Seule une page de la corbeille peut être supprimée définitivement');
  db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  return root;
}

export function listVersions(db: DB, pageId: string) {
  return (db.prepare(
    `SELECT v.id, v.title, v.created_at, u.name AS author, length(v.content) AS size
     FROM page_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ? ORDER BY v.id DESC`,
  ).all(pageId) as { id: number; title: string; created_at: number; author: string | null; size: number }[])
    .map((v) => ({ id: v.id, title: v.title, createdAt: v.created_at, author: v.author, size: v.size }));
}

export function getVersion(db: DB, pageId: string, versionId: number) {
  const v = db.prepare(
    `SELECT v.id, v.title, v.content, v.created_at, u.name AS author FROM page_versions v
     LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ? AND v.id = ?`,
  ).get(pageId, versionId) as { id: number; title: string; content: string; created_at: number; author: string | null } | undefined;
  if (!v) throw new HttpError(404, 'Version introuvable');
  return { id: v.id, title: v.title, createdAt: v.created_at, author: v.author, content: JSON.parse(v.content) as DocNode };
}

// Convertit une saisie libre en requête FTS5 sûre : uniquement des termes entre guillemets.
export function ftsQuery(input: string, operator: 'AND' | 'OR' = 'AND', maxTerms = 10) {
  const terms = [...new Set((input.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase()))]
    .filter((t) => t.length >= (operator === 'OR' ? 3 : 1))
    .slice(0, maxTerms)
    .map((t) => `"${t.slice(0, 40)}"*`);
  return terms.length ? terms.join(` ${operator} `) : null;
}

export function searchPages(db: DB, query: string, spaceIds: string[], limit = 20, operator: 'AND' | 'OR' = 'AND', label: string | null = null) {
  const match = ftsQuery(query, operator);
  if (!match) return [];
  return db.prepare(
    `SELECT p.id, p.space_id AS spaceId, p.parent_id AS parentId, p.title, p.icon, p.updated_at AS updatedAt, p.text,
            snippet(pages_fts, 1, char(2), char(3), '…', 20) AS snippet, bm25(pages_fts, 8.0, 1.0) AS rank
     FROM pages_fts JOIN pages p ON p.seq = pages_fts.rowid
     WHERE pages_fts MATCH ? AND p.deleted_at IS NULL AND p.space_id IN (SELECT value FROM json_each(?))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM page_labels l WHERE l.page_id = p.id AND l.name = ?))
     ORDER BY rank LIMIT ?`,
  ).all(match, JSON.stringify(spaceIds), label, label, limit) as {
    id: string; spaceId: string; parentId: string | null; title: string; icon: string; updatedAt: number; text: string; snippet: string; rank: number;
  }[];
}
