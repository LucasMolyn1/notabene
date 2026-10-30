// Fonctions ajoutées en v3 : commentaires de page et permissions fines par page.
// Les droits restent ceux de l'appelant : une permission fine ne fait que restreindre l'accès.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { getPrefs, watch } from '../lib/notifications.js';
import { entriesOf, filterReadable, governingPage, pageLevel } from '../lib/page-acl.js';

interface CommentRow {
  id: string; page_id: string; parent_id: string | null; author_id: string | null; author_name: string | null; body: string;
  created_at: number; updated_at: number; resolved_at: number | null; deleted_at: number | null; seq: number;
}

const toComment = (r: CommentRow) => ({
  id: r.id,
  pageId: r.page_id,
  parentId: r.parent_id,
  author: r.deleted_at ? null : r.author_id ? { id: r.author_id, name: r.author_name } : null,
  body: r.deleted_at ? null : r.body,
  deleted: !!r.deleted_at,
  resolved: !!r.resolved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT = `SELECT c.*, c.rowid AS seq, u.name AS author_name FROM page_comments c LEFT JOIN users u ON u.id = c.author_id`;
const commentParams = z.object({ id: idSchema, cid: idSchema });
const text = z.string().trim().min(1).max(5000);

export default async function v3Routes(app: FastifyInstance) {
  const { db, bus } = app;

  // ---- Commentaires ----------------------------------------------------------------------
  const byPage = (pageId: string, cid: string) => db.prepare(`${SELECT} WHERE c.id = ? AND c.page_id = ?`).get(cid, pageId) as CommentRow | undefined;
  const announce = (type: 'comment.created' | 'comment.updated' | 'comment.deleted', spaceId: string, pageId: string, req: { auth: { user: { id: string; name: string } } | null }, data: unknown) =>
    bus.publish({ type, spaceId, pageId, by: req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined, data });

  app.get('/pages/:id/comments', {
    schema: { tags: ['comments'], summary: 'Commentaires d’une page (pagination par curseur)', params: idParams, querystring: pageQuery.extend({ resolved: z.enum(['true', 'false']).optional() }) },
  }, async (req) => {
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const q = req.query as { cursor?: string; limit: number; resolved?: 'true' | 'false' };
    const after = decodeCursor(q.cursor, z.object({ s: z.number().int().min(0) }));
    const rows = db.prepare(
      // Ordre d'insertion (rowid) : stable même pour deux commentaires créés dans la même milliseconde.
      `${SELECT} WHERE c.page_id = ? AND c.rowid > ? ORDER BY c.rowid`,
    ).all(page.id, after?.s ?? 0) as CommentRow[];
    // Filtre « résolu » appliqué au fil entier (un commentaire suit l'état de son fil).
    const rootOf = new Map(rows.map((r) => [r.id, r.parent_id ?? r.id]));
    const resolvedRoots = new Set(rows.filter((r) => !r.parent_id && r.resolved_at).map((r) => r.id));
    const kept = q.resolved === undefined ? rows : rows.filter((r) => resolvedRoots.has(rootOf.get(r.id)!) === (q.resolved === 'true'));
    const items = kept.slice(0, q.limit);
    const last = items.at(-1);
    return { items: items.map(toComment), nextCursor: kept.length > q.limit && last ? encodeCursor({ s: last.seq }) : null };
  });

  app.post('/pages/:id/comments', {
    preHandler: guard('write'),
    schema: { tags: ['comments'], summary: 'Commenter une page (ou répondre à un commentaire)', params: idParams, body: z.object({ body: text, parentId: idSchema.nullable().optional() }) },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    const b = req.body as { body: string; parentId?: string | null };
    if (b.parentId) {
      const parent = byPage(page.id, b.parentId);
      if (!parent || parent.deleted_at || parent.parent_id) throw new HttpError(400, 'Réponse possible uniquement à un commentaire de premier niveau existant');
    }
    const id = newId();
    const now = Date.now();
    db.prepare('INSERT INTO page_comments (id, page_id, parent_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, page.id, b.parentId ?? null, auth.user.id, b.body, now, now);
    const row = toComment(byPage(page.id, id)!);
    announce('comment.created', page.space_id, page.id, req, { commentId: id });
    return reply.status(201).send(row);
  });

  app.patch('/pages/:id/comments/:cid', {
    preHandler: guard('write'),
    schema: { tags: ['comments'], summary: 'Modifier son commentaire ou résoudre un fil', params: commentParams, body: z.object({ body: text.optional(), resolved: z.boolean().optional() }) },
  }, async (req) => {
    const auth = requireAuth(req);
    const { id, cid } = req.params as { id: string; cid: string };
    const page = loadWritablePage(db, req, id);
    const row = byPage(page.id, cid);
    if (!row || row.deleted_at) throw new HttpError(404, 'Commentaire introuvable');
    const b = req.body as { body?: string; resolved?: boolean };
    if (b.body !== undefined && row.author_id !== auth.user.id) throw new HttpError(403, 'Seul l’auteur peut modifier son commentaire');
    if (b.resolved !== undefined && row.parent_id) throw new HttpError(400, 'Seul un commentaire de premier niveau peut être résolu');
    const now = Date.now();
    if (b.body !== undefined) db.prepare('UPDATE page_comments SET body = ?, updated_at = ? WHERE id = ?').run(b.body, now, cid);
    if (b.resolved !== undefined) db.prepare('UPDATE page_comments SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?').run(b.resolved ? now : null, b.resolved ? auth.user.id : null, now, cid);
    announce('comment.updated', page.space_id, page.id, req, { commentId: cid });
    return toComment(byPage(page.id, cid)!);
  });

  app.delete('/pages/:id/comments/:cid', {
    preHandler: guard('write'),
    schema: { tags: ['comments'], summary: 'Supprimer un commentaire (auteur ou administrateur)', params: commentParams },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id, cid } = req.params as { id: string; cid: string };
    const page = loadReadablePage(db, req, id);
    const row = byPage(page.id, cid);
    if (!row || row.deleted_at) throw new HttpError(404, 'Commentaire introuvable');
    if (row.author_id !== auth.user.id && auth.user.role !== 'admin') throw new HttpError(403, 'Seul l’auteur ou un administrateur peut supprimer ce commentaire');
    // Suppression logique : le texte est effacé, le fil (réponses) reste cohérent.
    db.prepare("UPDATE page_comments SET deleted_at = ?, body = '', updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), cid);
    if (row.author_id !== auth.user.id) audit(db, req, 'comment.delete', cid, { pageId: page.id });
    announce('comment.deleted', page.space_id, page.id, req, { commentId: cid });
    return reply.status(204).send();
  });

  // ---- Permissions par page --------------------------------------------------------------
  app.get('/pages/:id/permissions', {
    schema: { tags: ['permissions'], summary: 'Permissions d’une page (détail réservé aux administrateurs)', params: idParams },
  }, async (req) => {
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const gov = governingPage(db, page.id);
    const base = { restricted: !!gov, inheritedFrom: gov && gov !== page.id ? gov : null, yourLevel: pageLevel(db, req.auth, page.id) };
    if (req.auth?.user.role !== 'admin' || !req.auth.scopes.has('admin')) return base;
    const names = new Map((db.prepare('SELECT id, name, email FROM users').all() as { id: string; name: string; email: string | null }[]).map((u) => [u.id, u]));
    return { ...base, entries: gov ? entriesOf(db, gov).map((e) => ({ ...e, name: names.get(e.userId)?.name ?? null, email: names.get(e.userId)?.email ?? null })) : [] };
  });

  app.put('/pages/:id/permissions', {
    preHandler: guard('admin'),
    schema: {
      tags: ['permissions'],
      summary: 'Définir les permissions d’une page (administrateur) : liste vide = aucune restriction propre',
      params: idParams,
      body: z.object({ entries: z.array(z.object({ userId: idSchema, level: z.enum(['read', 'write']) })).max(100) }),
    },
  }, async (req) => {
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const { entries } = req.body as { entries: { userId: string; level: 'read' | 'write' }[] };
    if (new Set(entries.map((e) => e.userId)).size !== entries.length) throw new HttpError(400, 'Utilisateur en double');
    const known = db.prepare('SELECT id FROM users WHERE id = ? AND disabled = 0');
    for (const e of entries) if (!known.get(e.userId)) throw new HttpError(400, `Utilisateur inconnu ou désactivé : ${e.userId}`);
    db.transaction(() => {
      db.prepare('DELETE FROM page_acl WHERE page_id = ?').run(page.id);
      const ins = db.prepare('INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, ?)');
      for (const e of entries) ins.run(page.id, e.userId, e.level);
    })();
    audit(db, req, 'page.permissions', page.id, { entries: entries.length });
    // Les sessions de co-édition en cours se reconnectent : l'accès est revérifié.
    app.collab?.evictAll();
    bus.publish({ type: 'page.permissions', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });
    return { restricted: entries.length > 0, entries };
  });

  // ---- Notifications ---------------------------------------------------------------------
  interface NotifRow { id: string; type: string; page_id: string; title: string; icon: string; space_id: string; actor_id: string | null; actor_name: string | null; count: number; created_at: number; read_at: number | null }
  const inbox = (userId: string, unreadOnly: boolean, after: { c: number; i: string } | null, max: number) => db.prepare(
    `SELECT n.id, n.type, n.page_id, p.title, p.icon, p.space_id, n.actor_id, u.name AS actor_name, n.count, n.created_at, n.read_at
     FROM notifications n JOIN pages p ON p.id = n.page_id LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? AND p.deleted_at IS NULL AND (? = 0 OR n.read_at IS NULL)
       AND (? IS NULL OR n.created_at < ? OR (n.created_at = ? AND n.id < ?))
     ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
  ).all(userId, unreadOnly ? 1 : 0, after ? 1 : null, after?.c ?? 0, after?.c ?? 0, after?.i ?? '', max) as NotifRow[];
  // Accès relu à la lecture : une page devenue restreinte disparaît de la boîte de réception.
  const visible = (req: Parameters<typeof requireAuth>[0], rows: NotifRow[]) => filterReadable(db, req.auth, rows.map((r) => ({ ...r, id: r.page_id, nid: r.id }))).map((r) => ({ ...r, id: r.nid }));
  const toItem = (r: NotifRow) => ({
    id: r.id, type: r.type, count: r.count, createdAt: r.created_at, read: !!r.read_at,
    page: { id: r.page_id, title: r.title, icon: r.icon, spaceId: r.space_id },
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
  });

  app.get('/notifications', {
    schema: { tags: ['notifications'], summary: 'Boîte de réception (pagination par curseur)', querystring: pageQuery.extend({ unread: z.enum(['true', 'false']).default('false') }) },
  }, async (req) => {
    const auth = requireAuth(req);
    const q = req.query as { cursor?: string; limit: number; unread: 'true' | 'false' };
    const after = decodeCursor(q.cursor, z.object({ c: z.number(), i: z.string() }));
    // Les pages devenues restreintes sont filtrées après lecture : on relit par lots jusqu'à remplir la page demandée.
    const rows: NotifRow[] = [];
    let cursor = after;
    for (let round = 0; round < 20 && rows.length <= q.limit; round++) {
      const batch = inbox(auth.user.id, q.unread === 'true', cursor, q.limit * 2);
      if (!batch.length) break;
      rows.push(...(visible(req, batch) as unknown as NotifRow[]));
      const last = batch.at(-1)!;
      cursor = { c: last.created_at, i: last.id };
      if (batch.length < q.limit * 2) break;
    }
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return { items: items.map(toItem), nextCursor: rows.length > q.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null };
  });

  app.get('/notifications/unread-count', { schema: { tags: ['notifications'], summary: 'Nombre de notifications non lues' } }, async (req) => {
    const auth = requireAuth(req);
    return { unread: visible(req, inbox(auth.user.id, true, null, 500)).length };
  });

  app.post('/notifications/read', {
    schema: { tags: ['notifications'], summary: 'Marquer comme lues (ids, ou all)', body: z.object({ ids: z.array(idSchema).max(200).optional(), all: z.boolean().optional() }).refine((b) => b.all || b.ids?.length, 'ids ou all requis') },
  }, async (req) => {
    const auth = requireAuth(req);
    const b = req.body as { ids?: string[]; all?: boolean };
    const now = Date.now();
    let changes = 0;
    if (b.all) changes = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, auth.user.id).changes;
    else for (const id of b.ids!) changes += db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now, id, auth.user.id).changes;
    return { updated: changes };
  });

  const prefsBody = z.object({ emailComments: z.boolean(), emailChanges: z.boolean() });
  app.get('/notifications/preferences', { schema: { tags: ['notifications'], summary: 'Préférences d’e-mail' } }, async (req) =>
    ({ ...getPrefs(db, requireAuth(req).user.id), emailAvailable: app.mail.enabled }));
  app.put('/notifications/preferences', { schema: { tags: ['notifications'], summary: 'Modifier les préférences d’e-mail', body: prefsBody } }, async (req) => {
    const auth = requireAuth(req);
    const b = req.body as z.output<typeof prefsBody>;
    db.prepare(
      `INSERT INTO notification_prefs (user_id, email_comments, email_changes) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email_comments = excluded.email_comments, email_changes = excluded.email_changes`,
    ).run(auth.user.id, b.emailComments ? 1 : 0, b.emailChanges ? 1 : 0);
    // Valeurs relues en base : la réponse ne reprend jamais le corps de la requête.
    return { ...getPrefs(db, auth.user.id), emailAvailable: app.mail.enabled };
  });

  // ---- Suivi de page ---------------------------------------------------------------------
  const isWatching = (userId: string, pageId: string) => !!db.prepare('SELECT 1 FROM page_watch WHERE user_id = ? AND page_id = ?').get(userId, pageId);
  app.get('/pages/:id/watch', { schema: { tags: ['notifications'], summary: 'Suis-je cette page ?', params: idParams } }, async (req) => {
    const auth = requireAuth(req);
    return { watching: isWatching(auth.user.id, loadReadablePage(db, req, (req.params as { id: string }).id).id) };
  });
  app.put('/pages/:id/watch', { schema: { tags: ['notifications'], summary: 'Suivre une page', params: idParams } }, async (req) => {
    const auth = requireAuth(req);
    watch(db, auth.user.id, loadReadablePage(db, req, (req.params as { id: string }).id).id);
    return { watching: true };
  });
  app.delete('/pages/:id/watch', { schema: { tags: ['notifications'], summary: 'Ne plus suivre une page', params: idParams } }, async (req) => {
    const auth = requireAuth(req);
    db.prepare('DELETE FROM page_watch WHERE user_id = ? AND page_id = ?').run(auth.user.id, (req.params as { id: string }).id);
    return { watching: false };
  });
}
