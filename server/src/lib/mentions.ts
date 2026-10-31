// Mentions (@personne) : qui peut être mentionné, et validation des identifiants envoyés par le client.
// Règle : on ne mentionne et on ne nomme que des personnes actives qui peuvent LIRE la page. Les autres sont ignorées sans
// message, pour ne pas révéler qui existe ni qui a accès à une page restreinte.
// Le contenu d'une page ne garde que l'identifiant d'une mention : le nom vient de la table des utilisateurs (jamais copié
// dans les pages, les versions ou les modèles), donc il disparaît avec le compte.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { governingPage, canReadPage } from './page-acl.js';
import { EVERYONE } from './space-access.js';

export const MAX_MENTIONS = 10;
interface UserRow { id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader' }
const asAuth = (u: UserRow): Auth => ({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set(['read']) });

/**
 * Personnes actives qui peuvent lire la page, dont le nom (ou l'un de ses mots) commence par `q`.
 * Le SQL ne fait que préfiltrer (espace, puis restriction de la page) pour borner le nombre de comptes examinés ; la règle
 * de référence reste `canReadPage`, appliquée à chaque candidat.
 */
export function mentionableUsers(db: DB, pageId: string, q: string, limit = 8): { id: string; name: string }[] {
  const esc = q.replace(/[\\%_]/g, '\\$&').toLocaleLowerCase('fr');
  const page = db.prepare('SELECT space_id FROM pages WHERE id = ?').get(pageId) as { space_id: string } | undefined;
  if (!page) return [];
  const gov = governingPage(db, pageId);
  const rows = db.prepare(
    `SELECT id, name, email, role FROM users u
     WHERE disabled = 0 AND (lower_fr(name) LIKE @starts ESCAPE '\\' OR lower_fr(name) LIKE @word ESCAPE '\\')
       AND (role = 'admin'
         OR EXISTS (SELECT 1 FROM spaces s WHERE s.id = @space AND s.visibility = 'public')
         OR EXISTS (SELECT 1 FROM spaces s WHERE s.id = @space AND s.kind = 'personal' AND s.owner_id = u.id)
         OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = @space
              AND (m.user_id = u.id OR m.group_id = '${EVERYONE}' OR m.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id))))
       AND (@gov IS NULL OR role = 'admin'
         OR u.id IN (SELECT user_id FROM page_acl WHERE page_id = @gov)
         OR EXISTS (SELECT 1 FROM page_acl_groups g WHERE g.page_id = @gov
              AND (g.group_id = '${EVERYONE}' OR g.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id))))
     ORDER BY name COLLATE NOCASE LIMIT 200`,
  ).all({ starts: `${esc}%`, word: `% ${esc}%`, space: page.space_id, gov }) as UserRow[];
  return rows.filter((u) => canReadPage(db, asAuth(u), pageId)).slice(0, limit).map((u) => ({ id: u.id, name: u.name }));
}

/** Parmi `ids`, les personnes actives qui peuvent lire la page (au plus `cap`). */
export function readersAmong(db: DB, pageId: string, ids: string[], cap = MAX_MENTIONS): { id: string; name: string }[] {
  const unique = [...new Set(ids)].slice(0, cap);
  if (!unique.length) return [];
  const rows = db.prepare(
    'SELECT id, name, email, role FROM users WHERE disabled = 0 AND id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(unique)) as UserRow[];
  return rows.filter((u) => canReadPage(db, asAuth(u), pageId)).map((u) => ({ id: u.id, name: u.name }));
}

export const validMentions = (db: DB, pageId: string, ids: string[]) => readersAmong(db, pageId, ids, MAX_MENTIONS);
