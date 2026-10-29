// Jetons d'API : gérables uniquement depuis une session navigateur (un jeton ne peut
// pas en créer un autre), portées limitées au rôle de l'utilisateur.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ALL_SCOPES, requireAuth, scopesForRole } from '../auth/context.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../auth/tokens.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams } from '../lib/http.js';

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1).max(4),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

function requireSession(req: FastifyRequest) {
  const auth = requireAuth(req);
  if (auth.via !== 'session') throw new HttpError(403, 'Les jetons se gèrent depuis l’interface web');
  return auth;
}

export default async function tokenRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['tokens'];

  app.get('/tokens', { schema: { tags, summary: 'Lister mes jetons', hide: true } }, async (req) => listApiTokens(db, requireSession(req).user.id));

  app.post('/tokens', { schema: { tags, summary: 'Créer un jeton', hide: true, body: createBody } }, async (req, reply) => {
    const auth = requireSession(req);
    const body = req.body as z.output<typeof createBody>;
    const allowed = scopesForRole(auth.user.role);
    const scopes = [...new Set(body.scopes)] as typeof allowed;
    const denied = scopes.filter((s) => !allowed.includes(s));
    if (denied.length) throw new HttpError(403, `Portées non autorisées pour votre rôle : ${denied.join(', ')}`);
    const created = createApiToken(db, auth.user.id, { name: body.name, scopes, expiresInDays: body.expiresInDays });
    audit(db, req, 'token.create', created.id, { scopes, expiresInDays: body.expiresInDays });
    return reply.status(201).send({ ...created, name: body.name, scopes });
  });

  app.delete('/tokens/:id', { schema: { tags, summary: 'Révoquer un jeton', hide: true, params: idParams } }, async (req, reply) => {
    const auth = requireSession(req);
    const { id } = req.params as { id: string };
    if (!revokeApiToken(db, auth.user.id, id)) throw new HttpError(404, 'Jeton introuvable');
    audit(db, req, 'token.revoke', id);
    return reply.status(204).send();
  });
}
