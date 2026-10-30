// Connexion OIDC, déconnexion (locale + fournisseur) et connexion de développement.
import { BINDING_TTL_SECONDS, bindingCookieName, newBinding } from '../auth/login-binding.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasMfaClaim, roleFromGroups, safeReturnTo, upsertUser } from '../auth/oidc.js';
import { createSession, destroySession, sessionCookieName } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';

const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => req.ip } };

function displayName(profile: Record<string, unknown>) {
  for (const key of ['name', 'preferred_username', 'nickname', 'email']) {
    const v = profile[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return 'Utilisateur';
}

export default async function authRoutes(app: FastifyInstance) {
  const { db, config, oidc } = app;
  const cookieName = sessionCookieName(config.secureCookies);
  const cookieOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const };
  const bindingName = bindingCookieName(config.secureCookies);

  const startSession = (reply: import('fastify').FastifyReply, userId: string, idToken: string | null) => {
    const session = createSession(db, userId, idToken, config.SESSION_TTL_HOURS);
    reply.setCookie(cookieName, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
  };

  app.get('/auth/login', {
    config: authRateLimit,
    schema: { hide: true, querystring: z.object({ returnTo: z.string().max(512).optional(), reauth: z.enum(['1']).optional() }) },
  }, async (req, reply) => {
    const { returnTo, reauth } = req.query as { returnTo?: string; reauth?: '1' };
    if (!oidc.enabled) {
      if (config.DEV_LOGIN) return reply.redirect(`/?dev_login=1&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
      throw new HttpError(503, 'Fournisseur d’identité non configuré');
    }
    const binding = newBinding();
    const url = await oidc.authorizationUrl(safeReturnTo(returnTo), binding.hash, reauth === '1');
    reply.setCookie(bindingName, binding.token, { ...cookieOptions, maxAge: BINDING_TTL_SECONDS });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { config: authRateLimit, schema: { hide: true } }, async (req, reply) => {
    if (!oidc.enabled) throw new HttpError(404, 'Introuvable');
    const url = new URL(req.url, config.PUBLIC_URL);
    const idpError = url.searchParams.get('error');
    if (idpError) return reply.redirect(`/?auth_error=${encodeURIComponent(idpError.replace(/[^a-z_]/gi, '').slice(0, 40))}`);
    try {
      const { profile, idToken, returnTo } = await oidc.handleCallback(url, req.cookies[bindingName]);
      reply.clearCookie(bindingName, cookieOptions);
      const live = app.rt.get();
      if (live.OIDC_REQUIRE_MFA && !hasMfaClaim(profile)) {
        audit(db, req, 'auth.denied', String(profile.sub), { reason: 'mfa' });
        return reply.redirect('/?auth_error=mfa_required');
      }
      const role = roleFromGroups(profile.groups, live);
      if (!role) {
        audit(db, req, 'auth.denied', String(profile.sub));
        return reply.redirect('/?auth_error=forbidden');
      }
      const userId = upsertUser(db, {
        sub: String(profile.sub),
        email: typeof profile.email === 'string' ? profile.email.slice(0, 200) : null,
        name: displayName(profile),
        role,
      });
      const previous = req.cookies[cookieName];
      if (previous) destroySession(db, previous);
      startSession(reply, userId, idToken);
      req.auth = { user: { id: userId, name: displayName(profile), email: null, role }, via: 'session', scopes: new Set() };
      audit(db, req, 'auth.login', userId, { role });
      return reply.redirect(returnTo);
    } catch (err) {
      req.log.warn({ err }, 'échec du callback OIDC');
      return reply.redirect('/?auth_error=callback');
    }
  });

  app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    const token = req.cookies[cookieName];
    let redirect = '/';
    if (token) {
      if (req.auth) audit(db, req, 'auth.logout', req.auth.user.id);
      const idToken = destroySession(db, token);
      app.collab?.recheckAll(); // coupe les connexions de co-édition de cette session
      if (oidc.enabled) redirect = (await oidc.logoutUrl(idToken)) ?? '/';
    }
    reply.clearCookie(cookieName, cookieOptions);
    return { redirect };
  });

  // Connexion sans IdP pour le développement local uniquement (refusée en production par la config).
  if (config.DEV_LOGIN) {
    app.post('/auth/dev-login', {
      schema: { hide: true, body: z.object({ role: z.enum(['admin', 'editor', 'reader']), returnTo: z.string().optional() }) },
    }, async (req, reply) => {
      const { role, returnTo } = req.body as { role: 'admin' | 'editor' | 'reader'; returnTo?: string };
      const names = { admin: 'Admin (dev)', editor: 'Éditeur (dev)', reader: 'Lecteur (dev)' };
      const userId = upsertUser(db, { sub: `dev-${role}`, email: null, name: names[role], role });
      startSession(reply, userId, null);
      return { redirect: safeReturnTo(returnTo) };
    });
  }
}
