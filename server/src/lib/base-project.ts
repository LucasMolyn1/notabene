// Gestion de projet dans une base : réglages, sous-éléments, dépendances (« bloqué par ») et décalage des dates.
// Comme bases.ts, ce fichier ne contrôle pas l'accès : les routes ouvrent la base en écriture avant d'appeler ces fonctions, et
// tout reste dans la même base (une ligne parente ou bloquante d'une autre base est introuvable).
// Bornes : profondeur des sous-éléments, nombre de bloqueurs par ligne, et décalage en cascade limité en profondeur et en
// nombre de lignes touchées (au-delà : 409, et la transaction de l'appelant n'écrit rien).
import type { DB } from '../db.js';
import { type Ctx, propertiesOf } from './bases.js';
import { HttpError } from './http.js';

/** Nombre d'ancêtres au plus d'une ligne (une ligne de premier niveau en a 0). */
export const MAX_DEPTH = 4;
export const MAX_BLOCKERS = 10;
/** Décalage en cascade : niveaux et lignes décalées au plus. */
export const MAX_SHIFT_DEPTH = 20;
export const MAX_SHIFT_ROWS = 200;

export interface BaseSettings { subitems: boolean; dependencies: boolean; startPropertyId: string | null; endPropertyId: string | null }
interface SettingsRow { subitems: number; dependencies: number; start_property_id: string | null; end_property_id: string | null }

export function settingsOf(db: DB, baseId: string): BaseSettings {
  const r = db.prepare('SELECT subitems, dependencies, start_property_id, end_property_id FROM base_settings WHERE base_id = ?').get(baseId) as SettingsRow | undefined;
  return { subitems: !!r?.subitems, dependencies: !!r?.dependencies, startPropertyId: r?.start_property_id ?? null, endPropertyId: r?.end_property_id ?? null };
}

