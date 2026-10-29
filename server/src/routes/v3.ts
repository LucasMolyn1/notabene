// Fonctions ajoutées en v3 : commentaires de page et permissions fines par page.
// Les droits restent ceux de l'appelant : une permission fine ne fait que restreindre l'accès.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { entriesOf, governingPage, pageLevel } from '../lib/page-acl.js';

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
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
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
    const page = loadReadablePage(db, req, id);
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
}
