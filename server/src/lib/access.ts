// Visibilité des espaces : un espace se voit par adhésion (personne, groupe ou `everyone`, voir space-access.ts), un espace
// public se voit sans adhésion ; un administrateur voit tout ; un visiteur anonyme ne voit que les espaces publics.
import type { FastifyRequest } from 'fastify';
import { can } from '../auth/context.js';
import type { DB } from '../db.js';
import { HttpError } from './http.js';
import { canReadPage, canWritePage } from './page-acl.js';
import { getPageRow, type PageRow } from './pages.js';
import { atLeast, spaceRole, spaceRoles, type SpaceRole } from './space-access.js';

export interface SpaceRow {
  id: string;
  name: string;
  icon: string;
  description: string;
  visibility: 'private' | 'public';
  kind: 'shared' | 'personal';
  owner_id: string | null;
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
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

// Pour les routes : un jeton sans la portée « read » n'a pas plus de droits qu'un visiteur anonyme.
const actor = (req: FastifyRequest) => (can(req.auth, 'read') ? req.auth : null);

export function readableSpaces(db: DB, req: FastifyRequest): SpaceRow[] {
  const all = db.prepare('SELECT * FROM spaces ORDER BY position, created_at').all() as SpaceRow[];
  const roles = spaceRoles(db, actor(req));
  return all.filter((s) => roles.has(s.id));
}

export const readableSpaceIds = (db: DB, req: FastifyRequest) => readableSpaces(db, req).map((s) => s.id);

// Charge une page visible par l'appelant ; 404 sinon (on ne révèle pas son existence).
export function loadReadablePage(db: DB, req: FastifyRequest, id: string, { allowTrashed = false } = {}): PageRow {
  const row = getPageRow(db, id);
  if (!row || (!allowTrashed && row.deleted_at) || !readableSpaceIds(db, req).includes(row.space_id)) {
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
  const role = spaceRole(db, actor(req), spaceId);
  if (role === 'none') throw new HttpError(404, 'Espace introuvable');
  if (!atLeast(role, wanted)) throw new HttpError(403, wanted === 'full' ? 'Réservé aux gestionnaires de cet espace' : 'Accès en lecture seule sur cet espace');
  return role;
}

export const spaceRoleOf = (db: DB, req: FastifyRequest, spaceId: string) => spaceRole(db, actor(req), spaceId);
