// Configuration publique, identité courante, flux d'événements (SSE) et présence.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requireAuth } from '../auth/context.js';
import { isAiReady } from '../ai/settings.js';
import { readableSpaceIds } from '../lib/access.js';
import type { AppEvent } from '../lib/events.js';
import { idSchema } from '../lib/http.js';

// Origine du compte d'après le préfixe de son identifiant (sub).
const providerOf = (sub: string) => (sub.startsWith('local:') ? 'local' : sub.startsWith('ldap:') ? 'ldap' : sub.startsWith('saml:') ? 'saml' : sub.startsWith('dev-') ? 'dev' : 'oidc');

export default async function coreRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/config', { schema: { tags: ['session'], summary: 'Configuration publique de l’instance', security: [] } }, async () => ({
    auth: { oidc: !!app.oidc, devLogin: config.DEV_LOGIN, local: config.AUTH_LOCAL, ldap: !!config.LDAP_URL, saml: !!config.SAML_ENTRY_POINT, setupRequired: config.AUTH_LOCAL && !(app.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND password_hash IS NOT NULL LIMIT 1").get()) },
    drawioUrl: config.DRAWIO_URL ?? null,
    ai: isAiReady(db),
  }));

  app.get('/me', { schema: { tags: ['session'], summary: 'Utilisateur courant et permissions' } }, async (req) => {
    const auth = req.auth;
    return {
      user: auth?.user ?? null,
      via: auth?.via ?? null,
      mfaSetupRequired: !!auth?.mfaPending,
      provider: auth ? providerOf((db.prepare('SELECT sub FROM users WHERE id = ?').get(auth.user.id) as { sub: string } | undefined)?.sub ?? '') : null,
      csrf: auth?.via === 'session' ? auth.csrf : null,
      permissions: {
        read: can(auth, 'read'),
        write: can(auth, 'write'),
        ai: can(auth, 'ai') && isAiReady(db),
        admin: can(auth, 'admin'),
      },
    };
  });

  // Flux temps réel : changements de pages (sans contenu) et présence.
  app.get('/events', { schema: { tags: ['session'], summary: 'Flux SSE des changements' } }, async (req, reply) => {
    let spaces = new Set(readableSpaceIds(db, req));
    const authed = can(req.auth, 'read');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (event: AppEvent) => {
      if (event.type === 'space.changed') spaces = new Set(readableSpaceIds(db, req));
      if (event.type === 'presence' && !authed) return;
      if (event.spaceId && !spaces.has(event.spaceId)) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    res.write('retry: 5000\n\n');
    const unsubscribe = app.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.post('/presence', {
    schema: {
      tags: ['session'],
      summary: 'Signale la page consultée (présence)',
      body: z.object({ tabId: z.string().regex(/^[A-Za-z0-9_-]{6,32}$/), pageId: idSchema.nullable(), editing: z.boolean().default(false) }),
    },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const auth = requireAuth(req);
    const { tabId, pageId, editing } = req.body as { tabId: string; pageId: string | null; editing: boolean };
    app.presence.update(`${auth.user.id}:${tabId}`, auth.user, pageId, editing);
    return { peers: app.presence.list() };
  });
}
