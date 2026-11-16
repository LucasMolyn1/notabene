// Visibilité des espaces : un espace se voit par adhésion (personne, groupe ou `everyone`, voir space-access.ts), un espace
// public se voit sans adhésion ; un administrateur voit tout ; un visiteur anonyme ne voit que les espaces publics.
import type { FastifyRequest } from 'fastify';
import { type Auth, can, type Scope } from '../auth/context.js';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { AttachmentCloner, attachmentsDir, type AttachmentRef } from './attachments.js';
import { markDenied } from '../auth/denials.js';
import { HttpError } from './http.js';
import { canReadPage, canWritePage } from './page-acl.js';
import { getPageRow, type PageRow } from './pages.js';
import { atLeast, routeSpaceRoles, type SpaceRole } from './space-access.js';

export interface SpaceRow {
  id: string;
  name: string;
  icon: string;
  description: string;
  visibility: 'private' | 'public';
  kind: 'shared' | 'personal';
  owner_id: string | null;
  sharing_enabled: number;
  forms_enabled: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export const toSpace = (s: SpaceRow) => ({
  id: s.id,
  name: s.name,
  icon: s.icon,
  description: s.description,
  visibility: s.visibility,
  kind: s.kind,
  ownerId: s.owner_id,
  sharing: !!s.sharing_enabled,
  forms: !!s.forms_enabled,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

// Pour les routes : un jeton sans la portée « read » n'a pas plus de droits qu'un visiteur anonyme (routeSpaceRoles), et un jeton
// limité à certains espaces ne voit jamais les autres.
const roleOn = (db: DB, req: FastifyRequest, spaceId: string): SpaceRole => routeSpaceRoles(db, req.auth).get(spaceId) ?? 'none';

export function readableSpaces(db: DB, req: FastifyRequest): SpaceRow[] {
  const all = db.prepare('SELECT * FROM spaces ORDER BY position, created_at').all() as SpaceRow[];
  const roles = routeSpaceRoles(db, req.auth);
  return all.filter((s) => roles.has(s.id));
}

export const readableSpaceIds = (db: DB, req: FastifyRequest) => readableSpaces(db, req).map((s) => s.id);

// Charge une page visible par l'appelant ; 404 sinon (on ne révèle pas son existence).
// Jeton limité : l'objet existe mais son espace est hors du périmètre du jeton. Noté pour le journal (auth.denied), jamais
// renvoyé au jeton (qui reçoit le même 404 qu'un objet inexistant).
const outsideTokenSpaces = (req: FastifyRequest, spaceId: string | undefined) => {
  if (spaceId && req.auth?.spaceIds && !req.auth.spaceIds.has(spaceId)) markDenied(req, 'space');
};

export function loadReadablePage(db: DB, req: FastifyRequest, id: string, { allowTrashed = false } = {}): PageRow {
  const row = getPageRow(db, id);
  if (!row || (!allowTrashed && row.deleted_at) || !readableSpaceIds(db, req).includes(row.space_id)) {
    outsideTokenSpaces(req, row?.space_id);
    throw new HttpError(404, 'Page introuvable');
  }
  // Page restreinte : introuvable pour qui n'y a pas accès (on ne révèle pas son existence).
  if (!canReadPage(db, req.auth, id)) throw new HttpError(404, 'Page introuvable');
  return row;
}

// Page lisible ET modifiable : un accès en lecture seule (permission fine) donne 403.
export function loadWritablePage(db: DB, req: FastifyRequest, id: string, opts?: { allowTrashed?: boolean }): PageRow {
  const row = loadReadablePage(db, req, id, opts);
  if (!canWritePage(db, req.auth, id)) throw new HttpError(403, 'Accès en lecture seule sur cette page');
  return row;
}

// Droit minimal sur un espace : 404 si l'espace n'est pas visible (on ne révèle pas son existence), 403 si le droit est trop faible.
export function requireSpaceRole(db: DB, req: FastifyRequest, spaceId: string, wanted: Exclude<SpaceRole, 'none'>): SpaceRole {
  const role = roleOn(db, req, spaceId);
  if (role === 'none') {
    if (db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(spaceId)) outsideTokenSpaces(req, spaceId);
    throw new HttpError(404, 'Espace introuvable');
  }
  if (!atLeast(role, wanted)) throw new HttpError(403, wanted === 'full' ? 'Réservé aux gestionnaires de cet espace' : 'Accès en lecture seule sur cet espace');
  return role;
}

export const spaceRoleOf = (db: DB, req: FastifyRequest, spaceId: string) => roleOn(db, req, spaceId);

/**
 * Page parente d'une création, d'une copie ou d'un déplacement : introuvable (404) si elle n'est pas lisible (autre espace, espace
 * hors du périmètre d'un jeton, page restreinte), 403 si elle se lit sans pouvoir être modifiée.
 */
export function assertWritableParent(db: DB, req: FastifyRequest, parentId: string): void {
  if (!canReadPage(db, req.auth, parentId)) {
    outsideTokenSpaces(req, getPageRow(db, parentId)?.space_id);
    throw new HttpError(404, 'Page parente introuvable');
  }
  if (!canWritePage(db, req.auth, parentId)) throw new HttpError(403, 'Accès en lecture seule sur la page parente');
}

/** Jeton limité à certains espaces : ces actions (création d'espace, gestion d'instance) lui sont refusées. */
export function refuseSpaceLimitedToken(req: FastifyRequest, message = 'Un jeton limité à certains espaces ne peut pas faire cette action'): void {
  if (req.auth?.spaceIds) {
    markDenied(req, 'space');
    throw new HttpError(403, message);
  }
}

/**
 * Clause SQL (et paramètre JSON) qui borne `column` (un identifiant de page) aux espaces autorisés d'un jeton limité ; toujours
 * vraie sinon. Pour les écritures sur ses propres données (favoris, suivi, notifications lues) qui ne passent pas par une lecture.
 */
export function tokenPageClause(req: FastifyRequest, column: string): { sql: string; params: string[] } {
  const allowed = req.auth?.spaceIds;
  if (!allowed) return { sql: '1', params: [] };
  return { sql: `${column} IN (SELECT id FROM pages WHERE space_id IN (SELECT value FROM json_each(?)))`, params: [JSON.stringify([...allowed])] };
}

// Pièce jointe lisible par l'appelant : celle d'une page se lit avec la page (espace, restriction, corbeille) ; celle d'un modèle,
// par une personne connectée qui lit l'espace du modèle (comme le modèle lui-même).
export function canReadAttachment(db: DB, req: FastifyRequest, row: Pick<AttachmentRef, 'page_id' | 'template_id'>): boolean {
  if (row.page_id) {
    try { loadReadablePage(db, req, row.page_id); return true; } catch { return false; }
  }
  if (!row.template_id || !can(req.auth, 'read')) return false;
  const t = db.prepare('SELECT space_id FROM page_templates WHERE id = ?').get(row.template_id) as { space_id: string } | undefined;
  return !!t && readableSpaceIds(db, req).includes(t.space_id);
}

const cloneLimits = (config: Config) => ({
  totalBytes: config.ATTACHMENTS_TOTAL_MB * 1024 * 1024, userBytes: config.ATTACHMENT_USER_MB * 1024 * 1024, operationBytes: config.ATTACHMENT_COPY_MAX_MB * 1024 * 1024,
});

/** Copieur des pièces jointes citées, pour une copie faite par l'appelant (droits de lecture et quotas de l'appelant). */
export const clonerFor = (db: DB, config: Config, req: FastifyRequest) => new AttachmentCloner(
  db, attachmentsDir(config.DATA_DIR), req.auth?.user.id ?? null, (row) => canReadAttachment(db, req, row), cloneLimits(config),
);

/**
 * Copieur de la co-édition : une citation n'est copiée que si TOUTES les personnes qui ont modifié depuis le dernier enregistrement
 * peuvent la lire (sinon l'une aurait pu coller l'identifiant d'un fichier qu'elle ne voit pas). Jamais d'échec pour un plafond :
 * la citation est retirée. Les quotas sont ceux de `author` (dernière personne à avoir modifié).
 */
export function collabClonerFor(db: DB, config: Config, editorIds: string[], author: string | null): AttachmentCloner {
  const userRow = db.prepare('SELECT id, name, email, role, disabled FROM users WHERE id = ?');
  const auths = editorIds.map((id) => {
    const u = userRow.get(id) as { id: string; name: string; email: string | null; role: Auth['user']['role']; disabled: number } | undefined;
    return u && !u.disabled ? { user: { id: u.id, name: u.name, email: u.email, role: u.role }, via: 'session' as const, scopes: new Set<Scope>(['read', 'write']) } : null;
  });
  const canRead = (row: AttachmentRef) => auths.length > 0 && auths.every((auth) => !!auth && canReadAttachment(db, { auth } as FastifyRequest, row));
  return new AttachmentCloner(db, attachmentsDir(config.DATA_DIR), author, canRead, cloneLimits(config), { soft: true });
}
