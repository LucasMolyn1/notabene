// Partage public d'une page par lien (sans compte). Rien n'est définitif : à chaque lecture on revérifie que le partage est
// permis (réglage d'instance, réglage de l'espace), que la page existe hors corbeille et qu'elle n'a pas été restreinte depuis.
// Le visiteur ne reçoit que du contenu assaini : pas de nom de personne (mentions), pas de titre d'une page non partagée, pas
// d'ancre de commentaire.
import type { DB } from '../db.js';
import type { DocNode } from './content.js';
import { governingPage } from './page-acl.js';

const KEY = 'public_sharing';
export const MAX_SHARED_DESCENDANTS = 500;
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

export const sharingEnabled = (db: DB): boolean => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { enabled?: boolean }).enabled === true; } catch { return false; }
};

/** Adresse sans le jeton, pour les journaux. */
export const maskShareToken = (url: string) => url.replace(/(\/(?:share|public\/shares)\/)[^/?#]+/, '$1[jeton]');

/** En-têtes de l'enveloppe de l'application servie sur /share/<jeton>. */
export function shareShellHeaders(db: DB, url: string): Record<string, string> {
  const token = url.split('/')[2]?.split(/[?#]/)[0] ?? '';
  const found = activeShare(db, token);
  return { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': found?.share.indexing ? 'all' : 'noindex, nofollow' };
}

/** Active ou coupe le partage public de l'instance. Couper retire tous les partages (renvoie leur nombre). */
export function setSharingEnabled(db: DB, enabled: boolean, userId: string): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify({ enabled }), Date.now(), userId);
    return enabled ? 0 : db.prepare('DELETE FROM page_shares').run().changes;
  })();
}

export interface ShareRow {
  id: string; page_id: string; token: string; include_children: number; indexing: number; allow_restricted: number;
  created_by: string | null; created_at: number; updated_at: number;
}
interface SharedPage { id: string; space_id: string; parent_id: string | null; title: string; icon: string; content: string; updated_at: number }

/** Le partage de `token`, s'il est encore valable, avec sa page racine. Sinon null (jamais de détail sur la raison). */
export function activeShare(db: DB, token: string): { share: ShareRow; page: SharedPage } | null {
  if (!TOKEN_SHAPE.test(token) || !sharingEnabled(db)) return null;
  const share = db.prepare('SELECT * FROM page_shares WHERE token = ?').get(token) as ShareRow | undefined;
  if (!share) return null;
  const page = db.prepare(
    `SELECT p.id, p.space_id, p.parent_id, p.title, p.icon, p.content, p.updated_at FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.id = ? AND p.deleted_at IS NULL AND s.sharing_enabled = 1`,
  ).get(share.page_id) as SharedPage | undefined;
  if (!page) return null;
  // Une page devenue restreinte depuis le partage n'est plus servie, sauf si le partage a été confirmé pour une page restreinte.
  if (!share.allow_restricted && governingPage(db, page.id)) return null;
  return { share, page };
}

/**
 * Sous-pages incluses dans le partage : toutes celles qui descendent de la racine, hors corbeille, sauf celles qui ont leurs
 * propres permissions (avec leur sous-arbre) : une restriction plus étroite que celle de la racine ne s'ouvre jamais.
 */
export function sharedDescendants(db: DB, rootId: string): { id: string; parentId: string | null; title: string; icon: string; position: number }[] {
  const rows = db.prepare(
    `WITH RECURSIVE sub(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE parent_id = ? AND deleted_at IS NULL
       UNION ALL SELECT p.id, p.parent_id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL AND sub.depth < 50)
     SELECT p.id, p.parent_id AS parentId, p.title, p.icon, p.position,
       (EXISTS (SELECT 1 FROM page_acl a WHERE a.page_id = p.id) OR EXISTS (SELECT 1 FROM page_acl_groups g WHERE g.page_id = p.id)) AS own_acl
     FROM pages p JOIN sub ON sub.id = p.id ORDER BY p.position, p.created_at LIMIT ?`,
  ).all(rootId, MAX_SHARED_DESCENDANTS) as { id: string; parentId: string | null; title: string; icon: string; position: number; own_acl: number }[];
  const blocked = new Set(rows.filter((r) => r.own_acl).map((r) => r.id));
  const parent = new Map(rows.map((r) => [r.id, r.parentId]));
  const excluded = (id: string): boolean => {
    for (let cur: string | null | undefined = id, n = 0; cur && n < 60; cur = parent.get(cur), n++) if (blocked.has(cur)) return true;
    return false;
  };
  return rows.filter((r) => !excluded(r.id)).map(({ own_acl: _acl, ...r }) => r);
}

/**
 * Contenu destiné à un visiteur anonyme : une mention devient « @personne » (aucun nom), un lien vers une page qui n'est pas
 * dans le partage devient un texte neutre (aucun titre), les ancres de commentaires disparaissent.
 */
export function publicDoc(node: DocNode, shared: Set<string>): DocNode {
  if (node.type === 'mention') return { type: 'text', text: '@personne' };
  if (node.type === 'pageLink') {
    const id = String(node.attrs?.id ?? '');
    return shared.has(id) ? node : { type: 'text', text: 'page non partagée' };
  }
  const out: DocNode = { ...node };
  if (node.marks) {
    const marks = node.marks.filter((m) => m.type !== 'commentAnchor');
    if (marks.length) out.marks = marks; else delete out.marks;
  }
  if (node.content) out.content = node.content.map((c) => publicDoc(c, shared));
  return out;
}
