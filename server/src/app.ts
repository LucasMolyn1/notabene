// Assemblage de l'application Fastify : en-têtes de sécurité, limitation de débit,
// résolution de l'identité (session ou jeton), CSRF, validation Zod, OpenAPI.
import { existsSync } from 'node:fs';
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
import { sessionAuth, sessionCookieName } from './auth/session.js';
import { verifyApiToken } from './auth/tokens.js';
import { SecretBox, safeEqual } from './lib/crypto.js';
import { EventBus, Presence } from './lib/events.js';
import { HttpError } from './lib/http.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import authRoutes from './routes/auth.js';
import coreRoutes from './routes/core.js';
import importRoutes from './routes/import.js';
import localAuthRoutes from './routes/local-auth.js';
import mcpRoutes from './routes/mcp.js';
import pageRoutes from './routes/pages.js';
import spaceRoutes from './routes/spaces.js';
import tokenRoutes from './routes/tokens.js';
import versionRoutes from './routes/versions.js';
import webhookRoutes from './routes/webhooks.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    config: Config;
    box: SecretBox;
    bus: EventBus;
    presence: Presence;
    oidc: OidcClient | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AppOptions {
  config: Config;
  db: DB;
  logger?: FastifyServerOptions['logger'];
  clientDir?: string;
}

export async function buildApp({ config, db, logger = false, clientDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger === false ? false : {
      ...(typeof logger === 'object' ? logger : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 12 * 1024 * 1024,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('box', new SecretBox(config.ENCRYPTION_KEY));
  const bus = new EventBus();
  app.decorate('bus', bus);
  app.decorate('presence', new Presence(bus));
  app.decorate('oidc', config.OIDC_ISSUER ? new OidcClient(config, db) : null);
  app.decorateRequest('auth', null);

  // Validation des entrées par schémas Zod.
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });

  app.setErrorHandler((err, req, reply) => {
    const error = err as Error & { statusCode?: number; validation?: unknown; validationContext?: string };
    if (err instanceof ZodError || error.validation) {
      const zerr = err instanceof ZodError ? err : null;
      return reply.status(400).send({
        error: 'validation',
        message: 'Requête invalide',
        issues: zerr?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) ?? [],
      });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: 'http', message: err.message, ...(err.details ?? {}) });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: 'http', message: error.message });
    }
    req.log.error({ err }, 'erreur interne');
    return reply.status(500).send({ error: 'internal', message: 'Erreur interne' });
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
        frameAncestors: ["'self'", ...config.EMBED_ALLOWED_ORIGINS],
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
    max: 600,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => req.auth?.user.id ?? req.ip,
  });

  // Identité : jeton API (Authorization: Bearer) ou cookie de session, puis contrôle CSRF.
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
      const path = req.url.split('?')[0]!;
      if (req.auth.mfaPending && /^\/(api\/|mcp)/.test(path) && !/^\/api\/v1\/(me|config)$/.test(path)) {
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
      info: { title: 'Notabene API', version: '1.0.0', description: 'API REST du wiki Notabene. Authentification par jeton personnel : `Authorization: Bearer nb_…`.' },
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
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: true });

  await app.register(authRoutes);
  await app.register(localAuthRoutes, { prefix: '' });
  await app.register(coreRoutes, { prefix: '/api/v1' });
  await app.register(spaceRoutes, { prefix: '/api/v1' });
  await app.register(pageRoutes, { prefix: '/api/v1' });
  await app.register(tokenRoutes, { prefix: '/api/v1' });
  await app.register(aiRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(webhookRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1' });
  await app.register(mcpRoutes);
  await app.register(versionRoutes);
  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

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
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
    if (hasClient && req.method === 'GET' && !isApi) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: 'Ressource introuvable' });
  });

  return app;
}
