// Accusé de lecture : une demande par page, et des accusés EXPLICITES (la personne clique « J'ai lu »). Rien n'est enregistré
// à l'ouverture d'une page. Un nouvel accusé remplace le précédent (date et date de modification de la page à cet instant),
// ce qui permet de reconfirmer après une modification. Aucun contrôle d'accès ici : les routes passent par access.ts et
// page-acl.ts ; la liste des lecteurs ne garde que les comptes actifs qui lisent encore la page (canReadPage).
import type { DB } from '../db.js';
import { asAuth, type UserRow } from './mentions.js';
import { canReadPage } from './page-acl.js';

export interface ReadRequestRow { page_id: string; requested_by: string | null; created_at: number }
export interface ReceiptRow { page_id: string; user_id: string; acked_at: number; page_updated_at: number }

export const getReadRequest = (db: DB, pageId: string) =>
  db.prepare('SELECT * FROM page_read_requests WHERE page_id = ?').get(pageId) as ReadRequestRow | undefined;

export const getReceipt = (db: DB, pageId: string, userId: string) =>
  db.prepare('SELECT * FROM page_read_receipts WHERE page_id = ? AND user_id = ?').get(pageId, userId) as ReceiptRow | undefined;

/** Page modifiée après l'accusé. */
export const modifiedSinceAck = (receipt: Pick<ReceiptRow, 'page_updated_at'>, pageUpdatedAt: number) => pageUpdatedAt > receipt.page_updated_at;

/** Active la demande ; sans effet si elle existe déjà. Renvoie true si elle vient d'être créée. */
export const requestReceipts = (db: DB, pageId: string, by: string, now: number) =>
  db.prepare('INSERT OR IGNORE INTO page_read_requests (page_id, requested_by, created_at) VALUES (?, ?, ?)').run(pageId, by, now).changes > 0;

/** Retire la demande et tous ses accusés. `null` : aucune demande ; sinon le nombre d'accusés effacés (tous comptes confondus). */
export function clearReceipts(db: DB, pageId: string): number | null {
  return db.transaction(() => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM page_read_receipts WHERE page_id = ?').get(pageId) as { n: number };
    // Les accusés suivent par ON DELETE CASCADE ; supprimés ici aussi pour que la règle ne dépende pas du schéma.
    db.prepare('DELETE FROM page_read_receipts WHERE page_id = ?').run(pageId);
    return db.prepare('DELETE FROM page_read_requests WHERE page_id = ?').run(pageId).changes > 0 ? n : null;
  })();
}

/** Enregistre (ou renouvelle) l'accusé de `userId`. La demande doit exister (vérifié par la route). */
export function acknowledge(db: DB, pageId: string, userId: string, now: number): void {
  const page = db.prepare('SELECT updated_at FROM pages WHERE id = ?').get(pageId) as { updated_at: number };
  db.prepare(
    `INSERT INTO page_read_receipts (page_id, user_id, acked_at, page_updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (page_id, user_id) DO UPDATE SET acked_at = excluded.acked_at, page_updated_at = excluded.page_updated_at`,
  ).run(pageId, userId, now, page.updated_at);
}

export const withdrawReceipt = (db: DB, pageId: string, userId: string) =>
  db.prepare('DELETE FROM page_read_receipts WHERE page_id = ? AND user_id = ?').run(pageId, userId).changes > 0;

export type ReaderKey = { a: number; i: string };
export interface ReaderItem { user: { id: string; name: string }; ackedAt: number; modifiedSinceAck: boolean }

type Joined = ReceiptRow & UserRow;
const JOINED = `SELECT r.page_id, r.user_id, r.acked_at, r.page_updated_at, u.id, u.name, u.email, u.role
  FROM page_read_receipts r JOIN users u ON u.id = r.user_id WHERE r.page_id = @page AND u.disabled = 0`;

/** Accusés listables : compte actif qui lit encore la page. */
const listable = (db: DB, pageId: string) => (r: Joined) => canReadPage(db, asAuth(r), pageId);

export function countReaders(db: DB, pageId: string): number {
  const ok = listable(db, pageId);
  let n = 0;
  // .all() et non .iterate() : canReadPage interroge la base, ce que better-sqlite3 refuse pendant un parcours.
  for (const r of db.prepare(JOINED).all({ page: pageId }) as Joined[]) if (ok(r)) n++;
  return n;
}

/**
 * Lecteurs qui ont accusé réception, du plus récent au plus ancien (puis par identifiant), pagination par curseur sur
 * (date, identifiant). Les comptes désactivés ou qui ne lisent plus la page sont écartés.
 */
export function listReaders(db: DB, pageId: string, pageUpdatedAt: number, opts: { after: ReaderKey | null; limit: number }): { items: ReaderItem[]; next: ReaderKey | null } {
  const ok = listable(db, pageId);
  const rows = db.prepare(
    `${JOINED} AND (@a IS NULL OR r.acked_at < @a OR (r.acked_at = @a AND r.user_id > @i)) ORDER BY r.acked_at DESC, r.user_id ASC`,
  ).all({ page: pageId, a: opts.after?.a ?? null, i: opts.after?.i ?? null }) as Joined[];
  const items: ReaderItem[] = [];
  let more = false;
  for (const r of rows) {
    if (!ok(r)) continue;
    if (items.length === opts.limit) { more = true; break; }
    items.push({ user: { id: r.id, name: r.name }, ackedAt: r.acked_at, modifiedSinceAck: modifiedSinceAck(r, pageUpdatedAt) });
  }
  const last = items.at(-1);
  return { items, next: more && last ? { a: last.ackedAt, i: last.user.id } : null };
}
