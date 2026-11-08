// Vérification de page : personnes désignées pour confirmer qu'une page est à jour, échéance et rappels.
// Le statut est calculé ici, jamais stocké : none (pas de configuration), pending (jamais vérifiée), verified, expiring
// (échéance dans 7 jours ou moins), expired. Modifier la page n'invalide pas la vérification : on le signale seulement
// (`modifiedSinceVerification`). Aucun contrôle d'accès ici : les routes passent par access.ts et page-acl.ts.
import type { DB } from '../db.js';
import type { Notifier } from './notifications.js';
import { filterReadable } from './page-acl.js';

export const DAY = 86_400_000;
export const EXPIRING_WITHIN = 7 * DAY;
export const MAX_VERIFIERS = 10;
export const REMINDER_INTERVAL = 3_600_000;

export type VerificationStatus = 'none' | 'pending' | 'verified' | 'expiring' | 'expired';
type Notified = 'none' | 'expiring' | 'expired';

export interface VerificationRow {
  page_id: string;
  interval_days: number | null;
  verified_by: string | null;
  verified_at: number | null;
  expires_at: number | null;
  verified_content_updated_at: number | null;
  notified_state: Notified;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export const getVerification = (db: DB, pageId: string) =>
  db.prepare('SELECT * FROM page_verifications WHERE page_id = ?').get(pageId) as VerificationRow | undefined;

export const verifierIds = (db: DB, pageId: string): string[] =>
  (db.prepare('SELECT user_id FROM page_verifiers WHERE page_id = ? ORDER BY user_id').all(pageId) as { user_id: string }[]).map((r) => r.user_id);

export const isVerifier = (db: DB, pageId: string, userId: string) =>
  !!db.prepare('SELECT 1 FROM page_verifiers WHERE page_id = ? AND user_id = ?').get(pageId, userId);

export function statusOf(row: Pick<VerificationRow, 'verified_at' | 'expires_at'> | undefined, now: number): VerificationStatus {
  if (!row) return 'none';
  if (row.verified_at === null) return 'pending';
  if (row.expires_at === null) return 'verified';
  if (row.expires_at <= now) return 'expired';
  if (row.expires_at - now <= EXPIRING_WITHIN) return 'expiring';
  return 'verified';
}

export const modifiedSince = (row: Pick<VerificationRow, 'verified_at' | 'verified_content_updated_at'> | undefined, pageUpdatedAt: number) =>
  !!row && row.verified_at !== null && row.verified_content_updated_at !== null && pageUpdatedAt > row.verified_content_updated_at;

/** Crée ou remplace la configuration (vérificateurs, intervalle). Une page déjà vérifiée garde sa vérification, échéance recalculée. */
export function setVerification(db: DB, pageId: string, verifiers: string[], intervalDays: number | null, by: string, now: number): void {
  db.transaction(() => {
    const cur = getVerification(db, pageId);
    if (cur) {
      const expires = cur.verified_at !== null && intervalDays !== null ? cur.verified_at + intervalDays * DAY : null;
      db.prepare('UPDATE page_verifications SET interval_days = ?, expires_at = ?, updated_at = ? WHERE page_id = ?').run(intervalDays, expires, now, pageId);
    } else {
      db.prepare('INSERT INTO page_verifications (page_id, interval_days, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(pageId, intervalDays, by, now, now);
    }
    db.prepare('DELETE FROM page_verifiers WHERE page_id = ?').run(pageId);
    const ins = db.prepare('INSERT INTO page_verifiers (page_id, user_id) VALUES (?, ?)');
    for (const id of verifiers) ins.run(pageId, id);
  })();
}

export const clearVerification = (db: DB, pageId: string) => db.prepare('DELETE FROM page_verifications WHERE page_id = ?').run(pageId).changes > 0;

/** Marque la page vérifiée maintenant ; l'échéance repart de maintenant, les rappels sont réarmés. */
export function markVerified(db: DB, pageId: string, by: string, now: number): void {
  const cur = getVerification(db, pageId);
  if (!cur) return;
  const page = db.prepare('SELECT updated_at FROM pages WHERE id = ?').get(pageId) as { updated_at: number };
  db.prepare(
    `UPDATE page_verifications SET verified_by = ?, verified_at = ?, expires_at = ?, verified_content_updated_at = ?, notified_state = 'none', updated_at = ?
     WHERE page_id = ?`,
  ).run(by, now, cur.interval_days !== null ? now + cur.interval_days * DAY : null, page.updated_at, now, pageId);
}

const RANK: Record<Notified, number> = { none: 0, expiring: 1, expired: 2 };

/**
 * Rappels : quand une page vérifiée passe en « expiring » puis en « expired », chaque vérificateur qui lit encore la page reçoit
 * une notification, une seule fois par changement d'état (`notified_state`). Une échéance repoussée (intervalle allongé) fait
 * redescendre l'état sans notifier. Pages à la corbeille ignorées. Renvoie le nombre de notifications déposées.
 */
export function remindVerifications(db: DB, notifier: Notifier, now: number = Date.now()): number {
  const rows = db.prepare(
    `SELECT v.page_id, v.verified_at, v.expires_at, v.notified_state FROM page_verifications v JOIN pages p ON p.id = v.page_id
     WHERE p.deleted_at IS NULL AND v.verified_at IS NOT NULL AND (v.notified_state != 'none' OR (v.expires_at IS NOT NULL AND v.expires_at - ? <= ?))`,
  ).all(now, EXPIRING_WITHIN) as Pick<VerificationRow, 'page_id' | 'verified_at' | 'expires_at' | 'notified_state'>[];
  const save = db.prepare('UPDATE page_verifications SET notified_state = ? WHERE page_id = ?');
  let sent = 0;
  for (const r of rows) {
    const status = statusOf(r, now);
    const target: Notified = status === 'expired' ? 'expired' : status === 'expiring' ? 'expiring' : 'none';
    if (target === r.notified_state) continue;
    // L'état est enregistré avant l'envoi : un échec de dépôt ne provoque jamais de rappel en double.
    save.run(target, r.page_id);
    if (RANK[target] < RANK[r.notified_state]) continue;
    const type = target === 'expired' ? 'verification.expired' : 'verification.expiring';
    for (const userId of verifierIds(db, r.page_id)) {
      try { if (notifier.deliver(userId, type, r.page_id, null)) sent++; } catch { /* un rappel ne doit pas bloquer les suivants */ }
    }
  }
  return sent;
}

export interface DueItem {
  page: { id: string; title: string; icon: string; spaceId: string };
  status: Exclude<VerificationStatus, 'none' | 'verified'>;
  intervalDays: number | null;
  verifiedAt: number | null;
  expiresAt: number | null;
  modifiedSinceVerification: boolean;
}

const DUE_RANK = { expired: 0, expiring: 1, pending: 2 } as const;
export type DueKey = { s: number; d: number; i: string };
export const dueKey = (item: DueItem, createdAt: number): DueKey => ({ s: DUE_RANK[item.status], d: item.status === 'pending' ? createdAt : item.expiresAt!, i: item.page.id });
const cmp = (a: DueKey, b: DueKey) => a.s - b.s || a.d - b.d || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0);

/**
 * Pages à revoir (pending, expiring, expired) parmi celles que `auth` peut lire, triées par urgence : expirées d'abord (la plus
 * ancienne échéance en tête), puis à échéance proche, puis jamais vérifiées. `userId` : seulement les pages où cette personne est
 * vérificatrice. Pagination par curseur sur la clé de tri.
 */
export function duePages(
  db: DB, auth: import('../auth/context.js').Auth, opts: { userId: string | null; status?: DueItem['status']; after: DueKey | null; limit: number; now: number },
): { items: DueItem[]; next: DueKey | null } {
  const rows = db.prepare(
    `SELECT v.*, p.id, p.title, p.icon, p.space_id, p.updated_at AS page_updated_at FROM page_verifications v JOIN pages p ON p.id = v.page_id
     WHERE p.deleted_at IS NULL AND (@user IS NULL OR EXISTS (SELECT 1 FROM page_verifiers w WHERE w.page_id = v.page_id AND w.user_id = @user))`,
  ).all({ user: opts.userId }) as (VerificationRow & { id: string; title: string; icon: string; space_id: string; page_updated_at: number })[];
  const due = rows
    .map((r) => ({ r, status: statusOf(r, opts.now) }))
    .filter((x): x is { r: typeof x.r; status: DueItem['status'] } => x.status === 'pending' || x.status === 'expiring' || x.status === 'expired')
    .filter((x) => !opts.status || x.status === opts.status);
  // Lisibilité relue avec les droits de l'appelant : aucune page illisible (ni son titre) ne sort.
  const readable = new Set(filterReadable(db, auth, due.map((x) => ({ id: x.r.id }))).map((p) => p.id));
  const sorted = due.filter((x) => readable.has(x.r.id))
    .map((x) => {
      const item: DueItem = {
        page: { id: x.r.id, title: x.r.title, icon: x.r.icon, spaceId: x.r.space_id },
        status: x.status,
        intervalDays: x.r.interval_days,
        verifiedAt: x.r.verified_at,
        expiresAt: x.r.expires_at,
        modifiedSinceVerification: modifiedSince(x.r, x.r.page_updated_at),
      };
      return { item, key: dueKey(item, x.r.created_at) };
    })
    .sort((a, b) => cmp(a.key, b.key))
    .filter((x) => !opts.after || cmp(x.key, opts.after) > 0);
  const page = sorted.slice(0, opts.limit);
  return { items: page.map((x) => x.item), next: sorted.length > opts.limit && page.length ? page.at(-1)!.key : null };
}
