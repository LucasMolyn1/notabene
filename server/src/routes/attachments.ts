// Pièces jointes d'une page (API v3). Modèle de sécurité repris de routes/avatars.ts, appliqué à des fichiers quelconques :
//  - envoi : droit d'écriture sur la page (rôle, portée « write » du jeton, espace, permission fine), plafond par fichier et par instance ;
//  - lecture : droit de lecture de la page revérifié à CHAQUE requête (rien n'est mis en cache côté serveur ni partagé entre personnes) ;
//    un visiteur sans compte ne lit que par un lien de partage public qui couvre la page ;
//  - réponse : type reconnu sur les octets, téléchargement forcé sauf image raster, nosniff et CSP qui interdit toute exécution ;
//    requêtes partielles (Range, une seule plage) pour la lecture vidéo et audio, avec les mêmes en-têtes et les mêmes droits.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage } from '../lib/access.js';
import {
  ATTACHMENT_ID, attachmentPath, attachmentsDir, contentDisposition, drainAttachmentGc, INLINE_MIMES, newAttachmentId, parseRange,
  sanitizeFilename, SNIFF_BYTES, sniffMime, tempName, usedBytes, userBytes, type AttachmentMime,
} from '../lib/attachments.js';
import { audit } from '../lib/audit.js';
import { decodeCursor, encodeCursor, pageQuery } from '../lib/cursor.js';
import { HttpError, idParams } from '../lib/http.js';
import { activeShare, sharedDescendants } from '../lib/shares.js';

interface AttachmentRow {
  id: string; page_id: string; uploader_id: string | null; uploader_name: string | null; name: string; mime: AttachmentMime;
  size: number; sha256: string; created_at: number; seq: number;
}

const SELECT = 'SELECT a.*, a.rowid AS seq, u.name AS uploader_name FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id';
const attachmentParams = z.object({ id: z.string().regex(ATTACHMENT_ID, 'identifiant invalide') });
const MB = 1024 * 1024;

const toAttachment = (r: AttachmentRow) => ({
  id: r.id,
  pageId: r.page_id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  sha256: r.sha256,
  inline: INLINE_MIMES.has(r.mime),
  uploader: r.uploader_id ? { id: r.uploader_id, name: r.uploader_name } : null,
  createdAt: r.created_at,
});

// Erreur de l'analyseur multipart ou du flux : message en français, statut adapté (jamais le détail interne).
export function uploadError(err: unknown, maxMb: number): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { code?: string; statusCode?: number };
  if (e?.code === 'FST_REQ_FILE_TOO_LARGE') return new HttpError(413, `Fichier trop lourd (${maxMb} Mo au plus)`);
  if (e?.code === 'FST_FILES_LIMIT' || e?.code === 'FST_PARTS_LIMIT' || e?.code === 'FST_FIELDS_LIMIT') return new HttpError(400, 'Un seul fichier par envoi, sans autre champ');
  return new HttpError(400, 'Envoi interrompu ou invalide');
}

// Envois simultanés permis par personne, et durée totale maximale d'un envoi.
export const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_DEADLINE_MS = 30 * 60_000;

