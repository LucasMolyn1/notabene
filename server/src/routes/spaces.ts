// Espaces : lecture selon visibilité, gestion réservée aux administrateurs.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireScope } from '../auth/context.js';
import { readableSpaces, type SpaceRow, toSpace } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams, newId } from '../lib/http.js';

const spaceBody = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(16).default('📁'),
  description: z.string().max(1000).default(''),
  visibility: z.enum(['private', 'public']).default('private'),
});

export default async function spaceRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['spaces'];

  app.get('/spaces', { schema: { tags, summary: 'Lister les espaces visibles' } }, async (req) => readableSpaces(db, req).map(toSpace));

  app.post('/spaces', { preHandler: guard('admin'), schema: { tags, summary: 'Créer un espace (admin)', body: spaceBody } }, async (req, reply) => {
    const body = req.body as z.output<typeof spaceBody>;
    const now = Date.now();
    const id = newId();
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spaces').get() as { p: number }).p;
    db.prepare('INSERT INTO spaces (id, name, icon, description, visibility, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.icon, body.description, body.visibility, position, now, now);
    audit(db, req, 'space.create', id, { visibility: body.visibility });
    app.bus.publish({ type: 'space.changed' });
    return reply.status(201).send(toSpace(db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow));
  });

  app.patch('/spaces/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Modifier un espace (admin)', params: idParams, body: spaceBody.partial() },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const current = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow | undefined;
    if (!current) throw new HttpError(404, 'Espace introuvable');
    const next = { ...current, ...(req.body as Partial<SpaceRow>), updated_at: Date.now() };
    db.prepare('UPDATE spaces SET name = ?, icon = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.icon, next.description, next.visibility, next.updated_at, id);
    if (next.visibility !== current.visibility) audit(db, req, 'space.visibility', id, { visibility: next.visibility });
    app.bus.publish({ type: 'space.changed' });
    return toSpace(next);
  });

  app.delete('/spaces/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Supprimer un espace et toutes ses pages (admin)', params: idParams },
  }, async (req, reply) => {
    requireScope(req, 'admin');
    const { id } = req.params as { id: string };
    const count = (db.prepare('SELECT COUNT(*) AS n FROM spaces').get() as { n: number }).n;
    if (count <= 1) throw new HttpError(409, 'Impossible de supprimer le dernier espace');
    if (db.prepare('DELETE FROM spaces WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Espace introuvable');
    audit(db, req, 'space.delete', id);
    app.bus.publish({ type: 'space.changed' });
    return reply.status(204).send();
  });
}