/** Modifie les réglages. Les colonnes de début et de fin sont des colonnes Date de la base, distinctes. */
export function updateSettings(db: DB, baseId: string, patch: Partial<BaseSettings>): BaseSettings {
  return db.transaction(() => {
    const next = { ...settingsOf(db, baseId), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as BaseSettings;
    const dates = new Set(propertiesOf(db, baseId).filter((p) => p.type === 'date').map((p) => p.id));
    for (const id of [next.startPropertyId, next.endPropertyId]) if (id !== null && !dates.has(id)) throw new HttpError(400, 'Les colonnes de début et de fin sont des colonnes Date de la base');
    if (next.startPropertyId !== null && next.startPropertyId === next.endPropertyId) throw new HttpError(400, 'Le début et la fin sont deux colonnes différentes');
    db.prepare(`INSERT INTO base_settings (base_id, subitems, dependencies, start_property_id, end_property_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(base_id) DO UPDATE SET subitems = excluded.subitems, dependencies = excluded.dependencies, start_property_id = excluded.start_property_id, end_property_id = excluded.end_property_id`)
      .run(baseId, next.subitems ? 1 : 0, next.dependencies ? 1 : 0, next.startPropertyId, next.endPropertyId);
    return settingsOf(db, baseId);
  })();
}

const rowExists = (db: DB, baseId: string, id: string) => !!db.prepare('SELECT 1 FROM base_rows WHERE id = ? AND base_id = ?').get(id, baseId);

/**
 * Place une ligne sous une autre (ou au premier niveau avec null). Même base ; pas de cycle (ni elle-même ni un de ses
 * sous-éléments) ; après le déplacement, aucune ligne de son sous-arbre n'a plus de MAX_DEPTH ancêtres.
 */
export function setParent(ctx: Ctx, rowId: string, parentId: string | null): void {
  const { db, baseId } = ctx;
  if (!rowExists(db, baseId, rowId)) throw new HttpError(404, 'Ligne introuvable');
  if (parentId !== null) {
    if (!rowExists(db, baseId, parentId)) throw new HttpError(400, 'Ligne parente introuvable');
    // Ancêtres du nouveau parent (bornés : la profondeur est vérifiée à chaque écriture).
    const up = db.prepare('SELECT parent_id FROM base_rows WHERE id = ?');
    let ancestors = 0;
    for (let cur: string | null = parentId; cur !== null; ancestors++) {
      if (cur === rowId) throw new HttpError(409, 'Une ligne ne peut pas être sous-élément d’elle-même ou de ses sous-éléments');
      if (ancestors > MAX_DEPTH + 1) throw new HttpError(409, 'Arborescence trop profonde');
      cur = (up.get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    // Hauteur du sous-arbre de la ligne déplacée.
    const height = (db.prepare(`WITH RECURSIVE t(id, d) AS (
        SELECT id, 0 FROM base_rows WHERE id = ?
        UNION SELECT r.id, t.d + 1 FROM base_rows r JOIN t ON r.parent_id = t.id WHERE t.d < ?)
      SELECT MAX(d) AS h FROM t`).get(rowId, MAX_DEPTH + 1) as { h: number }).h;
    // La ligne aura `ancestors` ancêtres, ses sous-éléments jusqu'à `ancestors + height`.
    if (ancestors + height > MAX_DEPTH) throw new HttpError(409, `Au plus ${MAX_DEPTH} niveaux de sous-éléments`);
  }
  db.prepare('UPDATE base_rows SET parent_id = ? WHERE id = ?').run(parentId, rowId);
}

/** Dépendances de la base : pour chaque ligne, les lignes qui la bloquent. */
function blockersMap(db: DB, baseId: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of db.prepare('SELECT row_id, blocker_id FROM base_row_deps WHERE base_id = ?').all(baseId) as { row_id: string; blocker_id: string }[]) {
    m.set(d.row_id, [...(m.get(d.row_id) ?? []), d.blocker_id]);
  }
  return m;
}

/** Remplace la liste « bloqué par » d'une ligne : MAX_BLOCKERS au plus, lignes de la même base, sans cycle (409). */
export function setBlockers(ctx: Ctx, rowId: string, ids: string[]): void {
  const { db, baseId } = ctx;
  if (!rowExists(db, baseId, rowId)) throw new HttpError(404, 'Ligne introuvable');
  const list = [...new Set(ids)];
  if (list.length > MAX_BLOCKERS) throw new HttpError(400, `Au plus ${MAX_BLOCKERS} lignes bloquantes`);
  if (list.includes(rowId)) throw new HttpError(409, 'Une ligne ne peut pas se bloquer elle-même');
  if (list.length) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))').get(baseId, JSON.stringify(list)) as { n: number }).n;
    if (n !== list.length) throw new HttpError(400, 'Ligne bloquante introuvable');
  }
  // Cycle : la ligne serait (indirectement) bloquée par elle-même si elle bloque déjà, de proche en proche, un de ses nouveaux bloqueurs.
  const blockers = blockersMap(db, baseId);
  blockers.delete(rowId);
  const seen = new Set<string>();
  const stack = [...list];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === rowId) throw new HttpError(409, 'Ces dépendances formeraient un cycle');
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const b of blockers.get(cur) ?? []) stack.push(b);
  }
  db.prepare('DELETE FROM base_row_deps WHERE row_id = ?').run(rowId);
  const ins = db.prepare('INSERT INTO base_row_deps (base_id, row_id, blocker_id) VALUES (?, ?, ?)');
  for (const b of list) ins.run(baseId, rowId, b);
}

const DAY = 86_400_000;
const toDay = (s: string) => Date.parse(`${s}T00:00:00Z`) / DAY;
const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const asDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toDay(v)) ? v : null);

/**
 * Décalage : si les dépendances sont actives et la colonne de début définie, une ligne bloquée commence au plus tôt le jour qui
 * suit la fin (sinon le début) de chacune de ses lignes bloquantes. Après l'écriture de `rowId`, cette ligne puis, de proche en
 * proche, les lignes qu'elle bloque sont avancées si besoin (durée conservée, jamais vers le passé). Au-delà de MAX_SHIFT_DEPTH
 * niveaux ou de MAX_SHIFT_ROWS lignes décalées : 409. Rend les identifiants des lignes décalées (autres que `rowId`).
 */
