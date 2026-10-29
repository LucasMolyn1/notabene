// Visibilité des espaces : un utilisateur authentifié (portée « read ») voit tout ;
// un visiteur anonyme ne voit que les espaces publics.
import type { FastifyRequest } from 'fastify';
import { can } from '../auth/context.js';
import type { DB } from '../db.js';
import { HttpError } from './http.js';
import { canReadPage, canWritePage } from './page-acl.js';
import { getPageRow, type PageRow } from './pages.js';

export interface SpaceRow {
  id: string;
  name: string;
  icon: string;
  description: string;
  visibility: 'private' | 'public';
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
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

export function readableSpaces(db: DB, req: FastifyRequest): SpaceRow[] {
  const all = db.prepare('SELECT * FROM spaces ORDER BY position, created_at').all() as SpaceRow[];
  return can(req.auth, 'read') ? all : all.filter((s) => s.visibility === 'public');
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
