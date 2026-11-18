// Connexion OIDC (fournisseur principal et fournisseurs nommés comme Google), déconnexion (locale + fournisseur)
// et connexion de développement.
import { BINDING_TTL_SECONDS, bindingCookieName, newBinding } from '../auth/login-binding.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GOOGLE_SUB_PREFIX, NAMED_PROVIDERS, type OidcClient, ReauthRejected, googleDecision, hasMfaClaim, oidcProviderOfSub, roleFromGroups, safeReturnTo, upsertUser } from '../auth/oidc.js';
import { syncGroups } from '../lib/groups.js';
import { createSession, destroySession, sessionCookieName } from '../auth/session.js';
import type { Role } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';

type NamedProvider = (typeof NAMED_PROVIDERS)[number];

const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => req.ip } };

function displayName(profile: Record<string, unknown>) {
  for (const key of ['name', 'preferred_username', 'nickname', 'email']) {
    const v = profile[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return 'Utilisateur';
}

type Identity = { sub: string; email: string | null; role: Role; groups: unknown } | { denied: 'mfa_required' | 'email_unverified' | 'forbidden' };

export default async function authRoutes(app: FastifyInstance) {
  const { db, config, oidc } = app;
  const cookieName = sessionCookieName(config.secureCookies);
  const cookieOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const };
  const bindingName = bindingCookieName(config.secureCookies);

  const startSession = (reply: FastifyReply, userId: string, idToken: string | null) => {
    const session = createSession(db, userId, idToken, config.SESSION_TTL_HOURS);
    reply.setCookie(cookieName, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
  };

  const loginQuery = z.object({ returnTo: z.string().max(512).optional(), reauth: z.enum(['1']).optional() });

  // Départ vers un fournisseur OIDC : tentative à usage unique, liée au navigateur (cookie) et au fournisseur.
  const startLogin = async (client: OidcClient, req: FastifyRequest, reply: FastifyReply) => {
    const { returnTo, reauth } = req.query as z.output<typeof loginQuery>;
    const binding = newBinding();
    const url = await client.authorizationUrl(safeReturnTo(returnTo), binding.hash, reauth === '1');
    reply.setCookie(bindingName, binding.token, { ...cookieOptions, maxAge: BINDING_TTL_SECONDS });
    return reply.redirect(url.href);
  };

  // Identité retenue d'après le profil, selon la politique propre au fournisseur. Un refus est audité ici.
  const identityOf = (client: OidcClient, req: FastifyRequest, profile: Record<string, unknown>): Identity => {
    const live = app.rt.get();
    if (client.name === 'google') {
      const d = googleDecision(profile, live);
      if (!d.ok) {
        audit(db, req, 'auth.denied', `${GOOGLE_SUB_PREFIX}${String(profile.sub)}`, { reason: d.reason, method: 'google' });
        return { denied: d.reason === 'mfa' ? 'mfa_required' : d.reason === 'email_unverified' ? 'email_unverified' : 'forbidden' };
      }
      return { sub: d.sub, email: d.email, role: d.role, groups: null };
    }
    // Un sub du fournisseur principal ne doit jamais tomber dans un espace de noms interne (local:, ldap:, saml:, scim:,
    // google:, dev-) : il ouvrirait le compte local, LDAP, Google… qui porte ce même identifiant.
    if (oidcProviderOfSub(String(profile.sub)) !== 'principal') {
      audit(db, req, 'auth.denied', null, { reason: 'reserved_sub' });
      return { denied: 'forbidden' };
    }
    if (live.OIDC_REQUIRE_MFA && !hasMfaClaim(profile)) {
      audit(db, req, 'auth.denied', String(profile.sub), { reason: 'mfa' });
      return { denied: 'mfa_required' };
    }
    const role = roleFromGroups(profile.groups, live);
    if (!role) {
      audit(db, req, 'auth.denied', String(profile.sub));
      return { denied: 'forbidden' };
    }
    return { sub: String(profile.sub), email: typeof profile.email === 'string' ? profile.email.slice(0, 200) : null, role, groups: profile.groups };
  };

  const finishLogin = async (client: OidcClient, req: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(req.url, config.PUBLIC_URL);
    const idpError = url.searchParams.get('error');
    if (idpError) return reply.redirect(`/?auth_error=${encodeURIComponent(idpError.replace(/[^a-z_]/gi, '').slice(0, 40))}`);
    try {
      const { profile, idToken, returnTo } = await client.handleCallback(url, req.cookies[bindingName]);
      reply.clearCookie(bindingName, cookieOptions);
      const id = identityOf(client, req, profile);
      if ('denied' in id) return reply.redirect(`/?auth_error=${id.denied}`);
      const method = client.name === 'principal' ? {} : { method: client.name };
      // Compte désactivé : pas de session.
      const existing = db.prepare('SELECT disabled FROM users WHERE sub = ?').get(id.sub) as { disabled: number } | undefined;
      if (existing?.disabled) {
        audit(db, req, 'auth.denied', id.sub, { reason: 'disabled', ...method });
        return reply.redirect('/?auth_error=forbidden');
      }
      const userId = upsertUser(db, { sub: id.sub, email: id.email, name: displayName(profile), role: id.role });
      if (client.name === 'principal' && syncGroups(db, userId, 'oidc', id.groups)) { app.bus.publish({ type: 'space.changed' }); app.collab?.recheckAll(); }
      const previous = req.cookies[cookieName];
      if (previous) destroySession(db, previous);
      // Google ne propose pas de déconnexion côté fournisseur : son id_token n'est pas conservé.
      startSession(reply, userId, client.name === 'principal' ? idToken : null);
      req.auth = { user: { id: userId, name: displayName(profile), email: null, role: id.role }, via: 'session', scopes: new Set() };
      audit(db, req, 'auth.login', userId, { role: id.role, ...method }, { actorId: userId });
      return reply.redirect(returnTo);
    } catch (err) {
      if (err instanceof ReauthRejected) {
        audit(db, req, 'auth.denied', null, { reason: 'reauth', method: client.name });
        return reply.redirect('/?auth_error=reauth_failed');
      }
      req.log.warn({ err }, `échec du callback OIDC (${client.name})`);
      return reply.redirect('/?auth_error=callback');
    }
  };

  // Fournisseur principal : routes historiques, inchangées (URI de redirection déjà déclarée chez le fournisseur).
  app.get('/auth/login', { config: authRateLimit, schema: { hide: true, querystring: loginQuery } }, async (req, reply) => {
    if (!oidc.enabled) {
      if (config.DEV_LOGIN) return reply.redirect(`/?dev_login=1&returnTo=${encodeURIComponent(safeReturnTo((req.query as z.output<typeof loginQuery>).returnTo))}`);
      throw new HttpError(503, 'Fournisseur d’identité non configuré');
    }
    return startLogin(oidc, req, reply);
  });

  app.get('/auth/callback', { config: authRateLimit, schema: { hide: true } }, async (req, reply) => {
    if (!oidc.enabled) throw new HttpError(404, 'Introuvable');
    return finishLogin(oidc, req, reply);
  });

  // Fournisseurs nommés (Google) : /auth/oidc/<nom>/login et /auth/oidc/<nom>/callback. Inconnu ou non configuré : 404.
  const providerParams = z.object({ provider: z.enum(NAMED_PROVIDERS as [NamedProvider, ...NamedProvider[]]) });
  const namedClient = (req: FastifyRequest) => {
    const client = app.oidcProviders.get((req.params as z.output<typeof providerParams>).provider);
    if (!client.enabled) throw new HttpError(404, 'Introuvable');
    return client;
  };

  app.get('/auth/oidc/:provider/login', { config: authRateLimit, schema: { hide: true, params: providerParams, querystring: loginQuery } }, async (req, reply) =>
    startLogin(namedClient(req), req, reply));

  app.get('/auth/oidc/:provider/callback', { config: authRateLimit, schema: { hide: true, params: providerParams } }, async (req, reply) =>
    finishLogin(namedClient(req), req, reply));

  app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    const token = req.cookies[cookieName];
    let redirect = '/';
    if (token) {
      if (req.auth) audit(db, req, 'auth.logout', req.auth.user.id);
      const sub = req.auth ? (db.prepare('SELECT sub FROM users WHERE id = ?').get(req.auth.user.id) as { sub: string } | undefined)?.sub : undefined;
      const idToken = destroySession(db, token);
      app.collab?.recheckAll(); // coupe les connexions de co-édition de cette session
      // Un compte Google n'est jamais envoyé vers la page de déconnexion du fournisseur principal (Google n'en a pas).
      if (oidc.enabled && (sub === undefined || oidcProviderOfSub(sub) !== 'google')) redirect = (await oidc.logoutUrl(idToken)) ?? '/';
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
