// Modèles de ligne d'une base : valeurs de départ d'une nouvelle ligne. Comme bases.ts, ce fichier ne contrôle pas l'accès : les
// routes ouvrent la base (lecture pour lister, écriture pour modifier ou utiliser un modèle).
// Règles :
//  - les valeurs sont validées comme une ligne (checkValue), et seulement pour les colonnes que TEMPLATE_TYPES admet : jamais de
//    formule, cumul, relation, ID unique ni colonne dérivée (créé, modifié) ;
//  - appliquer un modèle revalide ses valeurs avec les droits de l'appelant ; une valeur devenue invalide (personne sans accès,
//    page illisible, option retirée) est ignorée, sans erreur ;
//  - un modèle d'une autre base est introuvable (404).
import type { DB } from '../db.js';
import { checkValue, type Ctx, MAX_ROW_CHARS, presentTemplateValues, propertiesOf, type Property, TEMPLATE_TYPES } from './bases.js';
import { HttpError, newId } from './http.js';

export const MAX_TEMPLATES = 20;
export const MAX_TEMPLATE_NAME = 60;

interface TemplateRow { id: string; base_id: string; name: string; vals: string; position: number; created_by: string | null; created_at: number }

const rowsOf = (db: DB, baseId: string) =>
  db.prepare('SELECT * FROM base_row_templates WHERE base_id = ? ORDER BY position, created_at').all(baseId) as TemplateRow[];

const templateById = (db: DB, baseId: string, id: string): TemplateRow => {
  const t = db.prepare('SELECT * FROM base_row_templates WHERE id = ? AND base_id = ?').get(id, baseId) as TemplateRow | undefined;
  if (!t) throw new HttpError(404, 'Modèle introuvable');
  return t;
};

/** Valide des valeurs de modèle (clé = colonne). Lève 400 pour une colonne inconnue, non admise ou une valeur invalide. */
function checkValues(ctx: Ctx, props: Property[], input: Record<string, unknown>): Record<string, unknown> {
  const byId = new Map(props.map((p) => [p.id, p]));
  const out = new Map<string, unknown>();
  for (const [key, raw] of Object.entries(input)) {
    const prop = byId.get(key);
    if (!prop) throw new HttpError(400, 'Colonne inconnue');
    if (!TEMPLATE_TYPES.has(prop.type)) throw new HttpError(400, `Colonne « ${prop.name} » : un modèle ne remplit pas ce type de colonne`);
    const v = checkValue(ctx, prop, raw);
    if (v !== null) out.set(prop.id, v);
  }
  const vals = Object.fromEntries(out);
  if (JSON.stringify(vals).length > MAX_ROW_CHARS) throw new HttpError(400, 'Modèle trop volumineux');
  return vals;
}

/** Modèles tels que les voit l'appelant : valeurs présentées comme une ligne. */
export function presentTemplates(ctx: Ctx, props: Property[], canSeeNames: boolean): { id: string; name: string; values: Record<string, unknown> }[] {
  const rows = rowsOf(ctx.db, ctx.baseId);
  const values = presentTemplateValues(ctx, props, canSeeNames, rows.map((t) => JSON.parse(t.vals) as Record<string, unknown>));
  return rows.map((t, i) => ({ id: t.id, name: t.name, values: values[i]! }));
}

export function addTemplate(ctx: Ctx, name: string, values: Record<string, unknown>, userId: string | null): string {
  const { db, baseId } = ctx;
  return db.transaction(() => {
    const existing = rowsOf(db, baseId);
    if (existing.length >= MAX_TEMPLATES) throw new HttpError(409, `Au plus ${MAX_TEMPLATES} modèles par base`);
    const vals = checkValues(ctx, propertiesOf(db, baseId), values);
    const id = newId();
    const position = existing.length ? existing[existing.length - 1]!.position + 1 : 0;
    db.prepare('INSERT INTO base_row_templates (id, base_id, name, vals, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, baseId, name, JSON.stringify(vals), position, userId, Date.now());
    return id;
  })();
}

/** Renomme un modèle ou remplace ses valeurs (toutes : les valeurs reçues remplacent les anciennes). */
export function updateTemplate(ctx: Ctx, id: string, patch: { name?: string; values?: Record<string, unknown> }): void {
  const { db, baseId } = ctx;
  db.transaction(() => {
    const t = templateById(db, baseId, id);
    const vals = patch.values === undefined ? t.vals : JSON.stringify(checkValues(ctx, propertiesOf(db, baseId), patch.values));
    db.prepare('UPDATE base_row_templates SET name = ?, vals = ? WHERE id = ?').run(patch.name ?? t.name, vals, id);
  })();
}

export function removeTemplate(db: DB, baseId: string, id: string): void {
  templateById(db, baseId, id);
  db.prepare('DELETE FROM base_row_templates WHERE id = ?').run(id);
}

/**
 * Valeurs de départ d'une ligne créée depuis un modèle : celles du modèle encore valables pour l'appelant (les autres sont
 * ignorées), puis `values` par-dessus. Le résultat est revalidé par addRow.
 */
export function valuesFromTemplate(ctx: Ctx, id: string, values: Record<string, unknown>): Record<string, unknown> {
  const t = templateById(ctx.db, ctx.baseId, id);
  const props = new Map(propertiesOf(ctx.db, ctx.baseId).map((p) => [p.id, p]));
  const out = new Map<string, unknown>();
  for (const [key, raw] of Object.entries(JSON.parse(t.vals) as Record<string, unknown>)) {
    const prop = props.get(key);
    if (!prop || !TEMPLATE_TYPES.has(prop.type)) continue;
    try {
      const v = checkValue(ctx, prop, raw);
      if (v !== null) out.set(key, v);
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 400) throw err;
    }
  }
  for (const [key, v] of Object.entries(values)) out.set(key, v);
  return Object.fromEntries(out);
}
