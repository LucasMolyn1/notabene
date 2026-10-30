// Assemblage de l'application Fastify : en-têtes de sécurité, limitation de débit,
// résolution de l'identité (session ou jeton), CSRF, validation Zod, OpenAPI.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { OidcClient } from './auth/oidc.js';
import { Mailer } from './lib/mail.js';
import { startNotifications } from './lib/notifications.js';
import { startWebhooks } from './lib/webhooks.js';
import { RuntimeSettings } from './lib/runtime-settings.js';
import settingsRoutes from './routes/settings.js';
import pageQueryRoutes from './routes/pages-query.js';
import seoRoutes from './routes/seo.js';
import avatarRoutes from './routes/avatars.js';
import v3Routes from './routes/v3.js';
import { sessionAuth as sessionAuthWithIdle, sessionCookieName } from './auth/session.js';
import { verifyApiToken } from './auth/tokens.js';
import { SecretBox, safeEqual } from './lib/crypto.js';
import { EventBus, Presence } from './lib/events.js';
import { HttpError } from './lib/http.js';
import { problem, usesProblemFormat } from './lib/problem.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import authRoutes from './routes/auth.js';
import websocket from '@fastify/websocket';
import collabRoutes from './routes/collab.js';
import coreRoutes from './routes/core.js';
import importRoutes from './routes/import.js';
import localAuthRoutes from './routes/local-auth.js';
import mcpRoutes from './routes/mcp.js';
import pageRoutes from './routes/pages.js';
import spaceRoutes from './routes/spaces.js';
import ssoRoutes from './routes/sso.js';
import tokenRoutes from './routes/tokens.js';
import versionRoutes from './routes/versions.js';
import webhookRoutes from './routes/webhooks.js';
import aboutRoutes from './routes/about.js';
import { UpdateChecker, updateSetting } from './lib/update-check.js';
import { VERSION } from './version.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    config: Config;
    box: SecretBox;
    bus: EventBus;
    presence: Presence;
    oidc: OidcClient;
    rt: RuntimeSettings;
    mail: Mailer;
    updates: UpdateChecker;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AppOptions {
  config: Config;
  db: DB;
  logger?: FastifyServerOptions['logger'];
  clientDir?: string;
  // Annuaire LDAP injectable (tests) ; par défaut construit d'après LDAP_URL.
  ldap?: import('./auth/ldap.js').LdapDirectory;
  // Injections pour les tests : client LDAP du test de connexion, expéditeur d'e-mails.
  ldapFactory?: import('./auth/ldap.js').ClientFactory;
  mailer?: Mailer;
  // Vérificateur de mise à jour injectable (tests) ; par défaut construit d'après UPDATE_CHECK.
  updateChecker?: UpdateChecker;
}

