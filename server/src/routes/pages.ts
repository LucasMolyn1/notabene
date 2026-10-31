// Pages : CRUD, arborescence, corbeille, favoris, versions, export et recherche.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard, requireAuth } from '../auth/context.js';
import { mentionIds } from '../lib/content.js';
import { copyTree } from '../lib/page-copy.js';
import { readersAmong } from '../lib/mentions.js';
import { loadReadablePage, loadWritablePage, readableSpaceIds, requireSpaceRole } from '../lib/access.js';
import { assertMoveKeepsRestriction, canReadPage, canWritePage, filterReadable, governingPage } from '../lib/page-acl.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { toMarkdown } from '../lib/markdown.js';
import {
  createPage, destroyPage, duplicatePage, getPageRow, getVersion, listPages, listVersions,
  movePage, type PageRow, restorePage, toMeta, toPage, trashPage, updatePage,
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

const moveBody = z.object({
  parentId: idSchema.nullable(),
  index: z.number().int().min(0).optional(),
  spaceId: idSchema.optional(),
});

// Les routes de liste, de lecture, de modification et de recherche sont dans routes/pages-query.ts.
export default async function pageRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['pages'];
  const by = (req: FastifyRequest) => (req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined);
  const userId = (req: FastifyRequest) => req.auth?.user.id ?? null;

  // Une page modifiable doit d'abord être lisible (sinon 404).
  const writable = (req: FastifyRequest, id: string, opts?: { allowTrashed?: boolean }) => loadWritablePage(db, req, id, opts);

  app.post('/pages', { preHandler: guard('write'), schema: { tags, summary: 'Créer une page', body: createBody } }, async (req, reply) => {
    const body = req.body as z.output<typeof createBody>;
    requireSpaceRole(db, req, body.spaceId, 'edit'); // 404 si l'espace n'est pas visible, 403 en lecture seule
    if (body.parentId && !canWritePage(db, req.auth, body.parentId)) throw new HttpError(403, 'Accès en lecture seule sur la page parente');
    const row = createPage(db, body, userId(req));
    bus.publish({ type: 'page.created', spaceId: row.space_id, pageId: row.id, version: row.version, by: by(req) });
    return reply.status(201).send(toPage(row));
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
      return p && visible.has(p.space_id) && !p.deleted_at && canReadPage(db, req.auth, id) ? p.title || 'Sans titre' : null;
    };
    // Les personnes mentionnées ne sont nommées qu'à une personne connectée, et seulement si elles peuvent lire la page.
    const doc = JSON.parse(row.content);
    const names = can(req.auth, 'read') ? new Map(readersAmong(db, row.id, mentionIds(doc), 200).map((u) => [u.id, u.name])) : new Map<string, string>();
    return reply.type('text/markdown; charset=utf-8').send(toMarkdown(row.title, row.icon, doc, titleOf, (id) => names.get(id) ?? null));
  });

  app.post('/pages/:id/move', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Déplacer une page dans l’arborescence', params: idParams, body: moveBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    writable(req, id);
    const body = req.body as z.output<typeof moveBody>;
    if (body.spaceId) requireSpaceRole(db, req, body.spaceId, 'edit'); // déplacer vers un espace : y écrire
    if (body.parentId && !canWritePage(db, req.auth, body.parentId)) throw new HttpError(403, 'Accès en lecture seule sur la page parente');
    assertMoveKeepsRestriction(db, req.auth, id, body.parentId);
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

  // Copie d'une page et de ses sous-pages (que la personne peut lire) vers un espace, l'original restant en place.
  const copyBody = z.object({ spaceId: idSchema, parentId: idSchema.nullable().optional() });
  app.post('/pages/:id/copy', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Copier une page et ses sous-pages lisibles vers un espace (la copie reste aussi restreinte que la source)', params: idParams, body: copyBody },
  }, async (req, reply) => {
    const src = loadReadablePage(db, req, (req.params as { id: string }).id);
    const body = req.body as z.output<typeof copyBody>;
    requireSpaceRole(db, req, body.spaceId, 'edit');
    if (body.parentId && !canWritePage(db, req.auth, body.parentId)) throw new HttpError(403, 'Accès en lecture seule sur la page parente');
    const result = copyTree(db, src.id, { spaceId: body.spaceId, parentId: body.parentId ?? null }, userId(req), (pid) => canReadPage(db, req.auth, pid));
    audit(db, req, 'page.copy', src.id, { to: body.spaceId, pages: result.count, skipped: result.skipped });
    bus.publish({ type: 'space.changed', spaceId: body.spaceId, by: by(req) });
    return reply.status(201).send({ page: toMeta(result.root), count: result.count, skipped: result.skipped });
  });

  app.delete('/pages/:id', { preHandler: guard('write'), schema: { tags, summary: 'Mettre une page (et ses sous-pages) à la corbeille', params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = writable(req, id);
    trashPage(db, id);
    bus.publish({ type: 'page.trashed', spaceId: row.space_id, pageId: id, by: by(req) });
    return reply.status(204).send();
  });

  app.get('/trash', { preHandler: guard('write'), schema: { tags, summary: 'Lister la corbeille' } }, async (req) =>
    filterReadable(db, req.auth, listPages(db, readableSpaceIds(db, req), userId(req), { trashed: true })));

  app.post('/pages/:id/restore', { preHandler: guard('write'), schema: { tags, summary: 'Restaurer une page de la corbeille', params: idParams } }, async (req) => {
    const { id } = req.params as { id: string };
    const trashed = writable(req, id, { allowTrashed: true });
    // Parent encore dans la corbeille : la page remonterait à la racine et perdrait la restriction qui la protège.
    const parent = trashed.parent_id ? getPageRow(db, trashed.parent_id) : null;
    if (parent?.deleted_at && governingPage(db, parent.id) && req.auth?.user.role !== 'admin') {
      throw new HttpError(409, 'Restaurez d’abord la page parente (zone restreinte) ou demandez à un administrateur');
    }
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
    const trashed = filterReadable(db, req.auth, listPages(db, readableSpaceIds(db, req), null, { trashed: true }));
    // Une racine peut avoir disparu avec une autre (sous-page en cascade) : on ne détruit que ce qui reste, en une seule transaction.
    db.transaction(() => { for (const p of trashed) if (getPageRow(db, p.id)) destroyPage(db, p.id); })();
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

}
