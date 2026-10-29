// Comptes locaux : installation initiale, connexion e-mail + mot de passe, MFA TOTP,
// changement de mot de passe et administration des comptes. Actif seulement si AUTH_LOCAL=true.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { createSession, sessionCookieName } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { HttpError, idParams, newId } from '../lib/http.js';
import { mails } from '../lib/mail.js';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from '../lib/password.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';

const RESET_TTL_MIN = 30;
const INVITE_TTL_H = 72;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const strict = { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => req.ip } };

const email = z.string().trim().toLowerCase().pipe(z.email().max(200));
const password = z.string().min(1).max(256);
const role = z.enum(['admin', 'editor', 'reader']);

interface UserRow {
  id: string; name: string; email: string | null; role: 'admin' | 'editor' | 'reader'; password_hash: string | null;
  totp_secret: string | null; totp_enabled: number; totp_last_step: number | null; recovery_codes: string | null;
  failed_logins: number; locked_until: number | null; disabled: number;
}

const hashCode = (code: string) => createHash('sha256').update(code.replace(/-/g, '').toLowerCase()).digest('hex');
const newRecoveryCodes = () => Array.from({ length: 10 }, () => { const h = randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });

export default async function localAuthRoutes(app: FastifyInstance) {
  const { db, config, box } = app;
  if (!config.AUTH_LOCAL) return;
  const cookieName = sessionCookieName(config.secureCookies);
  const cookieOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const };
  const publicOrigin = new URL(config.PUBLIC_URL).origin;

  const hasLocalAdmin = () => !!db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND password_hash IS NOT NULL AND disabled = 0 LIMIT 1").get();
  // Code d'installation : affiché dans les journaux du serveur, valable tant qu'aucun admin local n'existe.
  let setupCode: string | null = hasLocalAdmin() ? null : randomToken(12);
  if (setupCode) app.log.warn(`Aucun administrateur local : code d'installation = ${setupCode} (à saisir sur la page de connexion)`);

  const userById = (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  const userByEmail = (mail: string) => db.prepare('SELECT * FROM users WHERE sub = ?').get(`local:${mail}`) as UserRow | undefined;

  // Alerte par e-mail (si SMTP configuré) : jamais bloquante, jamais d'erreur renvoyée à l'appelant.
  const notify = (user: { email: string | null }, what: string) => {
    if (!user.email || !app.mail.enabled) return;
    void app.mail.send({ to: user.email, ...mails.alert(what) }).catch((err) => app.log.warn({ err }, 'alerte e-mail non envoyée'));
  };
  // Crée un jeton à usage unique ; l'ancien jeton du même compte est invalidé.
  const issueToken = (userId: string, kind: 'reset' | 'invite') => {
    const token = randomToken(32);
    const now = Date.now();
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, kind, now, now + (kind === 'invite' ? INVITE_TTL_H * 3_600_000 : RESET_TTL_MIN * 60_000));
    return `${config.PUBLIC_URL}/#/reset/${token}`;
  };

  const startSession = (reply: FastifyReply, userId: string) => {
    const s = createSession(db, userId, null, config.SESSION_TTL_HOURS);
    reply.setCookie(cookieName, s.token, { ...cookieOptions, expires: new Date(s.expiresAt) });
  };
  const sameOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin && origin !== publicOrigin) throw new HttpError(403, 'Origine non autorisée');
  };
  const sessionOnly = (req: FastifyRequest) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    const user = userById(auth.user.id);
    if (!user?.password_hash) throw new HttpError(400, 'Ce compte est géré par le fournisseur d’identité');
    return { auth, user };
  };
  const closeOtherSessions = (userId: string, keepHash?: string) =>
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, keepHash ?? '');

  // Valide un code TOTP ou un code de secours ; consomme/mémorise l'usage. Renvoie true si accepté.
  const checkSecondFactor = (user: UserRow, code: string): boolean => {
    const clean = code.trim();
    if (/^\d{6}$/.test(clean) && user.totp_secret) {
      const step = verifyTotp(box.open(user.totp_secret, `totp:${user.id}`), clean, user.totp_last_step);
      if (step === null) return false;
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      return true;
    }
    if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(clean) && user.recovery_codes) {
      const hashes = JSON.parse(user.recovery_codes) as string[];
      const h = hashCode(clean);
      const idx = hashes.findIndex((x) => safeEqual(x, h));
      if (idx < 0) return false;
      hashes.splice(idx, 1);
      db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
      return true;
    }
    return false;
  };

  // ---- Installation initiale ----------------------------------------------------------------
  app.post('/auth/local/setup', {
    config: strict,
    schema: { hide: true, body: z.object({ code: z.string().max(64), email, name: z.string().trim().min(1).max(120), password }) },
  }, async (req, reply) => {
    sameOrigin(req);
    const b = req.body as { code: string; email: string; name: string; password: string };
    if (!setupCode || hasLocalAdmin() || !safeEqual(b.code, setupCode)) throw new HttpError(403, 'Code d’installation invalide');
    const problem = passwordProblem(b.password, b.email);
    if (problem) throw new HttpError(400, problem);
    const id = newId();
    const now = Date.now();
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, last_login_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, `local:${b.email}`, b.email, b.name, 'admin', now, now, await hashPassword(b.password));
    setupCode = null;
    startSession(reply, id);
    audit(db, req, 'auth.local.setup', id);
    return reply.code(201).send({ redirect: '/' });
  });

  // ---- Connexion ----------------------------------------------------------------------------
  app.post('/auth/local/login', {
    config: strict,
    schema: { hide: true, body: z.object({ email, password, code: z.string().max(32).optional() }) },
  }, async (req, reply) => {
    sameOrigin(req);
    const b = req.body as { email: string; password: string; code?: string };
    const user = userByEmail(b.email);
    const now = Date.now();
    if (user?.locked_until && user.locked_until > now) throw new HttpError(429, 'Compte temporairement verrouillé : réessayez dans quelques minutes');

    const valid = await verifyPassword(b.password, user?.password_hash ?? (await dummyHash()));
    const fail = (reason: string) => {
      if (user) {
        const failures = user.failed_logins + 1;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures >= MAX_FAILURES ? 0 : failures, failures >= MAX_FAILURES ? now + LOCK_MS : null, user.id);
      }
      audit(db, req, 'auth.local.failed', user?.id ?? null, { reason });
      if (user && user.failed_logins + 1 >= MAX_FAILURES) notify(user, 'Votre compte Notabene a été verrouillé 15 minutes après plusieurs tentatives de connexion échouées.');
      throw new HttpError(401, 'Identifiants invalides');
    };
    if (!user || !user.password_hash || !valid || user.disabled) return fail('password');

    if (user.totp_enabled) {
      if (!b.code) return reply.code(401).send({ message: 'Code de vérification requis', mfaRequired: true });
      if (!checkSecondFactor(user, b.code)) return fail('mfa');
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, user.id);
    startSession(reply, user.id);
    audit(db, req, 'auth.login', user.id, { role: user.role, method: 'local', mfa: !!user.totp_enabled });
    return { redirect: '/' };
  });

  // ---- Compte courant : mot de passe et MFA -------------------------------------------------
  app.get('/auth/local/me', { schema: { hide: true } }, async (req) => {
    const auth = requireAuth(req);
    const u = userById(auth.user.id);
    return { local: !!u?.password_hash, mfa: !!u?.totp_enabled, recoveryLeft: u?.recovery_codes ? (JSON.parse(u.recovery_codes) as string[]).length : 0 };
  });

  app.post('/auth/local/password', {
    config: strict,
    schema: { hide: true, body: z.object({ current: password, next: password }) },
  }, async (req) => {
    const { auth, user } = sessionOnly(req);
    const b = req.body as { current: string; next: string };
    if (!(await verifyPassword(b.current, user.password_hash))) throw new HttpError(403, 'Mot de passe actuel incorrect');
    const problem = passwordProblem(b.next, user.email ?? undefined);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.next), user.id);
    const { changes } = closeOtherSessions(user.id, auth.sessionHash);
    audit(db, req, 'auth.local.password', user.id, { closedSessions: changes });
    notify(user, 'Le mot de passe de votre compte Notabene vient d’être modifié.');
    return { ok: true, closedSessions: changes };
  });

  app.post('/auth/mfa/setup', { config: strict, schema: { hide: true } }, async (req) => {
    const { user } = sessionOnly(req);
    if (user.totp_enabled) throw new HttpError(409, 'La double authentification est déjà active');
    const secret = newTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(box.seal(secret, `totp:${user.id}`), user.id);
    return { secret, uri: otpauthUri(secret, user.email ?? user.name) };
  });

  app.post('/auth/mfa/enable', { config: strict, schema: { hide: true, body: z.object({ code: z.string().max(10) }) } }, async (req) => {
    const { user } = sessionOnly(req);
    if (user.totp_enabled || !user.totp_secret) throw new HttpError(409, 'Aucune activation en cours');
    const step = verifyTotp(box.open(user.totp_secret, `totp:${user.id}`), (req.body as { code: string }).code.trim(), null);
    if (step === null) throw new HttpError(400, 'Code incorrect');
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?').run(step, JSON.stringify(codes.map(hashCode)), user.id);
    audit(db, req, 'auth.mfa.enable', user.id);
    notify(user, 'La double authentification vient d’être activée sur votre compte Notabene.');
    return { recoveryCodes: codes };
  });

  app.post('/auth/mfa/disable', {
    config: strict,
    schema: { hide: true, body: z.object({ password, code: z.string().max(32) }) },
  }, async (req) => {
    const { user } = sessionOnly(req);
    const b = req.body as { password: string; code: string };
    if (!user.totp_enabled) throw new HttpError(409, 'La double authentification n’est pas active');
    if (!(await verifyPassword(b.password, user.password_hash)) || !checkSecondFactor(user, b.code)) throw new HttpError(403, 'Mot de passe ou code incorrect');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?').run(user.id);
    audit(db, req, 'auth.mfa.disable', user.id);
    notify(user, 'La double authentification vient d’être désactivée sur votre compte Notabene.');
    return { ok: true };
  });

  // ---- Mot de passe oublié (nécessite SMTP) -------------------------------------------------
  // Réponse identique que le compte existe ou non ; l'envoi n'est pas attendu (pas d'écart de temps observable).
  app.post('/auth/local/forgot', { config: strict, schema: { hide: true, body: z.object({ email }) } }, async (req, reply) => {
    sameOrigin(req);
    if (!app.mail.enabled) throw new HttpError(404, 'Introuvable');
    const user = userByEmail((req.body as { email: string }).email);
    if (user?.password_hash && !user.disabled && user.email) {
      const recent = db.prepare('SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ?').get(user.id, Date.now() - 60_000);
      if (!recent) {
        const url = issueToken(user.id, 'reset');
        audit(db, req, 'auth.local.forgot', user.id);
        void app.mail.send({ to: user.email, ...mails.reset(url, RESET_TTL_MIN) }).catch((err) => app.log.warn({ err }, 'e-mail de réinitialisation non envoyé'));
      }
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/auth/local/reset', {
    config: strict,
    schema: { hide: true, body: z.object({ token: z.string().min(20).max(100), password }) },
  }, async (req) => {
    sameOrigin(req);
    const b = req.body as { token: string; password: string };
    const row = db.prepare('SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?').get(sha256(b.token)) as { user_id: string; expires_at: number } | undefined;
    const user = row && row.expires_at > Date.now() ? userById(row.user_id) : undefined;
    if (!user || !user.password_hash || user.disabled) throw new HttpError(400, 'Lien invalide ou expiré');
    const problem = passwordProblem(b.password, user.email ?? undefined);
    if (problem) throw new HttpError(400, problem);
    const hash = await hashPassword(b.password);
    // Consommation atomique : un lien ne sert qu'une fois, même en cas de requêtes simultanées.
    if (db.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(sha256(b.token)).changes !== 1) throw new HttpError(400, 'Lien invalide ou expiré');
    db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(db, req, 'auth.local.reset', user.id);
    notify(user, 'Le mot de passe de votre compte Notabene vient d’être réinitialisé.');
    return { ok: true };
  });

  // ---- Administration des comptes locaux ---------------------------------------------------
  const adminOnly = (req: FastifyRequest) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session' && !auth.scopes.has('admin')) throw new HttpError(403, 'Permission insuffisante');
    if (auth.user.role !== 'admin') throw new HttpError(403, 'Permission insuffisante');
    return auth;
  };

  // Mêmes routes sous chaque version de l'API (ce plugin est enregistré à la racine, hors des préfixes de version).
  for (const prefix of ['/api/v1', '/api/v2', '/api/v3']) {
    app.post(`${prefix}/admin/local-users`, {
      schema: { tags: ['admin'], summary: 'Créer un compte local (admin)', body: z.object({ email, name: z.string().trim().min(1).max(120), role, password: password.optional(), invite: z.boolean().default(false) }) },
    }, async (req, reply) => {
      adminOnly(req);
      const b = req.body as { email: string; name: string; role: 'admin' | 'editor' | 'reader'; password?: string; invite: boolean };
      if (b.invite && !app.mail.enabled) throw new HttpError(409, 'Configurez SMTP pour inviter par e-mail');
      if (!b.invite) {
        if (!b.password) throw new HttpError(400, 'Mot de passe requis');
        const problem = passwordProblem(b.password, b.email);
        if (problem) throw new HttpError(400, problem);
      }
      if (userByEmail(b.email)) throw new HttpError(409, 'Un compte existe déjà avec cette adresse');
      const id = newId();
      // Invitation : mot de passe aléatoire que personne ne connaît ; l'invité choisit le sien via le lien reçu.
      const hash = await hashPassword(b.invite ? randomToken(32) : b.password!);
      db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, `local:${b.email}`, b.email, b.name, b.role, Date.now(), hash);
      if (b.invite) {
        try {
          await app.mail.send({ to: b.email, ...mails.invite(issueToken(id, 'invite'), INVITE_TTL_H, b.name) });
        } catch (err) {
          db.prepare('DELETE FROM users WHERE id = ?').run(id);
          app.log.warn({ err }, 'invitation non envoyée');
          throw new HttpError(502, 'Envoi de l’invitation impossible : vérifiez la configuration SMTP');
        }
      }
      audit(db, req, 'user.create', id, { role: b.role, invited: b.invite });
      return reply.code(201).send({ id });
    });

    app.patch(`${prefix}/admin/local-users/:id`, {
      schema: {
        tags: ['admin'], summary: 'Modifier un compte local (rôle, désactivation, mot de passe, MFA)', params: idParams,
        body: z.object({ role: role.optional(), disabled: z.boolean().optional(), password: password.optional(), resetMfa: z.boolean().optional() }),
      },
    }, async (req) => {
      const auth = adminOnly(req);
      const { id } = req.params as { id: string };
      const b = req.body as { role?: 'admin' | 'editor' | 'reader'; disabled?: boolean; password?: string; resetMfa?: boolean };
      const user = userById(id);
      if (!user?.password_hash) throw new HttpError(404, 'Compte local introuvable');
      if (id === auth.user.id && (b.disabled || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'Vous ne pouvez pas vous désactiver ni vous rétrograder');
      if (b.password) {
        const problem = passwordProblem(b.password, user.email ?? undefined);
        if (problem) throw new HttpError(400, problem);
        db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(await hashPassword(b.password), id);
      }
      if (b.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
      if (b.disabled !== undefined) db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, id);
      if (b.resetMfa) db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?').run(id);
      if (b.password || b.disabled) closeOtherSessions(id);
      audit(db, req, 'user.update', id, { role: b.role, disabled: b.disabled, password: !!b.password, resetMfa: !!b.resetMfa });
      return { ok: true };
    });
  }
}
