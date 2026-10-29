// Permissions fines par page. Sans entrée, le comportement reste celui des espaces (aucune restriction).
// Dès qu'une page a des entrées, elle et ses descendants sont restreints à ces utilisateurs (la page
// restreinte la plus proche gouverne). Les administrateurs voient et modifient tout.
// Le niveau ACL ne fait que RESTREINDRE : il ne dépasse jamais le rôle ni la portée du jeton.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';

export type Level = 'none' | 'read' | 'write';
export type AclEntry = { userId: string; level: 'read' | 'write' };

export const hasAnyAcl = (db: DB) => !!db.prepare('SELECT 1 FROM page_acl LIMIT 1').get();

// Page qui gouverne `pageId` : elle-même ou son plus proche ancêtre ayant des entrées.
export function governingPage(db: DB, pageId: string): string | null {
  const row = db.prepare(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 100)
     SELECT up.id FROM up WHERE EXISTS (SELECT 1 FROM page_acl a WHERE a.page_id = up.id) ORDER BY up.depth LIMIT 1`,
  ).get(pageId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function entriesOf(db: DB, pageId: string): AclEntry[] {
  return (db.prepare('SELECT user_id AS userId, level FROM page_acl WHERE page_id = ? ORDER BY user_id').all(pageId)) as AclEntry[];
}

export function pageLevel(db: DB, auth: Auth | null, pageId: string): Level {
  const gov = governingPage(db, pageId);
  if (!gov) return 'write';
  if (!auth) return 'none';
  if (auth.user.role === 'admin') return 'write';
  const e = db.prepare('SELECT level FROM page_acl WHERE page_id = ? AND user_id = ?').get(gov, auth.user.id) as { level: 'read' | 'write' } | undefined;
  return e?.level ?? 'none';
}

export const canReadPage = (db: DB, auth: Auth | null, pageId: string) => pageLevel(db, auth, pageId) !== 'none';
export const canWritePage = (db: DB, auth: Auth | null, pageId: string) => pageLevel(db, auth, pageId) === 'write';

// Filtre une liste de pages (ou résultats de recherche) : un seul passage, sans coût si aucune restriction n'existe.
export function filterReadable<T extends { id: string }>(db: DB, auth: Auth | null, items: T[]): T[] {
  if (!hasAnyAcl(db)) return items;
  if (auth?.user.role === 'admin') return items;
  const parents = new Map((db.prepare('SELECT id, parent_id FROM pages').all() as { id: string; parent_id: string | null }[]).map((r) => [r.id, r.parent_id]));
  const acl = new Map<string, Map<string, string>>();
  for (const r of db.prepare('SELECT page_id, user_id, level FROM page_acl').all() as { page_id: string; user_id: string; level: string }[]) {
    if (!acl.has(r.page_id)) acl.set(r.page_id, new Map());
    acl.get(r.page_id)!.set(r.user_id, r.level);
  }
  const memo = new Map<string, boolean>();
  const readable = (id: string): boolean => {
    let cur: string | null | undefined = id;
    for (let depth = 0; cur && depth < 100; depth++) {
      const entries = acl.get(cur);
      if (entries) return !!auth && entries.has(auth.user.id);
      cur = parents.get(cur);
    }
    return true;
  };
  return items.filter((i) => { if (!memo.has(i.id)) memo.set(i.id, readable(i.id)); return memo.get(i.id)!; });
}
