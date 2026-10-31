// Bases (tableaux) : une base est une page (`pages.kind = 'base'`), donc arborescence, corbeille, permissions et recherche
// sont ceux des pages. Ce fichier ne contrôle pas l'accès : les routes ouvrent la base par loadReadablePage / loadWritablePage.
// Règles de ce fichier :
//  - toute valeur de cellule est validée selon le type de sa colonne (jamais de JSON libre stocké) ;
//  - une cellule « personne » ou « lien vers une page » ne garde qu'un identifiant : le nom ou le titre vient de la base de
//    données au moment de la lecture, et n'est donné que si le lecteur peut lui-même lire la personne ou la page ;
//  - des plafonds bornent colonnes, lignes, options et vues.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { evaluate, FormulaError, parseFormula, referencedProperties, type Value } from './formula.js';
import { HttpError, newId } from './http.js';
import { readersAmong } from './mentions.js';
import { canReadPage, filterReadable } from './page-acl.js';
import { createPage, getPageRow, type PageRow } from './pages.js';

export const MAX_PROPERTIES = 50;
export const MAX_ROWS = 5000;
export const MAX_OPTIONS = 100;
export const MAX_VIEWS = 10;
export const MAX_TEXT = 2000;
export const MAX_FORMULAS = 10;
export const MAX_ROW_CHARS = 20_000;
export const MAX_BASE_CHARS = 10_000_000;

export const PROPERTY_TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'formula'] as const;
export type PropertyType = typeof PROPERTY_TYPES[number];
export const OPTION_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
const WITH_OPTIONS = new Set<PropertyType>(['select', 'multi_select', 'status']);

const optionId = () => randomBytes(5).toString('hex');
const OPTION_ID = /^[0-9a-f]{10}$/;

export const optionSchema = z.object({
  id: z.string().regex(OPTION_ID).optional(),
  name: z.lazy(() => cleanName(40)),
  color: z.enum(OPTION_COLORS).default('gray'),
});
export interface Option { id: string; name: string; color: typeof OPTION_COLORS[number] }



// Vue : tri, filtres, colonnes masquées. Rien d'exécutable : des identifiants de colonnes, des opérateurs d'une liste fermée.
export const FILTER_OPS = ['contains', 'eq', 'neq', 'gt', 'lt', 'empty', 'notempty'] as const;
export const viewConfigSchema = z.object({
  sort: z.array(z.object({ propertyId: z.string().max(40), dir: z.enum(['asc', 'desc']) })).max(3).default([]),
  filters: z.array(z.object({
    propertyId: z.string().max(40),
    op: z.enum(FILTER_OPS),
    value: z.union([z.string().max(200), z.number().finite(), z.boolean()]).nullable().optional(),
  })).max(10).default([]),
  hidden: z.array(z.string().max(40)).max(MAX_PROPERTIES).default([]),
}).strict();
export type ViewConfig = z.output<typeof viewConfigSchema>;

interface PropertyRow { id: string; base_id: string; name: string; type: PropertyType; options: string; position: number; created_at: number; formula: string | null }
export interface Property { id: string; name: string; type: PropertyType; options: Option[]; position: number; formula: string | null }
interface RowRow { id: string; base_id: string; position: number; vals: string; created_by: string | null; created_at: number; updated_by: string | null; updated_at: number }

const toProperty = (r: PropertyRow): Property => ({ id: r.id, name: r.name, type: r.type, options: JSON.parse(r.options) as Option[], position: r.position, formula: r.formula });

export const propertiesOf = (db: DB, baseId: string): Property[] =>
  (db.prepare('SELECT * FROM base_properties WHERE base_id = ? ORDER BY position, created_at').all(baseId) as PropertyRow[]).map(toProperty);

const propertyById = (db: DB, baseId: string, id: string): Property => {
  const r = db.prepare('SELECT * FROM base_properties WHERE base_id = ? AND id = ?').get(baseId, id) as PropertyRow | undefined;
  if (!r) throw new HttpError(404, 'Colonne introuvable');
  return toProperty(r);
};