export default async function attachmentRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['attachments'];
  const dir = attachmentsDir(config.DATA_DIR);
  const maxFile = config.ATTACHMENT_MAX_MB * MB;
  const maxTotal = config.ATTACHMENTS_TOTAL_MB * MB;
  const maxUser = config.ATTACHMENT_USER_MB * MB;
  const idleMs = config.ATTACHMENT_UPLOAD_IDLE_SECONDS * 1000;

  // Analyseur multipart limité à ce plugin : aucune autre route n'accepte multipart/form-data. Un seul fichier, aucun champ.
  await app.register(multipart, {
    limits: { fieldNameSize: 100, fields: 0, fileSize: maxFile, files: 1, parts: 1, headerPairs: 20 },
    throwFileSizeLimit: true,
  });

  const byId = (id: string) => db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as AttachmentRow | undefined;

  // Octets des envois en cours (pas encore en base), au total et par personne : comptés dans les plafonds dès leur arrivée,
  // pour que plusieurs envois simultanés ne remplissent pas le disque au-delà du plafond avant d'être enregistrés.
  let reserved = 0;
  const inFlight = new Map<string, { count: number; bytes: number }>();

  // Écrit le flux dans un fichier temporaire (0600), en calculant l'empreinte et en gardant les premiers octets pour le type.
  // Coupe dès que le fichier dépasserait un plafond, ou si l'envoi reste muet trop longtemps ou dure trop.
  async function receive(stream: NodeJS.ReadableStream & { truncated?: boolean }, userId: string, mine: { bytes: number }, own: { bytes: number }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const usedTotal = usedBytes(db);
    const usedUser = userBytes(db, userId);
    const tmp = join(dir, tempName());
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLen = 0;
    let size = 0;
    let idle: NodeJS.Timeout | undefined;
    const tap: Transform = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        reserved += chunk.length;
        mine.bytes += chunk.length;
        own.bytes += chunk.length;
        if (usedTotal + reserved > maxTotal) { done(new HttpError(413, 'Espace de stockage des pièces jointes plein')); return; }
        if (usedUser + mine.bytes > maxUser) { done(new HttpError(413, `Quota personnel de pièces jointes atteint (${config.ATTACHMENT_USER_MB} Mo)`)); return; }
        hash.update(chunk);
        if (headLen < SNIFF_BYTES) { head.push(chunk.subarray(0, SNIFF_BYTES - headLen)); headLen += Math.min(chunk.length, SNIFF_BYTES - headLen); }
        armIdle();
        done(null, chunk);
      },
    });
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => tap.destroy(new HttpError(408, 'Envoi trop lent ou interrompu')), idleMs);
    };
    const deadline = setTimeout(() => tap.destroy(new HttpError(408, 'Envoi trop long')), UPLOAD_DEADLINE_MS);
    armIdle();
    try {
      await pipeline(stream, tap, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw uploadError(err, config.ATTACHMENT_MAX_MB);
    } finally {
      clearTimeout(idle);
      clearTimeout(deadline);
    }
    if (stream.truncated) {
      await unlink(tmp).catch(() => {});
      throw new HttpError(413, `Fichier trop lourd (${config.ATTACHMENT_MAX_MB} Mo au plus)`);
    }
    return { tmp, size, sha256: hash.digest('hex'), head: Buffer.concat(head) };
  }

  // Envoi d'un fichier : réponse sûre, quel que soit ce qu'il contient. Jamais gardé en cache : l'accès est revérifié à chaque fois,
  // y compris pour chaque morceau demandé par un lecteur vidéo (l'appelant a déjà contrôlé les droits de cette requête).
  const serve = async (req: FastifyRequest, reply: FastifyReply, row: AttachmentRow) => {
    const inline = INLINE_MIMES.has(row.mime);
    const etag = `"${row.sha256}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'private, no-store')
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('referrer-policy', 'no-referrer');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    // If-Range : la plage n'est servie que si le fichier est toujours celui que le client connaît (sinon : fichier entier).
    const ifRange = req.headers['if-range'];
    const range = ifRange === undefined || ifRange === etag ? parseRange(req.headers.range, row.size) : null;
    if (range === 'unsatisfiable') return reply.status(416).header('content-range', `bytes */${row.size}`).send();
    const stream = createReadStream(attachmentPath(dir, row.id), range ?? {});
    // Fichier absent du disque (dossier non restauré, effacé à la main) : introuvable, sans détail.
    await new Promise<void>((ok, ko) => { stream.once('open', () => ok()); stream.once('error', ko); }).catch(() => { throw new HttpError(404, 'Pièce jointe introuvable'); });
    reply
      // Le type enregistré est celui reconnu sur les octets (octet-stream à défaut) : jamais celui annoncé par le client.
      .header('content-type', row.mime)
      .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', row.name));
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${row.size}`).header('content-length', range.end - range.start + 1);
    } else reply.header('content-length', row.size);
    return reply.send(stream);
  };

  // ---- Envoi ------------------------------------------------------------------------------
  app.post('/pages/:id/attachments', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Joindre un fichier à une page (multipart/form-data, un seul fichier)', params: idParams, consumes: ['multipart/form-data'] },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    if (page.kind !== 'doc') throw new HttpError(409, 'Une base ne reçoit pas de pièce jointe');
    if (!req.isMultipart()) throw new HttpError(415, 'Envoi attendu en multipart/form-data');
    if (usedBytes(db) + reserved >= maxTotal) throw new HttpError(413, 'Espace de stockage des pièces jointes plein');
    const mine = inFlight.get(auth.user.id) ?? { count: 0, bytes: 0 };
    if (mine.count >= MAX_CONCURRENT_UPLOADS) throw new HttpError(429, 'Trop d’envois simultanés : attendez la fin des précédents');
    mine.count++;
    inFlight.set(auth.user.id, mine);
    // Part de cet envoi dans les réservations (rendue à la fin, réussite ou échec : une fois en base, les octets y sont comptés).
    const own = { bytes: 0 };
    try {
      let file;
      try { file = await req.file(); } catch (err) { throw uploadError(err, config.ATTACHMENT_MAX_MB); }
      if (!file) throw new HttpError(400, 'Aucun fichier reçu');
      const got = await receive(file.file, auth.user.id, mine, own);
      return await commit(req, reply, auth.user.id, page.id, file.filename, got);
    } finally {
      reserved -= own.bytes;
      mine.bytes -= own.bytes;
      if (--mine.count === 0) inFlight.delete(auth.user.id);
    }
  });

  // Fichier reçu : renommé sous son identifiant, puis enregistré si les plafonds le permettent encore (vérifiés en base, dans la
  // transaction d'insertion : deux envois simultanés ne les dépassent pas).
  async function commit(req: FastifyRequest, reply: FastifyReply, userId: string, pageId: string, filename: string | undefined, got: Awaited<ReturnType<typeof receive>>) {
    if (got.size === 0) { await unlink(got.tmp).catch(() => {}); throw new HttpError(400, 'Fichier vide'); }
    const id = newAttachmentId();
    const name = sanitizeFilename(filename);
    const mime = sniffMime(got.head);
    const final = attachmentPath(dir, id);
    try {
      await rename(got.tmp, final);
      db.transaction(() => {
        if (usedBytes(db) + got.size > maxTotal) throw new HttpError(413, 'Espace de stockage des pièces jointes plein');
        if (userBytes(db, userId) + got.size > maxUser) throw new HttpError(413, `Quota personnel de pièces jointes atteint (${config.ATTACHMENT_USER_MB} Mo)`);
        db.prepare('INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, pageId, userId, name, mime, got.size, got.sha256, Date.now());
      })();
    } catch (err) {
      await unlink(got.tmp).catch(() => {});
      await unlink(final).catch(() => {});
      throw err;
    }
    audit(db, req, 'attachment.upload', id, { pageId, size: got.size, mime });
    return reply.status(201).send(toAttachment(byId(id)!));
  }

  // ---- Liste et lecture -------------------------------------------------------------------
  app.get('/pages/:id/attachments', {
    schema: { tags, summary: 'Pièces jointes d’une page (pagination par curseur)', params: idParams, querystring: pageQuery },
  }, async (req) => {
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const q = req.query as z.output<typeof pageQuery>;
    const after = decodeCursor(q.cursor, z.object({ s: z.number().int().min(0) }));
    const rows = db.prepare(`${SELECT} WHERE a.page_id = ? AND a.rowid > ? ORDER BY a.rowid LIMIT ?`).all(page.id, after?.s ?? 0, q.limit + 1) as AttachmentRow[];
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return { items: items.map(toAttachment), nextCursor: rows.length > q.limit && last ? encodeCursor({ s: last.seq }) : null };
  });

  app.get('/attachments/:id', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Télécharger une pièce jointe (droit de lecture de la page vérifié à chaque requête)', params: attachmentParams },
  }, async (req, reply) => {
    const row = byId((req.params as { id: string }).id);
    if (!row) throw new HttpError(404, 'Pièce jointe introuvable');
    // Page illisible (restreinte, hors espace, à la corbeille) : même réponse qu'un identifiant inconnu.
    try { loadReadablePage(db, req, row.page_id); } catch { throw new HttpError(404, 'Pièce jointe introuvable'); }
    return serve(req, reply, row);
  });

  // Lecture sans compte : seulement si le lien couvre la page (racine du partage, ou sous-page incluse et non restreinte).
  app.get('/public/shares/:token/attachments/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Pièce jointe d’une page partagée publiquement (sans compte)', params: z.object({ token: z.string().max(100), id: z.string().regex(ATTACHMENT_ID, 'identifiant invalide') }) },
  }, async (req, reply) => {
    const { token, id } = req.params as { token: string; id: string };
    reply.header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex, nofollow');
    const found = activeShare(db, token);
    const row = found ? byId(id) : undefined;
    const covered = !!found && !!row && (row.page_id === found.page.id
      || (!!found.share.include_children && sharedDescendants(db, found.page.id).some((p) => p.id === row.page_id)));
    if (!found || !row || !covered) throw new HttpError(404, 'Pièce jointe introuvable');
    return serve(req, reply, row);
  });

  // ---- Suppression ------------------------------------------------------------------------
  app.delete('/attachments/:id', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Supprimer une pièce jointe (droit d’écriture sur la page)', params: attachmentParams },
  }, async (req, reply) => {
    const row = byId((req.params as { id: string }).id);
    if (!row) throw new HttpError(404, 'Pièce jointe introuvable');
    try { loadReadablePage(db, req, row.page_id); } catch { throw new HttpError(404, 'Pièce jointe introuvable'); }
    loadWritablePage(db, req, row.page_id);
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    audit(db, req, 'attachment.delete', row.id, { pageId: row.page_id, size: row.size });
    await drainAttachmentGc(db, dir);
    return reply.status(204).send();
  });
}