export async function buildApp({ config, db, logger = false, clientDir, ldap, ldapFactory, mailer, updateChecker }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger === false ? false : {
      ...(typeof logger === 'object' ? logger : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
    },
    // Un nombre = nombre de proxys de confiance en partant de la connexion ; l'adresse du client est lue à droite de X-Forwarded-For.
    // (L'option numérique de Fastify n'a pas cette sémantique : on passe par une fonction.)
    trustProxy: typeof config.TRUST_PROXY === 'number' ? ((_address: string, hop: number) => hop < (config.TRUST_PROXY as number)) : config.TRUST_PROXY,
    bodyLimit: 12 * 1024 * 1024,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  const box = new SecretBox(config.ENCRYPTION_KEY);
  app.decorate('box', box);
  const rt = new RuntimeSettings(config, db, box);
  app.decorate('rt', rt);
  app.decorate('updates', updateChecker ?? new UpdateChecker(() => updateSetting(db, config), config.UPDATE_CHECK_REPO, VERSION));
  app.decorate('mail', mailer ?? new Mailer(() => rt.get()));
  const bus = new EventBus();
  app.decorate('bus', bus);
  app.decorate('presence', new Presence(bus));
  const stopNotifications = startNotifications(db, bus, app.mail, () => rt.get());
  app.addHook('onClose', async () => { stopNotifications(); });
  const stopWebhooks = startWebhooks(db, bus, box, config.WEBHOOK_ALLOW_PRIVATE);
  app.addHook('onClose', async () => { stopWebhooks(); });
  app.decorate('oidc', new OidcClient(() => rt.get(), db));
  app.decorateRequest('auth', null);

  // Validation des entrées par schémas Zod.
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });

  // Format d'erreur : problem+json (RFC 9457) sous /api/v3 ; JSON { error, message } pour /auth/* et le reste.
  const fail = (req: { url: string }, reply: import('fastify').FastifyReply, status: number, legacy: Record<string, unknown>, extensions: Record<string, unknown> = {}) => {
    const message = String(legacy.message ?? '');
    if (usesProblemFormat(req.url)) {
      return reply.status(status).type('application/problem+json').send(problem(status, message, req.url, { ...extensions, code: legacy.error }));
    }
    return reply.status(status).send({ ...legacy, ...extensions });
  };

  app.setErrorHandler((err, req, reply) => {
    const error = err as Error & { statusCode?: number; validation?: unknown; validationContext?: string };
    if (err instanceof ZodError || error.validation) {
      const zerr = err instanceof ZodError ? err : null;
      const issues = zerr?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) ?? [];
      return fail(req, reply, 400, { error: 'validation', message: 'Requête invalide', issues }, usesProblemFormat(req.url) ? { errors: issues } : {});
    }
    if (err instanceof HttpError) {
      return fail(req, reply, err.statusCode, { error: 'http', message: err.message }, err.details ?? {});
    }
    if (error.statusCode && error.statusCode < 500) {
      return fail(req, reply, error.statusCode, { error: 'http', message: error.message });
    }
    req.log.error({ err }, 'erreur interne');
    return fail(req, reply, 500, { error: 'internal', message: 'Erreur interne' });
  });

  await app.register(cookie);

  const drawioOrigin = config.DRAWIO_URL ? new URL(config.DRAWIO_URL).origin : null;
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: drawioOrigin ? [drawioOrigin] : ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Liste relue à chaque réponse : elle se modifie depuis les paramètres sans redémarrage.
        frameAncestors: [() => ["'self'", ...rt.get().EMBED_ALLOWED_ORIGINS].join(' ')],
        ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: false, // remplacé par CSP frame-ancestors (intégration iframe contrôlée)
    crossOriginEmbedderPolicy: false,
    hsts: config.secureCookies ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => req.auth?.user.id ?? req.ip,
  });

  // Identité : jeton API (Authorization: Bearer) ou cookie de session, puis contrôle CSRF.
  // Résolution de session avec la limite d'inactivité configurée.
  const sessionAuth = (database: DB, token: string) => sessionAuthWithIdle(database, token, config.SESSION_IDLE_MINUTES * 60_000);
  const cookieName = sessionCookieName(config.secureCookies);
  const publicOrigin = new URL(config.PUBLIC_URL).origin;
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    const bearer = header === undefined ? undefined : /^Bearer\s+(\S+)$/.exec(header)?.[1];
    const cookie = req.cookies[cookieName];
    if (header !== undefined && !bearer) throw new HttpError(401, 'Jeton d’API invalide, expiré ou révoqué');
    req.auth = bearer ? verifyApiToken(db, bearer) : cookie ? sessionAuth(db, cookie) : null;
    if (bearer && !req.auth) throw new HttpError(401, 'Jeton d’API invalide, expiré ou révoqué');

    // CSRF : décidé d'après le mode d'authentification résolu côté serveur (les jetons Bearer n'y sont pas exposés).
    if (req.auth?.via === 'session' && !SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin) throw new HttpError(403, 'Origine non autorisée');
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, req.auth.csrf!)) throw new HttpError(403, 'Jeton CSRF invalide');
    }

    if (config.LOCAL_REQUIRE_MFA && req.auth) {
      const row = db.prepare('SELECT password_hash IS NOT NULL AS local, totp_enabled AS mfa FROM users WHERE id = ?').get(req.auth.user.id) as { local: number; mfa: number } | undefined;
      req.auth.mfaPending = !!row?.local && !row.mfa;
      // Décision d'après la route réellement appariée : le routeur décode l'URL, donc « /%61pi/… » atteint « /api/… ».
      const route = req.routeOptions.url ?? '';
      if (req.auth.mfaPending && /^\/(api\/|mcp|collab\/)/.test(route) && !/^\/api\/v3\/(me|config)$/.test(route)) {
        throw new HttpError(403, 'Activez la double authentification pour continuer', { mfaSetupRequired: true });
      }
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Notabene API', version: VERSION, description: 'API REST du wiki Notabene. Authentification par jeton personnel : `Authorization: Bearer nb_…`.' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Jeton personnel créé dans Notabene (menu utilisateur → Jetons d’API).' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: ({ schema, url }) => {
      if (!schema) return { schema, url };
      const out: Record<string, unknown> = { ...schema };
      for (const key of ['body', 'querystring', 'params'] as const) {
        const s = (schema as Record<string, unknown>)[key];
        if (s instanceof z.ZodType) out[key] = z.toJSONSchema(s, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' });
      }
      return { schema: out as typeof schema, url };
    },
  });
  if (config.API_DOCS !== 'off') {
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      staticCSP: true,
      // Par défaut la documentation n'est pas publique : elle décrit toute la surface de l'API.
      uiHooks: { onRequest: async (req) => { if (config.API_DOCS === 'auth' && !req.auth) throw new HttpError(401, 'Authentification requise'); } },
    });
  }

  await app.register(authRoutes);
  await app.register(localAuthRoutes, { prefix: '' });
  await app.register(ssoRoutes, { ldap });
  // Enregistré à la racine pour que `injectWS` et les routes WebSocket soient visibles de tous les plugins.
  if (config.COLLAB_ENABLED) await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(collabRoutes);
  // API publique : v3 uniquement (v1 et v2 ont été retirées ; voir docs/API-VERSIONING.md).
  await app.register(async (scope) => {
    await scope.register(coreRoutes);
    await scope.register(spaceRoutes);
    await scope.register(pageRoutes);
    await scope.register(pageQueryRoutes);
    await scope.register(tokenRoutes);
    await scope.register(aiRoutes);
    await scope.register(adminRoutes);
    await scope.register(settingsRoutes, { ldapFactory });
    await scope.register(webhookRoutes);
    await scope.register(importRoutes);
    await scope.register(v3Routes);
    await scope.register(aboutRoutes);
    await scope.register(avatarRoutes);
  }, { prefix: '/api/v3' });
  await app.register(mcpRoutes);
  await app.register(versionRoutes);
  // Santé : la base doit répondre, sinon le conteneur doit être signalé défaillant.
  app.get('/healthz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // Front compilé (production) : fichiers statiques + repli SPA.
  const dir = clientDir ?? resolve(process.cwd(), 'dist/client');
  const hasClient = existsSync(resolve(dir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: dir,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  await app.register(seoRoutes, { indexHtml: hasClient ? readFileSync(resolve(dir, 'index.html'), 'utf8') : null });
  app.setNotFoundHandler((req, reply) => {
    // Sondes HTTP (HAProxy, répartiteurs) : HEAD et OPTIONS sur la racine répondent sans corps.
    if (req.url === '/' && (req.method === 'HEAD' || req.method === 'OPTIONS')) {
      return reply.header('allow', 'GET, HEAD, OPTIONS').status(req.method === 'HEAD' ? 200 : 204).send();
    }
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
    if (hasClient && req.method === 'GET' && !isApi) {
      // L'application seule : jamais de contenu ici, donc rien à indexer (les pages publiques passent par routes/seo.ts).
      return reply.header('cache-control', 'no-cache').header('x-robots-tag', 'noindex, nofollow').sendFile('index.html');
    }
    return fail(req, reply, 404, { error: 'not_found', message: 'Ressource introuvable' });
  });

  return app;
}