/** Options normalisées : identifiants attribués, noms uniques (sans tenir compte de la casse), plafond. */
function normalizeOptions(type: PropertyType, input: z.input<typeof optionSchema>[] | undefined, keep?: Option[]): Option[] {
  const list = input ?? keep ?? [];
  if (!WITH_OPTIONS.has(type)) {
    if (list.length) throw new HttpError(400, 'Ce type de colonne n’a pas d’options');
    return [];
  }
  if (list.length > MAX_OPTIONS) throw new HttpError(400, `Au plus ${MAX_OPTIONS} options par colonne`);
  const known = new Set((keep ?? []).map((o) => o.id));
  const names = new Set<string>();
  const ids = new Set<string>();
  return list.map((o) => {
    const parsed = optionSchema.parse(o);
    const key = parsed.name.toLocaleLowerCase('fr');
    if (names.has(key)) throw new HttpError(400, `Option en double : ${parsed.name}`);
    names.add(key);
    // Un identifiant fourni doit être celui d'une option existante : on ne laisse pas le client en inventer.
    let id = parsed.id;
    if (id && !known.has(id)) id = undefined;
    if (!id || ids.has(id)) id = optionId();
    ids.add(id);
    return { id, name: parsed.name, color: parsed.color };
  });
}

/**
 * Une formule se vérifie à l'enregistrement : syntaxe, fonctions connues, et colonnes lues qui existent et ne sont pas elles-mêmes
 * calculées (pas de chaînes de formules, donc pas de cycle).
 */
export function checkFormula(props: Property[], formula: string, selfId?: string): string {
  let names: string[];
  try { names = referencedProperties(parseFormula(formula)); } catch (err) {
    if (err instanceof FormulaError) throw new HttpError(400, `Formule : ${err.message}`);
    throw err;
  }
  const readable = new Map(props.filter((p) => p.type !== 'formula' && p.id !== selfId).map((p) => [p.name, p]));
  for (const n of names) if (!readable.has(n)) throw new HttpError(400, `Formule : la colonne « ${n} » n'existe pas (ou est elle-même calculée)`);
  return formula;
}

