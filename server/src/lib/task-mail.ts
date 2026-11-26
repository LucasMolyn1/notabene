// E-mails de tâches (lignes de base dont une colonne Personne désigne quelqu'un) :
//  - attribution : notée à l'écriture de la ligne (lib/task-assign.ts), envoyée ici, au plus un e-mail par personne, par base et
//    par heure (les attributions de l'heure sont regroupées) ;
//  - retard : un seul e-mail par tâche, par personne et par échéance (une autre échéance rouvre l'envoi), seulement pour une
//    échéance dépassée depuis peu (OVERDUE_WINDOW_DAYS) : la mise en service ne réveille pas les vieux retards ;
//  - résumé hebdomadaire : le lundi à partir de SUMMARY_HOUR (heure du serveur), pour qui l'a demandé et a au moins une tâche à faire.
// Sécurité : à chaque envoi, compte actif, adresse présente, préférence relue, base hors corbeille et LISIBLE par le destinataire
// (restrictions de page comprises) ; l'e-mail ne contient que le titre de la tâche, le titre de la base, l'échéance et un lien
// construit sur PUBLIC_URL, jamais d'autre cellule ni le nom de la personne qui attribue. Plafond d'e-mails de tâches par personne
// et par jour. Idempotence (redémarrage, plusieurs instances sur la même base) : chaque envoi est d'abord réservé en base, dans une
// transaction, puis envoyé ; un envoi en échec n'est pas retenté (jamais de doublon).
import type { Auth } from '../auth/context.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { isTaskDate, myTasks, taskColumns, type TaskColumns } from './base-tasks.js';
import { type Mailer, mails } from './mail.js';
import { getPrefs } from './notifications.js';
import { canReadPage } from './page-acl.js';
import { spaceRoles } from './space-access.js';

/** Au plus un e-mail d'attribution par personne et par base pendant ce délai. */
export const ASSIGN_GROUP_MS = 60 * 60_000;
/** Délai avant l'envoi d'une attribution (les écritures rapprochées se regroupent). */
export const ASSIGN_DEBOUNCE_MS = 60_000;
/** E-mails de tâches (attribution et retard) au plus par personne et par jour. */
export const TASK_MAILS_PER_DAY = 20;
/** Tâches citées au plus dans un e-mail d'attribution ou de retard. */
export const MAX_MAIL_TASKS = 10;
/** Lignes au plus dans le résumé hebdomadaire. */
export const SUMMARY_MAX_LINES = 30;
/** Heure (du serveur) à partir de laquelle le résumé du lundi part. */
export const SUMMARY_HOUR = 8;
/** Une tâche dont l'échéance est dépassée depuis plus de ce nombre de jours ne donne plus d'e-mail de retard. */
export const OVERDUE_WINDOW_DAYS = 3;
/** Bases lues au plus par tranche du balayage des retards (le balayage reprend au passage suivant, curseur sur l'id). */
export const OVERDUE_BATCH = 200;
/** Personnes servies au plus par tranche du résumé hebdomadaire (les suivantes au passage suivant). */
export const SUMMARY_BATCH = 200;
const MAX_SCAN_ROWS = 2000;
const MAX_GROUPS = 500;
/** Rend la main à la boucle d'événements entre deux unités de travail (base, personne, groupe). */
const yieldLoop = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const TICK_MS = 60_000;
const SCAN_MS = 60 * 60_000;

interface UserRow { id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader'; disabled: number }
interface MailTask { title: string; due: string | null }

const asAuth = (u: UserRow): Auth => ({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set(['read']) });
// Texte inséré dans un e-mail : une seule ligne, sans caractère de contrôle, longueur bornée.
// eslint-disable-next-line no-control-regex
const oneLine = (v: string, max = 120) => v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Jour UTC (même convention que « Mes tâches »). */
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Jour local du serveur (clé du résumé hebdomadaire : la date du lundi). */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const taskLine = (t: MailTask) => `- ${oneLine(t.title) || 'Sans titre'}${t.due ? ` (échéance : ${frDate(t.due)})` : ''}`;

export class TaskMailer {
  #timer: NodeJS.Timeout | null = null;
  #first: NodeJS.Timeout | null = null;
  #busy = false;
  /** Début du dernier balayage complet des retards. */
  #lastScan = 0;
  /** Curseur du balayage des retards en cours (id de la dernière base traitée) ; null hors balayage. */
  #overdueCursor: string | null = null;
  /** Semaine (date du lundi) dont tous les résumés sont traités : plus aucune requête jusqu'à la semaine suivante. */
  #summaryDone: string | null = null;

