// Configuration publique, identité courante, flux d'événements (SSE) et présence.
import { effectiveEmbedHosts } from '../lib/embed.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Auth, can, requireAuth } from '../auth/context.js';
import { aiProviderLabel, isAiReady } from '../ai/settings.js';
import { canReadPage, filterReadable, hasAnyAcl } from '../lib/page-acl.js';
import { spaceRoles } from '../lib/space-access.js';
import { personalSpacesEnabled } from '../lib/personal-spaces.js';
import { sharingEnabled } from '../lib/shares.js';
import type { AppEvent } from '../lib/events.js';
import { idSchema } from '../lib/http.js';
import { reauthUntil } from '../lib/reauth.js';
import { VERSION } from '../version.js';

// Origine du compte d'après le préfixe de son identifiant (sub).
const providerOf = (sub: string) => (sub.startsWith('local:') ? 'local' : sub.startsWith('ldap:') ? 'ldap' : sub.startsWith('saml:') ? 'saml' : sub.startsWith('dev-') ? 'dev' : 'oidc');

export default async function coreRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/config', { schema: { tags: ['session'], summary: 'Configuration publique de l’instance', security: [] } }, async () => ({
    auth: { oidc: app.oidc.enabled, devLogin: config.DEV_LOGIN, local: config.AUTH_LOCAL, ldap: !!app.rt.get().LDAP_URL, saml: !!app.rt.get().SAML_ENTRY_POINT, mail: !!app.rt.get().SMTP_HOST, setupRequired: config.AUTH_LOCAL && !(app.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND password_hash IS NOT NULL LIMIT 1").get()) },
    drawioUrl: config.DRAWIO_URL ?? null,
    // Hôtes dont le contenu peut être intégré dans une page (liste vide : fonction inactive).
    embedHosts: effectiveEmbedHosts(app.rt.get().CONTENT_EMBED_HOSTS, config.PUBLIC_URL),
    collab: config.COLLAB_ENABLED,
    ai: isAiReady(db),
    personalSpaces: personalSpacesEnabled(db),
    sharing: sharingEnabled(db),
  }));

  app.get('/me', { schema: { tags: ['session'], summary: 'Utilisateur courant et permissions' } }, async (req) => {
    const auth = req.auth;
    return {
      user: auth?.user ?? null,
      via: auth?.via ?? null,
      mfaSetupRequired: !!auth?.mfaPending,
      version: auth ? VERSION : null,
      provider: auth ? providerOf((db.prepare('SELECT sub FROM users WHERE id = ?').get(auth.user.id) as { sub: string } | undefined)?.sub ?? '') : null,
      csrf: auth?.via === 'session' ? auth.csrf : null,
      // Fin de la fenêtre pendant laquelle les actions sensibles ne redemandent pas le mot de passe (null si aucune).
      reauthUntil: auth?.via === 'session' ? reauthUntil(db, auth.sessionHash) : null,
      permissions: {
        read: can(auth, 'read'),
        write: can(auth, 'write'),
        ai: can(auth, 'ai') && isAiReady(db),
        admin: can(auth, 'admin'),
      },
      // Destinataire du texte envoyé à l'assistant de rédaction (null si l'IA n'est pas prête ou pas permise).
      aiProvider: auth && can(auth, 'ai') && isAiReady(db) ? aiProviderLabel(db) : null,
    };
  });

  // Flux ouverts : sans les terminer à l'arrêt, le serveur attendrait indéfiniment leur fermeture (docker stop).
  const pageExists = db.prepare('SELECT 1 FROM pages WHERE id = ?');
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => { for (const res of streams) res.end(); });

  // Flux temps réel : changements de pages (sans contenu) et présence.
  // Présence : on ne montre qui consulte quelle page que pour les pages que l'appelant peut lire.
  const visiblePeers = (auth: Auth | null, peers: { pageId: string | null }[]) => {
    const ok = new Set(filterReadable(db, auth, peers.filter((p) => p.pageId).map((p) => ({ id: p.pageId! }))).map((p) => p.id));
    return peers.filter((p) => !p.pageId || ok.has(p.pageId));
  };

  app.get('/events', { schema: { tags: ['session'], summary: 'Flux SSE des changements' } }, async (req, reply) => {
    // Identité du flux : rôle et état du compte sont relus à chaque changement de droits (un administrateur rétrogradé, un
    // compte désactivé ou un groupe retiré ne gardent pas les droits de l'ouverture du flux).
    let auth = req.auth;
    const spaceIds = (a: Auth | null) => new Set(can(a, 'read') ? [...spaceRoles(db, a).keys()] : [...spaceRoles(db, null).keys()]);
    let spaces = spaceIds(auth);
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
    streams.add(res);
    const send = (event: AppEvent) => {
      if (event.type === 'space.changed' && auth) {
        const live = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(auth.user.id) as { role: 'admin' | 'editor' | 'reader'; disabled: number } | undefined;
        if (!live || live.disabled) { res.end(); return; }
        auth = { ...auth, user: { ...auth.user, role: live.role } };
      }
      if (event.type === 'space.changed') spaces = spaceIds(auth);
      if (event.type === 'presence' && !authed) return;
      // Notification : uniquement pour son destinataire.
      if (event.type === 'notification' && (event.data as { userId?: string } | undefined)?.userId !== req.auth?.user.id) return;
      if (event.spaceId && !spaces.has(event.spaceId)) return;
      // Page restreinte : l'événement n'est diffusé qu'à ceux qui y ont accès (page détruite : plus de restriction à appliquer).
      // Sans espace dans l'événement, le droit sur l'espace de la page est aussi relu (canReadPage).
      if (event.pageId && (!event.spaceId || hasAnyAcl(db)) && pageExists.get(event.pageId) && !canReadPage(db, auth, event.pageId)) return;
      const out = event.type === 'presence' ? { ...event, data: visiblePeers(auth, event.data as { pageId: string | null }[]) } : event;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(out)}\n\n`);
    };
    res.write('retry: 5000\n\n');
    const unsubscribe = app.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
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
    // Une page illisible n'est pas signalée (rien ne révèle son existence).
    const seen = pageId && canReadPage(db, auth, pageId) ? pageId : null;
    app.presence.update(`${auth.user.id}:${tabId}`, auth.user, seen, editing);
    return { peers: visiblePeers(auth, app.presence.list()) };
  });
}
