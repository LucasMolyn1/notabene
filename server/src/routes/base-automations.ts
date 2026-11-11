// Automatisations et boutons de ligne d'une base (règles de sécurité : lib/base-automations.ts).
// Accès : lister, créer, modifier, supprimer et voir l'historique demandent le droit d'écriture sur la base ; cliquer un bouton
// aussi (l'action agit avec les droits de la personne qui clique). Les lecteurs voient seulement les boutons, dans GET /bases/:id.
// Le réglage d'instance des webhooks d'automatisation est réservé aux administrateurs (désactivé par défaut).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard } from '../auth/context.js';
import { loadWritablePage, readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import {
  actionsInput, automationById, automationsOf, MAX_ACTIONS, MAX_AUTOMATIONS, MAX_BASE_RUNS_PER_MINUTE, MAX_FAILURES, MAX_FILTERS,
  MAX_RECIPIENTS, MAX_ROWS_TOUCHED, MAX_RUNS_PER_HOUR, MAX_RUNS_PER_MINUTE, presentAutomation, resigns, rotateSecret, runsOf,
  saveAutomation, setWebhooksEnabled, triggerSchema, webhooksEnabled, type AutomationRow, type SaveInput,
} from '../lib/base-automations.js';
import { cleanName, presentRows, propertiesOf, readBudget } from '../lib/bases.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { inPersonalSpace } from '../lib/personal-spaces.js';
import type { PageRow } from '../lib/pages.js';
import { assertSafeUrl } from '../lib/webhooks.js';

const name = cleanName(80);
const createBody = z.object({ name, enabled: z.boolean().optional(), trigger: triggerSchema, actions: actionsInput }).strict();
const patchBody = z.object({ name: name.optional(), enabled: z.boolean().optional(), trigger: triggerSchema.optional(), actions: actionsInput.optional() }).strict();
const autoParams = z.object({ id: idSchema, aid: idSchema });
const runBody = z.object({ rowId: idSchema }).strict();

export default async function baseAutomationRoutes(app: FastifyInstance) {
  const { db, box, bus, config } = app;
  const tags = ['bases'];
  const write = { preHandler: guard('write'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  const openBase = (req: FastifyRequest, id: string): PageRow => {
    if (!req.auth || !can(req.auth, 'read')) throw new HttpError(404, 'Base introuvable');
    const page = loadWritablePage(db, req, id);
    if (page.kind !== 'base') throw new HttpError(404, 'Base introuvable');
    return page;
  };
  // Dans un espace personnel le journal ne garde pas de détail (comme pour les bases).
  const detail = (page: PageRow, meta: Record<string, unknown>) => (inPersonalSpace(db, page.id) ? undefined : meta);
  const limits = {
    automations: MAX_AUTOMATIONS, actions: MAX_ACTIONS, filters: MAX_FILTERS, recipients: MAX_RECIPIENTS, rowsPerRun: MAX_ROWS_TOUCHED,
    failures: MAX_FAILURES, runsPerMinute: MAX_RUNS_PER_MINUTE, runsPerHour: MAX_RUNS_PER_HOUR, baseRunsPerMinute: MAX_BASE_RUNS_PER_MINUTE,
  };
  // Adresse de webhook : vérifiée par le garde réseau dès l'enregistrement (refus explicite), puis à chaque envoi. Webhooks
  // coupés ou espace personnel : aucune résolution DNS, le refus (403) vient de la validation.
  const checkUrls = async (page: PageRow, actions: SaveInput['actions']) => {
    if (!webhooksEnabled(db) || inPersonalSpace(db, page.id)) return;
    for (const a of actions ?? []) {
      if (a.type !== 'webhook' || a.url === undefined) continue;
      // Message unique : rien de la résolution DNS (adresses, erreurs du résolveur) ne revient à l'appelant.
      try { await assertSafeUrl(a.url, config.WEBHOOK_ALLOW_PRIVATE); } catch { throw new HttpError(400, 'Webhook : adresse refusée (https obligatoire, sans identifiants, nom public résolu, aucune adresse interne)'); }
    }
  };
  const view = (req: FastifyRequest, row: AutomationRow, secret: string | null = null) => ({ ...presentAutomation(db, req.auth, row), ...(secret ? { webhookSecret: secret } : {}) });
  const kindOf = (row: AutomationRow) => row.kind;

  app.get('/bases/:id/automations', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Automatisations d’une base (droit d’écriture)', params: idParams },
  }, async (req) => {
    const page = openBase(req, (req.params as { id: string }).id);
    return {
      items: automationsOf(db, page.id).map((r) => view(req, r)),
      limits,
      webhooksAvailable: webhooksEnabled(db) && !inPersonalSpace(db, page.id),
    };
  });

  app.post('/bases/:id/automations', {
    ...write,
    schema: { tags, summary: `Créer une automatisation ou un bouton de ligne (${MAX_AUTOMATIONS} par base ; secret du webhook montré une seule fois)`, params: idParams, body: createBody },
  }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id);
    const b = req.body as z.output<typeof createBody>;
    await checkUrls(page, b.actions);
    const { row, secret } = saveAutomation(db, box, req.auth!, page.id, b);
    audit(db, req, 'base.automation.create', page.id, detail(page, { automationId: row.id, kind: kindOf(row), actions: b.actions.map((a) => a.type) }));
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });
    return reply.status(201).send(view(req, row, secret));
  });

  app.patch('/bases/:id/automations/:aid', {
    ...write,
    schema: { tags, summary: 'Modifier une automatisation (déclencheur, actions ou réactivation : vous en devenez l’auteur)', params: autoParams, body: patchBody },
  }, async (req) => {
    const p = req.params as z.output<typeof autoParams>;
    const page = openBase(req, p.id);
    const cur = automationById(db, page.id, p.aid);
    const b = req.body as z.output<typeof patchBody>;
    await checkUrls(page, b.actions);
    const { row, secret } = saveAutomation(db, box, req.auth!, page.id, b, cur);
    audit(db, req, 'base.automation.update', page.id, detail(page, {
      automationId: row.id, resigned: resigns(b), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.actions ? { actions: b.actions.map((a) => a.type) } : {}),
    }));
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });
    return view(req, row, secret);
  });

  app.delete('/bases/:id/automations/:aid', { ...write, schema: { tags, summary: 'Supprimer une automatisation', params: autoParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof autoParams>;
    const page = openBase(req, p.id);
    automationById(db, page.id, p.aid);
    db.prepare('DELETE FROM base_automations WHERE id = ?').run(p.aid);
    audit(db, req, 'base.automation.delete', page.id, detail(page, { automationId: p.aid }));
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });
    return reply.status(204).send();
  });

  app.get('/bases/:id/automations/:aid/runs', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Dernières exécutions d’une automatisation (codes et nombres, jamais de contenu)', params: autoParams },
  }, async (req) => {
    const p = req.params as z.output<typeof autoParams>;
    const page = openBase(req, p.id);
    return { items: runsOf(db, automationById(db, page.id, p.aid)) };
  });

  app.post('/bases/:id/automations/:aid/webhook-secret', {
    ...write,
    schema: { tags, summary: 'Renouveler le secret du webhook (montré une seule fois)', params: autoParams },
  }, async (req) => {
    const p = req.params as z.output<typeof autoParams>;
    const page = openBase(req, p.id);
    const row = automationById(db, page.id, p.aid);
    // Réservé à l'auteur (ou à un administrateur), tant que les webhooks sont permis et hors espace personnel.
    if (row.author_id !== req.auth!.user.id && req.auth!.user.role !== 'admin') throw new HttpError(403, 'Seul l’auteur de l’automatisation peut renouveler ce secret');
    if (!webhooksEnabled(db)) throw new HttpError(403, 'Les webhooks d’automatisation sont désactivés par l’administrateur');
    if (inPersonalSpace(db, page.id)) throw new HttpError(403, 'Rien d’un espace personnel ne sort vers un service externe');
    const secret = rotateSecret(db, box, row);
    audit(db, req, 'base.automation.secret', page.id, detail(page, { automationId: p.aid }));
    return { webhookSecret: secret };
  });

  // Bouton de ligne : droits de la personne qui clique (écriture sur la base exigée ici). Réponse : résultat et ligne à jour.
  app.post('/bases/:id/automations/:aid/run', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Cliquer un bouton de ligne', params: autoParams, body: runBody },
  }, async (req) => {
    const p = req.params as z.output<typeof autoParams>;
    const page = openBase(req, p.id);
    const { rowId } = req.body as z.output<typeof runBody>;
    const r = app.automations.runButton(automationById(db, page.id, p.aid), rowId, req.auth!);
    const ctx = { db, auth: req.auth, spaces: new Set(readableSpaceIds(db, req)), baseId: page.id, touched: new Set<string>() };
    const row = presentRows(ctx, propertiesOf(db, page.id), true, rowId, readBudget())[0] ?? null;
    return { status: r.status, code: r.code, rows: r.rows.length, row };
  });

  // ----- Réglage d'instance -----
  app.get('/admin/automations', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Automatisations : réglage d’instance' } }, async () => ({
    webhooks: webhooksEnabled(db),
    count: (db.prepare('SELECT COUNT(*) AS n FROM base_automations').get() as { n: number }).n,
    webhookCount: (db.prepare("SELECT COUNT(*) AS n FROM base_automations WHERE webhook_url IS NOT NULL").get() as { n: number }).n,
  }));

  app.put('/admin/automations', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Autoriser ou non les webhooks d’automatisation (désactivé par défaut)', body: z.object({ webhooks: z.boolean() }).strict() },
  }, async (req) => {
    const { webhooks } = req.body as { webhooks: boolean };
    setWebhooksEnabled(db, webhooks, req.auth!.user.id);
    audit(db, req, 'settings.automations', null, { webhooks });
    return { webhooks };
  });
}
