// Pages : CRUD, arborescence, corbeille, favoris, versions, export et recherche.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { toMarkdown } from '../lib/markdown.js';
import {
  createPage, destroyPage, duplicatePage, getPageRow, getVersion, isFavorite, listPages, listVersions,
  movePage, type PageRow, restorePage, searchPages, toMeta, toPage, trashPage, updatePage,
} from '../lib/pages.js';

const title = z.string().max(300);
const icon = z.string().max(16);
const content = z.record(z.string(), z.unknown());

const createBody = z.object({
  spaceId: idSchema,
  parentId: idSchema.nullable().optional(),
  title: title.optional(),
  icon: icon.optional(),
  content: content.optional(),
  afterId: idSchema.nullable().optional(),
});

const updateBody = z.object({
  title: title.optional(),
  icon: icon.optional(),
  content: content.optional(),
  fullWidth: z.boolean().optional(),
  baseVersion: z.number().int().positive().optional(),
});

const moveBody = z.object({
  parentId: idSchema.nullable(),
  index: z.number().int().min(0).optional(),
  spaceId: idSchema.optional(),
});

export default async function pageRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['pages'];
  const by = (req: FastifyRequest) => (req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined);
  const userId = (req: FastifyRequest) => req.auth?.user.id ?? null;

  // Une page modifiable doit d'abord être lisible (sinon 404).
  const writable = (req: FastifyRequest, id: string, opts?: { allowTrashed?: boolean }) => loadReadablePage(db, req, id, opts);

  app.get('/pages', {
    schema: { tags, summary: 'Lister les pages (métadonnées, sans contenu)', querystring: z.object({ spaceId: idSchema.optional() }) },
  }, async (req) => {
    const { spaceId } = req.query as { spaceId?: string };
    const spaces = readableSpaceIds(db, req).filter((s) => !spaceId || s === spaceId);
    return listPages(db, spaces, userId(req));
  });

  app.post('/pages', { preHandler: guard('write'), schema: { tags, summary: 'Créer une page', body: createBody } }, async (req, reply) => {
    const body = req.body as z.output<typeof createBody>;
    if (!readableSpaceIds(db, req).includes(body.spaceId)) throw new HttpError(404, 'Espace introuvable');
    const row = createPage(db, body, userId(req));
    bus.publish({ type: 'page.created', spaceId: row.space_id, pageId: row.id, version: row.version, by: by(req) });
    return reply.status(201).send(toPage(row));
  });

  app.get('/pages/:id', { schema: { tags, summary: 'Lire une page avec son contenu', params: idParams } }, async (req) => {
    const row = loadReadablePage(db, req, (req.params as { id: string }).id);
    return toPage(row, isFavorite(db, userId(req), row.id));
  });

  app.get('/pages/:id/export', {
    schema: { tags, summary: 'Exporter une page', params: idParams, querystring: z.object({ format: z.enum(['markdown', 'json']).default('markdown') }) },
  }, async (req, reply) => {
    const row = loadReadablePage(db, req, (req.params as { id: string }).id);
    const { format } = req.query as { format: 'markdown' | 'json' };
    if (format === 'json') return toPage(row);
    const visible = new Set(readableSpaceIds(db, req));
    const titleOf = (id: string) => {
      const p = getPageRow(db, id);
      return p && visible.has(p.space_id) && !p.deleted_at ? p.title || 'Sans titre' : null;
    };
    return reply.type('text/markdown; charset=utf-8').send(toMarkdown(row.title, row.icon, JSON.parse(row.content), titleOf));
  });

  app.patch('/pages/:id', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Modifier une page (baseVersion pour détecter les conflits)', params: idParams, body: updateBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    writable(req, id);
    const row = updatePage(db, id, req.body as z.output<typeof updateBody>, userId(req));
    bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: id, version: row.version, by: by(req) });
    return toMeta(row, isFavorite(db, userId(req), id));
  });

  app.post('/pages/:id/move', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Déplacer une page dans l’arborescence', params: idParams, body: moveBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    writable(req, id);
    const body = req.body as z.output<typeof moveBody>;
    if (body.spaceId && !readableSpaceIds(db, req).includes(body.spaceId)) throw new HttpError(404, 'Espace introuvable');
    const { row, fromSpaceId } = movePage(db, id, body);
    bus.publish({ type: 'page.moved', spaceId: row.space_id, pageId: id, version: row.version, by: by(req) });
    if (fromSpaceId !== row.space_id) bus.publish({ type: 'page.moved', spaceId: fromSpaceId, pageId: id, by: by(req) });
    return toMeta(row);
  });

  app.post('/pages/:id/duplicate', { preHandler: guard('write'), schema: { tags, summary: 'Dupliquer une page', params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    writable(req, id);
    const row = duplicatePage(db, id, userId(req));
    bus.publish({ type: 'page.created', spaceId: row.space_id, pageId: row.id, by: by(req) });
    return reply.status(201).send(toMeta(row));
  });

  app.delete('/pages/:id', { preHandler: guard('write'), schema: { tags, summary: 'Mettre une page (et ses sous-pages) à la corbeille', params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = writable(req, id);
    trashPage(db, id);
    bus.publish({ type: 'page.trashed', spaceId: row.space_id, pageId: id, by: by(req) });
    return reply.status(204).send();
  });

  app.get('/trash', { preHandler: guard('write'), schema: { tags, summary: 'Lister la corbeille' } }, async (req) =>
    listPages(db, readableSpaceIds(db, req), userId(req), { trashed: true }));

  app.post('/pages/:id/restore', { preHandler: guard('write'), schema: { tags, summary: 'Restaurer une page de la corbeille', params: idParams } }, async (req) => {
    const { id } = req.params as { id: string };
    writable(req, id, { allowTrashed: true });
    const row = restorePage(db, id);
    bus.publish({ type: 'page.restored', spaceId: row.space_id, pageId: id, by: by(req) });
    return toMeta(row);
  });

  app.delete('/pages/:id/permanent', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Supprimer définitivement une page de la corbeille (admin)', params: idParams },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    writable(req, id, { allowTrashed: true });
    const row = destroyPage(db, id);
    audit(db, req, 'page.destroy', id, { title: row.title });
    bus.publish({ type: 'page.deleted', spaceId: row.space_id, pageId: id, by: by(req) });
    return reply.status(204).send();
  });

  app.delete('/trash', { preHandler: guard('admin'), schema: { tags, summary: 'Vider la corbeille (admin)' } }, async (req, reply) => {
    const trashed = listPages(db, readableSpaceIds(db, req), null, { trashed: true });
    for (const p of trashed) destroyPage(db, p.id);
    audit(db, req, 'trash.empty', null, { count: trashed.length });
    for (const spaceId of new Set(trashed.map((p) => p.spaceId))) bus.publish({ type: 'page.deleted', spaceId, by: by(req) });
    return reply.status(204).send();
  });

  app.put('/pages/:id/favorite', { schema: { tags, summary: 'Ajouter aux favoris', params: idParams } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    loadReadablePage(db, req, id);
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, page_id) VALUES (?, ?)').run(auth.user.id, id);
    return reply.status(204).send();
  });

  app.delete('/pages/:id/favorite', { schema: { tags, summary: 'Retirer des favoris', params: idParams } }, async (req, reply) => {
    const auth = requireAuth(req);
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND page_id = ?').run(auth.user.id, (req.params as { id: string }).id);
    return reply.status(204).send();
  });

  app.get('/pages/:id/versions', { schema: { tags, summary: 'Historique des versions', params: idParams } }, async (req) => {
    const row = loadReadablePage(db, req, (req.params as { id: string }).id);
    return listVersions(db, row.id);
  });

  const versionParams = z.object({ id: idSchema, versionId: z.coerce.number().int().positive() });

  app.get('/pages/:id/versions/:versionId', { schema: { tags, summary: 'Lire une version', params: versionParams } }, async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: number };
    loadReadablePage(db, req, id);
    return getVersion(db, id, versionId);
  });

  app.post('/pages/:id/versions/:versionId/restore', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Restaurer une version', params: versionParams },
  }, async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: number };
    writable(req, id);
    const v = getVersion(db, id, versionId);
    const row: PageRow = updatePage(db, id, { title: v.title, content: v.content }, userId(req));
    bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: id, version: row.version, by: by(req) });
    return toMeta(row);
  });

  app.get('/search', {
    schema: {
      tags: ['search'],
      summary: 'Recherche plein texte (insensible aux accents)',
      querystring: z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }),
    },
  }, async (req) => {
    const { q, limit } = req.query as { q: string; limit: number };
    return searchPages(db, q, readableSpaceIds(db, req), limit).map(({ text: _text, rank: _rank, ...r }) => r);
  });
}
