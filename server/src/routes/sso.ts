// Connexions fédérées : LDAP / Active Directory (formulaire) et SAML 2.0 (redirection).
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type GroupRoles, cleanName, roleFromGroupList } from '../auth/external.js';
import { LdapDirectory } from '../auth/ldap.js';
import { BINDING_TTL_SECONDS, bindingCookieName, bindingMatches, newBinding } from '../auth/login-binding.js';
import { safeReturnTo, upsertUser } from '../auth/oidc.js';
import { samlFor, userFromProfile } from '../auth/saml.js';
import { createSession, destroySession, sessionCookieName } from '../auth/session.js';
import type { Role } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

const STATE_TTL = 10 * 60_000;

export default async function ssoRoutes(app: FastifyInstance, opts: { ldap?: LdapDirectory } = {}) {
  const { db } = app;
  // Configuration effective relue à chaque requête : les fournisseurs se règlent à chaud depuis l'interface.
  const cfg = () => app.rt.get();
  const ldapFor = () => opts.ldap ?? (cfg().LDAP_URL ? new LdapDirectory(cfg()) : null);
  const config = app.config;
  const strict = { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => req.ip } };

  const cookieName = sessionCookieName(config.secureCookies);
  const cookieOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const };
  const bindingName = bindingCookieName(config.secureCookies);
  const samlBindingOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'none' as const };
  const publicOrigin = new URL(config.PUBLIC_URL).origin;

  const complete = (req: FastifyRequest, reply: FastifyReply, input: { sub: string; email: string | null; name: string; role: Role; method: string }) => {
    const existing = db.prepare('SELECT disabled FROM users WHERE sub = ?').get(input.sub) as { disabled: number } | undefined;
    if (existing?.disabled) {
      audit(db, req, 'auth.denied', input.sub, { reason: 'disabled', method: input.method });
      return false;
    }
    const userId = upsertUser(db, { sub: input.sub, email: input.email, name: input.name, role: input.role });
    const previous = req.cookies[cookieName];
    if (previous) destroySession(db, previous);
    const session = createSession(db, userId, null, config.SESSION_TTL_HOURS);
    reply.setCookie(cookieName, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
    audit(db, req, 'auth.login', userId, { role: input.role, method: input.method });
    return true;
  };

  // ---- LDAP -----------------------------------------------------------------------------------
  {
    app.post('/auth/ldap/login', {
      config: strict,
      schema: { hide: true, body: z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(256) }) },
    }, async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin) throw new HttpError(403, 'Origine non autorisée');
      const b = req.body as { username: string; password: string };
      const ldap = ldapFor();
      if (!ldap) throw new HttpError(404, 'Introuvable');
      const c = cfg();
      const roles: GroupRoles = { admin: c.LDAP_ADMIN_GROUPS, editor: c.LDAP_EDITOR_GROUPS, reader: c.LDAP_READER_GROUPS, defaultRole: c.LDAP_DEFAULT_ROLE };
      let user;
      try {
        user = await ldap.authenticate(b.username, b.password);
      } catch (err) {
        req.log.error({ err }, 'annuaire LDAP injoignable');
        throw new HttpError(503, 'Annuaire indisponible, réessayez plus tard');
      }
      if (!user) {
        audit(db, req, 'auth.ldap.failed', null, { username: b.username.slice(0, 64) });
        throw new HttpError(401, 'Identifiants invalides');
      }
      const role = roleFromGroupList(user.groups, roles);
      if (!role) {
        audit(db, req, 'auth.denied', `ldap:${user.username}`, { reason: 'group' });
        throw new HttpError(403, 'Votre compte n’appartient à aucun groupe autorisé. Demandez l’accès à un administrateur.');
      }
      if (!complete(req, reply, { sub: `ldap:${user.username.toLowerCase()}`, email: user.email, name: cleanName(user.name, user.username), role, method: 'ldap' })) {
        throw new HttpError(401, 'Identifiants invalides');
      }
      return { redirect: '/' };
    });
  }

  // ---- SAML -----------------------------------------------------------------------------------
  {
    const samlOrFail = () => {
      if (!cfg().SAML_ENTRY_POINT) throw new HttpError(404, 'Introuvable');
      return samlFor(cfg());
    };
    const rolesOf = (): GroupRoles => { const c = cfg(); return { admin: c.SAML_ADMIN_GROUPS, editor: c.SAML_EDITOR_GROUPS, reader: c.SAML_READER_GROUPS, defaultRole: c.SAML_DEFAULT_ROLE }; };
    await app.register(async (scope) => {
      await scope.register(formbody);

      scope.get('/auth/saml/login', {
        config: strict,
        schema: { hide: true, querystring: z.object({ returnTo: z.string().max(512).optional() }) },
      }, async (req, reply) => {
        const saml = samlOrFail();
        const state = randomToken(18);
        // Le retour SAML est un POST venu du fournisseur d'identité (autre site) : le cookie doit être SameSite=None,
        // donc Secure (HTTPS). Sans HTTPS (développement), la liaison n'est pas posée.
        const binding = config.secureCookies ? newBinding() : null;
        db.prepare('INSERT INTO login_states (state, code_verifier, nonce, return_to, expires_at, binding_hash) VALUES (?, ?, ?, ?, ?, ?)')
          .run(state, 'saml', 'saml', safeReturnTo((req.query as { returnTo?: string }).returnTo), Date.now() + STATE_TTL, binding?.hash ?? null);
        if (binding) reply.setCookie(bindingName, binding.token, { ...samlBindingOptions, maxAge: BINDING_TTL_SECONDS });
        return reply.redirect(await saml.getAuthorizeUrlAsync(state, undefined, {}));
      });

      scope.post('/auth/saml/callback', {
        config: strict,
        schema: { hide: true, body: z.object({ SAMLResponse: z.string().min(1).max(2_000_000), RelayState: z.string().max(200).optional() }) },
      }, async (req, reply) => {
        const saml = samlOrFail();
        const roles = rolesOf();
        const body = req.body as { SAMLResponse: string; RelayState?: string };
        // Le RelayState est notre état à usage unique : sans lui, pas de connexion (pas de SSO initié par l'IdP).
        const saved = db.prepare("DELETE FROM login_states WHERE state = ? AND code_verifier = 'saml' RETURNING return_to, expires_at, binding_hash")
          .get(body.RelayState ?? '') as { return_to: string; expires_at: number; binding_hash: string | null } | undefined;
        if (!saved || saved.expires_at < Date.now()) return reply.redirect('/?auth_error=callback');
        reply.clearCookie(bindingName, samlBindingOptions);
        if (!bindingMatches(saved.binding_hash, req.cookies[bindingName])) {
          audit(db, req, 'auth.saml.failed', null, { reason: 'binding' });
          return reply.redirect('/?auth_error=callback');
        }
        try {
          const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
          const user = profile ? userFromProfile(profile as unknown as Record<string, unknown>, cfg()) : null;
          if (!user) throw new Error('assertion sans identifiant');
          const role = roleFromGroupList(user.groups, roles);
          if (!role) {
            audit(db, req, 'auth.denied', `saml:${user.subject}`, { reason: 'group' });
            return reply.redirect('/?auth_error=forbidden');
          }
          if (!complete(req, reply, { sub: `saml:${user.subject}`, email: user.email, name: cleanName(user.name, user.email ?? user.subject), role, method: 'saml' })) {
            return reply.redirect('/?auth_error=forbidden');
          }
          return reply.redirect(saved.return_to);
        } catch (err) {
          req.log.warn({ err }, 'réponse SAML refusée');
          audit(db, req, 'auth.saml.failed', null);
          return reply.redirect('/?auth_error=callback');
        }
      });

      scope.get('/auth/saml/metadata', { schema: { hide: true } }, async (_req, reply) =>
        reply.type('application/samlmetadata+xml').send(samlOrFail().generateServiceProviderMetadata(null, null)));
    });
  }
}
