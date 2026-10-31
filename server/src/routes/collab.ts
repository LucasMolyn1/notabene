// WebSocket de co-édition : GET /collab/:id (cookie de session, rôle rédacteur, origine contrôlée).
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/context.js';
import { requireScope } from '../auth/context.js';
import { loadWritablePage } from '../lib/access.js';
import { canWritePage } from '../lib/page-acl.js';
import { getPageRow } from '../lib/pages.js';
import { CollabHub } from '../lib/collab.js';
import { HttpError, idParams } from '../lib/http.js';

export default async function collabRoutes(app: FastifyInstance) {
  const { db, config } = app;
  if (!config.COLLAB_ENABLED) return;
  const publicOrigin = new URL(config.PUBLIC_URL).origin;
  // Revalidation périodique d'une connexion ouverte : mêmes conditions qu'à la mise à niveau WebSocket.
  const authorize = (conn: { userId: string; sessionHash: string | null }, pageId: string) => {
    const row = db.prepare(
      'SELECT s.expires_at AS exp, u.name, u.email, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND u.id = ?',
    ).get(conn.sessionHash ?? '', conn.userId) as { exp: number; name: string; email: string | null; role: 'admin' | 'editor' | 'reader'; disabled: number } | undefined;
    if (!row || row.exp <= Date.now() || row.disabled || row.role === 'reader') return false;
    const page = getPageRow(db, pageId);
    if (!page || page.deleted_at || page.kind === 'base') return false;
    const auth: Auth = { user: { id: conn.userId, name: row.name, email: row.email, role: row.role }, via: 'session', scopes: new Set(['read', 'write']) };
    return canWritePage(db, auth, pageId);
  };
  const hub = new CollabHub(db, app.bus, authorize);
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
      if (loadWritablePage(db, req, (req.params as { id: string }).id).kind === 'base') throw new HttpError(409, 'Une base ne se modifie pas en co-édition de texte');
    },
  }, (socket, req) => {
    const user = req.auth!.user;
    hub.connect(socket, (req.params as { id: string }).id, { id: user.id, name: user.name, sessionHash: req.auth!.sessionHash });
  });
}

// Sans encapsulation (équivalent de fastify-plugin) : `app.collab` doit être visible des autres routes
// (évincer les salles quand les permissions changent, couper les connexions d'une session fermée).
(collabRoutes as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

declare module 'fastify' {
  interface FastifyInstance {
    collab?: CollabHub;
  }
}
