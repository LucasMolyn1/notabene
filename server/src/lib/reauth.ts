// Nouvelle preuve d'identité exigée avant de modifier la configuration d'authentification ou d'e-mail.
// Compte local : mot de passe (+ code TOTP si la MFA est active). Compte fédéré (OIDC, LDAP, SAML) : session ouverte depuis moins de 15 minutes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { audit } from './audit.js';
import { HttpError } from './http.js';
import { verifyPassword } from './password.js';
import { verifyTotp } from './totp.js';

export const reauthInput = z.object({ password: z.string().max(256).optional(), code: z.string().max(32).optional() }).default({});
export type Reauth = z.output<typeof reauthInput>;

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const FRESH_SESSION_MS = 15 * 60_000;
// Après une preuve d'identité réussie, les actions sensibles ordinaires ne la redemandent pas pendant cette durée (fixe, non prolongée à l'usage).
export const REAUTH_WINDOW_MS = 10 * 60_000;

export function reauthUntil(db: FastifyInstance['db'], sessionHash: string | undefined): number | null {
  const s = db.prepare('SELECT reauth_at FROM sessions WHERE id_hash = ?').get(sessionHash ?? '') as { reauth_at: number | null } | undefined;
  return s?.reauth_at && Date.now() - s.reauth_at < REAUTH_WINDOW_MS ? s.reauth_at + REAUTH_WINDOW_MS : null;
}

// `strict` : toujours ressaisir le mot de passe (suppression de compte, clé d'API), même dans la fenêtre.
export async function requireReauth(app: FastifyInstance, req: FastifyRequest, input: Reauth, opts: { strict?: boolean } = {}): Promise<void> {
  const { db, box } = app;
  const auth = requireAuth(req);
  if (auth.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
  const user = db.prepare('SELECT id, password_hash, totp_secret, totp_enabled, totp_last_step, failed_logins, locked_until FROM users WHERE id = ?')
    .get(auth.user.id) as { id: string; password_hash: string | null; totp_secret: string | null; totp_enabled: number; totp_last_step: number | null; failed_logins: number; locked_until: number | null } | undefined;
  if (!user) throw new HttpError(401, 'Authentification requise');

  if (!user.password_hash) {
    const session = db.prepare('SELECT created_at FROM sessions WHERE id_hash = ?').get(auth.sessionHash ?? '') as { created_at: number } | undefined;
    if (!session || Date.now() - session.created_at > FRESH_SESSION_MS) {
      throw new HttpError(403, 'Reconnectez-vous pour confirmer cette action sensible (session de moins de 15 minutes requise).', { reauth: 'login' });
    }
    return;
  }

  const now = Date.now();
  if (!opts.strict && !input.password) {
    const s = db.prepare('SELECT reauth_at FROM sessions WHERE id_hash = ?').get(auth.sessionHash ?? '') as { reauth_at: number | null } | undefined;
    if (s?.reauth_at && now - s.reauth_at < REAUTH_WINDOW_MS) return;
  }
  if (user.locked_until && user.locked_until > now) throw new HttpError(429, 'Compte temporairement verrouillé : réessayez dans quelques minutes');
  const fail = (message: string): never => {
    const failures = user.failed_logins + 1;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures >= MAX_FAILURES ? 0 : failures, failures >= MAX_FAILURES ? now + LOCK_MS : null, user.id);
    audit(db, req, 'auth.reauth.failed', user.id);
    throw new HttpError(401, message, { reauth: 'password' });
  };
  if (!input.password || !(await verifyPassword(input.password, user.password_hash))) return fail('Mot de passe incorrect');
  if (user.totp_enabled) {
    const code = (input.code ?? '').trim();
    const step = /^\d{6}$/.test(code) && user.totp_secret ? verifyTotp(box.open(user.totp_secret, `totp:${user.id}`), code, user.totp_last_step) : null;
    if (step === null) return fail('Code de double authentification invalide');
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  }
  if (user.failed_logins) db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(user.id);
  db.prepare('UPDATE sessions SET reauth_at = ? WHERE id_hash = ?').run(now, auth.sessionHash ?? '');
}
