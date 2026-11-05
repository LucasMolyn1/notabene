// Export ZIP (API v3) : une page avec ou sans ses sous-pages, ou un espace entier, en Markdown ou en HTML (lib/export-zip.ts).
// Réservé à une personne connectée (ou un jeton de lecture) : l'export est coûteux, un visiteur d'espace public n'y a pas accès.
// Droits revérifiés page par page et fichier par fichier ; débit limité et nombre d'exports simultanés borné ; journalisé.
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireScope } from '../auth/context.js';
import { loadReadablePage, requireSpaceRole } from '../lib/access.js';
import { attachmentsDir } from '../lib/attachments.js';
import { audit } from '../lib/audit.js';
import { buildExport, type ExportFormat, INLINE_IMAGES_MAX_BYTES } from '../lib/export-zip.js';
import { HttpError, idParams } from '../lib/http.js';

const pageQuery = z.object({ format: z.enum(['md', 'html']).default('md'), subpages: z.enum(['true', 'false']).default('false') });
const spaceQuery = z.object({ format: z.enum(['md', 'html']).default('md') });

// Exports en cours : au plus un par personne et trois sur l'instance (chacun lit la base et des fichiers).
export const MAX_CONCURRENT_EXPORTS = 3;
// Client muet plus longtemps que ce délai (lecture arrêtée sans fermer) : la connexion est coupée et le créneau rendu.
export const EXPORT_IDLE_MS = 60_000;

// Nom du fichier proposé au téléchargement : ASCII sûr (le titre n'y entre pas tel quel).
const downloadName = (title: string) => (title || 'export').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';

type Built = Awaited<ReturnType<typeof buildExport>>;

export default async function exportRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['export'];
  const filesDir = attachmentsDir(config.DATA_DIR);
  const limits = { maxPages: config.EXPORT_MAX_PAGES, maxBytes: config.EXPORT_MAX_MB * 1024 * 1024, inlineBytes: INLINE_IMAGES_MAX_BYTES };
  const running = new Set<string>();

  const send = async (req: FastifyRequest, reply: FastifyReply, name: string, build: () => Promise<Built>, log: (s: Built['summary']) => void) => {
    const userId = requireScope(req, 'read').user.id;
    if (running.has(userId)) throw new HttpError(429, 'Un export est déjà en cours pour votre compte : attendez sa fin');
    if (running.size >= MAX_CONCURRENT_EXPORTS) throw new HttpError(429, 'Trop d’exports en cours : réessayez dans un instant');
    // Créneau pris dès le début (préparation comprise) et rendu une seule fois : fin du flux, erreur ou connexion coupée.
    running.add(userId);
    let released = false;
    const release = () => { if (!released) { released = true; running.delete(userId); } };
    try {
      // Archive préparée avant les en-têtes : un plafond dépassé est une vraie réponse 413.
      const { stream, summary } = await build();
      log(summary);
      const body = Readable.from(stream);
      body.once('close', release);
      body.once('error', release);
      reply.raw.once('close', release);
      try { reply.raw.setTimeout(EXPORT_IDLE_MS, () => { body.destroy(); reply.raw.destroy(); release(); }); } catch { /* transport sans délai (tests) */ }
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${name}.zip"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(body);
    } catch (err) {
      release();
      throw err;
    }
  };

  app.get('/pages/:id/export/zip', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags, summary: 'Exporter une page en ZIP (Markdown ou HTML), avec ses sous-pages lisibles si subpages=true', params: idParams, querystring: pageQuery,
    },
  }, async (req, reply) => {
    requireScope(req, 'read');
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const q = req.query as z.output<typeof pageQuery>;
    const format = q.format as ExportFormat;
    const subpages = q.subpages === 'true';
    return send(req, reply, downloadName(page.title),
      () => buildExport(db, req, { spaceId: page.space_id, rootIds: [page.id], subpages, format, filesDir, limits }),
      (s) => audit(db, req, 'page.export.zip', page.id, { format, subpages, ...s }));
  });

  app.get('/spaces/:id/export/zip', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Exporter un espace en ZIP (Markdown ou HTML) : pages lisibles, hors corbeille', params: idParams, querystring: spaceQuery },
  }, async (req, reply) => {
    requireScope(req, 'read');
    const { id } = req.params as { id: string };
    requireSpaceRole(db, req, id, 'view'); // 404 si l'espace n'est pas visible
    const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(id) as { name: string };
    const format = (req.query as z.output<typeof spaceQuery>).format as ExportFormat;
    const roots = (db.prepare('SELECT id FROM pages WHERE space_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY position, created_at').all(id) as { id: string }[]).map((r) => r.id);
    return send(req, reply, downloadName(space.name),
      () => buildExport(db, req, { spaceId: id, rootIds: roots, subpages: true, format, filesDir, limits }),
      (s) => audit(db, req, 'space.export.zip', id, { format, ...s }));
  });
}