export function addProperty(db: DB, baseId: string, input: { name: string; type: PropertyType; options?: z.input<typeof optionSchema>[]; formula?: string }): Property {
  return db.transaction(() => {
    const props = propertiesOf(db, baseId);
    if (props.length >= MAX_PROPERTIES) throw new HttpError(409, `Au plus ${MAX_PROPERTIES} colonnes par base`);
    if ((input.type === 'formula') !== (input.formula !== undefined)) throw new HttpError(400, input.type === 'formula' ? 'Une colonne calculée demande une formule' : 'Seule une colonne calculée a une formule');
    if (input.type === 'formula' && props.filter((p) => p.type === 'formula').length >= MAX_FORMULAS) throw new HttpError(409, `Au plus ${MAX_FORMULAS} colonnes calculées par base`);
    const formula = input.formula === undefined ? null : checkFormula(props, input.formula);
    const options = normalizeOptions(input.type, input.options ?? (input.type === 'status' ? defaultStatus() : undefined));
    const id = newId();
    db.prepare('INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, formula) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, baseId, input.name, input.type, JSON.stringify(options), props.length ? props[props.length - 1]!.position + 1 : 0, Date.now(), formula);
    return propertyById(db, baseId, id);
  })();
}

const defaultStatus = (): z.input<typeof optionSchema>[] => [
  { name: 'À faire', color: 'gray' }, { name: 'En cours', color: 'blue' }, { name: 'Terminé', color: 'green' },
];

/** Renomme une colonne ou change ses options. Une option retirée disparaît des cellules qui la portaient. */
export function updateProperty(db: DB, baseId: string, id: string, input: { name?: string; options?: z.input<typeof optionSchema>[]; formula?: string }): Property {
  return db.transaction(() => {
    const prop = propertyById(db, baseId, id);
    const props = propertiesOf(db, baseId);
    if (input.formula !== undefined && prop.type !== 'formula') throw new HttpError(400, 'Seule une colonne calculée a une formule');
    const formula = input.formula === undefined ? prop.formula : checkFormula(props, input.formula, id);
    // Renommer une colonne lue par une formule la casserait en silence : on refuse, la formule se corrige d'abord.
    if (input.name !== undefined && input.name !== prop.name) {
      const user = formulaUsing(props, prop.name, id);
      if (user) throw new HttpError(409, `La colonne « ${prop.name} » est lue par la formule de « ${user} » : modifiez d'abord cette formule`);
    }
    const options = input.options === undefined ? prop.options : normalizeOptions(prop.type, input.options, prop.options);
    db.prepare('UPDATE base_properties SET name = ?, options = ?, formula = ? WHERE id = ?').run(input.name ?? prop.name, JSON.stringify(options), formula, id);
    if (input.options !== undefined) {
      const alive = new Set(options.map((o) => o.id));
      const removed = prop.options.filter((o) => !alive.has(o.id)).map((o) => o.id);
      if (removed.length) rewriteRows(db, baseId, (vals) => {
        const v = vals.get(id);
        if (typeof v === 'string' && removed.includes(v)) { vals.delete(id); return true; }
        if (Array.isArray(v)) {
          const kept = v.filter((x) => !removed.includes(String(x)));
          if (kept.length !== v.length) { if (kept.length) vals.set(id, kept); else vals.delete(id); return true; }
        }
        return false;
      });
    }
    return propertyById(db, baseId, id);
  })();
}

/** Nom de la première colonne calculée qui lit la colonne `name` (hors `exceptId`), sinon null. */
function formulaUsing(props: Property[], name: string, exceptId: string): string | null {
  for (const p of props) {
    if (p.type !== 'formula' || p.id === exceptId || !p.formula) continue;
    try { if (referencedProperties(parseFormula(p.formula)).includes(name)) return p.name; } catch { /* formule déjà invalide : elle ne lit rien */ }
  }
  return null;
}

export function removeProperty(db: DB, baseId: string, id: string): void {
  db.transaction(() => {
    const removed = propertyById(db, baseId, id);
    const user = formulaUsing(propertiesOf(db, baseId), removed.name, id);
    if (user) throw new HttpError(409, `La colonne « ${removed.name} » est lue par la formule de « ${user} » : modifiez d'abord cette formule`);
    if (propertiesOf(db, baseId).length <= 1) throw new HttpError(409, 'Une base garde au moins une colonne');
    db.prepare('DELETE FROM base_properties WHERE id = ?').run(id);
    rewriteRows(db, baseId, (vals) => vals.delete(id));
    // Les vues ne gardent aucune référence à une colonne qui n'existe plus.
    for (const v of viewsOf(db, baseId)) {
      const c = v.config;
      const next: ViewConfig = { sort: c.sort.filter((s) => s.propertyId !== id), filters: c.filters.filter((f) => f.propertyId !== id), hidden: c.hidden.filter((h) => h !== id) };
      if (JSON.stringify(next) !== JSON.stringify(c)) db.prepare('UPDATE base_views SET config = ? WHERE id = ?').run(JSON.stringify(next), v.id);
    }
  })();
}

// Les cellules sont manipulées dans une Map : la clé (identifiant de colonne) vient du client, jamais d'un objet indexé par elle.
function rewriteRows(db: DB, baseId: string, fn: (vals: Map<string, unknown>) => boolean) {
  const upd = db.prepare('UPDATE base_rows SET vals = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, vals FROM base_rows WHERE base_id = ?').all(baseId) as { id: string; vals: string }[]) {
    const vals = new Map(Object.entries(JSON.parse(r.vals) as Record<string, unknown>));
    if (fn(vals)) upd.run(JSON.stringify(Object.fromEntries(vals)), r.id);
  }
}

// ---------- Valeurs ----------

