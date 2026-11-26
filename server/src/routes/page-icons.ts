// Icône de page importée (API v3). Modèle de sécurité repris de routes/avatars.ts et routes/attachments.ts :
//  - import : droit d'écriture sur la page (rôle, portée « write » du jeton, espace, permission fine) ; type reconnu sur les octets,
//    poids et dimensions bornés, aucun SVG (lib/page-icons.ts) ; l'image remplace la précédente et l'icône de la page la désigne ;
//  - lecture : droit de lecture de la page revérifié à CHAQUE requête, avant toute réponse 304 ; sans compte, seulement par un lien
//    de partage (page ou espace) qui sert la page ;
//  - réponse : type fixe (celui reconnu à l'import), nosniff, affichage en ligne, CSP sandbox, cache privé revalidé.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams } from '../lib/http.js';
import { checkIconImage, getIconImage, ICON_IMAGE_ID, ICON_IMAGE_MAX_BYTES, iconImageId, type IconImageRow, storeIconImage } from '../lib/page-icons.js';
import { getPageRow, isFavorite, toMeta, updatePage } from '../lib/pages.js';
import { activeShare, sharedDescendants } from '../lib/shares.js';
import { activeSpaceShare, spaceSharePages } from '../lib/space-shares.js';

const iconParams = z.object({ id: z.string().regex(ICON_IMAGE_ID, 'identifiant invalide') });
const uploadBody = z.object({ image: z.string().max(Math.ceil(ICON_IMAGE_MAX_BYTES * 4 / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image en base64 attendue') });

export default async function pageIconRoutes(app: FastifyInstance) {
  const { db, bus, config } = app;
  // Plafonds communs avec les pièces jointes.
  const limits = { totalBytes: config.ATTACHMENTS_TOTAL_MB * 1024 * 1024, userBytes: config.ATTACHMENT_USER_MB * 1024 * 1024 };
  const tags = ['pages'];
  const notFound = () => new HttpError(404, 'Icône introuvable');

  const serve = (req: FastifyRequest, reply: FastifyReply, row: IconImageRow) => {
    const etag = `"${row.sha256}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'private, no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('referrer-policy', 'no-referrer');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.header('content-type', row.mime).header('content-disposition', 'inline').header('content-length', row.size).send(row.data);
  };

  // ---- Import et retrait --------------------------------------------------------------------
  app.put('/pages/:id/icon-image', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Importer l’icône image d’une page (PNG, JPEG, WebP ou GIF en base64, 512 Ko au plus)', params: idParams, body: uploadBody },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    // Octets nettoyés (sans métadonnées) : ce sont eux qui sont stockés, servis et dont l'empreinte fait l'ETag.
    const { mime, data } = checkIconImage(Buffer.from((req.body as z.output<typeof uploadBody>).image, 'base64'));
    // Image et icône dans la même transaction : l'icône ne désigne jamais une image absente.
    const row = db.transaction(() => {
      const icon = storeIconImage(db, page.id, data, mime, auth.user.id, limits);
      return updatePage(db, page.id, { icon }, auth.user.id);
    })();
    audit(db, req, 'page.icon.set', page.id, { size: data.length, mime });
    bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: row.id, version: row.version, by: { id: auth.user.id, name: auth.user.name } });
    reply.header('etag', `"${row.version}"`);
    return toMeta(row, isFavorite(db, auth.user.id, row.id));
  });

  app.delete('/pages/:id/icon-image', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Retirer l’icône image d’une page (l’icône redevient vide)', params: idParams },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    const had = db.prepare('SELECT 1 FROM page_icon_images WHERE page_id = ?').get(page.id);
    if (iconImageId(page.icon)) {
      const row = updatePage(db, page.id, { icon: '' }, auth.user.id);
      bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: row.id, version: row.version, by: { id: auth.user.id, name: auth.user.name } });
    } else db.prepare('DELETE FROM page_icon_images WHERE page_id = ?').run(page.id);
    if (had) audit(db, req, 'page.icon.remove', page.id);
    return reply.status(204).send();
  });

  // ---- Lecture ------------------------------------------------------------------------------
  app.get('/page-icons/:id', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Icône image d’une page (droit de lecture de la page vérifié à chaque requête)', params: iconParams },
  }, async (req, reply) => {
    const row = getIconImage(db, (req.params as { id: string }).id);
    if (!row) throw notFound();
    // Page illisible (restreinte, hors espace, hors périmètre du jeton) : même réponse qu'un identifiant inconnu. Une page de la
    // corbeille se lit par qui peut voir la corbeille (portée d'écriture), comme sa liste.
    try { loadReadablePage(db, req, row.page_id, { allowTrashed: can(req.auth, 'write') }); } catch { throw notFound(); }
    // Image que l'icône de sa page ne désigne plus (en attente de nettoyage) : introuvable.
    if (getPageRow(db, row.page_id)?.icon !== `img:${row.id}`) throw notFound();
    return serve(req, reply, row);
  });

  // Sans compte : seulement si le lien sert la page (racine du partage, sous-page incluse et non restreinte, ou page servie d'un
  // espace partagé). Toute raison de refus donne la même réponse 404.
  app.get('/public/shares/:token/page-icons/:id', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Icône image d’une page partagée publiquement (sans compte)', params: z.object({ token: z.string().max(100), id: z.string().regex(ICON_IMAGE_ID, 'identifiant invalide') }) },
  }, async (req, reply) => {
    const { token, id } = req.params as { token: string; id: string };
    reply.header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex, nofollow');
    const found = activeShare(db, token);
    const spaceShare = found ? null : activeSpaceShare(db, token);
    const row = found || spaceShare ? getIconImage(db, id) : undefined;
    const covered = !!row && (found
      ? row.page_id === found.page.id || (!!found.share.include_children && sharedDescendants(db, found.page.id).some((p) => p.id === row.page_id))
      : !!spaceShare && spaceSharePages(db, spaceShare.space.id).some((p) => p.id === row.page_id));
    if (!row || !covered || getPageRow(db, row.page_id)?.icon !== `img:${row.id}`) throw notFound();
    return serve(req, reply, row);
  });
}