export function cascadeShift(ctx: Ctx, rowId: string, userId: string | null): string[] {
  const { db, baseId } = ctx;
  const s = settingsOf(db, baseId);
  if (!s.dependencies || !s.startPropertyId) return [];
  const start = s.startPropertyId;
  const end = s.endPropertyId;
  const blockers = blockersMap(db, baseId);
  const blocks = new Map<string, string[]>();
  for (const [r, bs] of blockers) for (const b of bs) blocks.set(b, [...(blocks.get(b) ?? []), r]);
  // Lignes atteignables depuis la ligne écrite (elle comprise), et tri topologique de ce sous-graphe (sans cycle par construction).
  const reach = new Set<string>([rowId]);
  const queue = [rowId];
  while (queue.length) for (const n of blocks.get(queue.shift()!) ?? []) if (!reach.has(n)) { reach.add(n); queue.push(n); }
  const indeg = new Map<string, number>([...reach].map((n) => [n, (blockers.get(n) ?? []).filter((b) => reach.has(b)).length]));
  const order: string[] = [];
  const ready = [...reach].filter((n) => indeg.get(n) === 0);
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    for (const m of blocks.get(n) ?? []) if (reach.has(m)) { const d = indeg.get(m)! - 1; indeg.set(m, d); if (d === 0) ready.push(m); }
  }
  // Valeurs des lignes concernées et de leurs bloqueurs.
  const need = new Set<string>(reach);
  for (const n of reach) for (const b of blockers.get(n) ?? []) need.add(b);
  const vals = new Map<string, Record<string, unknown>>();
  for (const r of db.prepare('SELECT id, vals FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))').all(baseId, JSON.stringify([...need])) as { id: string; vals: string }[]) {
    vals.set(r.id, JSON.parse(r.vals) as Record<string, unknown>);
  }
  const finish = (id: string) => { const v = vals.get(id); return v ? asDate(end ? v[end] : undefined) ?? asDate(v[start]) : null; };
  const depth = new Map<string, number>([[rowId, 0]]);
  const moved: string[] = [];
  for (const n of order) {
    const v = vals.get(n);
    const st = v ? asDate(v[start]) : null;
    if (!v || !st) continue;
    let required: number | null = null;
    for (const b of blockers.get(n) ?? []) {
      const f = finish(b);
      if (f !== null) required = Math.max(required ?? -Infinity, toDay(f) + 1);
    }
    if (required === null || toDay(st) >= required) continue;
    // Profondeur : 1 + celle de la plus profonde ligne bloquante déjà décalée (ou de la ligne écrite).
    const d = n === rowId ? 0 : 1 + Math.max(0, ...(blockers.get(n) ?? []).map((b) => depth.get(b) ?? -1).filter((x) => x >= 0));
    if (d > MAX_SHIFT_DEPTH) throw new HttpError(409, `Décalage trop profond (au plus ${MAX_SHIFT_DEPTH} niveaux) : rien n'a été modifié`);
    depth.set(n, d);
    const delta = required - toDay(st);
    const next = { ...v, [start]: fromDay(required) };
    const en = end ? asDate(v[end]) : null;
    if (end && en) next[end] = fromDay(toDay(en) + delta);
    for (const k of [start, end]) if (k && typeof next[k] === 'string' && !/^\d{4}-/.test(next[k] as string)) throw new HttpError(409, 'Date décalée hors limites : rien n\'a été modifié');
    vals.set(n, next);
    moved.push(n);
    if (moved.length > MAX_SHIFT_ROWS) throw new HttpError(409, `Décalage trop étendu (au plus ${MAX_SHIFT_ROWS} lignes) : rien n'a été modifié`);
  }
  const upd = db.prepare('UPDATE base_rows SET vals = ?, updated_by = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  for (const n of moved) upd.run(JSON.stringify(vals.get(n)), userId, now, n);
  return moved.filter((n) => n !== rowId);
}
