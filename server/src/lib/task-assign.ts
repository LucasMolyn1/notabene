// Attributions de tâches : notées dans la transaction qui écrit la ligne (lib/bases.ts, addRow et patchRow : routes, modèles,
// automatisations), puis envoyées plus tard par lib/task-mail.ts, regroupées, avec l'accès relu à l'envoi.
// Règles : une personne n'est notée que si elle apparaît dans une colonne Personne où elle n'était dans aucune avant l'écriture
// (passer d'une colonne Personne à une autre n'est pas une attribution) ; jamais la personne qui écrit ; jamais une écriture sans
// auteur (réponse anonyme à un formulaire) ; seulement un compte existant et actif.
import type { DB } from '../db.js';
import type { Property } from './bases.js';

export function recordAssignments(
  db: DB, baseId: string, rowId: string, props: Property[], before: Record<string, unknown>, after: Record<string, unknown>, actorId: string | null,
): void {
  if (!actorId) return;
  const people = props.filter((p) => p.type === 'person');
  if (!people.length) return;
  const prev = new Set(people.map((p) => before[p.id]).filter((v): v is string => typeof v === 'string'));
  const added = new Set<string>();
  for (const p of people) {
    const v = after[p.id];
    if (typeof v === 'string' && !prev.has(v) && v !== actorId) added.add(v);
  }
  if (!added.size) return;
  const ins = db.prepare('INSERT OR IGNORE INTO task_assign_events (row_id, user_id, base_id, created_at) SELECT ?, id, ?, ? FROM users WHERE id = ? AND disabled = 0');
  const now = Date.now();
  for (const userId of added) ins.run(rowId, baseId, now, userId);
}
