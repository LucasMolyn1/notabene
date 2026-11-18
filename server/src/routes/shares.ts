// Partage public d'une page par lien. Trois familles de routes :
//  - gestion (session web uniquement, droit d'écriture sur la page) : créer, régler, régénérer, retirer ;
//  - administration : réglage d'instance, liste des partages ;
//  - lecture publique, SANS compte : /api/v3/public/shares/<jeton>[/pages/<id>], et l'enveloppe /share/<jeton> de l'application.
// Les mêmes adresses publiques servent aussi le partage d'un espace entier (lib/space-shares.ts), géré sur /spaces/:id/shares
// par les gestionnaires de l'espace et les administrateurs.
// Le jeton est le seul secret du lien : aléatoire (192 bits), jamais écrit dans le journal, et vérifié à chaque lecture (lib/shares.ts).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage, requireSpaceRole } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import type { DocNode } from '../lib/content.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { canWritePage, filterReadable } from '../lib/page-acl.js';
import { expandSyncedCopies, MAX_ANONYMOUS_SOURCE_CHARS } from '../lib/synced-blocks.js';
import { activeShare, anonymousCanRead, publicDoc, restrictionKey, setSharingEnabled, sharedDescendants, sharingEnabled, type ShareRow } from '../lib/shares.js';
import {
  activeSpaceShare, createSpaceShare, MAX_SPACE_SHARES, setSpaceSharingEnabled, spaceAllowsShare, spaceSharePages, spaceSharingEnabled,
  spaceSharingSetting, type SpaceShareRow,
} from '../lib/space-shares.js';

