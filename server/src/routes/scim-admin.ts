// Administration du provisionnement SCIM (sous /api/v3) : état, activation, jetons dédiés.
// Administrateur depuis une session navigateur uniquement : un jeton d'API, même de portée admin, ne gère pas SCIM.
// Activer SCIM ou créer un jeton exige une nouvelle preuve d'identité (même règle que les réglages d'authentification).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams } from '../lib/http.js';
import { reauthInput, requireReauth } from '../lib/reauth.js';
import { MAX_SCIM_TOKENS, activeScimTokens, createScimToken, listScimTokens, revokeScimToken, saveScimSettings, scimSettings } from '../lib/scim.js';

const settingsBody = z.object({ enabled: z.boolean(), defaultRole: z.enum(['reader', 'editor']), reauth: reauthInput });
const tokenBody = z.object({
  name: z.string().trim().min(1).max(80).refine((n) => ![...n].some((c) => c.charCodeAt(0) < 32), 'caractères interdits'),
  expiresInDays: z.number().int().min(1).max(730).default(365),
  reauth: reauthInput,
});

export default async function scimAdminRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['admin'];
  const strict = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  const adminSession = (req: FastifyRequest) => {
    if (req.auth?.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    return req.auth;
  };

  const view = () => {
    const s = scimSettings(db, config);
    return {
      enabled: s.enabled,
      defaultRole: s.defaultRole,
      locked: s.locked,
      source: s.source,
      endpoint: `${config.PUBLIC_URL}/scim/v2`,
      tokens: listScimTokens(db),
      stats: {
        users: (db.prepare("SELECT COUNT(*) AS n FROM scim_users s JOIN users u ON u.id = s.user_id WHERE u.role != 'admin' AND s.deleted_at IS NULL").get() as { n: number }).n,
        groups: (db.prepare('SELECT COUNT(*) AS n FROM scim_groups').get() as { n: number }).n,
      },
    };
  };

  app.get('/admin/scim', { preHandler: guard('admin'), schema: { tags, summary: 'Provisionnement SCIM : état et jetons (sans secret)', hide: true } }, async (req) => {
    adminSession(req);
    return view();
  });

  app.put('/admin/scim/settings', { preHandler: guard('admin'), config: strict, schema: { tags, hide: true, body: settingsBody } }, async (req) => {
    const auth = adminSession(req);
    const body = req.body as z.output<typeof settingsBody>;
    if (scimSettings(db, config).locked) throw new HttpError(409, 'Réglé par l’environnement (CONFIG_LOCKED) : modifiez SCIM_ENABLED et SCIM_DEFAULT_ROLE.');
    await requireReauth(app, req, body.reauth);
    saveScimSettings(db, { enabled: body.enabled, defaultRole: body.defaultRole }, auth.user.id);
    audit(db, req, 'scim.settings', 'scim', { enabled: body.enabled, defaultRole: body.defaultRole });
    return view();
  });

  // Le jeton n'est renvoyé qu'ici, une seule fois ; seule son empreinte est conservée.
  app.post('/admin/scim/tokens', { preHandler: guard('admin'), config: strict, schema: { tags, hide: true, body: tokenBody } }, async (req, reply) => {
    const auth = adminSession(req);
    const body = req.body as z.output<typeof tokenBody>;
    await requireReauth(app, req, body.reauth);
    if (activeScimTokens(db) >= MAX_SCIM_TOKENS) throw new HttpError(409, `Au plus ${MAX_SCIM_TOKENS} jetons SCIM actifs : révoquez-en un d’abord`);
    const created = createScimToken(db, auth.user.id, { name: body.name, expiresInDays: body.expiresInDays });
    audit(db, req, 'scim.token.create', created.id, { expiresInDays: body.expiresInDays });
    return reply.code(201).send(created);
  });

  app.delete('/admin/scim/tokens/:id', { preHandler: guard('admin'), config: strict, schema: { tags, hide: true, params: idParams } }, async (req, reply) => {
    adminSession(req);
    const { id } = req.params as { id: string };
    if (!revokeScimToken(db, id)) throw new HttpError(404, 'Jeton introuvable');
    audit(db, req, 'scim.token.revoke', id);
    return reply.code(204).send();
  });
}
