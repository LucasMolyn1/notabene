import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { clonerFor, loadWritablePage, requireSpaceRole } from '../lib/access.js';
import { AttachmentWriter, attachmentsDir } from '../lib/attachments.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { IMPORT_LIMITS, importMarkdown } from '../lib/markdown-import.js';
import { importNotion, type ImportReport } from '../lib/notion-import.js';
import { ZipArchive } from '../lib/zip-read.js';

const body = z.object({
  spaceId: idSchema,
  files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).min(1).max(IMPORT_LIMITS.files),
});

const notionQuery = z.object({
  // Obligatoire et explicite : « true » simule (rien n'est enregistré sauf le rapport), « false » importe.
  dryRun: z.enum(['true', 'false']).transform((v) => v === 'true'),
  parentId: idSchema.optional(),
});

// Rapports gardés par personne (les plus anciens sont supprimés au-delà).
export const MAX_REPORTS_PER_USER = 20;
const MB = 1024 * 1024;

interface ReportRow { id: string; user_id: string; space_id: string; source: string; dry_run: number; created_at: number; summary: string; items: string }
const toReport = (r: ReportRow, full: boolean) => ({
  id: r.id,
  source: r.source,
  spaceId: r.space_id,
  dryRun: !!r.dry_run,
  createdAt: r.created_at,
  summary: JSON.parse(r.summary) as ImportReport['summary'],
  ...(full ? { items: JSON.parse(r.items) as ImportReport['items'] } : {}),
});

export default async function importRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.post('/admin/import/markdown', {
    preHandler: guard('admin'),
    bodyLimit: 32 * 1024 * 1024,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags: ['admin'], summary: 'Importer des fichiers Markdown (export Wiki.js, dossier de notes) dans un espace', body },
  }, async (req) => {
    const { spaceId, files } = req.body as z.output<typeof body>;
    requireSpaceRole(db, req, spaceId, 'edit'); // jamais dans l'espace personnel de quelqu'un d'autre
    const cloner = clonerFor(db, config, req);
    let result;
    try { result = importMarkdown(db, { spaceId, files, userId: req.auth?.user.id ?? null, cloner }); } catch (err) { cloner.rollback(); throw err; }
    audit(db, req, 'import.markdown', spaceId, { files: files.length, ...result });
    app.bus.publish({ type: 'space.changed', spaceId });
    return result;
  });

  // ---- Import Notion (archive ZIP « Markdown & CSV ») ------------------------------------------
  // Corps brut application/zip : analyseur limité à ce plugin, plafonné par IMPORT_ZIP_MAX_MB. L'archive reste en mémoire et
  // n'est jamais écrite sur le disque ; seuls les fichiers joints sont enregistrés, comme des pièces jointes ordinaires.
  const zipLimit = config.IMPORT_ZIP_MAX_MB * MB;
  app.addContentTypeParser(['application/zip', 'application/x-zip-compressed'], { parseAs: 'buffer', bodyLimit: zipLimit }, (_req, payload, done) => done(null, payload));

  app.post('/spaces/:id/import/notion', {
    preHandler: guard('write'),
    bodyLimit: zipLimit,
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['import'],
      summary: 'Importer un export Notion (ZIP « Markdown & CSV ») dans un espace ; dryRun=true simule et rend le même rapport',
      params: idParams, querystring: notionQuery, consumes: ['application/zip'],
    },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const spaceId = (req.params as { id: string }).id;
    const { dryRun, parentId } = req.query as z.output<typeof notionQuery>;
    requireSpaceRole(db, req, spaceId, 'edit');
    if (parentId) {
      const parent = loadWritablePage(db, req, parentId);
      if (parent.space_id !== spaceId) throw new HttpError(404, 'Page introuvable');
    }
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Archive attendue (Content-Type: application/zip)');
    const zip = new ZipArchive(req.body, {
      maxEntries: config.IMPORT_ZIP_MAX_ENTRIES, maxTotalBytes: config.IMPORT_ZIP_UNCOMPRESSED_MB * MB, maxRatio: config.IMPORT_ZIP_MAX_RATIO,
    });
    const writer = new AttachmentWriter(db, attachmentsDir(config.DATA_DIR), auth.user.id, {
      fileBytes: config.ATTACHMENT_MAX_MB * MB, totalBytes: config.ATTACHMENTS_TOTAL_MB * MB, userBytes: config.ATTACHMENT_USER_MB * MB,
    }, dryRun);
    const cloner = clonerFor(db, config, req);
    let report: ImportReport;
    try {
      report = importNotion(db, { zip, spaceId, parentId: parentId ?? null, userId: auth.user.id, auth: req.auth, writer, cloner, dryRun });
    } catch (err) {
      writer.rollback();
      cloner.rollback();
      throw err;
    }
    // Simulation : la transaction a été annulée, les copies éventuelles de fichiers cités sont effacées.
    if (dryRun) cloner.rollback();

    const id = newId();
    const now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO import_reports (id, user_id, space_id, source, dry_run, created_at, summary, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, auth.user.id, spaceId, 'notion', dryRun ? 1 : 0, now, JSON.stringify(report.summary), JSON.stringify(report.items));
      db.prepare(`DELETE FROM import_reports WHERE user_id = ? AND id NOT IN (
        SELECT id FROM import_reports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(auth.user.id, auth.user.id, MAX_REPORTS_PER_USER);
    })();
    // Journal : volumes seulement, jamais de nom de fichier ni de titre.
    audit(db, req, dryRun ? 'import.notion.dry_run' : 'import.notion', spaceId, { report: id, entries: zip.items.length, bytes: req.body.length, ...report.summary });
    if (!dryRun) app.bus.publish({ type: 'space.changed', spaceId });
    return reply.status(dryRun ? 200 : 201).send({ id, source: 'notion', spaceId, parentId: parentId ?? null, dryRun, createdAt: now, ...report });
  });

  // Rapports : ceux de la personne connectée seulement, et seulement si elle lit encore l'espace (sinon : introuvable).
  app.get('/imports', {
    preHandler: guard('read'),
    schema: { tags: ['import'], summary: 'Mes derniers rapports d’import (sans le détail fichier par fichier)' },
  }, async (req) => {
    const auth = requireAuth(req);
    const rows = db.prepare('SELECT * FROM import_reports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(auth.user.id, MAX_REPORTS_PER_USER) as ReportRow[];
    const readable = rows.filter((r) => { try { requireSpaceRole(db, req, r.space_id, 'view'); return true; } catch { return false; } });
    return { items: readable.map((r) => toReport(r, false)) };
  });

  app.get('/imports/:id', {
    preHandler: guard('read'),
    schema: { tags: ['import'], summary: 'Rapport d’import, fichier par fichier', params: idParams },
  }, async (req) => {
    const auth = requireAuth(req);
    const row = db.prepare('SELECT * FROM import_reports WHERE id = ? AND user_id = ?').get((req.params as { id: string }).id, auth.user.id) as ReportRow | undefined;
    if (!row) throw new HttpError(404, 'Rapport introuvable');
    try { requireSpaceRole(db, req, row.space_id, 'view'); } catch { throw new HttpError(404, 'Rapport introuvable'); }
    return toReport(row, true);
  });
}
