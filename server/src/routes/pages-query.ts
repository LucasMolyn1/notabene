// Pages (lecture et modification) : listes paginées par curseur avec filtres, ETag / If-Match, recherche paginée.
// La logique métier reste celle de lib/ ; seuls la forme des réponses et le contrôle de concurrence changent.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadReadablePage, loadWritablePage, readableSpaceIds } from '../lib/access.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { filterReadable } from '../lib/page-acl.js';
import { isFavorite, listPages, searchPages, toMeta, toPage, updatePage } from '../lib/pages.js';

const patchBody = z.object({
  title: z.string().max(300).optional(),
  icon: z.string().max(16).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  fullWidth: z.boolean().optional(),
});

const etag = (version: number) => `"${version}"`;

export default async function pageQueryRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['pages'];
  const userId = (req: FastifyRequest) => req.auth?.user.id ?? null;

  app.get('/pages', {
    schema: {
      tags,
      summary: 'Lister les pages (pagination par curseur, filtres)',
      querystring: pageQuery.extend({
        spaceId: idSchema.optional(),
        parentId: z.union([idSchema, z.literal('root')]).optional(),
        q: z.string().trim().max(200).optional(),
        updatedAfter: z.coerce.number().int().min(0).optional(),
      }),
    },
  }, async (req) => {
    const f = req.query as { cursor?: string; limit: number; spaceId?: string; parentId?: string; q?: string; updatedAfter?: number };
    const after = decodeCursor(f.cursor, z.object({ c: z.number(), i: z.string() }));
    const spaces = readableSpaceIds(db, req).filter((s) => !f.spaceId || s === f.spaceId);
    const needle = f.q?.toLowerCase();
    const rows = filterReadable(db, req.auth, listPages(db, spaces, userId(req)))
      .filter((p) => (f.parentId === undefined || p.parentId === (f.parentId === 'root' ? null : f.parentId))
        && (needle === undefined || p.title.toLowerCase().includes(needle))
        && (f.updatedAfter === undefined || p.updatedAt > f.updatedAfter))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((p) => !after || p.createdAt > after.c || (p.createdAt === after.c && p.id > after.i));
    const items = rows.slice(0, f.limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > f.limit && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null };
  });

  app.get('/pages/:id', { schema: { tags, summary: 'Lire une page (en-tête ETag = version)', params: idParams } }, async (req, reply) => {
    const row = loadReadablePage(db, req, (req.params as { id: string }).id);
    reply.header('etag', etag(row.version));
    return toPage(row, isFavorite(db, userId(req), row.id));
  });

  app.patch('/pages/:id', {
    preHandler: async (req) => { if (!req.auth) throw new HttpError(401, 'Authentification requise'); },
    schema: { tags, summary: 'Modifier une page : If-Match (ETag) obligatoire pour changer le contenu', params: idParams, body: patchBody },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!req.auth?.scopes.has('write') || req.auth.user.role === 'reader') throw new HttpError(403, 'Permission insuffisante');
    loadWritablePage(db, req, id);
    const body = req.body as z.output<typeof patchBody>;
    const header = req.headers['if-match'];
    const match = typeof header === 'string' ? /^"?(\d{1,12})"?$/.exec(header.trim()) : null;
    if (typeof header === 'string' && !match) throw new HttpError(400, 'En-tête If-Match invalide (attendu : la valeur de l’ETag)');
    if (body.content !== undefined && !match) throw new HttpError(428, 'En-tête If-Match requis pour modifier le contenu : envoyez l’ETag reçu à la lecture');
    let row;
    try {
      row = updatePage(db, id, { ...body, baseVersion: match ? Number(match[1]) : undefined }, userId(req));
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) throw new HttpError(412, 'La page a changé depuis votre lecture (ETag périmé)', err.details);
      throw err;
    }
    bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: id, version: row.version, by: { id: req.auth.user.id, name: req.auth.user.name } });
    reply.header('etag', etag(row.version));
    return toMeta(row, isFavorite(db, userId(req), id));
  });

  app.get('/search', {
    schema: { tags: ['search'], summary: 'Recherche plein texte paginée', querystring: pageQuery.extend({ q: z.string().trim().min(1).max(200) }) },
  }, async (req) => {
    const { q, limit, cursor } = req.query as { q: string; limit: number; cursor?: string };
    const { o: offset } = decodeCursor(cursor, z.object({ o: z.number().int().min(0).max(1000) })) ?? { o: 0 };
    // Le classement est recalculé à chaque appel : le curseur est un décalage dans la liste filtrée (limité à 500 résultats).
    const all = filterReadable(db, req.auth, searchPages(db, q, readableSpaceIds(db, req), 500))
      .map(({ text: _text, rank: _rank, ...r }) => r);
    const items = all.slice(offset, offset + limit);
    return { items, nextCursor: offset + limit < all.length ? encodeCursor({ o: offset + limit }) : null };
  });
}
