// Mentions (@personne) : qui peut être mentionné, et validation des identifiants envoyés par le client.
// Règle : on ne mentionne et on ne nomme que des personnes actives qui peuvent LIRE la page. Les autres sont ignorées sans
// message, pour ne pas révéler qui existe ni qui a accès à une page restreinte.
// Le contenu d'une page ne garde que l'identifiant d'une mention : le nom vient de la table des utilisateurs (jamais copié
// dans les pages, les versions ou les modèles), donc il disparaît avec le compte.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { governingPage, canReadPage } from './page-acl.js';

export const MAX_MENTIONS = 10;
interface UserRow { id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader' }
const asAuth = (u: UserRow): Auth => ({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set() });

/** Personnes actives qui peuvent lire la page, dont le nom (ou l'un de ses mots) commence par `q`. */
export function mentionableUsers(db: DB, pageId: string, q: string, limit = 8): { id: string; name: string }[] {
  const esc = q.replace(/[\\%_]/g, '\\$&').toLocaleLowerCase('fr');
  const match = "disabled = 0 AND (lower(name) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')";
  const gov = governingPage(db, pageId);
  // Page restreinte : les administrateurs et les personnes de la liste de la page qui gouverne (même règle que pageLevel).
  return (gov
    ? db.prepare(`SELECT id, name FROM users WHERE ${match} AND (role = 'admin' OR id IN (SELECT user_id FROM page_acl WHERE page_id = ?)) ORDER BY name COLLATE NOCASE LIMIT ?`)
      .all(`${esc}%`, `% ${esc}%`, gov, limit)
    : db.prepare(`SELECT id, name FROM users WHERE ${match} ORDER BY name COLLATE NOCASE LIMIT ?`).all(`${esc}%`, `% ${esc}%`, limit)) as { id: string; name: string }[];
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
