// À propos : version, nouveautés (CHANGELOG.md) et, pour les administrateurs, mise à jour disponible.
import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/context.js';
import { loadChangelog } from '../lib/changelog.js';
import { COMMIT, VERSION } from '../version.js';

export default async function aboutRoutes(app: FastifyInstance) {
  app.get('/about', { preHandler: guard('read'), schema: { tags: ['session'], summary: 'Version de l’instance et nouveautés' } }, async () => ({
    version: VERSION,
    commit: COMMIT,
    releases: loadChangelog().slice(0, 8),
  }));

  app.get('/admin/update-check', { preHandler: guard('admin'), config: { rateLimit: { max: 60, timeWindow: '1 hour' } }, schema: { tags: ['admin'], summary: 'Mise à jour disponible (si UPDATE_CHECK=true)' } }, async () => app.updates.status());
}
