// Espaces personnels : un espace par compte, créé à la demande, dont le propriétaire est le seul membre.
// Réglage d'instance (désactivé par défaut) qui ne gouverne que la CRÉATION : les espaces existants restent à leurs propriétaires.
// Les administrateurs ne les voient pas (space-access.ts). Si le compte disparaît, l'espace devient orphelin : invisible de tous
// jusqu'à ce qu'un administrateur le reprenne (il devient un espace partagé, action journalisée) ou le supprime.
import type { DB } from '../db.js';
import { newId } from './http.js';

const KEY = 'personal_spaces';

export const personalSpacesEnabled = (db: DB): boolean => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { enabled?: boolean }).enabled === true; } catch { return false; }
};

export function setPersonalSpaces(db: DB, enabled: boolean, userId: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify({ enabled }), Date.now(), userId);
}

export const personalSpaceOf = (db: DB, userId: string) =>
  db.prepare("SELECT * FROM spaces WHERE kind = 'personal' AND owner_id = ?").get(userId) as import('./access.js').SpaceRow | undefined;

/** Crée l'espace personnel de `user` (un seul par compte). */
export function createPersonalSpace(db: DB, user: { id: string; name: string }): string {
  const now = Date.now();
  const id = newId();
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spaces').get() as { p: number }).p;
  db.prepare("INSERT INTO spaces (id, name, icon, description, visibility, kind, owner_id, position, created_at, updated_at) VALUES (?, ?, 'home', '', 'private', 'personal', ?, ?, ?, ?)")
    .run(id, `Espace de ${user.name}`.slice(0, 80), user.id, position, now, now);
  return id;
}

/** Espaces personnels sans propriétaire (compte supprimé) : à reprendre ou à supprimer par un administrateur. */
export const orphanSpaces = (db: DB) => db.prepare(
  `SELECT s.id, s.name, s.created_at AS createdAt, (SELECT COUNT(*) FROM pages p WHERE p.space_id = s.id AND p.deleted_at IS NULL) AS pages
   FROM spaces s WHERE s.kind = 'personal' AND s.owner_id IS NULL ORDER BY s.created_at`,
).all() as { id: string; name: string; createdAt: number; pages: number }[];