const putBody = z.object({
  includeChildren: z.boolean().optional(),
  indexing: z.boolean().optional(),
  confirmRestricted: z.boolean().optional(),
  regenerate: z.boolean().optional(),
});
// Lien de partage d'un espace : un libellé (pour qui, par exemple le nom du client) et une expiration facultative.
const spaceShareBody = z.object({
  label: z.string().trim().max(80).default(''),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
const spaceShareParams = z.object({ id: idSchema, shareId: idSchema });

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
    if (page.kind === 'base') throw new HttpError(409, 'Une base ne se partage pas publiquement');
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

  // ---- Partage d'un espace entier --------------------------------------------------------------
  // Gestionnaire de l'espace (rôle `full`) ou administrateur, en session web : 404 sans accès à l'espace, 403 sans le rôle.
  const manageSpace = (req: Parameters<typeof requireAuth>[0], spaceId: string) => {
    needSession(req);
    requireSpaceRole(db, req, spaceId, 'full');
  };
  const isExpired = (s: SpaceShareRow, now: number) => s.expires_at !== null && s.expires_at <= now;

  app.get('/spaces/:id/shares', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Liens de partage d’un espace (gestionnaires et administrateurs)', params: idParams },
  }, async (req) => {
    const { id } = req.params as { id: string };
    manageSpace(req, id);
    const now = Date.now();
    const rows = db.prepare(
      `SELECT sh.*, u.name AS by_name FROM space_shares sh LEFT JOIN users u ON u.id = sh.created_by
       WHERE sh.space_id = ? ORDER BY sh.created_at DESC LIMIT 100`,
    ).all(id) as (SpaceShareRow & { by_name: string | null })[];
    return {
      available: spaceSharingEnabled(db) && spaceAllowsShare(db, id),
      instanceEnabled: sharingEnabled(db),
      spaceSharingEnabled: spaceSharingSetting(db),
      spaceAllows: spaceAllowsShare(db, id),
      // Jamais le lien lui-même : seule son empreinte est gardée, il n'est montré qu'à la création.
      items: rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, expired: isExpired(r, now), createdBy: r.by_name })),
    };
  });

  app.post('/spaces/:id/shares', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Créer un lien de partage en lecture seule pour tout un espace (le lien n’est montré qu’une fois)', params: idParams, body: spaceShareBody },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    manageSpace(req, id);
    const b = req.body as z.output<typeof spaceShareBody>;
    if (!spaceSharingEnabled(db)) throw new HttpError(403, 'Le partage d’espace n’est pas activé sur cette instance');
    if (!spaceAllowsShare(db, id)) throw new HttpError(403, 'Le partage public est désactivé dans cet espace');
    const now = Date.now();
    const active = (db.prepare('SELECT COUNT(*) AS n FROM space_shares WHERE space_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(id, now) as { n: number }).n;
    if (active >= MAX_SPACE_SHARES) throw new HttpError(409, `Au plus ${MAX_SPACE_SHARES} liens actifs par espace`);
    const { row, token } = createSpaceShare(db, id, { label: b.label, expiresAt: b.expiresInDays ? now + b.expiresInDays * 86_400_000 : null }, req.auth!.user.id);
    audit(db, req, 'space.share.create', id, { shareId: row.id, expires: row.expires_at !== null });
    return reply.status(201).send({ id: row.id, label: row.label, url: urlOf(token), createdAt: row.created_at, expiresAt: row.expires_at });
  });

  app.delete('/spaces/:id/shares/:shareId', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Révoquer un lien de partage d’un espace', params: spaceShareParams },
  }, async (req, reply) => {
    const { id, shareId } = req.params as z.output<typeof spaceShareParams>;
    manageSpace(req, id);
    if (!db.prepare('DELETE FROM space_shares WHERE id = ? AND space_id = ?').run(shareId, id).changes) throw new HttpError(404, 'Lien introuvable');
    audit(db, req, 'space.share.revoke', id, { shareId });
    return reply.status(204).send();
  });

  // ---- Administration ----------------------------------------------------------------------
  app.get('/admin/sharing', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Partage public : réglage d’instance' } }, async () => ({
    enabled: sharingEnabled(db),
    shares: (db.prepare('SELECT COUNT(*) AS n FROM page_shares').get() as { n: number }).n,
    spaces: { enabled: spaceSharingSetting(db), links: (db.prepare('SELECT COUNT(*) AS n FROM space_shares').get() as { n: number }).n },
  }));

  app.put('/admin/sharing/spaces', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Autoriser ou non le partage d’espaces entiers par lien (désactiver retire tous ces liens)', body: z.object({ enabled: z.boolean() }) },
  }, async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    const removed = setSpaceSharingEnabled(db, enabled, req.auth!.user.id);
    audit(db, req, 'settings.space_sharing', null, { enabled, removed });
    // `effective` : faux tant que le partage public de l'instance reste coupé.
    return { enabled, removed, effective: spaceSharingEnabled(db) };
  });

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

  // Contenu d'une page pour un visiteur anonyme : copies synchronisées résolues seulement si la source est publiée par ce partage
  // (`ids`) ou lisible sans compte (espace public), puis assainissement (publicDoc).
  const anonymousContent = (raw: string, ids: Set<string>): DocNode => {
    try { return publicDoc(expandSyncedCopies(db, JSON.parse(raw) as DocNode, (pid) => anonymousCanRead(db, pid, ids), { maxSourceChars: MAX_ANONYMOUS_SOURCE_CHARS }), ids); } catch { return { type: 'doc', content: [] }; }
  };

  // Partage d'un espace entier : l'arborescence servie et la page demandée (par défaut la première page racine ; null si l'espace
  // n'a aucune page servie). Ni l'identifiant de l'espace ni rien hors de l'arborescence ne sort ; jamais indexable.
  const spacePayload = (token: string, targetId: string | null) => {
    const found = activeSpaceShare(db, token);
    if (!found) return null;
    const tree = spaceSharePages(db, found.space.id);
    const ids = new Set(tree.map((t) => t.id));
    const wanted = targetId ?? tree[0]?.id ?? null;
    let page: { id: string; title: string; icon: string; content: DocNode; updatedAt: number } | null = null;
    if (wanted !== null) {
      if (!ids.has(wanted)) return null;
      const row = db.prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE id = ? AND space_id = ? AND deleted_at IS NULL')
        .get(wanted, found.space.id) as { id: string; title: string; icon: string; content: string; updated_at: number } | undefined;
      if (!row) return null;
      page = { id: row.id, title: row.title, icon: row.icon, content: anonymousContent(row.content, ids), updatedAt: row.updated_at };
    }
    return {
      kind: 'space' as const,
      indexing: false,
      space: { name: found.space.name, icon: found.space.icon },
      root: null,
      page,
      tree: tree.map((t) => ({ id: t.id, parentId: t.parentId, title: t.title, icon: t.icon })),
      titles: Object.fromEntries(tree.map((t) => [t.id, t.title])),
    };
  };

  const payload = (token: string, targetId: string | null) => {
    const found = activeShare(db, token);
    if (!found) return spacePayload(token, targetId);
    const { share, page: root } = found;
    const tree = share.include_children ? sharedDescendants(db, root.id) : [];
    const ids = new Set([root.id, ...tree.map((t) => t.id)]);
    const targetRow = targetId === null || targetId === root.id
      ? root
      : (ids.has(targetId) ? db.prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE id = ? AND deleted_at IS NULL').get(targetId) as typeof root | undefined : undefined);
    if (!targetRow) return null;
    const titles = new Map<string, string>([[root.id, root.title], ...tree.map((t) => [t.id, t.title] as [string, string])]);
    const content = anonymousContent(targetRow.content, ids);
    return {
      kind: 'page' as const,
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
