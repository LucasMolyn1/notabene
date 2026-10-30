// Libellés de page. Un libellé n'existe que par les pages qui le portent : pas de liste globale, donc
// rien à fuiter. Toute liste de libellés ou de comptes est calculée sur les seules pages lisibles par l'appelant.
import type { DB } from '../db.js';
import { HttpError } from './http.js';

export const MAX_LABELS_PER_PAGE = 20;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

/** Forme canonique : sans espaces de bord, en minuscules, espaces internes remplacés par des tirets. */
export function normalizeLabel(raw: string): string {
  const name = raw.normalize('NFC').trim().toLocaleLowerCase('fr').replace(/\s+/gu, '-');
  if (!NAME.test(name)) {
    throw new HttpError(400, 'Libellé invalide : 40 caractères au plus, lettres, chiffres, tirets et soulignés, en commençant par une lettre ou un chiffre');
  }
  return name;
}

export const labelsOf = (db: DB, pageId: string): string[] =>
  (db.prepare('SELECT name FROM page_labels WHERE page_id = ? ORDER BY name').all(pageId) as { name: string }[]).map((r) => r.name);

/** Ajoute un libellé (sans effet s'il est déjà posé). Renvoie true s'il vient d'être ajouté. */
export function addLabel(db: DB, pageId: string, name: string, userId: string | null): boolean {
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM page_labels WHERE page_id = ? AND name = ?').get(pageId, name)) return false;
    const { n } = db.prepare('SELECT count(*) AS n FROM page_labels WHERE page_id = ?').get(pageId) as { n: number };
    if (n >= MAX_LABELS_PER_PAGE) throw new HttpError(400, `Une page porte au plus ${MAX_LABELS_PER_PAGE} libellés`);
    db.prepare('INSERT INTO page_labels (page_id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(pageId, name, Date.now(), userId);
    return true;
  })();
}

export const removeLabel = (db: DB, pageId: string, name: string): boolean =>
  db.prepare('DELETE FROM page_labels WHERE page_id = ? AND name = ?').run(pageId, name).changes > 0;

/** Pages (parmi `spaceIds`, hors corbeille) qui portent le libellé : à filtrer ensuite par `filterReadable`. */
export const pageIdsWithLabel = (db: DB, name: string, spaceIds: string[]): Set<string> =>
  new Set((db.prepare(
    `SELECT l.page_id AS id FROM page_labels l JOIN pages p ON p.id = l.page_id
     WHERE l.name = ? AND p.deleted_at IS NULL AND p.space_id IN (SELECT value FROM json_each(?))`,
  ).all(name, JSON.stringify(spaceIds)) as { id: string }[]).map((r) => r.id));

/** Libellés des pages données avec le nombre de pages, pour un préfixe éventuel. L'appelant ne passe que des pages lisibles et hors corbeille. */
export function labelCounts(db: DB, pageIds: string[], prefix = '', limit = 200): { name: string; count: number }[] {
  if (!pageIds.length) return [];
  const like = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
  return db.prepare(
    `SELECT l.name AS name, count(*) AS count FROM page_labels l
     WHERE l.page_id IN (SELECT value FROM json_each(?)) AND l.name LIKE ? ESCAPE '\\'
     GROUP BY l.name ORDER BY count DESC, l.name LIMIT ?`,
  ).all(JSON.stringify(pageIds), like, limit) as { name: string; count: number }[];
}
