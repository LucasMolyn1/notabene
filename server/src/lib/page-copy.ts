// Copie d'une page et de ses sous-pages vers un autre espace (ou un autre endroit), l'original restant en place.
// Règles de sécurité : on ne copie que ce que la personne peut LIRE (une sous-page qui lui est cachée, et tout ce qui est
// dessous, est laissée de côté) ; la copie reste aussi restreinte que la source (sinon copier vers un autre espace
// rendrait visible à tous une page réservée) ; les mentions déjà notifiées ne le sont pas de nouveau.
import type { DB } from '../db.js';
import { type DocNode } from './content.js';
import { copyBaseData } from './bases.js';
import { HttpError } from './http.js';
import { entriesOf, governingPage } from './page-acl.js';
import { createPage, getPageRow, type PageRow } from './pages.js';

export const MAX_COPY_PAGES = 500;

/** Retire les ancres de commentaires : les fils de la source ne suivent pas la copie. */
export function stripCommentAnchors(node: DocNode): DocNode {
  const out: DocNode = { ...node };
  if (node.marks) {
    const marks = node.marks.filter((m) => m.type !== 'commentAnchor');
    if (marks.length) out.marks = marks; else delete out.marks;
  }
  if (node.content) out.content = node.content.map(stripCommentAnchors);
  return out;
}

export function copyTree(
  db: DB,
  sourceId: string,
  target: { spaceId: string; parentId: string | null },
  userId: string | null,
  canRead: (pageId: string) => boolean,
): { root: PageRow; count: number; skipped: number } {
  // Arbre à copier, dans l'ordre d'affichage ; les pages illisibles sont écartées avec leurs descendantes.
  const plan: { src: PageRow; parent: number | null }[] = [];
  let skipped = 0;
  const children = db.prepare('SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, created_at');
  const visit = (id: string, parent: number | null) => {
    const row = getPageRow(db, id);
    if (!row || row.deleted_at) return;
    if (plan.length >= MAX_COPY_PAGES) throw new HttpError(413, `Trop de pages à copier (au plus ${MAX_COPY_PAGES})`);
    const index = plan.push({ src: row, parent }) - 1;
    for (const c of children.all(id) as { id: string }[]) {
      if (canRead(c.id)) visit(c.id, index); else skipped++;
    }
  };
  visit(sourceId, null);

  return db.transaction(() => {
    const created: PageRow[] = [];
    for (const { src, parent } of plan) {
      const copy = createPage(db, {
        spaceId: target.spaceId,
        parentId: parent === null ? target.parentId : created[parent]!.id,
        title: src.title,
        icon: src.icon,
        content: stripCommentAnchors(JSON.parse(src.content) as DocNode),
        kind: src.kind,
      }, userId);
      if (src.kind === 'base') copyBaseData(db, src.id, copy.id, userId);
      created.push(copy);
      db.prepare('INSERT INTO page_acl (page_id, user_id, level) SELECT ?, user_id, level FROM page_acl WHERE page_id = ?').run(copy.id, src.id);
      db.prepare('INSERT INTO page_acl_groups (page_id, group_id, level) SELECT ?, group_id, level FROM page_acl_groups WHERE page_id = ?').run(copy.id, src.id);
      db.prepare('INSERT INTO page_labels (page_id, name, created_at, created_by) SELECT ?, name, created_at, created_by FROM page_labels WHERE page_id = ?').run(copy.id, src.id);
      db.prepare('INSERT INTO page_mentions (page_id, user_id, notified_at) SELECT ?, user_id, notified_at FROM page_mentions WHERE page_id = ?').run(copy.id, src.id);
    }
    // Une source restreinte par un ancêtre : la racine copiée porte la même liste, sinon elle serait lisible de tout l'espace d'arrivée.
    const gov = governingPage(db, sourceId);
    if (gov && gov !== sourceId) {
      const insert = db.prepare('INSERT OR IGNORE INTO page_acl (page_id, user_id, level) VALUES (?, ?, ?)');
      const insertGroup = db.prepare('INSERT OR IGNORE INTO page_acl_groups (page_id, group_id, level) VALUES (?, ?, ?)');
      for (const e of entriesOf(db, gov)) {
        if (e.userId) insert.run(created[0]!.id, e.userId, e.level);
        else if (e.groupId) insertGroup.run(created[0]!.id, e.groupId, e.level);
      }
    }
    return { root: getPageRow(db, created[0]!.id)!, count: created.length, skipped };
  })();
}
