// Espaces personnels, côté administration : réglage d'instance, espaces orphelins (compte supprimé), reprise.
// Un administrateur ne voit jamais le contenu d'un espace personnel ; il ne gère que le réglage et les orphelins.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { idParams } from '../lib/http.js';
import { HttpError } from '../lib/http.js';
import { orphanSpaces, personalSpacesEnabled, setPersonalSpaces } from '../lib/personal-spaces.js';
import { requireReauth, reauthInput } from '../lib/reauth.js';

export default async function personalSpaceRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['admin'];

  app.get('/admin/personal-spaces', { preHandler: guard('admin'), schema: { tags, summary: 'Espaces personnels : réglage et espaces orphelins' } }, async () => ({
    enabled: personalSpacesEnabled(db),
    count: (db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'personal'").get() as { n: number }).n,
    orphans: orphanSpaces(db),
  }));

  app.put('/admin/personal-spaces', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Autoriser ou non la création d’espaces personnels (les espaces existants restent à leurs propriétaires)', body: z.object({ enabled: z.boolean() }) },
  }, async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    setPersonalSpaces(db, enabled, req.auth!.user.id);
    audit(db, req, 'settings.personal-spaces', null, { enabled });
    app.bus.publish({ type: 'space.changed' });
    return { enabled };
  });

  // Reprise d'un espace dont le propriétaire n'existe plus : il devient un espace partagé, visible des administrateurs.
  app.post('/admin/personal-spaces/:id/recover', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Reprendre un espace personnel orphelin (action journalisée, mot de passe redemandé)', params: idParams, body: z.object({ reauth: reauthInput }) },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await requireReauth(app, req, (req.body as { reauth: z.output<typeof reauthInput> }).reauth, { strict: true });
    const space = db.prepare("SELECT id, name FROM spaces WHERE id = ? AND kind = 'personal' AND owner_id IS NULL").get(id) as { id: string; name: string } | undefined;
    if (!space) throw new HttpError(404, 'Espace orphelin introuvable');
    db.prepare("UPDATE spaces SET kind = 'shared', name = ?, updated_at = ? WHERE id = ?").run(`${space.name} (repris)`.slice(0, 80), Date.now(), id);
    audit(db, req, 'space.personal.recover', id);
    app.bus.publish({ type: 'space.changed' });
    app.collab?.evictAll();
    return { id };
  });
}