export interface Ctx {
  db: DB;
  auth: Auth | null;
  /** Espaces que l'appelant peut voir (liens vers des pages). */
  spaces: Set<string>;
  baseId: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Nom saisi : sans caractères de contrôle ni de direction du texte (qui déguisent un nom affiché ou exporté), non vide après nettoyage. */
export const cleanName = (max: number) => z.string().transform((v) => v.replace(CONTROL, '').trim()).pipe(z.string().min(1).max(max));

/** Valide une valeur pour une colonne. `null` efface la cellule. Lève 400 si la valeur ne convient pas. */
export function checkValue(ctx: Ctx, prop: Property, v: unknown): unknown {
  if (v === null) return null;
  const bad = (m: string): never => { throw new HttpError(400, `Colonne « ${prop.name} » : ${m}`); };
  switch (prop.type) {
    case 'formula':
      return bad('colonne calculée, non modifiable');
    case 'text': {
      if (typeof v !== 'string') return bad('texte attendu');
      const t = v.replace(CONTROL, '');
      if (t.length > MAX_TEXT) return bad(`au plus ${MAX_TEXT} caractères`);
      return t === '' ? null : t;
    }
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15) return bad('nombre attendu');
      return v;
    case 'date':
      if (typeof v !== 'string' || !isDate(v)) return bad('date AAAA-MM-JJ attendue');
      return v;
    case 'checkbox':
      if (typeof v !== 'boolean') return bad('oui ou non attendu');
      return v;
    case 'select':
    case 'status':
      if (typeof v !== 'string' || !prop.options.some((o) => o.id === v)) return bad('option inconnue');
      return v;
    case 'multi_select': {
      if (!Array.isArray(v) || v.length > 20) return bad('liste d’options attendue (20 au plus)');
      const ids = [...new Set(v)];
      if (!ids.every((x) => typeof x === 'string' && prop.options.some((o) => o.id === x))) return bad('option inconnue');
      return ids.length ? ids : null;
    }
    case 'person': {
      // Même réponse pour une personne inexistante ou sans accès : on ne révèle pas qui existe ni qui lit la base.
      if (typeof v !== 'string' || !readersAmong(ctx.db, ctx.baseId, [v], 1).length) return bad('personne introuvable ou sans accès à cette base');
      return v;
    }
    case 'page_link': {
      if (typeof v !== 'string') return bad('identifiant de page attendu');
      const p = getPageRow(ctx.db, v);
      if (!p || p.deleted_at || !ctx.spaces.has(p.space_id) || !canReadPage(ctx.db, ctx.auth, v)) return bad('page introuvable');
      return v;
    }
  }
}

/** Applique une modification de cellules (clé = colonne, `null` = effacer) à des valeurs existantes. */
export function applyPatch(ctx: Ctx, props: Property[], current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const byId = new Map(props.map((p) => [p.id, p]));
  const next = new Map(Object.entries(current));
  for (const [key, raw] of Object.entries(patch)) {
    const prop = byId.get(key);
    if (!prop) throw new HttpError(400, 'Colonne inconnue');
    const v = checkValue(ctx, prop, raw);
    if (v === null) next.delete(prop.id); else next.set(prop.id, v);
  }
  const out = Object.fromEntries(next);
  if (JSON.stringify(out).length > MAX_ROW_CHARS) throw new HttpError(400, 'Ligne trop volumineuse');
  return out;
}

export const rowCount = (db: DB, baseId: string) => (db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ?').get(baseId) as { n: number }).n;

const baseChars = (db: DB, baseId: string) => (db.prepare('SELECT COALESCE(SUM(length(vals)), 0) AS n FROM base_rows WHERE base_id = ?').get(baseId) as { n: number }).n;
const assertRoom = (db: DB, baseId: string, added: number) => {
  if (baseChars(db, baseId) + added > MAX_BASE_CHARS) throw new HttpError(409, 'Cette base a atteint sa taille maximale');
};

export function addRow(ctx: Ctx, values: Record<string, unknown>, userId: string | null): RowRow {
  const { db, baseId } = ctx;
  return db.transaction(() => {
    if (rowCount(db, baseId) >= MAX_ROWS) throw new HttpError(409, `Au plus ${MAX_ROWS} lignes par base`);
    const vals = applyPatch(ctx, propertiesOf(db, baseId), {}, values);
    assertRoom(db, baseId, JSON.stringify(vals).length);
    const last = db.prepare('SELECT MAX(position) AS m FROM base_rows WHERE base_id = ?').get(baseId) as { m: number | null };
    const id = newId();
    const now = Date.now();
    db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, baseId, last.m === null ? 0 : last.m + 1, JSON.stringify(vals), userId, now, userId, now);
    return db.prepare('SELECT * FROM base_rows WHERE id = ?').get(id) as RowRow;
  })();
}

