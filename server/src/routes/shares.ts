// Partage public d'une page par lien. Trois familles de routes :
//  - gestion (session web uniquement, droit d'écriture sur la page) : créer, régler, régénérer, retirer ;
//  - administration : réglage d'instance, liste des partages ;
//  - lecture publique, SANS compte : /api/v3/public/shares/<jeton>[/pages/<id>], et l'enveloppe /share/<jeton> de l'application.
// Le jeton est le seul secret du lien : aléatoire (192 bits), jamais écrit dans le journal, et vérifié à chaque lecture (lib/shares.ts).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import type { DocNode } from '../lib/content.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { canWritePage, filterReadable } from '../lib/page-acl.js';
import { activeShare, publicDoc, restrictionKey, setSharingEnabled, sharedDescendants, sharingEnabled, type ShareRow } from '../lib/shares.js';

const putBody = z.object({
  includeChildren: z.boolean().optional(),
  indexing: z.boolean().optional(),
  confirmRestricted: z.boolean().optional(),
  regenerate: z.boolean().optional(),
});

export default async function shareRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const tags = ['shares'];
  const urlOf = (token: string) => `${config.PUBLIC_URL}/share/${token}`;

  // Le lien est un secret : session web seulement (un jeton d'API, même de portée écriture, ne publie rien).
  const needSession = (req: Parameters<typeof requireAuth>[0]) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'Le partage public se règle depuis la session web');
    return auth;
  };
  const shareOf = (pageId: string) => db.prepare('SELECT * FROM page_shares WHERE page_id = ?').get(pageId) as ShareRow | undefined;
  const view = (s: ShareRow) => ({ id: s.id, url: urlOf(s.token), includeChildren: !!s.include_children, indexing: !!s.indexing, allowRestricted: !!s.restricted_key, createdAt: s.created_at, updatedAt: s.updated_at });
  const spaceAllows = (spaceId: string) => !!db.prepare('SELECT 1 FROM spaces WHERE id = ? AND sharing_enabled = 1').get(spaceId);

  // ---- Gestion ----------------------------------------------------------------------------
  app.get('/pages/:id/share', { preHandler: guard('read'), schema: { tags, summary: 'État du partage public d’une page', params: idParams } }, async (req) => {
    needSession(req);
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    const writable = canWritePage(db, req.auth, page.id);
    const share = shareOf(page.id);
    return {
      available: sharingEnabled(db) && spaceAllows(page.space_id),
      instanceEnabled: sharingEnabled(db),
      canManage: writable,
      restricted: restrictionKey(db, page.id) !== null,
      confirmed: share ? share.restricted_key === restrictionKey(db, page.id) : false,
      share: share && writable ? view(share) : null, // le lien n'est montré qu'à qui peut modifier la page
    };
  });

  app.put('/pages/:id/share', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Créer ou régler le partage public d’une page', params: idParams, body: putBody },
  }, async (req, reply) => {
    needSession(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    const b = req.body as z.output<typeof putBody>;
    if (!sharingEnabled(db)) throw new HttpError(403, 'Le partage public n’est pas activé sur cette instance');
    if (!spaceAllows(page.space_id)) throw new HttpError(403, 'Le partage public est désactivé dans cet espace');
    const key = restrictionKey(db, page.id);
    const restricted = key !== null;
    const existing = shareOf(page.id);
    // Une page restreinte demande une confirmation, sauf si ce partage l'a déjà reçue pour exactement cette restriction.
    if (restricted && !b.confirmRestricted && existing?.restricted_key !== key) throw new HttpError(409, 'Cette page a des permissions restreintes : confirmez pour la rendre publique', { code: 'restricted' });
    const now = Date.now();
    if (!existing) {
      db.prepare('INSERT INTO page_shares (id, page_id, token, include_children, indexing, restricted_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), page.id, randomToken(24), b.includeChildren ? 1 : 0, b.indexing ? 1 : 0, key, req.auth!.user.id, now, now);
      audit(db, req, 'share.create', page.id, { children: !!b.includeChildren, indexing: !!b.indexing, restricted });
    } else {
      db.prepare('UPDATE page_shares SET include_children = ?, indexing = ?, restricted_key = ?, token = ?, updated_at = ? WHERE id = ?')
        .run(b.includeChildren === undefined ? existing.include_children : b.includeChildren ? 1 : 0, b.indexing === undefined ? existing.indexing : b.indexing ? 1 : 0, key, b.regenerate ? randomToken(24) : existing.token, now, existing.id);
      audit(db, req, b.regenerate ? 'share.regenerate' : 'share.update', page.id, { children: b.includeChildren ?? !!existing.include_children, indexing: b.indexing ?? !!existing.indexing });
    }
    return reply.status(existing ? 200 : 201).send(view(shareOf(page.id)!));
  });

  app.delete('/pages/:id/share', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Retirer le partage public d’une page', params: idParams },
  }, async (req, reply) => {
    needSession(req);
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    if (db.prepare('DELETE FROM page_shares WHERE page_id = ?').run(page.id).changes) audit(db, req, 'share.revoke', page.id);
    return reply.status(204).send();
  });

  // Partages que l'on peut gérer : pages lisibles ET modifiables (un administrateur voit ceux des espaces partagés, jamais des espaces personnels).
  app.get('/shares', { preHandler: guard('write'), schema: { tags, summary: 'Pages partagées publiquement que je peux gérer' } }, async (req) => {
    needSession(req);
    const rows = db.prepare(
      `SELECT sh.*, p.title, p.icon, p.space_id, s.name AS space_name, u.name AS by_name
       FROM page_shares sh JOIN pages p ON p.id = sh.page_id JOIN spaces s ON s.id = p.space_id LEFT JOIN users u ON u.id = sh.created_by
       WHERE p.deleted_at IS NULL ORDER BY sh.created_at DESC LIMIT 1000`,
    ).all() as (ShareRow & { title: string; icon: string; space_id: string; space_name: string; by_name: string | null })[];
    const readable = new Set(filterReadable(db, req.auth, rows.map((r) => ({ id: r.page_id }))).map((r) => r.id));
    return {
      enabled: sharingEnabled(db),
      items: rows.filter((r) => readable.has(r.page_id) && canWritePage(db, req.auth, r.page_id)).map((r) => ({
        pageId: r.page_id, title: r.title, icon: r.icon, spaceName: r.space_name, createdBy: r.by_name, ...view(r),
      })),
    };
  });

  // ---- Administration ----------------------------------------------------------------------
  app.get('/admin/sharing', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Partage public : réglage d’instance' } }, async () => ({
    enabled: sharingEnabled(db),
    shares: (db.prepare('SELECT COUNT(*) AS n FROM page_shares').get() as { n: number }).n,
  }));

  app.put('/admin/sharing', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Autoriser ou non le partage public (désactiver retire tous les partages)', body: z.object({ enabled: z.boolean() }) },
  }, async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    const removed = setSharingEnabled(db, enabled, req.auth!.user.id);
    audit(db, req, 'settings.sharing', null, { enabled, removed });
    return { enabled, removed };
  });

  // ---- Lecture publique (sans compte) ------------------------------------------------------
  const hardened = (reply: FastifyReply, indexing: boolean) =>
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', indexing ? 'all' : 'noindex, nofollow');
  const notFound = (reply: FastifyReply) => hardened(reply, false).status(404).send({ message: 'Lien introuvable ou expiré' });
  const publicLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

  const payload = (token: string, targetId: string | null) => {
    const found = activeShare(db, token);
    if (!found) return null;
    const { share, page: root } = found;
    const tree = share.include_children ? sharedDescendants(db, root.id) : [];
    const ids = new Set([root.id, ...tree.map((t) => t.id)]);
    const targetRow = targetId === null || targetId === root.id
      ? root
      : (ids.has(targetId) ? db.prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE id = ? AND deleted_at IS NULL').get(targetId) as typeof root | undefined : undefined);
    if (!targetRow) return null;
    const titles = new Map<string, string>([[root.id, root.title], ...tree.map((t) => [t.id, t.title] as [string, string])]);
    let content: DocNode;
    try { content = publicDoc(JSON.parse(targetRow.content) as DocNode, ids); } catch { content = { type: 'doc', content: [] }; }
    return {
      indexing: !!share.indexing,
      root: { id: root.id, title: root.title, icon: root.icon },
      page: { id: targetRow.id, title: targetRow.title, icon: targetRow.icon, content, updatedAt: targetRow.updated_at },
      tree: tree.map((t) => ({ id: t.id, parentId: t.parentId === root.id ? null : t.parentId, title: t.title, icon: t.icon })),
      titles: Object.fromEntries(titles),
    };
  };

  app.get('/public/shares/:token', { config: publicLimit, schema: { tags, summary: 'Page partagée publiquement (sans compte)', params: z.object({ token: z.string() }) } }, async (req, reply) => {
    const data = payload((req.params as { token: string }).token, null);
    return data ? hardened(reply, data.indexing).send(data) : notFound(reply);
  });

  app.get('/public/shares/:token/pages/:pageId', {
    config: publicLimit,
    schema: { tags, summary: 'Sous-page d’une page partagée publiquement (sans compte)', params: z.object({ token: z.string(), pageId: idSchema }) },
  }, async (req, reply) => {
    const { token, pageId } = req.params as { token: string; pageId: string };
    const data = payload(token, pageId);
    return data ? hardened(reply, data.indexing).send(data) : notFound(reply);
  });
}
