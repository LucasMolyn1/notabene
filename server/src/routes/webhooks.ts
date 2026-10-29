import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, idParams, newId } from '../lib/http.js';
import { assertSafeUrl, deliver, WEBHOOK_EVENTS } from '../lib/webhooks.js';

const body = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

interface Row { id: string; name: string; url: string; secret: string; events: string; enabled: number; created_at: number; last_status: number | null; last_at: number | null; failures: number }

const view = (r: Row) => ({
  id: r.id, name: r.name, url: r.url, events: JSON.parse(r.events) as string[], enabled: !!r.enabled,
  createdAt: r.created_at, lastStatus: r.last_status, lastAt: r.last_at, failures: r.failures,
});

// La livraison des webhooks est démarrée une seule fois par app.ts, indépendamment des versions d'API servies.
export default async function webhookRoutes(app: FastifyInstance) {
  const { db, box, config } = app;
  const tags = ['webhooks'];
  const allow = config.WEBHOOK_ALLOW_PRIVATE;

  const find = (id: string) => {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Webhook introuvable');
    return row;
  };
  const checkUrl = async (url: string) => {
    try { await assertSafeUrl(url, allow); } catch (err) { throw new HttpError(400, (err as Error).message); }
  };

  app.get('/admin/webhooks', { preHandler: guard('admin'), schema: { tags, summary: 'Webhooks configurés' } }, async () => ({
    events: WEBHOOK_EVENTS,
    items: (db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Row[]).map(view),
  }));

  app.post('/admin/webhooks', { preHandler: guard('admin'), schema: { tags, summary: 'Créer un webhook (secret affiché une seule fois)', body } }, async (req, reply) => {
    const b = req.body as z.infer<typeof body>;
    await checkUrl(b.url);
    const id = newId();
    const secret = `whsec_${randomToken(24)}`;
    db.prepare('INSERT INTO webhooks (id, name, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, b.name, b.url, box.seal(secret, `webhook:${id}`), JSON.stringify(b.events), Date.now());
    audit(db, req, 'webhook.create', id, { url: new URL(b.url).origin });
    return reply.code(201).send({ ...view(find(id)), secret });
  });

  app.patch('/admin/webhooks/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Modifier ou réactiver un webhook', params: idParams, body: body.partial().extend({ enabled: z.boolean().optional() }) },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const cur = find(id);
    const b = req.body as Partial<z.infer<typeof body>> & { enabled?: boolean };
    if (b.url) await checkUrl(b.url);
    db.prepare('UPDATE webhooks SET name = ?, url = ?, events = ?, enabled = ?, failures = CASE WHEN ? = 1 THEN 0 ELSE failures END WHERE id = ?')
      .run(b.name ?? cur.name, b.url ?? cur.url, b.events ? JSON.stringify(b.events) : cur.events, (b.enabled ?? !!cur.enabled) ? 1 : 0, b.enabled ? 1 : 0, id);
    audit(db, req, 'webhook.update', id);
    return view(find(id));
  });

  app.delete('/admin/webhooks/:id', { preHandler: guard('admin'), schema: { tags, summary: 'Supprimer un webhook', params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    find(id);
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    audit(db, req, 'webhook.delete', id);
    return reply.code(204).send();
  });

  app.post('/admin/webhooks/:id/test', { preHandler: guard('admin'), schema: { tags, summary: 'Envoyer un évènement de test', params: idParams } }, async (req) => {
    const { id } = req.params as { id: string };
    const status = await deliver(db, box, allow, find(id), 'ping', { message: 'Notabene' });
    return { ok: status >= 200 && status < 300, status };
  });
}
