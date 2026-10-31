// Permissions fines par page. Sans entrée, le comportement reste celui de l'espace (aucune restriction).
// Dès qu'une page a des entrées (personnes ou groupes), elle et ses descendants sont restreints à ces personnes (la page
// restreinte la plus proche gouverne). Les administrateurs voient et modifient tout.
// Le niveau ACL ne fait que RESTREINDRE : le niveau d'une page est le plus BAS entre le droit sur l'espace (space-access.ts,
// rôle global compris) et l'entrée de la page ; entre plusieurs entrées d'une même personne (directe, groupes), la plus haute compte.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { HttpError } from './http.js';
import { EVERYONE, spaceRole, spaceRoles } from './space-access.js';

export type Level = 'none' | 'read' | 'write';
export type AclEntry = { userId?: string; groupId?: string; level: 'read' | 'write' };

export const hasAnyAcl = (db: DB) => !!db.prepare('SELECT 1 FROM page_acl LIMIT 1').get() || !!db.prepare('SELECT 1 FROM page_acl_groups LIMIT 1').get();

// Page qui gouverne `pageId` : elle-même ou son plus proche ancêtre ayant des entrées.
export function governingPage(db: DB, pageId: string): string | null {
  const row = db.prepare(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 100)
     SELECT up.id FROM up WHERE EXISTS (SELECT 1 FROM page_acl a WHERE a.page_id = up.id) OR EXISTS (SELECT 1 FROM page_acl_groups g WHERE g.page_id = up.id) ORDER BY up.depth LIMIT 1`,
  ).get(pageId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function entriesOf(db: DB, pageId: string): AclEntry[] {
  return [
    ...(db.prepare('SELECT user_id AS userId, level FROM page_acl WHERE page_id = ? ORDER BY user_id').all(pageId) as { userId: string; level: 'read' | 'write' }[]),
    ...(db.prepare('SELECT group_id AS groupId, level FROM page_acl_groups WHERE page_id = ? ORDER BY group_id').all(pageId) as { groupId: string; level: 'read' | 'write' }[]),
  ];
}

// Niveau accordé par la page restreinte `gov` à une personne : le plus haut de son entrée directe et de celles de ses groupes.
function aclLevel(db: DB, userId: string, gov: string): 'read' | 'write' | null {
  const rows = db.prepare(
    `SELECT level FROM page_acl WHERE page_id = @page AND user_id = @user
     UNION ALL
     SELECT level FROM page_acl_groups WHERE page_id = @page
       AND (group_id = '${EVERYONE}' OR group_id IN (SELECT group_id FROM group_members WHERE user_id = @user))`,
  ).all({ page: gov, user: userId }) as { level: 'read' | 'write' }[];
  if (!rows.length) return null;
  return rows.some((r) => r.level === 'write') ? 'write' : 'read';
}

export function pageLevel(db: DB, auth: Auth | null, pageId: string): Level {
  const page = db.prepare('SELECT space_id FROM pages WHERE id = ?').get(pageId) as { space_id: string } | undefined;
  if (!page) return 'none';
  const space = spaceRole(db, auth, page.space_id);
  if (space === 'none') return 'none';
  const fromSpace: Level = space === 'view' ? 'read' : 'write';
  const gov = governingPage(db, pageId);
  if (!gov) return fromSpace;
  if (!auth) return 'none';
  if (auth.user.role === 'admin') return 'write';
  const acl = aclLevel(db, auth.user.id, gov);
  if (!acl) return 'none';
  return acl === 'read' || fromSpace === 'read' ? 'read' : 'write';
}

export const canReadPage = (db: DB, auth: Auth | null, pageId: string) => pageLevel(db, auth, pageId) !== 'none';
export const canWritePage = (db: DB, auth: Auth | null, pageId: string) => pageLevel(db, auth, pageId) === 'write';

// Filtre une liste de pages (ou résultats de recherche) : d'abord par espace (droit sur l'espace de chaque page, une page
// inconnue est écartée), puis par restriction de page. Coût proportionnel aux pages demandées (et à leur profondeur),
// jamais à la taille totale du wiki.
export function filterReadable<T extends { id: string }>(db: DB, auth: Auth | null, items: T[]): T[] {
  if (!items.length) return items;
  const ids = JSON.stringify([...new Set(items.map((i) => i.id))]);
  const roles = spaceRoles(db, auth);
  const spaceOf = new Map((db.prepare('SELECT id, space_id FROM pages WHERE id IN (SELECT value FROM json_each(?))').all(ids) as { id: string; space_id: string }[]).map((r) => [r.id, r.space_id]));
  items = items.filter((i) => { const sid = spaceOf.get(i.id); return sid !== undefined && roles.has(sid); });
  if (!items.length || !hasAnyAcl(db)) return items;
  if (auth?.user.role === 'admin') return items;
  // Pour chaque page demandée : la page restreinte la plus proche (elle-même ou un ancêtre).
  const rows = db.prepare(
    `WITH RECURSIVE up(orig, id, parent_id, depth) AS (
       SELECT id, id, parent_id, 0 FROM pages WHERE id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT up.orig, p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 100)
     SELECT orig, id FROM up WHERE id IN (SELECT page_id FROM page_acl UNION SELECT page_id FROM page_acl_groups) ORDER BY orig, depth`,
  ).all(JSON.stringify([...new Set(items.map((i) => i.id))])) as { orig: string; id: string }[];
  const governing = new Map<string, string>();
  for (const r of rows) if (!governing.has(r.orig)) governing.set(r.orig, r.id);
  if (!governing.size) return items;
  const allowed = new Set<string>();
  if (auth) {
    for (const r of db.prepare(
      `SELECT page_id FROM page_acl WHERE user_id = @user
       UNION SELECT page_id FROM page_acl_groups WHERE group_id = '${EVERYONE}' OR group_id IN (SELECT group_id FROM group_members WHERE user_id = @user)`,
    ).all({ user: auth.user.id }) as { page_id: string }[]) allowed.add(r.page_id);
  }
  return items.filter((i) => { const g = governing.get(i.id); return !g || allowed.has(g); });
}

// Pages dont la seule entrée de permission est `who` : si cette entrée disparaît (groupe supprimé, compte effacé), la page n'aurait
// plus aucune restriction et deviendrait lisible de tout l'espace. On la garde fermée en lui donnant une entrée pour `closedBy`
// (un administrateur, qui voit tout de toute façon).
export function pagesOnlyOpenTo(db: DB, who: { userId: string } | { groupId: string }): string[] {
  const byUser = 'userId' in who;
  const id = byUser ? who.userId : who.groupId;
  const [own, ownCol, other] = byUser ? ['page_acl', 'user_id', 'page_acl_groups'] : ['page_acl_groups', 'group_id', 'page_acl'];
  const pages = db.prepare(`SELECT page_id FROM ${own} WHERE ${ownCol} = ?`).all(id) as { page_id: string }[];
  const hasOtherOwn = db.prepare(`SELECT 1 FROM ${own} WHERE page_id = ? AND ${ownCol} != ?`);
  const hasOther = db.prepare(`SELECT 1 FROM ${other} WHERE page_id = ?`);
  return pages.map((r) => r.page_id).filter((p) => !hasOtherOwn.get(p, id) && !hasOther.get(p));
}

export function keepPagesClosed(db: DB, pageIds: string[], closedBy: string): void {
  const insert = db.prepare("INSERT OR IGNORE INTO page_acl (page_id, user_id, level) VALUES (?, ?, 'write')");
  for (const p of pageIds) insert.run(p, closedBy);
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
