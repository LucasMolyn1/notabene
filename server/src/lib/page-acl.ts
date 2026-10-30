// Permissions fines par page. Sans entrée, le comportement reste celui des espaces (aucune restriction).
// Dès qu'une page a des entrées, elle et ses descendants sont restreints à ces utilisateurs (la page
// restreinte la plus proche gouverne). Les administrateurs voient et modifient tout.
// Le niveau ACL ne fait que RESTREINDRE : il ne dépasse jamais le rôle ni la portée du jeton.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { HttpError } from './http.js';

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

// Filtre une liste de pages (ou résultats de recherche) : sans coût si aucune restriction n'existe, et sinon
// proportionnel aux pages demandées (et à leur profondeur), jamais à la taille totale du wiki.
export function filterReadable<T extends { id: string }>(db: DB, auth: Auth | null, items: T[]): T[] {
  if (!items.length || !hasAnyAcl(db)) return items;
  if (auth?.user.role === 'admin') return items;
  // Pour chaque page demandée : la page restreinte la plus proche (elle-même ou un ancêtre).
  const rows = db.prepare(
    `WITH RECURSIVE up(orig, id, parent_id, depth) AS (
       SELECT id, id, parent_id, 0 FROM pages WHERE id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT up.orig, p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 100)
     SELECT orig, id FROM up WHERE id IN (SELECT page_id FROM page_acl) ORDER BY orig, depth`,
  ).all(JSON.stringify([...new Set(items.map((i) => i.id))])) as { orig: string; id: string }[];
  const governing = new Map<string, string>();
  for (const r of rows) if (!governing.has(r.orig)) governing.set(r.orig, r.id);
  if (!governing.size) return items;
  const allowed = new Set<string>();
  if (auth) {
    for (const r of db.prepare('SELECT page_id FROM page_acl WHERE user_id = ?').all(auth.user.id) as { page_id: string }[]) allowed.add(r.page_id);
  }
  return items.filter((i) => { const g = governing.get(i.id); return !g || allowed.has(g); });
}

// Un déplacement ne doit ni lever ni changer la restriction qui protège une page : sinon un rédacteur
// (non administrateur) rendrait lisible par d'autres une page cachée. Une page qui porte ses propres entrées
// garde sa restriction où qu'elle aille ; sinon seul un administrateur peut la sortir de sa zone restreinte.
export function assertMoveKeepsRestriction(db: DB, auth: Auth | null, pageId: string, newParentId: string | null): void {
  if (auth?.user.role === 'admin') return;
  if (entriesOf(db, pageId).length) return;
  const cur = db.prepare('SELECT parent_id FROM pages WHERE id = ?').get(pageId) as { parent_id: string | null } | undefined;
  const before = cur?.parent_id ? governingPage(db, cur.parent_id) : null;
  const after = newParentId ? governingPage(db, newParentId) : null;
  if (before && before !== after) throw new HttpError(403, 'Sortir cette page de sa zone restreinte est réservé aux administrateurs');
}