export function patchRow(ctx: Ctx, rowId: string, patch: Record<string, unknown>, userId: string | null): RowRow {
  const { db, baseId } = ctx;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM base_rows WHERE id = ? AND base_id = ?').get(rowId, baseId) as RowRow | undefined;
    if (!row) throw new HttpError(404, 'Ligne introuvable');
    const vals = applyPatch(ctx, propertiesOf(db, baseId), JSON.parse(row.vals) as Record<string, unknown>, patch);
    assertRoom(db, baseId, Math.max(0, JSON.stringify(vals).length - row.vals.length));
    db.prepare('UPDATE base_rows SET vals = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vals), userId, Date.now(), rowId);
    return db.prepare('SELECT * FROM base_rows WHERE id = ?').get(rowId) as RowRow;
  })();
}

export function removeRows(db: DB, baseId: string, ids: string[]): number {
  return db.prepare('DELETE FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))').run(baseId, JSON.stringify(ids)).changes;
}

// ---------- Lecture ----------

export interface PresentedRow { id: string; position: number; values: Record<string, unknown>; createdAt: number; updatedAt: number }

/**
 * Lignes telles que les voit l'appelant. Une cellule « personne » n'est nommée qu'à une personne connectée et seulement si cette
 * personne peut lire la base ; une cellule « page » ne donne le titre que d'une page que l'appelant peut lire. Sinon la cellule est vide.
 */
export function presentRows(ctx: Ctx, props: Property[], canSeeNames: boolean, only?: string): PresentedRow[] {
  const { db, baseId } = ctx;
  const rows = (only
    ? db.prepare('SELECT * FROM base_rows WHERE base_id = ? AND id = ?').all(baseId, only)
    : db.prepare('SELECT * FROM base_rows WHERE base_id = ? ORDER BY position, created_at').all(baseId)) as RowRow[];
  const parsed = rows.map((r) => ({ r, vals: JSON.parse(r.vals) as Record<string, unknown> }));
  const people = new Set<string>();
  const pagesSeen = new Set<string>();
  for (const p of props) {
    if (p.type !== 'person' && p.type !== 'page_link') continue;
    for (const { vals } of parsed) {
      const v = vals[p.id];
      if (typeof v === 'string') (p.type === 'person' ? people : pagesSeen).add(v);
    }
  }
  const names = new Map(canSeeNames && people.size ? readersAmong(db, baseId, [...people], people.size).map((u) => [u.id, u.name]) : []);
  const pageInfo = new Map<string, { id: string; title: string; icon: string }>();
  if (pagesSeen.size) {
    // Une requête pour toutes les pages visées (sans leur contenu), puis le filtre de droits habituel.
    const found = db.prepare('SELECT id, space_id, title, icon FROM pages WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...pagesSeen])) as { id: string; space_id: string; title: string; icon: string }[];
    for (const pg of filterReadable(db, ctx.auth, found.filter((f) => ctx.spaces.has(f.space_id)))) pageInfo.set(pg.id, { id: pg.id, title: pg.title, icon: pg.icon });
  }
  const kinds = new Map(props.map((p) => [p.id, p.type]));
  // Formules : analysées une fois, évaluées par ligne sur les valeurs telles que CE lecteur les voit (un nom ou un titre qu'il ne peut
  // pas lire est déjà absent à ce stade, donc la formule ne peut pas le révéler).
  const formulas = props.filter((p) => p.type === 'formula' && p.formula).flatMap((p) => {
    try { return [{ id: p.id, ast: parseFormula(p.formula!) }]; } catch { return []; }
  });
  const byName = new Map(props.filter((p) => p.type !== 'formula').map((p) => [p.name, p]));
  return parsed.map(({ r, vals }) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) {
      const t = kinds.get(k);
      if (!t) continue;
      if (t === 'person') { const n = typeof v === 'string' ? names.get(v) : undefined; if (n !== undefined) out[k] = { id: v, name: n }; }
      else if (t === 'page_link') { const info = typeof v === 'string' ? pageInfo.get(v) : undefined; if (info) out[k] = info; }
      else out[k] = v;
    }
    for (const f of formulas) {
      const result = evaluate(f.ast, (name) => { const p = byName.get(name); return p ? primitive(p, out[p.id]) : null; });
      if (result !== null) out[f.id] = result;
    }
    return { id: r.id, position: r.position, values: out, createdAt: r.created_at, updatedAt: r.updated_at };
  });
}

