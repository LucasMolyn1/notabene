// Accusé de lecture (API v3). Droits, tous issus des contrôles existants (access.ts, page-acl.ts) :
//  - lire l'état et son propre accusé : personne connectée qui peut lire la page (404 sinon, comme ailleurs) ;
//  - activer ou désactiver la demande : pouvoir modifier la page ; désactiver efface tous les accusés ;
//  - accuser réception ou retirer son accusé : pouvoir lire la page ; un jeton d'API doit porter la portée d'écriture ;
//  - liste des lecteurs (noms, dates) : la personne qui a demandé, l'auteur de la page et les administrateurs, seulement.
// Les autres ne voient ni nom ni nombre. Un accusé n'est jamais journalisé un par un (volume et vie privée).
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
  acknowledge, clearReceipts, countReaders, getReadRequest, getReceipt, listReaders, modifiedSinceAck, type ReadRequestRow, requestReceipts, withdrawReceipt,
} from '../lib/read-receipts.js';

const readersCursor = z.object({ a: z.number().int().min(0), i: idSchema });
const WRITE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

// Un jeton d'API doit porter la portée d'écriture pour accuser réception ; une session suffit (un lecteur accuse réception).
const tokenMayWrite = (auth: Auth) => auth.via === 'session' || auth.scopes.has('write');
// Administrateur : rôle et portée (un jeton sans la portée admin n'en donne pas les droits).
const isAdmin = (auth: Auth) => can(auth, 'admin');
const canSeeReaders = (auth: Auth, page: PageRow, request: ReadRequestRow | undefined) =>
  isAdmin(auth) || (page.created_by !== null && page.created_by === auth.user.id) || (!!request && request.requested_by === auth.user.id);

export default async function readReceiptRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['read-receipts'];
  const pageOf = (req: FastifyRequest) => (req.params as { id: string }).id;

  const view = (req: FastifyRequest, page: PageRow) => {
    const auth = requireAuth(req);
    const request = getReadRequest(db, page.id);
    const mine = request ? getReceipt(db, page.id, auth.user.id) : undefined;
    // Comme ailleurs : le nom n'est montré que si le compte est actif et lit encore la page.
    const by = request?.requested_by ? readersAmong(db, page.id, [request.requested_by], 1)[0] : undefined;
    const seeReaders = canSeeReaders(auth, page, request);
    return {
      pageId: page.id,
      requested: !!request,
      requestedBy: by ? { id: by.id, name: by.name } : null,
      requestedAt: request?.created_at ?? null,
      myAck: mine ? { ackedAt: mine.acked_at, modifiedSinceAck: modifiedSinceAck(mine, page.updated_at) } : null,
      canRequest: can(auth, 'write') && canWritePage(db, auth, page.id),
      canAck: !!request && tokenMayWrite(auth),
      canSeeReaders: seeReaders,
      ...(seeReaders ? { readersCount: request ? countReaders(db, page.id) : 0 } : {}),
    };
  };
  // Seules la demande et son retrait sont diffusées. Un accusé ou son retrait ne l'est JAMAIS : l'événement partirait vers
  // tous les lecteurs de la page (y compris les visiteurs d'un espace public) et révélerait qui lit, et combien.
  const announce = (req: FastifyRequest, page: PageRow) => bus.publish({
    type: 'page.read-receipt', spaceId: page.space_id, pageId: page.id,
    by: { id: req.auth!.user.id, name: req.auth!.user.name },
  });

  app.get('/pages/:id/read-receipt', {
    preHandler: guard('read'),
    schema: { tags, summary: 'État de la demande d’accusé de lecture et mon accusé', params: idParams },
  }, async (req) => view(req, loadReadablePage(db, req, pageOf(req))));

  app.put('/pages/:id/read-receipt', {
    preHandler: guard('write'),
    config: WRITE_LIMIT,
    schema: { tags, summary: 'Demander un accusé de lecture sur la page (sans effet si déjà demandé)', params: idParams },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, pageOf(req));
    if (requestReceipts(db, page.id, auth.user.id, Date.now())) {
      audit(db, req, 'read-receipt.request', page.id);
      announce(req, page);
    }
    return view(req, page);
  });

  app.delete('/pages/:id/read-receipt', {
    preHandler: guard('write'),
    config: WRITE_LIMIT,
    schema: { tags, summary: 'Retirer la demande d’accusé de lecture et effacer tous les accusés', params: idParams },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, pageOf(req));
    // Droit de voir le nombre évalué avant l'effacement (la demande porte l'identité du demandeur).
    const current = getReadRequest(db, page.id);
    const seeCount = canSeeReaders(auth, page, current);
    // Retirer la demande efface les accusés : réservé à qui peut les voir (demandeur, auteur, administrateurs), pour qu'un
    // autre éditeur ne puisse pas la retirer puis la reposer à son nom et voir ensuite les accusés.
    if (current && !seeCount) throw new HttpError(403, 'Seuls le demandeur, l’auteur de la page et les administrateurs peuvent retirer cette demande');
    const deleted = clearReceipts(db, page.id);
    if (deleted !== null) {
      audit(db, req, 'read-receipt.clear', page.id, { receiptsDeleted: deleted });
      announce(req, page);
    }
    // Le nombre d'accusés effacés n'est rendu qu'aux personnes qui peuvent voir la liste des lecteurs (toujours dans l'audit).
    return { cleared: deleted !== null, receiptsDeleted: seeCount ? (deleted ?? 0) : null };
  });

  app.post('/pages/:id/read-receipt/ack', {
    preHandler: guard('read'),
    config: WRITE_LIMIT,
    schema: { tags, summary: 'Accuser réception (« J’ai lu ») ; renouvelle un accusé existant', params: idParams },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadReadablePage(db, req, pageOf(req));
    if (!tokenMayWrite(auth)) throw new HttpError(403, 'Permission insuffisante');
    if (!getReadRequest(db, page.id)) throw new HttpError(409, 'Aucun accusé de lecture n’est demandé sur cette page');
    acknowledge(db, page.id, auth.user.id, Date.now());
    return view(req, page);
  });

  app.delete('/pages/:id/read-receipt/ack', {
    preHandler: guard('read'),
    config: WRITE_LIMIT,
    schema: { tags, summary: 'Retirer mon accusé de lecture', params: idParams },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const page = loadReadablePage(db, req, pageOf(req));
    if (!tokenMayWrite(auth)) throw new HttpError(403, 'Permission insuffisante');
    withdrawReceipt(db, page.id, auth.user.id);
    return reply.status(204).send();
  });

  app.get('/pages/:id/read-receipt/readers', {
    preHandler: guard('read'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Personnes qui ont accusé réception (demandeur, auteur de la page, administrateurs), pagination par curseur', params: idParams, querystring: pageQuery },
  }, async (req) => {
    const auth = requireAuth(req);
    const page = loadReadablePage(db, req, pageOf(req));
    const request = getReadRequest(db, page.id);
    if (!canSeeReaders(auth, page, request)) throw new HttpError(403, 'Réservé à la personne qui a demandé, à l’auteur de la page et aux administrateurs');
    const q = req.query as z.output<typeof pageQuery>;
    const after = decodeCursor(q.cursor, readersCursor);
    if (!request) return { items: [], nextCursor: null };
    const { items, next } = listReaders(db, page.id, page.updated_at, { after, limit: q.limit });
    return { items, nextCursor: next ? encodeCursor(next) : null };
  });
}
