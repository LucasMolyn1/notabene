// Journal d'audit (admin) : liste filtrée et paginée par curseur, export CSV ou JSON en flux, état de l'envoi au SIEM,
// et lecture des durées de conservation. Format des évènements : lib/audit-events.ts et docs/AUDIT.md.
// La configuration du SIEM passe par /admin/settings/siem (ressaisie du mot de passe et test d'envoi obligatoires).
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import {
  type AuditFilters, auditFilters, auditMaxId, auditPage, auditWhere, CSV_COLUMNS, csvLine, FilterError, toAuditEvent,
} from '../lib/audit-events.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { HttpError } from '../lib/http.js';
import { MAX_REPORTS_PER_USER } from './import.js';

// Plafond d'un export (lignes) et taille des lots lus en base : jamais tout le journal en mémoire.
export const EXPORT_MAX_ROWS = 100_000;
const EXPORT_BATCH = 1_000;

const FILTER_KEYS = Object.keys(auditFilters.shape) as (keyof AuditFilters)[];
const filtersOf = (q: Record<string, unknown>): AuditFilters => Object.fromEntries(FILTER_KEYS.filter((k) => q[k] !== undefined).map((k) => [k, q[k]])) as AuditFilters;

const listQuery = auditFilters.extend({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const exportQuery = auditFilters.extend({ format: z.enum(['csv', 'json']).default('csv') });
const cursorSchema = z.object({ i: z.number().int().positive() }).strict();

const where = (f: AuditFilters) => {
  try { return auditWhere(f); } catch (err) {
    if (err instanceof FilterError) throw new HttpError(400, err.message);
    throw err;
  }
};

// Durées de conservation réglables (variables d'environnement *_RETENTION_DAYS) ; 0 = jamais purgé.
const RETENTION: { key: 'AUDIT_RETENTION_DAYS' | 'AUDIT_IP_RETENTION_DAYS' | 'TRASH_RETENTION_DAYS' | 'NOTIFICATION_RETENTION_DAYS' | 'AI_CHAT_RETENTION_DAYS'; label: string; description: string; min?: number }[] = [
  { key: 'AUDIT_RETENTION_DAYS', label: 'Journal d’audit', description: 'Les entrées du journal d’audit sont supprimées après ce délai.' },
  { key: 'AUDIT_IP_RETENTION_DAYS', label: 'Adresses IP du journal d’audit', description: 'L’adresse IP est effacée des entrées plus anciennes ; l’entrée elle-même reste.' },
  { key: 'TRASH_RETENTION_DAYS', label: 'Corbeille', description: 'Les pages placées à la corbeille, avec leurs sous-pages et pièces jointes, sont supprimées définitivement après ce délai.' },
  { key: 'NOTIFICATION_RETENTION_DAYS', label: 'Notifications lues', description: 'Les notifications déjà lues sont supprimées après ce délai ; les non lues sont gardées.' },
  { key: 'AI_CHAT_RETENTION_DAYS', label: 'Conversations du chat IA', description: 'Les conversations sans activité depuis ce délai sont supprimées avec leurs messages (100 conversations au plus par personne).', min: 1 },
];

export default async function auditRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['admin'];

  app.get('/admin/audit/events', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Journal d’audit : évènements filtrés, paginés par curseur', querystring: listQuery },
  }, async (req) => {
    const q = req.query as z.output<typeof listQuery>;
    const f = filtersOf(q);
    where(f); // filtres incohérents : 400 avant toute lecture
    const before = decodeCursor(q.cursor, cursorSchema)?.i ?? null;
    const rows = auditPage(db, f, before, q.limit + 1);
    const items = rows.slice(0, q.limit);
    return { items: items.map(toAuditEvent), nextCursor: rows.length > q.limit ? encodeCursor({ i: items.at(-1)!.id }) : null };
  });

  // Export en flux, par lots, du plus récent au plus ancien. L'export est lui-même journalisé (format, nombre de lignes,
  // filtres employés), sans aucune ligne du journal.
  app.get('/admin/audit/export', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags, summary: 'Exporter le journal d’audit (CSV ou JSON)', querystring: exportQuery },
  }, async (req, reply) => {
    const q = req.query as z.output<typeof exportQuery>;
    const f = filtersOf(q);
    const w = where(f);
    // Instantané : les entrées écrites pendant l'export (dont la sienne) n'y figurent pas.
    const maxId = auditMaxId(db);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${w.sql} AND a.id <= ?`).get(...w.args, maxId) as { n: number }).n;
    const rows = Math.min(total, EXPORT_MAX_ROWS);
    const truncated = total > EXPORT_MAX_ROWS;
    audit(db, req, 'audit.export', null, { format: q.format, rows, truncated, filters: Object.keys(f) });

    function* lines(): Generator<string> {
      const json = q.format === 'json';
      yield json ? '[' : `\uFEFF${CSV_COLUMNS.join(',')}\r\n`;
      let before = maxId + 1;
      let sent = 0;
      while (sent < rows) {
        const batch = auditPage(db, f, before, Math.min(EXPORT_BATCH, rows - sent));
        if (!batch.length) break;
        let chunk = '';
        for (const r of batch) {
          const e = toAuditEvent(r);
          chunk += json ? `${sent ? ',' : ''}\n${JSON.stringify(e)}` : `${csvLine(e)}\r\n`;
          sent++;
        }
        before = batch.at(-1)!.id;
        yield chunk;
      }
      if (json) yield '\n]\n';
    }

    // Nom construit côté serveur, en ASCII : rien de la requête n'entre dans l'en-tête.
    const name = `journal-audit-${new Date().toISOString().slice(0, 10)}.${q.format}`;
    return reply
      .header('content-type', q.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-export-rows', String(rows))
      .header('x-export-truncated', String(truncated))
      .send(Readable.from(lines()));
  });

  // État de l'envoi au SIEM (lecture seule ; aucun secret, origine de l'adresse seulement).
  app.get('/admin/audit/siem', { preHandler: guard('admin'), schema: { tags, summary: 'État de l’envoi du journal d’audit au SIEM' } }, async () =>
    app.auditForwarder.status());

  // Durées de conservation effectives (lecture seule : elles se règlent par variables d'environnement).
  app.get('/admin/retention', { preHandler: guard('admin'), schema: { tags, summary: 'Durées de conservation des données' } }, async () => ({
    purgeIntervalMinutes: 60,
    items: RETENTION.map((r) => {
      const days = Math.max(r.min ?? 0, config[r.key]);
      return { key: r.key, label: r.label, description: r.description, days, purged: days > 0 };
    }),
    fixed: [
      { label: 'Sessions', description: 'Une session expire après sa durée maximale ou après une période sans activité.', value: `${config.SESSION_TTL_HOURS} h, ou ${config.SESSION_IDLE_MINUTES} min sans activité` },
      { label: 'Liens de connexion et de réinitialisation', description: 'Supprimés dès leur expiration.', value: 'à l’expiration' },
      { label: 'Rapports d’import', description: 'Seuls les derniers rapports de chaque personne sont gardés.', value: `${MAX_REPORTS_PER_USER} rapports par personne` },
    ],
  }));
}
