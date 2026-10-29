// WebSocket de co-édition : GET /collab/:id (cookie de session, rôle rédacteur, origine contrôlée).
import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth/context.js';
import { loadWritablePage } from '../lib/access.js';
import { CollabHub } from '../lib/collab.js';
import { HttpError, idParams } from '../lib/http.js';

export default async function collabRoutes(app: FastifyInstance) {
  const { db, config } = app;
  if (!config.COLLAB_ENABLED) return;
  const publicOrigin = new URL(config.PUBLIC_URL).origin;
  const hub = new CollabHub(db, app.bus);
  app.decorate('collab', hub);
  app.addHook('onClose', async () => hub.shutdown());

  app.get('/collab/:id', {
    websocket: true,
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => req.ip } },
    schema: { hide: true, params: idParams },
    // preValidation : refus HTTP classiques (401/403/404) avant la mise à niveau WebSocket.
    preValidation: async (req) => {
      // Protection contre le détournement de WebSocket inter-sites : l'origine doit être la nôtre.
      if (req.headers.origin !== publicOrigin) throw new HttpError(403, 'Origine non autorisée');
      if (req.auth?.via !== 'session') throw new HttpError(401, 'Session requise');
      requireScope(req, 'write');
      loadWritablePage(db, req, (req.params as { id: string }).id);
    },
  }, (socket, req) => {
    const user = req.auth!.user;
    hub.connect(socket, (req.params as { id: string }).id, { id: user.id, name: user.name });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    collab?: CollabHub;
  }
}