/** Valeur d'une cellule telle que la lit une formule : un nombre, un texte ou un booléen (jamais un objet). */
function primitive(p: Property, v: unknown): Value {
  if (v === undefined || v === null) return null;
  switch (p.type) {
    case 'select': case 'status': return p.options.find((o) => o.id === v)?.name ?? null;
    case 'multi_select': return (v as string[]).map((x) => p.options.find((o) => o.id === x)?.name).filter(Boolean).join(', ') || null;
    case 'person': return (v as { name: string }).name;
    case 'page_link': return (v as { title: string }).title;
    default: return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null;
  }
}

// ---------- Vues ----------

interface ViewRow { id: string; base_id: string; name: string; config: string; position: number }
export const viewsOf = (db: DB, baseId: string) =>
  (db.prepare('SELECT * FROM base_views WHERE base_id = ? ORDER BY position, created_at').all(baseId) as ViewRow[])
    .map((v) => ({ id: v.id, name: v.name, config: viewConfigSchema.parse(JSON.parse(v.config)), position: v.position }));

/** Une vue ne cite que des colonnes de la base. */
export function checkViewConfig(db: DB, baseId: string, config: ViewConfig): ViewConfig {
  const ids = new Set(propertiesOf(db, baseId).map((p) => p.id));
  const all = [...config.sort.map((s) => s.propertyId), ...config.filters.map((f) => f.propertyId), ...config.hidden];
  if (all.some((id) => !ids.has(id))) throw new HttpError(400, 'La vue cite une colonne inconnue');
  return config;
}

export function addView(db: DB, baseId: string, name: string, config: ViewConfig): { id: string } {
  return db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM base_views WHERE base_id = ?').get(baseId) as { n: number }).n;
    if (n >= MAX_VIEWS) throw new HttpError(409, `Au plus ${MAX_VIEWS} vues par base`);
    const id = newId();
    db.prepare('INSERT INTO base_views (id, base_id, name, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, baseId, name, JSON.stringify(checkViewConfig(db, baseId, config)), n, Date.now());
    return { id };
  })();
}

// ---------- Création, copie, texte de recherche ----------

export function createBase(db: DB, input: { spaceId: string; parentId?: string | null; title?: string; icon?: string }, userId: string | null): PageRow {
  return db.transaction(() => {
    const page = createPage(db, { ...input, kind: 'base' }, userId);
    addProperty(db, page.id, { name: 'Nom', type: 'text' });
    addView(db, page.id, 'Tableau', viewConfigSchema.parse({}));
    return page;
  })();
}

