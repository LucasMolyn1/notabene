// Vérification de page (API v3). Droits, tous issus des contrôles existants (access.ts, page-acl.ts) :
//  - lire le statut : personne connectée qui peut lire la page (404 sinon, comme ailleurs) ;
//  - configurer ou retirer : pouvoir modifier la page ; chaque vérificateur désigné doit être actif et pouvoir la lire ;
//  - marquer vérifiée : vérificateur désigné ou administrateur, qui lit encore la page.
// Seuls l'identifiant et le nom des vérificateurs sont montrés, et seulement à qui lit la page.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Auth, can, guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { readersAmong } from '../lib/mentions.js';
import { canWritePage } from '../lib/page-acl.js';
import type { PageRow } from '../lib/pages.js';
import {
  clearVerification, duePages, getVerification, isVerifier, markVerified, MAX_VERIFIERS, modifiedSince, setVerification, statusOf, verifierIds,
} from '../lib/verifications.js';

const setBody = z.object({
  verifierIds: z.array(idSchema).min(1).max(MAX_VERIFIERS).refine((ids) => new Set(ids).size === ids.length, 'Vérificateur en double'),
  intervalDays: z.number().int().min(1).max(3650).nullable(),
});
const listQuery = pageQuery.extend({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['pending', 'expiring', 'expired']).optional(),
});
const dueCursor = z.object({ s: z.number().int().min(0).max(2), d: z.number().int(), i: idSchema });

const isAdmin = (auth: Auth) => can(auth, 'admin');
// Un jeton d'API doit porter la portée d'écriture pour marquer une page vérifiée ; une session suffit (un lecteur peut être vérificateur).
const tokenMayWrite = (auth: Auth) => auth.via === 'session' || auth.scopes.has('write');

export default async function verificationRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['verifications'];

  const view = (req: FastifyRequest, page: PageRow) => {
    const auth = requireAuth(req);
    const row = getVerification(db, page.id);
    const verifier = !!row && isVerifier(db, page.id, auth.user.id);
    // Comme pour les vérificateurs : le nom n'est montré que si le compte est actif et lit encore la page.
    const by = row?.verified_by ? readersAmong(db, page.id, [row.verified_by], 1)[0] : undefined;
    return {
      pageId: page.id,
      status: statusOf(row, Date.now()),
      configured: !!row,
      intervalDays: row?.interval_days ?? null,
      // Vérificateurs actifs qui lisent encore la page ; les autres restent enregistrés mais ne sont ni montrés ni notifiés.
      verifiers: row ? readersAmong(db, page.id, verifierIds(db, page.id), MAX_VERIFIERS).sort((a, b) => a.name.localeCompare(b.name, 'fr')) : [],
      verifiedAt: row?.verified_at ?? null,
      verifiedBy: by ? { id: by.id, name: by.name } : null,
      expiresAt: row?.expires_at ?? null,
      modifiedSinceVerification: modifiedSince(row, page.updated_at),
      isVerifier: verifier,
      canVerify: !!row && (verifier || isAdmin(auth)) && tokenMayWrite(auth),
      canConfigure: can(auth, 'write') && canWritePage(db, auth, page.id),
    };
  };
  const announce = (req: FastifyRequest, page: PageRow) =>
    bus.publish({ type: 'page.verification', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });

  app.get('/pages/:id/verification', {
    preHandler: guard('read'),
    schema: { tags, summary: 'Statut de vérification d’une page', params: idParams },
  }, async (req) => view(req, loadReadablePage(db, req, (req.params as { id: string }).id)));

  app.put('/pages/:id/verification', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Désigner les vérificateurs et l’intervalle (null : sans échéance)', params: idParams, body: setBody },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    const b = req.body as z.output<typeof setBody>;
    // Même réponse pour un compte inconnu, désactivé ou sans accès : rien ne révèle qui existe ni qui lit la page.
    const readers = new Set(readersAmong(db, page.id, b.verifierIds, MAX_VERIFIERS).map((u) => u.id));
    const refused = b.verifierIds.filter((id) => !readers.has(id));
    if (refused.length) throw new HttpError(422, 'Chaque vérificateur doit être un compte actif qui peut lire cette page', { refused });
    const existed = !!getVerification(db, page.id);
    setVerification(db, page.id, b.verifierIds, b.intervalDays, auth.user.id, Date.now());
    audit(db, req, 'verification.set', page.id, { verifiers: b.verifierIds.length, intervalDays: b.intervalDays, created: !existed });
    announce(req, page);
    return view(req, page);
  });

  app.delete('/pages/:id/verification', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Retirer la vérification d’une page', params: idParams },
  }, async (req, reply) => {
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    if (clearVerification(db, page.id)) {
      audit(db, req, 'verification.clear', page.id);
      announce(req, page);
    }
    return reply.status(204).send();
  });

  app.post('/pages/:id/verification/verify', {
    preHandler: guard('read'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Marquer la page vérifiée (vérificateur désigné ou administrateur)', params: idParams },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    if (!tokenMayWrite(auth)) throw new HttpError(403, 'Permission insuffisante');
    if (!getVerification(db, page.id)) throw new HttpError(409, 'Aucune vérification n’est configurée sur cette page');
    if (!isVerifier(db, page.id, auth.user.id) && !isAdmin(auth)) throw new HttpError(403, 'Réservé aux vérificateurs désignés et aux administrateurs');
    markVerified(db, page.id, auth.user.id, Date.now());
    audit(db, req, 'verification.verify', page.id);
    announce(req, page);
    return view(req, page);
  });

  app.get('/verifications', {
    preHandler: guard('read'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Pages à revoir (jamais vérifiées, à échéance proche, expirées), pagination par curseur', querystring: listQuery },
  }, async (req) => {
    const auth = requireAuth(req);
    const q = req.query as z.output<typeof listQuery>;
    if (q.scope === 'all' && !isAdmin(auth)) throw new HttpError(403, 'Réservé aux administrateurs');
    const after = decodeCursor(q.cursor, dueCursor);
    const { items, next } = duePages(db, auth, { userId: q.scope === 'mine' ? auth.user.id : null, status: q.status, after, limit: q.limit, now: Date.now() });
    return { items, nextCursor: next ? encodeCursor(next) : null };
  });
}
