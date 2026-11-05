// Conversion des images base64 en pièces jointes (administrateurs) : état, estimation, lancement et retour arrière.
// La conversion tourne en tâche de fond dans le serveur, par lots ; une seule exécution à la fois (y compris avec la commande
// en ligne `cli.js migrate-images`). Lancer ou défaire : session web d'un administrateur (pas de jeton), débit limité, journalisé.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { attachmentsDir } from '../lib/attachments.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import {
  dryRun, type MigrationContext, migrationStatus, REASON_LABELS, releaseStaleServerRuns, runDetail, type RunStats, startConversion, startRevert, toRun, type RunRow,
} from '../lib/image-migration.js';

const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'identifiant invalide');
const startBody = z.object({ action: z.enum(['dry-run', 'convert', 'revert']), runId: runId.optional() })
  .refine((b) => (b.action === 'revert') === (b.runId !== undefined), 'runId est attendu pour un retour arrière, et seulement pour lui');

export default async function imageMigrationRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['admin'];
  const MB = 1024 * 1024;
  let stopping = false;
  let current: Promise<unknown> | null = null;

  // Une exécution du serveur ne survit pas à son arrêt : celle restée « en cours » est marquée interrompue (reprise possible).
  releaseStaleServerRuns(db);
  app.addHook('onClose', async () => { stopping = true; await current; });

  const context = (req: FastifyRequest): MigrationContext => ({
    db,
    filesDir: attachmentsDir(config.DATA_DIR),
    limits: { totalBytes: config.ATTACHMENTS_TOTAL_MB * MB, userBytes: config.ATTACHMENT_USER_MB * MB, fileBytes: config.ATTACHMENT_MAX_MB * MB },
    busy: (pageId) => app.collab?.isOpen(pageId) ?? false,
    source: 'api',
    startedBy: req.auth?.user.id ?? null,
    onChanged: (p) => app.bus.publish({ type: 'page.updated', spaceId: p.spaceId, pageId: p.id, version: p.version, quiet: true }),
    shouldStop: () => stopping,
    yieldBetweenBatches: () => new Promise((done) => setImmediate(done)),
  });

  app.get('/admin/images/migration', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Conversion des images base64 : pages concernées, exécution en cours et dernières exécutions' },
  }, async () => ({ ...migrationStatus(db), labels: REASON_LABELS }));

  app.get('/admin/images/migration/runs/:runId', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Détail d’une exécution : pages converties, rétablies ou ignorées (avec le motif)', params: z.object({ runId }) },
  }, async (req) => runDetail(db, (req.params as { runId: string }).runId));

  app.post('/admin/images/migration', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags, summary: 'Estimer (dry-run), lancer la conversion des images base64, ou défaire une conversion (revert)', body: startBody },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    const body = req.body as z.output<typeof startBody>;
    const ctx = context(req);
    if (body.action === 'dry-run') {
      const report = dryRun(ctx);
      audit(db, req, 'images.migration.dryrun', null, { pages: report.pages, images: report.images, bytes: report.bytes });
      return report;
    }
    const started = body.action === 'convert' ? startConversion(ctx) : startRevert(ctx, body.runId!);
    audit(db, req, body.action === 'convert' ? 'images.migration.start' : 'images.migration.revert', started.id, body.runId ? { reverts: body.runId } : undefined);
    const done = (stats: RunStats | null, error?: Error) =>
      audit(db, req, 'images.migration.end', started.id, error ? { error: error.message.slice(0, 200) } : { ...stats, reasons: stats?.reasons });
    // Lancée après la réponse : la requête ne porte pas le premier lot.
    current = new Promise((go) => setImmediate(go)).then(() => started.run())
      .then((stats) => done(stats))
      .catch((err: Error) => { req.log.error({ err }, 'conversion des images : échec'); done(null, err); })
      .finally(() => { current = null; });
    const row = db.prepare('SELECT * FROM image_migration_runs WHERE id = ?').get(started.id) as RunRow;
    return reply.status(202).send(toRun(row));
  });
}
