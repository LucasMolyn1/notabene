// Groupes : listes de personnes auxquelles on accorde un rôle sur un espace ou une page.
//  - `local` : créé et rempli à la main par un administrateur ;
//  - `system` : « Tout le monde » (`everyone`), implicite, ni modifiable ni supprimable ;
//  - `oidc` | `ldap` | `saml` : lié à UN groupe du fournisseur d'identité (créé à la main par un administrateur, jamais
//    automatiquement), dont l'adhésion est recopiée à chaque connexion. Un groupe du fournisseur inconnu ne crée donc rien.
import type { DB } from '../db.js';
import { EVERYONE } from './space-access.js';

export type GroupSource = 'local' | 'system' | 'oidc' | 'ldap' | 'saml';
export const SYNC_SOURCES = ['oidc', 'ldap', 'saml'] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];
export const MAX_GROUPS = 500;
export const MAX_GROUP_MEMBERS = 5000;

export interface GroupRow { id: string; name: string; description: string; source: GroupSource; external_id: string | null; created_at: number }

export const toGroup = (g: GroupRow, memberCount?: number) => ({
  id: g.id, name: g.name, description: g.description, source: g.source, externalId: g.external_id,
  ...(memberCount === undefined ? {} : { memberCount }),
});

export const isEveryone = (id: string) => id === EVERYONE;

/**
 * Recopie l'adhésion de `userId` depuis les groupes du fournisseur : ajoute les groupes liés dont le nom figure dans
 * `external`, retire les autres groupes liés à ce fournisseur. Les groupes locaux ne sont jamais touchés. Renvoie vrai si
 * quelque chose a changé. Un nom qui ne correspond à aucun groupe lié est ignoré.
 */
export function syncGroups(db: DB, userId: string, source: SyncSource, external: unknown): boolean {
  const names = (Array.isArray(external) ? external : typeof external === 'string' ? [external] : [])
    .filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= 512)
    .slice(0, 1000);
  // Les DN LDAP se comparent sans tenir compte de la casse ; les noms OIDC et SAML sont exacts (« Admins » et « admins » diffèrent).
  const key = (v: string) => (source === 'ldap' ? v.trim().toLowerCase() : v);
  const wanted = new Set(names.map(key));
  const linked = db.prepare('SELECT id, external_id FROM groups WHERE source = ?').all(source) as { id: string; external_id: string }[];
  let changed = false;
  db.transaction(() => {
    for (const g of linked) {
      if (wanted.has(key(g.external_id))) changed = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, userId).changes > 0 || changed;
      else changed = db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, userId).changes > 0 || changed;
    }
  })();
  return changed;
}
