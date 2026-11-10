// « Mes tâches » et progression d'une base. Ce fichier ne contrôle pas l'accès aux bases une à une : myTasks reçoit les espaces
// lisibles de l'appelant et filtre les bases par filterReadable (restriction de page, compte requis) ; progressOf est appelé par
// une route qui a déjà ouvert la base en lecture.
// Règle « terminé » commune : la cellule de la première colonne Statut vaut la DERNIÈRE option de ce statut ; sans colonne Statut,
// la première case à cocher est cochée. Sans l'une ni l'autre, rien n'est jamais terminé.
// Les lignes sont lues par json_extract, colonne par colonne : jamais toutes les cellules de toutes les lignes en mémoire.
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { settingsOf } from './base-project.js';
import { type Option, propertiesOf, type Property } from './bases.js';
import { filterReadable } from './page-acl.js';

/** Bases parcourues au plus, tâches rendues au plus. */
export const MAX_TASK_BASES = 200;
export const MAX_TASKS = 500;
/** Bases candidates lues avant le filtre de droits (bornent le travail quand beaucoup de bases sont restreintes). */
const MAX_CANDIDATES = 1000;

// Chemin JSON d'une colonne : les identifiants sont générés par le serveur (base64url), le chemin est passé en paramètre SQL.
const path = (id: string | null | undefined) => (id ? `$."${id}"` : '$."-"');
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

interface DoneRule { kind: 'status' | 'checkbox'; prop: Property; last: Option | null }

/** Colonne qui dit « terminé » : première colonne Statut (dernière option), sinon première case à cocher. */
function doneRule(props: Property[]): DoneRule | null {
  const status = props.find((p) => p.type === 'status');
  if (status) return { kind: 'status', prop: status, last: status.options[status.options.length - 1] ?? null };
  const box = props.find((p) => p.type === 'checkbox');
  return box ? { kind: 'checkbox', prop: box, last: null } : null;
}

/** Condition SQL « terminé » et ses paramètres (une case cochée est stockée `true`, que json_extract rend 1). */
function doneSql(rule: DoneRule | null): { sql: string; params: unknown[] } {
  if (!rule) return { sql: '0', params: [] };
  if (rule.kind === 'status') return rule.last ? { sql: 'json_extract(vals, ?) IS ?', params: [path(rule.prop.id), rule.last.id] } : { sql: '0', params: [] };
  // IS (et non =) : une case absente donne faux, jamais NULL (NOT NULL écarterait la ligne).
  return { sql: "json_type(vals, ?) IS 'true'", params: [path(rule.prop.id)] };
}

export interface Progress { propertyId: string; kind: 'status' | 'checkbox'; done: number; total: number }