  constructor(private readonly db: DB, private readonly mailer: Mailer, private readonly config: () => Config, private readonly log?: (msg: string) => void) {}

  start() {
    const tick = () => { void this.tick().catch(() => this.log?.('e-mails de tâches : passage en échec')); };
    this.#first = setTimeout(tick, 60_000).unref();
    this.#timer = setInterval(tick, TICK_MS).unref();
    return () => { if (this.#first) clearTimeout(this.#first); if (this.#timer) clearInterval(this.#timer); this.#first = this.#timer = null; };
  }

  /**
   * Un passage : attributions ; une tranche du balayage des retards (un balayage complet commence au plus une fois par heure et
   * se poursuit tranche par tranche, une par passage) ; une tranche du résumé (sans effet hors du lundi matin).
   */
  async tick(now = Date.now()) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.processAssignments(now);
      if (this.#overdueCursor !== null || now - this.#lastScan >= SCAN_MS) {
        if (this.#overdueCursor === null) this.#lastScan = now;
        await this.processOverdue(now);
      }
      await this.processSummary(now);
    } finally { this.#busy = false; }
  }

  /** Un balayage des retards est en cours (tranches restantes). */
  get overduePending() { return this.#overdueCursor !== null; }

  #user(id: string) {
    return this.db.prepare('SELECT id, name, email, role, disabled FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  /** Destinataire d'un e-mail de tâches : compte actif, adresse présente, e-mails de tâches activés. */
  #recipient(id: string): UserRow | null {
    const u = this.#user(id);
    if (!u || u.disabled || !u.email || !getPrefs(this.db, u.id).emailTasks) return null;
    return u;
  }

  /** Base hors corbeille et lisible par `u` (restrictions de page comprises). Rend son titre. */
  #readableBase(u: UserRow, baseId: string): string | null {
    const b = this.db.prepare("SELECT title FROM pages WHERE id = ? AND kind = 'base' AND deleted_at IS NULL").get(baseId) as { title: string } | undefined;
    return b && canReadPage(this.db, asAuth(u), baseId) ? b.title : null;
  }

  /** Réserve un e-mail de tâches dans le plafond du jour ; false si le plafond est atteint. */
  #takeDaily(userId: string, now: number): boolean {
    const day = utcDay(now);
    return this.db.transaction(() => {
      const n = (this.db.prepare('SELECT n FROM task_mail_daily WHERE user_id = ? AND day = ?').get(userId, day) as { n: number } | undefined)?.n ?? 0;
      if (n >= TASK_MAILS_PER_DAY) return false;
      this.db.prepare('INSERT INTO task_mail_daily (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1').run(userId, day);
      return true;
    }).immediate();
  }

  /** Lignes `rowIds` de la base qui désignent encore `userId` et ne sont pas terminées. */
  #openTasks(baseId: string, cols: TaskColumns, rowIds: string[], userId: string): MailTask[] {
    const rows = this.db.prepare(
      `SELECT json_extract(vals, ?) AS title, ${cols.due.sql} AS due FROM base_rows
       WHERE base_id = ? AND id IN (SELECT value FROM json_each(?)) AND NOT (${cols.done.sql})
         AND EXISTS (SELECT 1 FROM json_each(?) c WHERE json_extract(vals, c.value) = ?)
       ORDER BY position, created_at`,
    ).all(cols.title, ...cols.due.params, baseId, JSON.stringify(rowIds), ...cols.done.params, JSON.stringify(cols.people), userId) as { title: unknown; due: unknown }[];
    return rows.map((r) => ({ title: typeof r.title === 'string' ? r.title : '', due: isTaskDate(r.due) ? r.due : null }));
  }

