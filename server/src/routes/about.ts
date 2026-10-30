// À propos : version, nouveautés (CHANGELOG.md) et, pour les administrateurs, mise à jour disponible.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { reauthInput, requireReauth } from '../lib/reauth.js';
import { saveUpdateSetting, updateSetting } from '../lib/update-check.js';
import { readUpdater, requestUpdate } from '../lib/updater.js';
import { loadChangelog } from '../lib/changelog.js';
import { COMMIT, VERSION } from '../version.js';

export default async function aboutRoutes(app: FastifyInstance) {
  app.get('/about', { preHandler: guard('read'), schema: { tags: ['session'], summary: 'Version de l’instance et nouveautés' } }, async () => ({
    version: VERSION,
    commit: COMMIT,
    releases: loadChangelog().slice(0, 8),
  }));

  app.get('/admin/update-check', { preHandler: guard('admin'), config: { rateLimit: { max: 60, timeWindow: '1 hour' } }, schema: { tags: ['admin'], summary: 'Mise à jour disponible (si la vérification est activée)' } }, async () => ({ ...(await app.updates.status()), updater: readUpdater(app.config.UPDATER_DIR) }));

  // « Vérifier maintenant » : même appel que la vérification périodique, sans attendre la fin du cache.
  app.post('/admin/update-check/refresh', { preHandler: guard('admin'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } }, schema: { hide: true } },
    async () => ({ ...(await app.updates.status({ force: true })), updater: readUpdater(app.config.UPDATER_DIR) }));

  // Activer ou couper la vérification depuis l'interface (administrateur, mot de passe ressaisi).
  app.put('/admin/update-check/settings', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { hide: true, body: z.object({ enabled: z.boolean(), reauth: reauthInput }) },
  }, async (req) => {
    const body = req.body as { enabled: boolean; reauth: z.output<typeof reauthInput> };
    if (updateSetting(app.db, app.config).locked) throw new HttpError(409, 'Réglé par l’environnement (CONFIG_LOCKED) : modifiez UPDATE_CHECK.');
    await requireReauth(app, req, body.reauth);
    saveUpdateSetting(app.db, body.enabled, req.auth!.user.id);
    audit(app.db, req, 'settings.updates', 'updates', { enabled: body.enabled });
    return app.updates.status();
  });

  // Demande de mise à jour depuis l'interface : l'hôte décide et exécute (scripts/updater). Mot de passe toujours ressaisi.
  app.post('/admin/update/apply', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { hide: true, body: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), reauth: reauthInput }) },
  }, async (req) => {
    const body = req.body as { version: string; reauth: z.output<typeof reauthInput> };
    const dir = app.config.UPDATER_DIR;
    const updater = readUpdater(dir);
    if (!dir || !updater.available) throw new HttpError(409, 'Le service de mise à jour de l’hôte ne répond pas (voir docs/MISE-A-JOUR.md).');
    if (updater.state === 'running') throw new HttpError(409, 'Une mise à jour est déjà en cours.');
    const status = await app.updates.status();
    if (!status.updateAvailable || status.latest?.version !== body.version) throw new HttpError(409, 'Cette version n’est pas la dernière version publiée.');
    await requireReauth(app, req, body.reauth, { strict: true });
    requestUpdate(dir, body.version, req.auth!.user.id);
    audit(app.db, req, 'update.request', body.version, { from: status.current });
    return { requested: true, version: body.version };
  });
}
