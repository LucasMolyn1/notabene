// Page Paramètres : vue d'ensemble de l'instance, utilisateurs, journal d'audit (admin)
// et sessions de l'utilisateur courant.
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { assertBackupAllowed, backupName, backupTo, encryptFile } from '../backup.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams } from '../lib/http.js';
import { eraseUser, exportUserData } from '../lib/personal-data.js';
import { reauthInput, requireReauth } from '../lib/reauth.js';

const VERSION = (() => {
  try { return (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'inconnue'; }
})();

const count = (db: FastifyInstance['db'], sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

export default async function adminRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const live = () => app.rt.get();

  // Configuration non secrète : aucun mot de passe, secret client ni clé n'est renvoyé.
  app.get('/admin/instance', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Vue d’ensemble de l’instance (sans secrets)' } }, async () => {
    const now = Date.now();
    return {
      version: VERSION,
      publicUrl: config.PUBLIC_URL,
      environment: config.NODE_ENV,
      auth: {
        mode: app.oidc.enabled ? 'oidc' : 'dev',
        issuer: live().OIDC_ISSUER ?? null,
        clientId: live().OIDC_CLIENT_ID ?? null,
        scopes: live().OIDC_SCOPES,
        groups: { admin: live().OIDC_ADMIN_GROUPS, editor: live().OIDC_EDITOR_GROUPS, reader: live().OIDC_READER_GROUPS },
        defaultRole: live().OIDC_DEFAULT_ROLE,
        sessionTtlHours: config.SESSION_TTL_HOURS,
        redirectUri: `${config.PUBLIC_URL}/auth/callback`,
      },
      integrations: {
        drawioUrl: config.DRAWIO_URL ?? null,
        embedAllowedOrigins: live().EMBED_ALLOWED_ORIGINS,
        trustProxy: config.TRUST_PROXY,
      },
      stats: {
        users: count(db, 'SELECT COUNT(*) AS n FROM users'),
        spaces: count(db, 'SELECT COUNT(*) AS n FROM spaces'),
        publicSpaces: count(db, "SELECT COUNT(*) AS n FROM spaces WHERE visibility = 'public'"),
        pages: count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'),
        trashed: count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL'),
        versions: count(db, 'SELECT COUNT(*) AS n FROM page_versions'),
        activeTokens: count(db, 'SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL AND expires_at > ?', now),
        activeSessions: count(db, 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', now),
      },
    };
  });

  app.get('/admin/users', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Utilisateurs (rôles issus des groupes OIDC)' } }, async () =>
    (db.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login_at, u.disabled, u.totp_enabled, (u.password_hash IS NOT NULL) AS is_local,
              (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > ?) AS tokens
       FROM users u ORDER BY u.last_login_at DESC`,
    ).all(Date.now()) as { id: string; name: string; email: string | null; role: string; created_at: number; last_login_at: number | null; tokens: number; disabled: number; totp_enabled: number; is_local: number }[])
      .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at, tokens: u.tokens, disabled: !!u.disabled, mfa: !!u.totp_enabled, local: !!u.is_local })));

  app.get('/admin/audit', {
    preHandler: guard('admin'),
    schema: { tags: ['admin'], summary: 'Journal d’audit', querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) },
  }, async (req) => {
    const { limit } = req.query as { limit: number };
    return db.prepare(
      `SELECT a.id, a.at, a.action, a.target, a.ip, a.meta, u.name AS user FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?`,
    ).all(limit);
  });

  // Téléchargement d'une copie cohérente de la base (admin, session navigateur uniquement). Contient des secrets chiffrés et des hash de jetons.
  app.get('/admin/backup', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { hide: true },
  }, async (req, reply) => {
    if (req.auth?.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    // Même règle que la sauvegarde planifiée : en production, pas de copie en clair sans choix explicite.
    try { assertBackupAllowed(process.env); } catch (err) { throw new HttpError(409, (err as Error).message); }
    const dir = mkdtempSync(resolve(tmpdir(), 'nb-backup-'));
    let name = backupName();
    let file = resolve(dir, name);
    try {
      await backupTo(db, file);
      // Destinataire age configuré : le téléchargement est chiffré comme les sauvegardes planifiées.
      if (process.env.BACKUP_AGE_RECIPIENT) { file = await encryptFile(file, process.env.BACKUP_AGE_RECIPIENT); name = `${name}.age`; }
    } catch (err) {
      rmSync(dir, { recursive: true, force: true }); // jamais de copie en clair laissée dans /tmp
      throw err;
    }
    audit(db, req, 'backup.download', null);
    const stream = createReadStream(file);
    stream.on('close', () => rmSync(dir, { recursive: true, force: true }));
    return reply.header('content-type', name.endsWith('.age') ? 'application/octet-stream' : 'application/vnd.sqlite3').header('content-disposition', `attachment; filename="${name}"`).send(stream);
  });

  // Sessions de l'utilisateur courant (navigateur uniquement).
  const requireSession = (req: Parameters<typeof requireAuth>[0]) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    return auth;
  };

  app.get('/sessions', { schema: { tags: ['session'], summary: 'Mes sessions actives', hide: true } }, async (req) => {
    const auth = requireSession(req);
    return (db.prepare('SELECT id_hash, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(auth.user.id, Date.now()) as { id_hash: string; created_at: number; last_seen_at: number; expires_at: number }[])
      .map((s) => ({ id: s.id_hash.slice(0, 8), current: s.id_hash === auth.sessionHash, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at }));
  });

  app.delete('/sessions/others', { schema: { tags: ['session'], summary: 'Fermer mes autres sessions', hide: true } }, async (req) => {
    const auth = requireSession(req);
    const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(auth.user.id, auth.sessionHash);
    app.collab?.recheckAll();
    audit(db, req, 'auth.sessions.revoke', auth.user.id, { count: changes });
    return { closed: changes };
  });

  // ---- Données personnelles (RGPD) -----------------------------------------------------------
  const sendExport = (reply: FastifyReply, data: unknown, name: string) =>
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="${name}.json"`).send(JSON.stringify(data, null, 2));

  // Droit d'accès et de portabilité : l'utilisateur télécharge ses propres données.
  app.get('/me/export', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } }, schema: { hide: true } }, async (req, reply) => {
    const auth = requireSession(req);
    audit(db, req, 'user.export', auth.user.id);
    return sendExport(reply, exportUserData(db, auth.user.id), 'mes-donnees-notabene');
  });

  // Un administrateur peut répondre à une demande d'accès pour un compte.
  app.get('/admin/users/:id/export', { preHandler: guard('admin'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } }, schema: { hide: true, params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = exportUserData(db, id);
    if (!data) throw new HttpError(404, 'Utilisateur introuvable');
    audit(db, req, 'user.export', id);
    return sendExport(reply, data, 'donnees-utilisateur');
  });

  // Droit à l'effacement : anonymisation (voir lib/personal-data.ts). Un compte fédéré encore autorisé par l'annuaire
  // serait recréé à sa prochaine connexion : retirez-le d'abord des groupes ou désactivez la connexion.
  app.post('/admin/users/:id/erase', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { hide: true, params: idParams, body: z.object({ reauth: reauthInput }) },
  }, async (req) => {
    const auth = requireSession(req);
    const { id } = req.params as { id: string };
    await requireReauth(app, req, (req.body as { reauth: z.output<typeof reauthInput> }).reauth);
    if (id === auth.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte ici');
    const target = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id) as { role: string; disabled: number } | undefined;
    if (!target) throw new HttpError(404, 'Utilisateur introuvable');
    if (target.role === 'admin' && !target.disabled && count(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", id) === 0) {
      throw new HttpError(409, 'Impossible de supprimer le dernier administrateur actif');
    }
    eraseUser(db, id);
    app.collab?.recheckAll();
    audit(db, req, 'user.erase', null, { role: target.role });
    return { ok: true };
  });
}
