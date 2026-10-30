// Mentions (@personne) : qui peut être mentionné, et validation des identifiants envoyés par le client.
// Règle : on ne mentionne que des personnes actives qui peuvent LIRE la page. Les autres sont ignorées sans message,
// pour ne pas révéler qui existe ni qui a accès à une page restreinte.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { canReadPage } from './page-acl.js';

export const MAX_MENTIONS = 10;
interface UserRow { id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader' }
const asAuth = (u: UserRow): Auth => ({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set() });

/** Personnes actives qui peuvent lire la page, dont le nom commence par `q`. */
export function mentionableUsers(db: DB, pageId: string, q: string, limit = 8): { id: string; name: string }[] {
  // Le début du nom ou le début d'un de ses mots (« dup » trouve « Jean Dupont »).
  const esc = q.replace(/[\\%_]/g, '\\$&').toLocaleLowerCase('fr');
  const rows = db.prepare(
    `SELECT id, name, email, role FROM users WHERE disabled = 0 AND (lower(name) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') ORDER BY name COLLATE NOCASE LIMIT 200`,
  ).all(`${esc}%`, `% ${esc}%`) as UserRow[];
  return rows.filter((u) => canReadPage(db, asAuth(u), pageId)).slice(0, limit).map((u) => ({ id: u.id, name: u.name }));
}

/** Parmi `ids`, ceux qui désignent une personne active pouvant lire la page (au plus MAX_MENTIONS). */
export function validMentions(db: DB, pageId: string, ids: string[]): { id: string; name: string }[] {
  const unique = [...new Set(ids)].slice(0, MAX_MENTIONS);
  if (!unique.length) return [];
  const rows = db.prepare(
    'SELECT id, name, email, role FROM users WHERE disabled = 0 AND id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(unique)) as UserRow[];
  return rows.filter((u) => canReadPage(db, asAuth(u), pageId)).map((u) => ({ id: u.id, name: u.name }));
}

export function namesOf(db: DB, ids: string[]): { id: string; name: string }[] {
  if (!ids.length) return [];
  return db.prepare('SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids.slice(0, 200))) as { id: string; name: string }[];
}