/** Copie colonnes, lignes et vues d'une base vers une autre (vide). Les cellules « personne » et « page » gardent leur identifiant. */
export function copyBaseData(db: DB, srcId: string, dstId: string, userId: string | null): void {
  db.transaction(() => {
    db.prepare('DELETE FROM base_properties WHERE base_id = ?').run(dstId);
    db.prepare('DELETE FROM base_views WHERE base_id = ?').run(dstId);
    const map = new Map<string, string>();
    const insProp = db.prepare('INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, formula) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of db.prepare('SELECT * FROM base_properties WHERE base_id = ? ORDER BY position, created_at').all(srcId) as PropertyRow[]) {
      const id = newId();
      map.set(p.id, id);
      insProp.run(id, dstId, p.name, p.type, p.options, p.position, Date.now(), p.formula);
    }
    const now = Date.now();
    const insRow = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of db.prepare('SELECT * FROM base_rows WHERE base_id = ? ORDER BY position, created_at').all(srcId) as RowRow[]) {
      const vals: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(JSON.parse(r.vals) as Record<string, unknown>)) { const nk = map.get(k); if (nk) vals[nk] = v; }
      insRow.run(newId(), dstId, r.position, JSON.stringify(vals), userId, now, userId, now);
    }
    const insView = db.prepare('INSERT INTO base_views (id, base_id, name, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const v of viewsOf(db, srcId)) {
      const c = v.config;
      const next: ViewConfig = {
        sort: c.sort.filter((s) => map.has(s.propertyId)).map((s) => ({ ...s, propertyId: map.get(s.propertyId)! })),
        filters: c.filters.filter((f) => map.has(f.propertyId)).map((f) => ({ ...f, propertyId: map.get(f.propertyId)! })),
        hidden: c.hidden.filter((h) => map.has(h)).map((h) => map.get(h)!),
      };
      insView.run(newId(), dstId, v.name, JSON.stringify(next), v.position, now);
    }
    reindexBase(db, dstId);
  })();
}

const MAX_INDEX_ROWS = 2000;
const MAX_INDEX_CHARS = 100_000;

/** Texte de recherche de la base : noms de colonnes et contenu des cellules textuelles (bornés). La recherche applique ensuite les droits de la page. */
export function reindexBase(db: DB, baseId: string): void {
  const props = propertiesOf(db, baseId);
  const parts: string[] = props.map((p) => p.name);
  let size = parts.join(' ').length;
  const rows = db.prepare('SELECT vals FROM base_rows WHERE base_id = ? ORDER BY position, created_at LIMIT ?').all(baseId, MAX_INDEX_ROWS) as { vals: string }[];
  outer: for (const r of rows) {
    const vals = JSON.parse(r.vals) as Record<string, unknown>;
    for (const p of props) {
      const v = vals[p.id];
      let t: string | null = null;
      if (typeof v === 'string' && (p.type === 'text' || p.type === 'date')) t = v;
      else if (typeof v === 'number') t = String(v);
      else if (typeof v === 'string' && (p.type === 'select' || p.type === 'status')) t = p.options.find((o) => o.id === v)?.name ?? null;
      else if (Array.isArray(v)) t = v.map((x) => p.options.find((o) => o.id === x)?.name).filter(Boolean).join(' ');
      if (!t) continue;
      if (size + t.length > MAX_INDEX_CHARS) break outer;
      parts.push(t);
      size += t.length + 1;
    }
  }
  db.prepare('UPDATE pages SET text = ? WHERE id = ?').run(parts.join('\n'), baseId);
}

/** Date et auteur de dernière modification de la base, pour « modifié par … ». */
export function touchBase(db: DB, baseId: string, userId: string | null): void {
  db.prepare('UPDATE pages SET updated_at = ?, updated_by = ? WHERE id = ?').run(Date.now(), userId, baseId);
}

// ---------- Export CSV ----------

/** Neutralise l'interprétation d'une cellule comme formule par un tableur (= + - @ tabulation retour). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(props: Property[], rows: PresentedRow[]): string {
  const text = (p: Property, v: unknown): string => {
    if (v === undefined || v === null) return '';
    switch (p.type) {
      case 'checkbox': return v ? 'oui' : 'non';
      case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
      case 'select': case 'status': return p.options.find((o) => o.id === v)?.name ?? '';
      case 'multi_select': return (v as string[]).map((x) => p.options.find((o) => o.id === x)?.name).filter(Boolean).join(', ');
      case 'person': return (v as { name: string }).name;
      case 'page_link': return (v as { title: string }).title || 'Sans titre';
      default: return String(v);
    }
  };
  // Nombres et dates sont validés : ils ne peuvent pas être une formule, et « -5 » doit rester un nombre pour le tableur.
  const cell = (p: Property, v: unknown) => (p.type === 'number' || p.type === 'date' ? text(p, v) : csvCell(text(p, v)));
  const lines = [props.map((p) => csvCell(p.name)).join(',')];
  for (const r of rows) lines.push(props.map((p) => cell(p, r.values[p.id])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