/** Progression d'une base : lignes terminées sur lignes en tout, ou null sans colonne Statut ni case à cocher. */
export function progressOf(db: DB, baseId: string, props: Property[] = propertiesOf(db, baseId)): Progress | null {
  const rule = doneRule(props);
  if (!rule) return null;
  const d = doneSql(rule);
  const r = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${d.sql} THEN 1 ELSE 0 END), 0) AS done FROM base_rows WHERE base_id = ?`)
    .get(...d.params, baseId) as { total: number; done: number };
  return { propertyId: rule.prop.id, kind: rule.kind, done: r.done, total: r.total };
}

export interface Task {
  baseId: string; baseTitle: string; spaceId: string; rowId: string; title: string; due: string | null;
  status: { name: string; color: string; done: boolean } | null; done: boolean;
}

/**
 * Échéance : colonne de fin des réglages, sinon de début, sinon première colonne Date ou Plage de dates. Rend l'expression SQL qui
 * la lit et ses paramètres (une plage donne sa fin, sinon son début).
 */
function dueOf(db: DB, baseId: string, props: Property[]): { sql: string; params: string[] } {
  const kind = new Map(props.filter((p) => p.type === 'date' || p.type === 'date_range').map((p) => [p.id, p.type]));
  const s = settingsOf(db, baseId);
  const id = [s.endPropertyId, s.startPropertyId].find((x) => x && kind.has(x)) ?? props.find((p) => kind.has(p.id))?.id ?? null;
  if (id && kind.get(id) === 'date_range') return { sql: 'COALESCE(json_extract(vals, ?), json_extract(vals, ?))', params: [`${path(id)}.end`, `${path(id)}.start`] };
  return { sql: 'json_extract(vals, ?)', params: [path(id)] };
}

/**
 * Tâches de `userId` : lignes dont une colonne Personne le désigne, dans les bases lisibles (espace lisible, page lisible, hors
 * corbeille). Tri : en retard (non terminées, échéance passée), puis échéance croissante, puis sans échéance. `includeDone` à
 * false écarte les tâches terminées. `truncated` : un plafond (bases ou tâches) a été atteint.
 */
export function myTasks(db: DB, auth: Auth, spaceIds: string[], includeDone: boolean, today = new Date().toISOString().slice(0, 10)): { tasks: Task[]; truncated: boolean } {
  const candidates = db.prepare(
    `SELECT p.id, p.title, p.space_id FROM pages p
     WHERE p.kind = 'base' AND p.deleted_at IS NULL AND p.space_id IN (SELECT value FROM json_each(?))
       AND EXISTS (SELECT 1 FROM base_properties bp WHERE bp.base_id = p.id AND bp.type = 'person')
     ORDER BY p.updated_at DESC, p.id LIMIT ?`,
  ).all(JSON.stringify(spaceIds), MAX_CANDIDATES + 1) as { id: string; title: string; space_id: string }[];
  let truncated = candidates.length > MAX_CANDIDATES;
  const readable = filterReadable(db, auth, candidates.slice(0, MAX_CANDIDATES));
  if (readable.length > MAX_TASK_BASES) truncated = true;

  const rank = (t: Task) => (t.due === null ? 2 : !t.done && t.due < today ? 0 : 1);
  const cmp = (a: Task, b: Task) => rank(a) - rank(b) || (a.due ?? '').localeCompare(b.due ?? '') || a.baseTitle.localeCompare(b.baseTitle, 'fr') || a.rowId.localeCompare(b.rowId);
  let kept: Task[] = [];
  for (const base of readable.slice(0, MAX_TASK_BASES)) {
    const props = propertiesOf(db, base.id);
    const people = props.filter((p) => p.type === 'person').map((p) => path(p.id));
    if (!people.length) continue;
    const titleId = props.find((p) => p.type === 'text')?.id;
    const due = dueOf(db, base.id, props);
    const rule = doneRule(props);
    const d = doneSql(rule);
    // Au plus MAX_TASKS + 1 lignes par base, par échéance croissante (sans échéance en dernier) : de quoi garder les MAX_TASKS premières.
    const rows = db.prepare(
      `SELECT id, json_extract(vals, ?) AS title, ${due.sql} AS due, json_extract(vals, ?) AS status, (${d.sql}) AS done
       FROM base_rows
       WHERE base_id = ? AND EXISTS (SELECT 1 FROM json_each(?) c WHERE json_extract(vals, c.value) = ?)
         ${includeDone ? '' : `AND NOT (${d.sql})`}
       ORDER BY typeof(${due.sql}) IS NOT 'text', ${due.sql}, position, created_at LIMIT ?`,
    ).all(
      path(titleId), ...due.params, path(rule?.kind === 'status' ? rule.prop.id : null), ...d.params,
      base.id, JSON.stringify(people), auth.user.id,
      ...(includeDone ? [] : d.params),
      ...due.params, ...due.params, MAX_TASKS + 1,
    ) as { id: string; title: unknown; due: unknown; status: unknown; done: number }[];
    if (rows.length > MAX_TASKS) truncated = true;
    const statusProp = rule?.kind === 'status' ? rule.prop : null;
    for (const r of rows) {
      const opt = statusProp && typeof r.status === 'string' ? statusProp.options.find((o) => o.id === r.status) : undefined;
      const done = !!r.done;
      kept.push({
        baseId: base.id, baseTitle: base.title, spaceId: base.space_id, rowId: r.id,
        title: typeof r.title === 'string' ? r.title : '',
        due: isDate(r.due) ? r.due : null,
        status: opt ? { name: opt.name, color: opt.color, done } : null,
        done,
      });
    }
    // Mémoire bornée : on ne garde que les MAX_TASKS premières tâches à chaque base.
    if (kept.length > MAX_TASKS) { kept.sort(cmp); kept = kept.slice(0, MAX_TASKS); truncated = true; }
  }
  kept.sort(cmp);
  return { tasks: kept, truncated };
}
