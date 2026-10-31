// Droits par espace : personnes et groupes membres d'un espace, avec un rôle `view`, `edit` ou `full`.
//
// Règles (deny by default) :
//  - le droit d'une personne sur un espace est le PLUS ÉLEVÉ de tous ses chemins : son adhésion directe, celle de ses groupes
//    et celle du groupe `everyone` (tous les comptes) ;
//  - le rôle global reste un plafond : un lecteur n'a jamais plus que `view`, quel que soit le rôle de l'espace ;
//  - un administrateur a `full` partout ; un espace public se lit sans adhésion (visiteurs anonymes compris) ;
//  - sans adhésion, sur un espace privé : aucun accès.
// La permission de page (page-acl.ts) ne fait que restreindre ce niveau, jamais l'élargir.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';

export type SpaceRole = 'none' | 'view' | 'edit' | 'full';
export const EVERYONE = 'everyone';
const RANK: Record<SpaceRole, number> = { none: 0, view: 1, edit: 2, full: 3 };
const top = (a: SpaceRole, b: SpaceRole): SpaceRole => (RANK[a] >= RANK[b] ? a : b);
export const atLeast = (role: SpaceRole, wanted: SpaceRole) => RANK[role] >= RANK[wanted];

/** Groupes d'une personne, `everyone` compris. */
export const userGroupIds = (db: DB, userId: string): string[] => [
  EVERYONE,
  ...(db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[]).map((r) => r.group_id),
];

const MEMBERSHIPS = `
  SELECT space_id, role FROM space_members WHERE user_id = @user
  UNION ALL
  SELECT space_id, role FROM space_members
   WHERE group_id = '${EVERYONE}' OR group_id IN (SELECT group_id FROM group_members WHERE user_id = @user)`;

/**
 * Rôle de `auth` sur chaque espace. `auth` nul = visiteur anonyme (espaces publics en lecture seule). Les portées du jeton ne
 * sont pas regardées ici : c'est le rôle de la route (guard) ; seul le rôle global plafonne.
 */
export function spaceRoles(db: DB, auth: Auth | null): Map<string, SpaceRole> {
  const spaces = db.prepare('SELECT id, visibility FROM spaces').all() as { id: string; visibility: 'private' | 'public' }[];
  const roles = new Map<string, SpaceRole>();
  if (!auth) {
    for (const s of spaces) if (s.visibility === 'public') roles.set(s.id, 'view');
    return roles;
  }
  if (auth.user.role === 'admin') {
    for (const s of spaces) roles.set(s.id, 'full');
    return roles;
  }
  const own = new Map<string, SpaceRole>();
  for (const m of db.prepare(MEMBERSHIPS).all({ user: auth.user.id }) as { space_id: string; role: SpaceRole }[]) {
    own.set(m.space_id, top(own.get(m.space_id) ?? 'none', m.role));
  }
  const cap: SpaceRole = auth.user.role === 'reader' ? 'view' : 'full';
  for (const s of spaces) {
    // Un espace public se lit sans adhésion ; l'adhésion ne peut qu'ajouter des droits d'écriture.
    let role = own.get(s.id) ?? 'none';
    if (s.visibility === 'public') role = top(role, 'view');
    if (RANK[role] > RANK[cap]) role = cap;
    if (role !== 'none') roles.set(s.id, role);
  }
  return roles;
}

export function spaceRole(db: DB, auth: Auth | null, spaceId: string): SpaceRole {
  return spaceRoles(db, auth).get(spaceId) ?? 'none';
}

/** Peut gérer les membres et les paramètres de l'espace (administrateur, ou membre `full` d'un rôle global autre que lecteur). */
export const canManageSpace = (db: DB, auth: Auth | null, spaceId: string) => spaceRole(db, auth, spaceId) === 'full';
