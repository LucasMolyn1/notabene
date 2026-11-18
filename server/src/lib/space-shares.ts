// Partage d'un espace entier par lien non répertorié, en lecture seule et sans compte (par exemple pour un client).
// Règles :
//  - réservé à la session web d'un gestionnaire de l'espace (rôle `full`) ou d'un administrateur ; jamais un espace personnel ;
//  - le jeton (32 octets aléatoires, base64url) n'est jamais stocké : seule son empreinte SHA-256 l'est ; il n'est montré qu'une
//    fois, à la création, et n'apparaît ni dans les journaux (maskShareToken : il passe par /share et /public/shares) ni dans l'audit ;
//  - désactivé par défaut : il faut le partage public de l'instance ET le réglage dédié `public_space_sharing`, plus le partage
//    autorisé dans l'espace. Couper l'un de ces réglages retire les liens ; tout est de plus relu à chaque lecture ;
//  - expiration facultative, vérifiée à chaque lecture (les liens expirés sont purgés par cleanup) ;
//  - contenu : l'arborescence des pages de l'espace hors corbeille, hors bases, sans aucune page qui a ses propres permissions ni
//    son sous-arbre ; chaque page passe par publicDoc (ni nom de personne, ni titre hors partage, ni ancre de commentaire) ;
//  - toute raison de refus donne la même réponse 404, sans détail.
import type { DB } from '../db.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { newId } from './http.js';
import type { Auth } from '../auth/context.js';
import { canManageSpace } from './space-access.js';
import { sharingEnabled, TOKEN_SHAPE } from './shares.js';

const KEY = 'public_space_sharing';
/** Pages au plus dans l'arborescence servie d'un espace partagé. */
export const MAX_SPACE_SHARE_PAGES = 2000;
/** Liens actifs au plus par espace. */
export const MAX_SPACE_SHARES = 20;
/** Forme d'un jeton de partage d'espace : 32 octets en base64url (43 caractères). */
export const SPACE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface SpaceShareRow { id: string; space_id: string; token_hash: string; label: string; expires_at: number | null; created_by: string | null; created_at: number }
export interface SharedSpace { id: string; name: string; icon: string }
export interface SpaceTreeItem { id: string; parentId: string | null; title: string; icon: string; position: number }

/** Réglage dédié de l'instance (désactivé tant qu'un administrateur ne l'a pas activé). */
export const spaceSharingSetting = (db: DB): boolean => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { enabled?: boolean }).enabled === true; } catch { return false; }
};

/** Le partage d'espace est possible sur l'instance : partage public ET réglage dédié. */
export const spaceSharingEnabled = (db: DB): boolean => sharingEnabled(db) && spaceSharingSetting(db);

/** Active ou coupe le partage d'espace. Couper retire tous les liens (renvoie leur nombre) : réactiver n'en fait revivre aucun. */
export function setSpaceSharingEnabled(db: DB, enabled: boolean, userId: string): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify({ enabled }), Date.now(), userId);
    return enabled ? 0 : db.prepare('DELETE FROM space_shares').run().changes;
  })();
}

/** L'espace accepte un lien de partage : espace partagé (jamais personnel) dont le partage public est autorisé. */
export const spaceAllowsShare = (db: DB, spaceId: string): boolean =>
  !!db.prepare("SELECT 1 FROM spaces WHERE id = ? AND kind = 'shared' AND sharing_enabled = 1").get(spaceId);

/** Crée un lien pour un espace. Rend le jeton en clair, une seule fois. */
export function createSpaceShare(db: DB, spaceId: string, input: { label: string; expiresAt: number | null }, userId: string): { row: SpaceShareRow; token: string } {
  const token = randomToken(32);
  const row: SpaceShareRow = { id: newId(), space_id: spaceId, token_hash: sha256(token), label: input.label, expires_at: input.expiresAt, created_by: userId, created_at: Date.now() };
  db.prepare('INSERT INTO space_shares (id, space_id, token_hash, label, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.space_id, row.token_hash, row.label, row.expires_at, row.created_by, row.created_at);
  return { row, token };
}

/** Le lien ne vit que tant que son créateur existe, est actif et gère encore l'espace (rôle `full` ou administrateur). */
function creatorStillManages(db: DB, share: SpaceShareRow): boolean {
  if (!share.created_by) return false;
  const u = db.prepare('SELECT id, name, email, role FROM users WHERE id = ? AND disabled = 0').get(share.created_by) as Auth['user'] | undefined;
  if (!u) return false;
  const auth: Auth = { user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session', scopes: new Set(['read']) };
  return canManageSpace(db, auth, share.space_id);
}

/** Le partage d'espace de `token`, s'il est encore valable, avec son espace. Sinon null (jamais de détail sur la raison). */
export function activeSpaceShare(db: DB, token: string, now = Date.now()): { share: SpaceShareRow; space: SharedSpace } | null {
  if (!TOKEN_SHAPE.test(token) || !SPACE_TOKEN.test(token) || !spaceSharingEnabled(db)) return null;
  const hash = sha256(token);
  const share = db.prepare('SELECT * FROM space_shares WHERE token_hash = ?').get(hash) as SpaceShareRow | undefined;
  if (!share || !safeEqual(share.token_hash, hash)) return null;
  if (share.expires_at !== null && share.expires_at <= now) return null;
  if (!spaceAllowsShare(db, share.space_id)) return null;
  if (!creatorStillManages(db, share)) return null;
  const space = db.prepare('SELECT id, name, icon FROM spaces WHERE id = ?').get(share.space_id) as SharedSpace | undefined;
  return space ? { share, space } : null;
}

/**
 * Pages servies par un partage d'espace : celles de l'espace, hors corbeille, hors bases, sans celles qui ont leurs propres
 * permissions ni leur sous-arbre (on ne descend jamais dedans, avant toute limite : une troncature ne fait rien réapparaître).
 * Ordre par profondeur : un parent précède toujours ses enfants, donc une troncature ne laisse aucune page orpheline.
 */
export function spaceSharePages(db: DB, spaceId: string): SpaceTreeItem[] {
  const open = `p.kind = 'doc' AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM page_acl a WHERE a.page_id = p.id) AND NOT EXISTS (SELECT 1 FROM page_acl_groups g WHERE g.page_id = p.id)`;
  return db.prepare(
    `WITH RECURSIVE sub(id, depth) AS (
       SELECT p.id, 0 FROM pages p WHERE p.space_id = ? AND p.parent_id IS NULL AND ${open}
       UNION ALL SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id WHERE sub.depth < 50 AND p.space_id = ? AND ${open})
     SELECT p.id, p.parent_id AS parentId, p.title, p.icon, p.position FROM pages p JOIN sub ON sub.id = p.id
     ORDER BY sub.depth, p.position, p.created_at LIMIT ?`,
  ).all(spaceId, spaceId, MAX_SPACE_SHARE_PAGES) as SpaceTreeItem[];
}