  async #send(to: string, mail: { subject: string; text: string }): Promise<boolean> {
    try { await this.mailer.send({ to, ...mails.notification(mail.subject, mail.text) }); return true; } catch {
      // Jamais l'erreur du serveur SMTP dans le journal : elle peut citer l'adresse du destinataire.
      this.log?.('e-mail de tâches non envoyé');
      return false;
    }
  }

  #list(tasks: MailTask[]): string {
    const lines = tasks.slice(0, MAX_MAIL_TASKS).map(taskLine);
    if (tasks.length > MAX_MAIL_TASKS) lines.push(`… et ${tasks.length - MAX_MAIL_TASKS} autre(s).`);
    return lines.join('\n');
  }

  /** Attributions en attente : un e-mail par personne et par base, au plus une fois par heure. Rend le nombre d'e-mails envoyés. */
  async processAssignments(now = Date.now()): Promise<number> {
    const { db } = this;
    // Sans SMTP, rien ne s'accumule : une attribution n'attend pas l'activation du SMTP pour partir des jours plus tard.
    if (!this.mailer.enabled) { db.prepare('DELETE FROM task_assign_events').run(); return 0; }
    db.prepare('DELETE FROM task_assign_events WHERE created_at < ?').run(now - 24 * 60 * 60_000);
    const groups = db.prepare(
      `SELECT e.user_id AS userId, e.base_id AS baseId FROM task_assign_events e LEFT JOIN task_assign_mails m ON m.user_id = e.user_id AND m.base_id = e.base_id
       GROUP BY e.user_id, e.base_id HAVING MIN(e.created_at) <= ? AND (MAX(m.sent_at) IS NULL OR MAX(m.sent_at) <= ?) LIMIT ?`,
    ).all(now - ASSIGN_DEBOUNCE_MS, now - ASSIGN_GROUP_MS, MAX_GROUPS) as { userId: string; baseId: string }[];
    let sent = 0;
    for (const g of groups) {
      await yieldLoop();
      // Réservation atomique : relit le délai, prend les attributions et note l'envoi (une autre instance ne trouve plus rien).
      const rowIds = db.transaction(() => {
        const last = (db.prepare('SELECT sent_at FROM task_assign_mails WHERE user_id = ? AND base_id = ?').get(g.userId, g.baseId) as { sent_at: number } | undefined)?.sent_at;
        if (last !== undefined && now - last < ASSIGN_GROUP_MS) return [];
        const ids = (db.prepare('SELECT row_id FROM task_assign_events WHERE user_id = ? AND base_id = ? AND created_at <= ?').all(g.userId, g.baseId, now) as { row_id: string }[]).map((r) => r.row_id);
        if (!ids.length) return [];
        db.prepare('DELETE FROM task_assign_events WHERE user_id = ? AND base_id = ? AND created_at <= ?').run(g.userId, g.baseId, now);
        db.prepare('INSERT INTO task_assign_mails (user_id, base_id, sent_at) VALUES (?, ?, ?) ON CONFLICT(user_id, base_id) DO UPDATE SET sent_at = excluded.sent_at').run(g.userId, g.baseId, now);
        return ids;
      }).immediate();
      if (!rowIds.length) continue;
      const u = this.#recipient(g.userId);
      if (!u) continue;
      const baseTitle = this.#readableBase(u, g.baseId);
      const cols = baseTitle === null ? null : taskColumns(db, g.baseId);
      if (baseTitle === null || !cols) continue;
      const tasks = this.#openTasks(g.baseId, cols, rowIds, u.id);
      if (!tasks.length || !this.#takeDaily(u.id, now)) continue;
      const base = oneLine(baseTitle) || 'Sans titre';
      const head = tasks.length === 1 ? `Une tâche vous a été attribuée dans la base « ${base} » :` : `${tasks.length} tâches vous ont été attribuées dans la base « ${base} » :`;
      const url = this.config().PUBLIC_URL;
      if (await this.#send(u.email!, {
        subject: tasks.length === 1 ? `BeNote : tâche attribuée dans « ${base} »` : `BeNote : ${tasks.length} tâches attribuées dans « ${base} »`,
        text: `${head}\n\n${this.#list(tasks)}\n\nOuvrir la base : ${url}/p/${g.baseId}\nMes tâches : ${url}/tasks`,
      })) sent++;
    }
    return sent;
  }

  /**
   * Une tranche du balayage des retards (échéance dépassée depuis peu, non terminées) : au plus `batch` bases après le curseur,
   * un e-mail par personne et par tranche. La dernière tranche (moins de `batch` bases) termine le balayage : aucune base n'est
   * jamais laissée de côté, quel que soit leur nombre.
   */
  async processOverdue(now = Date.now(), batch = OVERDUE_BATCH): Promise<number> {
    const { db } = this;
    if (!this.mailer.enabled) { this.#overdueCursor = null; return 0; }
    const today = utcDay(now);
    const from = addDays(today, -OVERDUE_WINDOW_DAYS);
    const bases = db.prepare(
      `SELECT p.id FROM pages p WHERE p.kind = 'base' AND p.deleted_at IS NULL AND p.id > ?
         AND EXISTS (SELECT 1 FROM base_properties bp WHERE bp.base_id = p.id AND bp.type = 'person')
       ORDER BY p.id LIMIT ?`,
    ).all(this.#overdueCursor ?? '', batch) as { id: string }[];
    this.#overdueCursor = bases.length < batch ? null : bases.at(-1)!.id;
    // Par personne : tâches en retard trouvées (base, ligne, titre, échéance).
    const found = new Map<string, { baseId: string; rowId: string; title: string; due: string }[]>();
    for (const b of bases) {
      await yieldLoop();
      const cols = taskColumns(db, b.id);
      if (!cols) continue;
      const rows = db.prepare(
        `SELECT id, json_extract(vals, ?) AS title, ${cols.due.sql} AS due,
           (SELECT json_group_array(DISTINCT json_extract(vals, c.value)) FROM json_each(?) c WHERE json_type(vals, c.value) = 'text') AS who
         FROM base_rows WHERE base_id = ? AND NOT (${cols.done.sql}) AND ${cols.due.sql} >= ? AND ${cols.due.sql} < ? LIMIT ?`,
      ).all(cols.title, ...cols.due.params, JSON.stringify(cols.people), b.id, ...cols.done.params, ...cols.due.params, from, ...cols.due.params, today, MAX_SCAN_ROWS) as
        { id: string; title: unknown; due: unknown; who: string }[];
      for (const r of rows) {
        if (!isTaskDate(r.due)) continue;
        for (const userId of JSON.parse(r.who) as string[]) {
          const list = found.get(userId) ?? [];
          list.push({ baseId: b.id, rowId: r.id, title: typeof r.title === 'string' ? r.title : '', due: r.due });
          found.set(userId, list);
        }
      }
    }
    let sent = 0;
    const claim = db.prepare(
      `INSERT INTO task_overdue_mails (row_id, user_id, due, sent_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(row_id, user_id) DO UPDATE SET due = excluded.due, sent_at = excluded.sent_at WHERE task_overdue_mails.due IS NOT excluded.due`,
    );
    for (const [userId, all] of found) {
      await yieldLoop();
      const u = this.#recipient(userId);
      if (!u) continue;
      const titles = new Map<string, string | null>();
      const readable = all.filter((t) => {
        if (!titles.has(t.baseId)) titles.set(t.baseId, this.#readableBase(u, t.baseId));
        return titles.get(t.baseId) !== null;
      });
      if (!readable.length) continue;
      // Plafond, puis réservation de chaque tâche (déjà signalée pour cette échéance : écartée), dans la même transaction.
      const claimed = db.transaction(() => {
        const n = (db.prepare('SELECT n FROM task_mail_daily WHERE user_id = ? AND day = ?').get(u.id, today) as { n: number } | undefined)?.n ?? 0;
        if (n >= TASK_MAILS_PER_DAY) return [];
        const mine = readable.filter((t) => claim.run(t.rowId, u.id, t.due, now).changes > 0);
        if (mine.length) db.prepare('INSERT INTO task_mail_daily (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1').run(u.id, today);
        return mine;
      }).immediate();
      if (!claimed.length) continue;
      const url = this.config().PUBLIC_URL;
      const lines = claimed.slice(0, MAX_MAIL_TASKS).map((t) => `${taskLine(t)}, base « ${oneLine(titles.get(t.baseId) ?? '') || 'Sans titre'} » : ${url}/p/${t.baseId}`);
      if (claimed.length > MAX_MAIL_TASKS) lines.push(`… et ${claimed.length - MAX_MAIL_TASKS} autre(s).`);
      if (await this.#send(u.email!, {
        subject: claimed.length === 1 ? 'BeNote : une tâche est en retard' : `BeNote : ${claimed.length} tâches sont en retard`,
        text: `${claimed.length === 1 ? 'Cette tâche qui vous est attribuée a dépassé son échéance' : 'Ces tâches qui vous sont attribuées ont dépassé leur échéance'} :\n\n${lines.join('\n')}\n\nMes tâches : ${url}/tasks`,
      })) sent++;
    }
    return sent;
  }

  /**
   * Résumé hebdomadaire : le lundi à partir de SUMMARY_HOUR, une fois par semaine, seulement s'il y a des tâches à faire.
   * Par tranches de `batch` personnes pas encore servies cette semaine (l'état est en base : un redémarrage reprend où on en
   * était) ; une tranche incomplète clôt la semaine, et plus rien n'est lu jusqu'au lundi suivant.
   */
  async processSummary(now = Date.now(), batch = SUMMARY_BATCH): Promise<number> {
    const { db } = this;
    if (!this.mailer.enabled) return 0;
    const d = new Date(now);
    if (d.getDay() !== 1 || d.getHours() < SUMMARY_HOUR) return 0;
    const week = localDay(d);
    if (this.#summaryDone === week) return 0;
    const users = db.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.disabled FROM users u JOIN notification_prefs np ON np.user_id = u.id
       LEFT JOIN task_summary_mails s ON s.user_id = u.id
       WHERE np.email_summary = 1 AND u.disabled = 0 AND u.email IS NOT NULL AND u.email <> '' AND s.week IS NOT ?
       ORDER BY u.id LIMIT ?`,
    ).all(week, batch) as UserRow[];
    if (users.length < batch) this.#summaryDone = week;
    const claim = db.prepare(
      `INSERT INTO task_summary_mails (user_id, week, sent_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET week = excluded.week, sent_at = excluded.sent_at WHERE task_summary_mails.week IS NOT excluded.week`,
    );
    const today = utcDay(now);
    const url = this.config().PUBLIC_URL;
    let sent = 0;
    for (const u of users) {
      await yieldLoop();
      if (!claim.run(u.id, week, now).changes) continue;
      const auth = asAuth(u);
      // Mêmes règles que « Mes tâches » : espaces lisibles, bases lisibles (restrictions comprises), hors corbeille.
      const { tasks } = myTasks(db, auth, [...spaceRoles(db, auth).keys()], false, today);
      if (!tasks.length) continue;
      const lines = tasks.slice(0, SUMMARY_MAX_LINES).map((t) => {
        const late = t.due !== null && t.due < today;
        return `- ${oneLine(t.title) || 'Sans titre'} (base « ${oneLine(t.baseTitle) || 'Sans titre'} ») : ${t.due ? `échéance ${frDate(t.due)}` : 'sans échéance'}, ${late ? 'en retard' : 'à faire'}`;
      });
      if (tasks.length > SUMMARY_MAX_LINES) lines.push(`… et ${tasks.length - SUMMARY_MAX_LINES} autre(s).`);
      const late = tasks.filter((t) => t.due !== null && t.due < today).length;
      if (await this.#send(u.email!, {
        subject: 'BeNote : vos tâches de la semaine',
        text: `Vous avez ${tasks.length} tâche(s) à faire${late ? `, dont ${late} en retard` : ''} :\n\n${lines.join('\n')}\n\nMes tâches : ${url}/tasks`,
      })) sent++;
    }
    return sent;
  }
}
