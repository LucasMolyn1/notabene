// Notifications : commentaires et modifications des pages suivies, boîte de réception et e-mails.
// Sécurité : le destinataire doit pouvoir LIRE la page au moment de l'envoi (permissions fines comprises) ;
// l'e-mail ne contient que le titre de la page, le nom de l'auteur et un lien, jamais le contenu.
import type { Auth } from '../auth/context.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { type EventBus } from './events.js';
import { newId } from './http.js';
import type { Mailer } from './mail.js';
import { mails } from './mail.js';
import { canReadPage } from './page-acl.js';
import { getPageRow } from './pages.js';

const EMAIL_CHANGES_INTERVAL = 60 * 60_000;
export type NotificationType = 'comment' | 'reply' | 'page.updated';

interface UserRow { id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader'; disabled: number }
const asAuth = (u: UserRow): Auth => ({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set() });
const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);

export const getPrefs = (db: DB, userId: string) => {
  const row = db.prepare('SELECT email_comments AS c, email_changes AS g FROM notification_prefs WHERE user_id = ?').get(userId) as { c: number; g: number } | undefined;
  return { emailComments: row ? !!row.c : true, emailChanges: row ? !!row.g : false };
};

export const watch = (db: DB, userId: string, pageId: string) =>
  db.prepare('INSERT OR IGNORE INTO page_watch (user_id, page_id, created_at) VALUES (?, ?, ?)').run(userId, pageId, Date.now());

export function startNotifications(db: DB, bus: EventBus, mailer: Mailer, config: () => Config) {
  const user = (id: string) => db.prepare('SELECT id, name, email, role, disabled FROM users WHERE id = ?').get(id) as UserRow | undefined;

  const deliver = (userId: string, type: NotificationType, pageId: string, actorId: string | null) => {
    const target = user(userId);
    if (!target || target.disabled || userId === actorId) return;
    // Accès relu à chaque envoi : une page restreinte ne notifie jamais quelqu'un qui n'y a plus accès.
    if (!canReadPage(db, asAuth(target), pageId)) return;
    const now = Date.now();
    // Les modifications se regroupent : une notification non lue par page et par personne.
    const open = type === 'page.updated'
      ? db.prepare("SELECT id FROM notifications WHERE user_id = ? AND page_id = ? AND type = 'page.updated' AND read_at IS NULL").get(userId, pageId) as { id: string } | undefined
      : undefined;
    if (open) db.prepare('UPDATE notifications SET count = count + 1, created_at = ?, actor_id = ? WHERE id = ?').run(now, actorId, open.id);
    else db.prepare('INSERT INTO notifications (id, user_id, type, page_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), userId, type, pageId, actorId, now);
    bus.publish({ type: 'notification', data: { userId } });
    void email(target, type, pageId, actorId).catch(() => undefined);
  };

  const email = async (target: UserRow, type: NotificationType, pageId: string, actorId: string | null) => {
    if (!target.email || !mailer.enabled) return;
    const prefs = getPrefs(db, target.id);
    if (type === 'page.updated') {
      if (!prefs.emailChanges) return;
      // Au plus un e-mail par page et par heure.
      const w = db.prepare('SELECT last_emailed_at AS t FROM page_watch WHERE user_id = ? AND page_id = ?').get(target.id, pageId) as { t: number | null } | undefined;
      if (w?.t && Date.now() - w.t < EMAIL_CHANGES_INTERVAL) return;
      db.prepare('UPDATE page_watch SET last_emailed_at = ? WHERE user_id = ? AND page_id = ?').run(Date.now(), target.id, pageId);
    } else if (!prefs.emailComments) return;
    const page = getPageRow(db, pageId);
    if (!page) return;
    const actor = actorId ? user(actorId)?.name ?? 'Quelqu’un' : 'Quelqu’un';
    const title = oneLine(page.title || 'Sans titre');
    const url = `${config().PUBLIC_URL}/p/${pageId}`;
    const what = { comment: 'a commenté', reply: 'a répondu à votre commentaire sur', 'page.updated': 'a modifié' }[type];
    await mailer.send({ to: target.email, ...mails.notification(`Notabene : ${oneLine(actor)} ${what} « ${title} »`, `${oneLine(actor)} ${what} la page « ${title} ».\n\nOuvrir la page : ${url}`) });
  };

  return bus.subscribe((e) => {
    try {
      if (!e.pageId) return;
      const actorId = e.by?.id ?? null;
      if (e.type === 'page.created' && actorId) watch(db, actorId, e.pageId);
      if (e.type === 'comment.created') {
        const commentId = (e.data as { commentId?: string } | undefined)?.commentId;
        const c = commentId ? db.prepare('SELECT parent_id, author_id FROM page_comments WHERE id = ?').get(commentId) as { parent_id: string | null; author_id: string | null } | undefined : undefined;
        if (!c) return;
        if (c.author_id) watch(db, c.author_id, e.pageId); // commenter, c'est suivre
        const done = new Set<string>();
        if (c.parent_id) {
          const parent = db.prepare('SELECT author_id FROM page_comments WHERE id = ?').get(c.parent_id) as { author_id: string | null } | undefined;
          if (parent?.author_id) { done.add(parent.author_id); deliver(parent.author_id, 'reply', e.pageId, c.author_id); }
        }
        for (const w of db.prepare('SELECT user_id FROM page_watch WHERE page_id = ?').all(e.pageId) as { user_id: string }[]) {
          if (!done.has(w.user_id)) deliver(w.user_id, 'comment', e.pageId, c.author_id);
        }
      } else if (e.type === 'page.updated') {
        for (const w of db.prepare('SELECT user_id FROM page_watch WHERE page_id = ?').all(e.pageId) as { user_id: string }[]) deliver(w.user_id, 'page.updated', e.pageId, actorId);
      }
    } catch { /* une notification ne doit jamais faire échouer l'action qui l'a provoquée */ }
  });
}
