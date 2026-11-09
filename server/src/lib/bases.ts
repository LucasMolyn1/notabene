// Bases (tableaux) : une base est une page (`pages.kind = 'base'`), donc arborescence, corbeille, permissions et recherche
// sont ceux des pages. Ce fichier ne contrôle pas l'accès : les routes ouvrent la base par loadReadablePage / loadWritablePage.
// Règles de ce fichier :
//  - toute valeur de cellule est validée selon le type de sa colonne (jamais de JSON libre stocké) ;
//  - une cellule « personne » ou « lien vers une page » ne garde qu'un identifiant : le nom ou le titre vient de la base de
//    données au moment de la lecture, et n'est donné que si le lecteur peut lui-même lire la personne ou la page ;
//  - des plafonds bornent colonnes, lignes, options et vues ;
//  - une cellule « relation » ne garde que des identifiants de lignes d'une autre base (ou de la même) : la base cible est relue
//    avec les droits du lecteur à chaque lecture et à chaque écriture (voir baseLevel) ; un cumul est calculé à la lecture, sur les
//    seules lignes cibles que le lecteur peut lire.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type Auth, can } from '../auth/context.js';
import type { DB } from '../db.js';
import { type Budget, evaluate, FormulaError, parseFormula, referencedProperties, type Value } from './formula.js';
import { HttpError, idSchema, newId } from './http.js';
import { readersAmong } from './mentions.js';
import { canReadPage, filterReadable, pageLevel } from './page-acl.js';
import { createPage, getPageRow, type PageRow } from './pages.js';

export const MAX_PROPERTIES = 50;
export const MAX_ROWS = 5000;
export const MAX_OPTIONS = 100;
export const MAX_VIEWS = 10;
export const MAX_TEXT = 2000;
export const MAX_FORMULAS = 10;
/** Caractères que les fonctions de texte des formules peuvent traiter pour UNE lecture de la base (borne le temps de calcul). */
/** `linkedChars` : volume (JSON) des lignes d'autres bases lues pour les relations et cumuls d'UNE lecture. */
export const limits = { formulaChars: 20_000_000, linkedChars: 20_000_000 };
export const MAX_ROW_CHARS = 20_000;
export const MAX_BASE_CHARS = 10_000_000;

export const PROPERTY_TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'formula', 'relation', 'rollup'] as const;
export type PropertyType = typeof PROPERTY_TYPES[number];
/** Colonnes dont la valeur est calculée à la lecture : jamais écrites, jamais lues par une formule ni par un cumul. */
const COMPUTED = new Set<PropertyType>(['formula', 'rollup']);
export const MAX_RELATIONS = 10;
export const MAX_ROLLUPS = 10;
/** Lignes liées par une cellule relation. */
export const MAX_LINKS = 50;
/** Lignes supprimées en une fois, sous-éléments compris. */
export const MAX_DELETE = 500;
export const ROLLUP_FNS = ['count', 'sum', 'avg', 'min', 'max', 'percent_checked'] as const;
export type RollupFn = typeof ROLLUP_FNS[number];
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
export const VIEW_TYPES = ['table', 'kanban', 'timeline'] as const;
export const TIMELINE_SCALES = ['day', 'week', 'month', 'quarter'] as const;
export const viewConfigSchema = z.object({
  // `kanban` : les lignes sont des cartes rangées en colonnes selon la valeur d'une colonne Sélection ou Statut (`groupBy`).
  // `timeline` : barres entre les colonnes de début et de fin des réglages de la base ; `groupBy` et `colorBy` facultatifs.
  type: z.enum(VIEW_TYPES).default('table'),
  groupBy: z.string().max(40).optional(),
  scale: z.enum(TIMELINE_SCALES).optional(),
  colorBy: z.string().max(40).optional(),
  sort: z.array(z.object({ propertyId: z.string().max(40), dir: z.enum(['asc', 'desc']) })).max(3).default([]),
  filters: z.array(z.object({
    propertyId: z.string().max(40),
    op: z.enum(FILTER_OPS),
    value: z.union([z.string().max(200), z.number().finite(), z.boolean()]).nullable().optional(),
  })).max(10).default([]),
  hidden: z.array(z.string().max(40)).max(MAX_PROPERTIES).default([]),
}).strict();
export type ViewConfig = z.output<typeof viewConfigSchema>;

interface PropertyRow { id: string; base_id: string; name: string; type: PropertyType; options: string; position: number; created_at: number; formula: string | null; config: string }
/** Relation : base cible et, pour une relation double, colonne miroir dans la cible. */
export interface RelationConfig { targetId: string; backPropertyId: string | null }
/** Cumul : relation de la même base, colonne lue dans la base cible (aucune pour `count`), fonction. */
export interface RollupConfig { relationId: string; targetPropertyId: string | null; fn: RollupFn }
export type PropertyConfig = RelationConfig | RollupConfig | Record<string, never>;
export interface Property { id: string; name: string; type: PropertyType; options: Option[]; position: number; formula: string | null; config: PropertyConfig }
export interface RowRow { id: string; base_id: string; position: number; vals: string; created_by: string | null; created_at: number; updated_by: string | null; updated_at: number; parent_id: string | null }

// La configuration est écrite par ce serveur seulement ; relue avec prudence (une configuration illisible vaut « aucune »).
function parseConfig(type: PropertyType, raw: string): PropertyConfig {
  let c: unknown;
  try { c = JSON.parse(raw); } catch { c = {}; }
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (type === 'relation') return { targetId: str(o.targetId) ?? '', backPropertyId: str(o.backPropertyId) };
  if (type === 'rollup') return { relationId: str(o.relationId) ?? '', targetPropertyId: str(o.targetPropertyId), fn: (ROLLUP_FNS as readonly string[]).includes(o.fn as string) ? o.fn as RollupFn : 'count' };
  return {};
}
const toProperty = (r: PropertyRow): Property => ({ id: r.id, name: r.name, type: r.type, options: JSON.parse(r.options) as Option[], position: r.position, formula: r.formula, config: parseConfig(r.type, r.config) });
export const relationOf = (p: Property) => p.config as RelationConfig;
export const rollupOf = (p: Property) => p.config as RollupConfig;

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
  // Ni formule, ni cumul, ni relation : pas de chaîne de calculs (donc pas de cycle), et aucune donnée d'une autre base.
  const readable = new Map(props.filter((p) => !COMPUTED.has(p.type) && p.type !== 'relation' && p.id !== selfId).map((p) => [p.name, p]));
  for (const n of names) if (!readable.has(n)) throw new HttpError(400, `Formule : la colonne « ${n} » n'existe pas (ou est elle-même calculée)`);
  return formula;
}

/** Configuration reçue à la création d'une relation (`twoWay` : colonne miroir dans la base cible). */
export const relationInput = z.object({ targetId: idSchema, twoWay: z.boolean().optional() }).strict();
/** Configuration reçue pour un cumul (création ou modification). */
export const rollupInput = z.object({ relationId: idSchema, targetPropertyId: idSchema.nullable().optional(), fn: z.enum(ROLLUP_FNS) }).strict();

function parseInput<T extends z.ZodType>(schema: T, v: unknown, what: string): z.output<T> {
  const r = schema.safeParse(v ?? null);
  if (!r.success) throw new HttpError(400, `Configuration de ${what} invalide`);
  return r.data;
}

/** Un cumul lit une relation de la même base et, sauf `count`, une colonne Nombre (ou Case à cocher pour `percent_checked`) de la cible. */
function checkRollup(ctx: Ctx, props: Property[], input: z.output<typeof rollupInput>): RollupConfig {
  const rel = props.find((p) => p.id === input.relationId && p.type === 'relation');
  if (!rel) throw new HttpError(400, 'Cumul : relation inconnue');
  const targetId = relationOf(rel).targetId;
  if (baseLevel(ctx, targetId) === 'none') throw new HttpError(404, 'Base liée introuvable');
  if (input.fn === 'count') return { relationId: rel.id, targetPropertyId: null, fn: 'count' };
  const target = input.targetPropertyId ? propertiesOf(ctx.db, targetId).find((p) => p.id === input.targetPropertyId) : undefined;
  if (!target) throw new HttpError(400, 'Cumul : colonne de la base liée inconnue');
  const want = input.fn === 'percent_checked' ? 'checkbox' : 'number';
  if (target.type !== want) throw new HttpError(400, want === 'number' ? 'Cumul : cette fonction demande une colonne Nombre' : 'Cumul : cette fonction demande une colonne Case à cocher');
  return { relationId: rel.id, targetPropertyId: target.id, fn: input.fn };
}

/** Premier nom libre dans une base : « Nom », « Nom (2) »… (même règle que assertFreeName). */
function freeName(props: Property[], wanted: string): string {
  const base = wanted.slice(0, 54) || 'Relation';
  if (!props.some((p) => sameName(p.name, base))) return base;
  for (let i = 2; ; i++) { const n = `${base} (${i})`; if (!props.some((p) => sameName(p.name, n))) return n; }
}

const insertProperty = (db: DB, baseId: string, props: Property[], v: { name: string; type: PropertyType; options?: Option[]; formula?: string | null; config?: PropertyConfig }) => {
  const id = newId();
  db.prepare('INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, formula, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, baseId, v.name, v.type, JSON.stringify(v.options ?? []), props.length ? props[props.length - 1]!.position + 1 : 0, Date.now(), v.formula ?? null, JSON.stringify(v.config ?? {}));
  return id;
};

/**
 * Ajoute une colonne. Une relation ou un cumul demande `ctx` (droits de l'appelant sur la base cible) :
 *  - relation simple : lire la base cible ; relation double : pouvoir l'écrire (la colonne miroir y est créée) ;
 *  - cumul : lire la base cible de sa relation.
 * Une base cible illisible répond 404, comme une base qui n'existe pas.
 */
export function addProperty(db: DB, baseId: string, input: { name: string; type: PropertyType; options?: z.input<typeof optionSchema>[]; formula?: string; config?: unknown }, ctx?: Ctx): Property {
  return db.transaction(() => {
    const props = propertiesOf(db, baseId);
    if (props.length >= MAX_PROPERTIES) throw new HttpError(409, `Au plus ${MAX_PROPERTIES} colonnes par base`);
    assertFreeName(props, input.name);
    if ((input.type === 'formula') !== (input.formula !== undefined)) throw new HttpError(400, input.type === 'formula' ? 'Une colonne calculée demande une formule' : 'Seule une colonne calculée a une formule');
    const linked = input.type === 'relation' || input.type === 'rollup';
    if (!linked && input.config !== undefined) throw new HttpError(400, 'Ce type de colonne n’a pas de configuration');
    if (linked && !ctx) throw new HttpError(400, 'Relation impossible ici');
    if (input.type === 'formula' && props.filter((p) => p.type === 'formula').length >= MAX_FORMULAS) throw new HttpError(409, `Au plus ${MAX_FORMULAS} colonnes calculées par base`);
    const formula = input.formula === undefined ? null : checkFormula(props, input.formula);
    const options = normalizeOptions(input.type, input.options ?? (input.type === 'status' ? defaultStatus() : undefined));

    if (input.type === 'rollup') {
      if (props.filter((p) => p.type === 'rollup').length >= MAX_ROLLUPS) throw new HttpError(409, `Au plus ${MAX_ROLLUPS} cumuls par base`);
      const config = checkRollup(ctx!, props, parseInput(rollupInput, input.config, 'cumul'));
      return propertyById(db, baseId, insertProperty(db, baseId, props, { name: input.name, type: 'rollup', config }));
    }
    if (input.type === 'relation') {
      const cfg = parseInput(relationInput, input.config, 'relation');
      if (props.filter((p) => p.type === 'relation').length >= MAX_RELATIONS) throw new HttpError(409, `Au plus ${MAX_RELATIONS} relations par base`);
      const level = baseLevel(ctx!, cfg.targetId);
      if (level === 'none') throw new HttpError(404, 'Base liée introuvable');
      if (cfg.twoWay && level !== 'write') throw new HttpError(403, 'Une relation double demande de pouvoir modifier la base liée');
      const id = insertProperty(db, baseId, props, { name: input.name, type: 'relation', config: { targetId: cfg.targetId, backPropertyId: null } });
      if (cfg.twoWay) {
        const targetProps = propertiesOf(db, cfg.targetId);
        if (targetProps.length >= MAX_PROPERTIES) throw new HttpError(409, `La base liée a déjà ${MAX_PROPERTIES} colonnes`);
        if (targetProps.filter((p) => p.type === 'relation').length >= MAX_RELATIONS) throw new HttpError(409, `La base liée a déjà ${MAX_RELATIONS} relations`);
        // Nom neutre : le titre de la base d'origine serait montré aux lecteurs de la cible, même s'ils ne peuvent pas la lire.
        const back = insertProperty(db, cfg.targetId, targetProps, { name: freeName(targetProps, 'Relation'), type: 'relation', config: { targetId: baseId, backPropertyId: id } });
        db.prepare('UPDATE base_properties SET config = ? WHERE id = ?').run(JSON.stringify({ targetId: cfg.targetId, backPropertyId: back }), id);
        if (cfg.targetId !== baseId) ctx!.touched?.add(cfg.targetId);
      }
      return propertyById(db, baseId, id);
    }
    return propertyById(db, baseId, insertProperty(db, baseId, props, { name: input.name, type: input.type, options, formula }));
  })();
}

const defaultStatus = (): z.input<typeof optionSchema>[] => [
  { name: 'À faire', color: 'gray' }, { name: 'En cours', color: 'blue' }, { name: 'Terminé', color: 'green' },
];

/** Renomme une colonne ou change ses options. Une option retirée disparaît des cellules qui la portaient. Seul un cumul change de configuration. */
export function updateProperty(db: DB, baseId: string, id: string, input: { name?: string; options?: z.input<typeof optionSchema>[]; formula?: string; config?: unknown }, ctx?: Ctx): Property {
  return db.transaction(() => {
    const prop = propertyById(db, baseId, id);
    const props = propertiesOf(db, baseId);
    if (input.formula !== undefined && prop.type !== 'formula') throw new HttpError(400, 'Seule une colonne calculée a une formule');
    if (input.config !== undefined && prop.type === 'relation') throw new HttpError(400, 'La base liée d’une relation ne change pas');
    if (input.config !== undefined && prop.type !== 'rollup') throw new HttpError(400, 'Ce type de colonne n’a pas de configuration');
    if (input.config !== undefined && !ctx) throw new HttpError(400, 'Cumul impossible ici');
    if (input.name !== undefined && input.name !== prop.name) assertFreeName(props, input.name, id);
    const formula = input.formula === undefined ? prop.formula : checkFormula(props, input.formula, id);
    const config = input.config === undefined ? prop.config : checkRollup(ctx!, props, parseInput(rollupInput, input.config, 'cumul'));
    // Renommer une colonne lue par une formule la casserait en silence : on refuse, la formule se corrige d'abord.
    if (input.name !== undefined && input.name !== prop.name) {
      const user = formulaUsing(props, prop.name, id);
      if (user) throw new HttpError(409, `La colonne « ${prop.name} » est lue par la formule de « ${user} » : modifiez d'abord cette formule`);
    }
    const options = input.options === undefined ? prop.options : normalizeOptions(prop.type, input.options, prop.options);
    db.prepare('UPDATE base_properties SET name = ?, options = ?, formula = ?, config = ? WHERE id = ?').run(input.name ?? prop.name, JSON.stringify(options), formula, JSON.stringify(config), id);
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

const sameName = (a: string, b: string) => a.normalize('NFC').toLocaleLowerCase('fr') === b.normalize('NFC').toLocaleLowerCase('fr');
/** Deux colonnes ne portent pas le même nom (casse et accents composés ignorés) : une formule lit une colonne par son nom, sans ambiguïté possible. */
function assertFreeName(props: Property[], name: string, exceptId?: string) {
  if (props.some((p) => p.id !== exceptId && sameName(p.name, name))) throw new HttpError(409, `Une colonne s'appelle déjà « ${name} »`);
}

/** Nom de la première colonne calculée qui lit la colonne `name` (hors `exceptId`), sinon null. */
function formulaUsing(props: Property[], name: string, exceptId: string): string | null {
  for (const p of props) {
    if (p.type !== 'formula' || p.id === exceptId || !p.formula) continue;
    try { if (referencedProperties(parseFormula(p.formula)).includes(name)) return p.name; } catch { /* formule déjà invalide : elle ne lit rien */ }
  }
  return null;
}

/**
 * Colonne miroir d'une relation double, si le couple est intact (chacune désigne l'autre). Une colonne miroir supprimée, ou dont
 * la base a disparu, laisse une relation simple.
 */
export function pairOf(db: DB, baseId: string, prop: Property): Property | null {
  if (prop.type !== 'relation') return null;
  const cfg = relationOf(prop);
  if (!cfg.backPropertyId) return null;
  const r = db.prepare("SELECT * FROM base_properties WHERE id = ? AND base_id = ? AND type = 'relation'").get(cfg.backPropertyId, cfg.targetId) as PropertyRow | undefined;
  if (!r) return null;
  const back = toProperty(r);
  const bc = relationOf(back);
  return bc.targetId === baseId && bc.backPropertyId === prop.id ? back : null;
}

/** Supprime une colonne. Une relation double laisse sa colonne miroir en relation simple ; la base de celle-ci est ajoutée à `touched`. */
export function removeProperty(db: DB, baseId: string, id: string, touched?: Set<string>): void {
  db.transaction(() => {
    const removed = propertyById(db, baseId, id);
    const props = propertiesOf(db, baseId);
    const user = formulaUsing(props, removed.name, id);
    if (user) throw new HttpError(409, `La colonne « ${removed.name} » est lue par la formule de « ${user} » : modifiez d'abord cette formule`);
    const rollup = props.find((p) => p.type === 'rollup' && rollupOf(p).relationId === id);
    if (rollup) throw new HttpError(409, `La relation « ${removed.name} » est lue par le cumul « ${rollup.name} » : supprimez d'abord ce cumul`);
    if (props.length <= 1) throw new HttpError(409, 'Une base garde au moins une colonne');
    // Relation double : la colonne miroir reste, avec ses valeurs, et devient une relation simple.
    const back = pairOf(db, baseId, removed);
    if (back) {
      db.prepare('UPDATE base_properties SET config = ? WHERE id = ?').run(JSON.stringify({ targetId: relationOf(back).targetId, backPropertyId: null }), back.id);
      const target = relationOf(removed).targetId;
      if (target !== baseId) touched?.add(target);
    }
    db.prepare('DELETE FROM base_properties WHERE id = ?').run(id);
    rewriteRows(db, baseId, (vals) => vals.delete(id));
    // Les vues ne gardent aucune référence à une colonne qui n'existe plus.
    for (const v of viewsOf(db, baseId)) {
      const c = v.config;
      const next = remapView(c, (pid) => (pid === id ? undefined : pid));
      if (JSON.stringify(next) !== JSON.stringify(c)) db.prepare('UPDATE base_views SET config = ? WHERE id = ?').run(JSON.stringify(next), v.id);
    }
  })();
}

/**
 * Réécrit les colonnes citées par une vue (`map` rend le nouvel identifiant, ou undefined si la colonne disparaît). Un Kanban qui perd
 * sa colonne de rangement redevient un tableau. Clés dans l'ordre du schéma : une vue inchangée se compare à l'identique.
 */
function remapView(c: ViewConfig, map: (id: string) => string | undefined): ViewConfig {
  const groupBy = c.groupBy === undefined ? undefined : map(c.groupBy);
  const colorBy = c.colorBy === undefined ? undefined : map(c.colorBy);
  const type = c.type === 'kanban' && !groupBy ? 'table' : c.type;
  const ids = (list: string[]) => list.map(map).filter((x): x is string => x !== undefined);
  return {
    type,
    ...(groupBy ? { groupBy } : {}),
    ...(type === 'timeline' && c.scale ? { scale: c.scale } : {}),
    ...(type === 'timeline' && colorBy ? { colorBy } : {}),
    sort: c.sort.flatMap((s) => { const p = map(s.propertyId); return p ? [{ ...s, propertyId: p }] : []; }),
    filters: c.filters.flatMap((f) => { const p = map(f.propertyId); return p ? [{ ...f, propertyId: p }] : []; }),
    hidden: ids(c.hidden),
  };
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
  /** Espaces que l'appelant peut voir (liens vers des pages, bases liées). */
  spaces: Set<string>;
  baseId: string;
  /** Autres bases modifiées par l'écriture en cours (colonnes et cellules miroirs, liens nettoyés) : la route les signale. */
  touched?: Set<string>;
}

export type Level = 'none' | 'read' | 'write';
/**
 * Droit de l'appelant sur une autre base (cible d'une relation) : mêmes règles que l'ouverture d'une base par les routes
 * (compte connecté, espace lisible, page non supprimée, permissions de page, portée du jeton).
 */
export function baseLevel(ctx: Pick<Ctx, 'db' | 'auth' | 'spaces'>, baseId: string): Level {
  if (!ctx.auth || !can(ctx.auth, 'read')) return 'none';
  const row = ctx.db.prepare('SELECT space_id, kind, deleted_at FROM pages WHERE id = ?').get(baseId) as { space_id: string; kind: string; deleted_at: number | null } | undefined;
  if (!row || row.deleted_at || row.kind !== 'base' || !ctx.spaces.has(row.space_id)) return 'none';
  const level = pageLevel(ctx.db, ctx.auth, baseId);
  if (level === 'none') return 'none';
  return level === 'write' && can(ctx.auth, 'write') ? 'write' : 'read';
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Nom saisi : sans caractères de contrôle ni de direction du texte (qui déguisent un nom affiché ou exporté), non vide après nettoyage. */
export const cleanName = (max: number) => z.string().transform((v) => v.replace(CONTROL, '').normalize('NFC').trim()).pipe(z.string().min(1).max(max));
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Valide une valeur pour une colonne. `null` efface la cellule. Lève 400 si la valeur ne convient pas. */
export function checkValue(ctx: Ctx, prop: Property, v: unknown): unknown {
  const bad = (m: string): never => { throw new HttpError(400, `Colonne « ${prop.name} » : ${m}`); };
  // Relation : les droits sur la base cible se vérifient aussi pour effacer (une relation double modifie la cible).
  if (prop.type === 'relation') return checkRelation(ctx, prop, v, bad);
  if (v === null) return null;
  switch (prop.type) {
    case 'formula':
    case 'rollup':
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
  return bad('type inconnu');
}

/**
 * Cellule relation : une liste d'identifiants de lignes de la base cible. Il faut pouvoir lire la cible (404 sinon, comme une base
 * inexistante) et, pour une relation double, pouvoir l'écrire (403). Les lignes doivent exister dans la cible.
 */
function checkRelation(ctx: Ctx, prop: Property, v: unknown, bad: (m: string) => never): string[] | null {
  const cfg = relationOf(prop);
  const level = baseLevel(ctx, cfg.targetId);
  if (level === 'none') throw new HttpError(404, 'Base liée introuvable');
  if (level !== 'write' && pairOf(ctx.db, ctx.baseId, prop)) throw new HttpError(403, 'Relation double : il faut pouvoir modifier la base liée');
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_LINKS) return bad(`liste d’au plus ${MAX_LINKS} lignes attendue`);
  if (!v.every((x) => typeof x === 'string' && ROW_ID.test(x))) return bad('identifiant de ligne attendu');
  const ids = [...new Set(v as string[])];
  if (!ids.length) return null;
  const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))').get(cfg.targetId, JSON.stringify(ids)) as { n: number }).n;
  if (n !== ids.length) return bad('ligne liée introuvable');
  return ids;
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

/**
 * Relations doubles : après l'écriture d'une ligne (`before` → `after`), chaque ligne cible ajoutée ou retirée reçoit (ou perd)
 * l'identifiant de la ligne dans sa colonne miroir. Le droit d'écriture sur la cible a été vérifié par checkRelation. Une cellule
 * miroir pleine (MAX_LINKS) refuse tout (409), la transaction de l'appelant n'écrit alors rien. `after` peut être modifié (relation
 * d'une base vers elle-même, ligne liée à elle-même).
 */
function syncMirrors(ctx: Ctx, props: Property[], rowId: string, before: Record<string, unknown>, after: Record<string, unknown>, userId: string | null) {
  const { db, baseId } = ctx;
  const list = (v: unknown) => (Array.isArray(v) ? v as string[] : []);
  for (const p of props) {
    const back = pairOf(db, baseId, p);
    if (!back) continue;
    const targetId = relationOf(p).targetId;
    const old = new Set(list(before[p.id]));
    const now = new Set(list(after[p.id]));
    const changes = [...[...now].filter((x) => !old.has(x)).map((t) => [t, true] as const), ...[...old].filter((x) => !now.has(x)).map((t) => [t, false] as const)];
    for (const [t, add] of changes) {
      const edit = (cell: string[]): string[] | null => {
        const next = add ? (cell.includes(rowId) ? cell : [...cell, rowId]) : cell.filter((x) => x !== rowId);
        if (next.length > MAX_LINKS) throw new HttpError(409, `Une ligne liée a déjà ${MAX_LINKS} liens dans « ${back.name} »`);
        return next.length ? next : null;
      };
      if (targetId === baseId && t === rowId) {
        const next = edit(list(after[back.id]));
        if (next) after[back.id] = next; else delete after[back.id];
        continue;
      }
      const row = db.prepare('SELECT id, vals FROM base_rows WHERE id = ? AND base_id = ?').get(t, targetId) as { id: string; vals: string } | undefined;
      if (!row) continue;
      const vals = new Map(Object.entries(JSON.parse(row.vals) as Record<string, unknown>));
      const next = edit(list(vals.get(back.id)));
      if (next) vals.set(back.id, next); else vals.delete(back.id);
      const json = JSON.stringify(Object.fromEntries(vals));
      if (json.length > MAX_ROW_CHARS) throw new HttpError(409, 'Une ligne liée est trop volumineuse');
      assertRoom(db, targetId, Math.max(0, json.length - row.vals.length));
      db.prepare('UPDATE base_rows SET vals = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(json, userId, Date.now(), t);
      if (targetId !== baseId) ctx.touched?.add(targetId);
    }
  }
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
    const props = propertiesOf(db, baseId);
    const vals = applyPatch(ctx, props, {}, values);
    const id = newId();
    syncMirrors(ctx, props, id, {}, vals, userId);
    assertRoom(db, baseId, JSON.stringify(vals).length);
    const last = db.prepare('SELECT MAX(position) AS m FROM base_rows WHERE base_id = ?').get(baseId) as { m: number | null };
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
    const props = propertiesOf(db, baseId);
    const before = JSON.parse(row.vals) as Record<string, unknown>;
    const vals = applyPatch(ctx, props, before, patch);
    syncMirrors(ctx, props, rowId, before, vals, userId);
    if (JSON.stringify(vals).length > MAX_ROW_CHARS) throw new HttpError(400, 'Ligne trop volumineuse');
    assertRoom(db, baseId, Math.max(0, JSON.stringify(vals).length - row.vals.length));
    db.prepare('UPDATE base_rows SET vals = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vals), userId, Date.now(), rowId);
    return db.prepare('SELECT * FROM base_rows WHERE id = ?').get(rowId) as RowRow;
  })();
}

/** Lignes demandées et tous leurs sous-éléments (de la même base). */
export function withDescendants(db: DB, baseId: string, ids: string[]): string[] {
  return (db.prepare(`WITH RECURSIVE t(id) AS (
      SELECT id FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))
      UNION SELECT r.id FROM base_rows r JOIN t ON r.parent_id = t.id)
    SELECT id FROM t`).all(baseId, JSON.stringify(ids)) as { id: string }[]).map((r) => r.id);
}

/**
 * Supprime des lignes et leurs sous-éléments (au plus MAX_DELETE en tout, sinon 409 et rien n'est supprimé), puis retire leurs
 * identifiants des cellules relation qui les citaient, dans toutes les bases (y compris celle-ci). Rend le nombre de lignes
 * supprimées ; les autres bases nettoyées sont ajoutées à `touched`.
 */
export function removeRows(db: DB, baseId: string, ids: string[], touched?: Set<string>): number {
  return db.transaction(() => {
    const all = withDescendants(db, baseId, ids);
    if (all.length > MAX_DELETE) throw new HttpError(409, `Au plus ${MAX_DELETE} lignes supprimées à la fois (sous-éléments compris)`);
    if (!all.length) return 0;
    // Les sous-éléments partent aussi par ON DELETE CASCADE : `changes` ne les compterait pas, d'où le compte de la liste.
    db.prepare('DELETE FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))').run(baseId, JSON.stringify(all));
    for (const b of unlinkRows(db, baseId, new Set(all))) if (b !== baseId) touched?.add(b);
    return all.length;
  })();
}

/**
 * Retire des identifiants de lignes (supprimées) de la base `baseId` des cellules relation qui pointent vers elle. Seules les lignes
 * qui citent un de ces identifiants sont lues et réécrites (filtre SQL). Rend les bases modifiées.
 */
function unlinkRows(db: DB, baseId: string, gone: Set<string>): string[] {
  const refs = db.prepare("SELECT id, base_id FROM base_properties WHERE type = 'relation' AND json_extract(config, '$.targetId') = ?").all(baseId) as { id: string; base_id: string }[];
  const byBase = new Map<string, string[]>();
  for (const r of refs) byBase.set(r.base_id, [...(byBase.get(r.base_id) ?? []), r.id]);
  const citing = db.prepare(`SELECT r.id, r.vals FROM base_rows r WHERE r.base_id = ? AND EXISTS (
      SELECT 1 FROM json_each(r.vals) c, json_each(c.value) l
      WHERE c.type = 'array' AND c.key IN (SELECT value FROM json_each(?)) AND l.value IN (SELECT value FROM json_each(?)))`);
  const upd = db.prepare('UPDATE base_rows SET vals = ? WHERE id = ?');
  const goneJson = JSON.stringify([...gone]);
  const changed: string[] = [];
  for (const [b, propIds] of byBase) {
    const rows = citing.all(b, JSON.stringify(propIds), goneJson) as { id: string; vals: string }[];
    for (const r of rows) {
      const vals = new Map(Object.entries(JSON.parse(r.vals) as Record<string, unknown>));
      for (const pid of propIds) {
        const v = vals.get(pid);
        if (!Array.isArray(v)) continue;
        const kept = v.filter((x) => !gone.has(String(x)));
        if (kept.length) vals.set(pid, kept); else vals.delete(pid);
      }
      upd.run(JSON.stringify(Object.fromEntries(vals)), r.id);
    }
    if (rows.length) changed.push(b);
  }
  return changed;
}

// ---------- Lecture ----------

export interface PresentedRow {
  id: string; position: number; values: Record<string, unknown>; createdAt: number; updatedAt: number;
  /** Ligne parente (sous-élément), de la même base. */
  parentId: string | null;
  /** Lignes de la même base qui bloquent celle-ci. */
  blockedBy: string[];
}

/** Lignes d'une base cible, telles qu'un lecteur qui peut lire cette base les voit : titre (1re colonne texte) et valeurs brutes. */
interface Target { level: Level; title: Property | undefined; props: Map<string, Property>; rows: Map<string, Record<string, unknown>> }

/**
 * Lignes telles que les voit l'appelant. Une cellule « personne » n'est nommée qu'à une personne connectée et seulement si cette
 * personne peut lire la base ; une cellule « page » ne donne le titre que d'une page que l'appelant peut lire ; une cellule « relation »
 * ne montre que des lignes d'une base que l'appelant peut lire, et un cumul ne calcule que sur elles. Sinon la cellule est vide.
 */
export function presentRows(ctx: Ctx, props: Property[], canSeeNames: boolean, only?: string | string[]): PresentedRow[] {
  const { db, baseId } = ctx;
  const rows = (only !== undefined
    ? db.prepare('SELECT * FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY position, created_at').all(baseId, JSON.stringify(Array.isArray(only) ? only : [only]))
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
  const targets = loadTargets(ctx, props, parsed);
  const byId = new Map(props.map((p) => [p.id, p]));
  const kinds = new Map(props.map((p) => [p.id, p.type]));
  // Formules : analysées une fois, évaluées par ligne sur les valeurs telles que CE lecteur les voit (un nom ou un titre qu'il ne peut
  // pas lire est déjà absent à ce stade, donc la formule ne peut pas le révéler).
  const formulas = props.filter((p) => p.type === 'formula' && p.formula).flatMap((p) => {
    try { return [{ id: p.id, ast: parseFormula(p.formula!) }]; } catch { return []; }
  });
  const byName = new Map(props.filter((p) => !COMPUTED.has(p.type) && p.type !== 'relation').map((p) => [p.name, p]));
  const rollups = props.filter((p) => p.type === 'rollup');
  const budget: Budget = { chars: limits.formulaChars };
  const deps = new Map<string, string[]>();
  for (const d of db.prepare('SELECT row_id, blocker_id FROM base_row_deps WHERE base_id = ? ORDER BY blocker_id').all(baseId) as { row_id: string; blocker_id: string }[]) {
    deps.set(d.row_id, [...(deps.get(d.row_id) ?? []), d.blocker_id]);
  }
  return parsed.map(({ r, vals }) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) {
      const t = kinds.get(k);
      if (!t) continue;
      if (t === 'person') { const n = typeof v === 'string' ? names.get(v) : undefined; if (n !== undefined) out[k] = { id: v, name: n }; }
      else if (t === 'page_link') { const info = typeof v === 'string' ? pageInfo.get(v) : undefined; if (info) out[k] = info; }
      else if (t === 'relation') { const links = presentLinks(targets.get(k), v); if (links.length) out[k] = links; }
      else if (t === 'rollup') continue;
      else out[k] = v;
    }
    for (const f of formulas) {
      const result = evaluate(f.ast, (name) => { const p = byName.get(name); return p ? readCell(p, out[p.id]) : null; }, budget);
      if (result !== null) out[f.id] = result;
    }
    for (const ru of rollups) {
      const cfg = rollupOf(ru);
      const rel = byId.get(cfg.relationId);
      const result = rel ? computeRollup(cfg, targets.get(rel.id), vals[rel.id], budget) : null;
      if (result !== null) out[ru.id] = result;
    }
    return { id: r.id, position: r.position, values: out, createdAt: r.created_at, updatedAt: r.updated_at, parentId: r.parent_id ?? null, blockedBy: deps.get(r.id) ?? [] };
  });
}

/**
 * Pour chaque colonne relation : droit du lecteur sur la cible et lignes citées (seulement si la cible est lisible). Une requête par
 * base cible (plusieurs relations vers la même base la partagent) ; la base elle-même réutilise les lignes déjà lues. Le volume lu
 * dans d'autres bases est borné par limits.linkedChars : au-delà, les lignes non lues manquent (cellule ou cumul incomplets).
 */
function loadTargets(ctx: Ctx, props: Property[], parsed: { r: RowRow; vals: Record<string, unknown> }[]): Map<string, Target> {
  const out = new Map<string, Target>();
  const relations = props.filter((p) => p.type === 'relation');
  if (!relations.length) return out;
  const own = new Map(parsed.map((x) => [x.r.id, x.vals]));
  // Par base cible : droit, colonnes, identifiants cités.
  const byTarget = new Map<string, { level: Level; wanted: Set<string> }>();
  for (const p of relations) {
    const targetId = relationOf(p).targetId;
    let t = byTarget.get(targetId);
    if (!t) { t = { level: baseLevel(ctx, targetId), wanted: new Set() }; byTarget.set(targetId, t); }
    if (t.level === 'none') continue;
    for (const { vals } of parsed) { const v = vals[p.id]; if (Array.isArray(v)) for (const x of v) if (!own.has(String(x)) || targetId !== ctx.baseId) t.wanted.add(String(x)); }
  }
  let budget = limits.linkedChars;
  const loaded = new Map<string, { title: Property | undefined; props: Map<string, Property>; rows: Map<string, Record<string, unknown>> }>();
  for (const [targetId, t] of byTarget) {
    if (t.level === 'none') continue;
    const tprops = propertiesOf(ctx.db, targetId);
    const rows = new Map<string, Record<string, unknown>>(targetId === ctx.baseId ? own : []);
    if (t.wanted.size) {
      const stmt = ctx.db.prepare('SELECT id, vals FROM base_rows WHERE base_id = ? AND id IN (SELECT value FROM json_each(?))');
      for (const r of stmt.iterate(targetId, JSON.stringify([...t.wanted])) as Iterable<{ id: string; vals: string }>) {
        if ((budget -= r.vals.length) < 0) break;
        rows.set(r.id, JSON.parse(r.vals) as Record<string, unknown>);
      }
    }
    loaded.set(targetId, { title: tprops.find((x) => x.type === 'text'), props: new Map(tprops.map((x) => [x.id, x])), rows });
  }
  for (const p of relations) {
    const targetId = relationOf(p).targetId;
    const l = loaded.get(targetId);
    out.set(p.id, l ? { level: byTarget.get(targetId)!.level, ...l } : { level: 'none', title: undefined, props: new Map(), rows: new Map() });
  }
  return out;
}

/** Cellule relation présentée : lignes existantes de la cible, avec leur titre ; vide si la cible est illisible. */
function presentLinks(t: Target | undefined, v: unknown): { id: string; title: string }[] {
  if (!t || t.level === 'none' || !Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const vals = t.rows.get(String(x));
    if (!vals) return [];
    const title = t.title ? vals[t.title.id] : undefined;
    return [{ id: String(x), title: typeof title === 'string' ? title : '' }];
  });
}

/** Cumul d'une ligne, sur les lignes liées lisibles. Le nombre de valeurs lues est décompté du budget des formules de la lecture. */
function computeRollup(cfg: RollupConfig, t: Target | undefined, v: unknown, budget: Budget): number | null {
  if (!t || t.level === 'none') return null;
  const linked = (Array.isArray(v) ? v : []).map((x) => t.rows.get(String(x))).filter((x): x is Record<string, unknown> => x !== undefined);
  if ((budget.chars -= linked.length + 1) < 0) return null;
  if (cfg.fn === 'count') return linked.length;
  const target = cfg.targetPropertyId ? t.props.get(cfg.targetPropertyId) : undefined;
  if (!target) return null;
  if (cfg.fn === 'percent_checked') {
    if (target.type !== 'checkbox' || !linked.length) return null;
    return Math.round((linked.filter((vals) => vals[target.id] === true).length / linked.length) * 10000) / 100;
  }
  if (target.type !== 'number') return null;
  const nums = linked.map((vals) => vals[target.id]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (cfg.fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (!nums.length) return null;
  if (cfg.fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  return cfg.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
}

/** Colonnes telles que les voit l'appelant : la configuration d'une relation ne nomme la base cible que pour qui peut la lire. */
export function presentProperties(ctx: Ctx, props: Property[]) {
  const levels = new Map<string, Level>();
  const readableTarget = (targetId: string) => {
    if (!levels.has(targetId)) levels.set(targetId, baseLevel(ctx, targetId));
    return levels.get(targetId) !== 'none';
  };
  const byId = new Map(props.map((p) => [p.id, p]));
  return props.map((p) => {
    if (p.type === 'rollup') {
      // Colonne lue dans la cible : seulement pour qui peut lire cette cible.
      const cfg = rollupOf(p);
      const rel = byId.get(cfg.relationId);
      const ok = !!rel && rel.type === 'relation' && readableTarget(relationOf(rel).targetId);
      return ok ? p : { ...p, config: { ...cfg, targetPropertyId: null } };
    }
    if (p.type !== 'relation') return p;
    const cfg = relationOf(p);
    const readable = readableTarget(cfg.targetId);
    const title = readable ? (ctx.db.prepare('SELECT title FROM pages WHERE id = ?').get(cfg.targetId) as { title: string } | undefined)?.title ?? null : null;
    return { ...p, config: { targetId: cfg.targetId, targetTitle: title, backPropertyId: readable ? cfg.backPropertyId : null } };
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

// Une case décochée n'est pas stockée : pour une formule elle vaut faux (et non « vide »).
const readCell = (p: Property, v: unknown): Value => (p.type === 'checkbox' ? v === true : primitive(p, v));

// ---------- Vues ----------

interface ViewRow { id: string; base_id: string; name: string; config: string; position: number }
export const viewsOf = (db: DB, baseId: string) =>
  (db.prepare('SELECT * FROM base_views WHERE base_id = ? ORDER BY position, created_at').all(baseId) as ViewRow[])
    .map((v) => ({ id: v.id, name: v.name, config: viewConfigSchema.parse(JSON.parse(v.config)), position: v.position }));

/** Une vue ne cite que des colonnes de la base. */
export function checkViewConfig(db: DB, baseId: string, config: ViewConfig): ViewConfig {
  const props = propertiesOf(db, baseId);
  const ids = new Set(props.map((p) => p.id));
  const all = [...config.sort.map((s) => s.propertyId), ...config.filters.map((f) => f.propertyId), ...config.hidden, ...(config.groupBy ? [config.groupBy] : []), ...(config.colorBy ? [config.colorBy] : [])];
  if (all.some((id) => !ids.has(id))) throw new HttpError(400, 'La vue cite une colonne inconnue');
  const choice = (id: string | undefined) => { const p = props.find((x) => x.id === id); return !!p && (p.type === 'select' || p.type === 'status'); };
  if (config.type === 'kanban') {
    if (!choice(config.groupBy)) throw new HttpError(400, 'Un Kanban se range selon une colonne Sélection ou Statut');
  } else if (config.type === 'timeline') {
    if (config.groupBy !== undefined && !choice(config.groupBy)) throw new HttpError(400, 'Une chronologie se regroupe selon une colonne Sélection ou Statut');
    if (config.colorBy !== undefined && !choice(config.colorBy)) throw new HttpError(400, 'Une chronologie se colore selon une colonne Sélection ou Statut');
  } else if (config.groupBy !== undefined) throw new HttpError(400, 'Seules les vues Kanban et chronologie se rangent par colonne');
  if (config.type !== 'timeline' && (config.scale !== undefined || config.colorBy !== undefined)) throw new HttpError(400, 'Échelle et couleur ne concernent que la chronologie');
  // Chronologie : échelle par défaut à la semaine (clés dans l'ordre du schéma).
  if (config.type === 'timeline' && !config.scale) {
    return { type: config.type, ...(config.groupBy ? { groupBy: config.groupBy } : {}), scale: 'week', ...(config.colorBy ? { colorBy: config.colorBy } : {}), sort: config.sort, filters: config.filters, hidden: config.hidden };
  }
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

/**
 * Copie colonnes, lignes, vues, sous-éléments, dépendances et réglages d'une base vers une autre (vide). Les cellules « personne »
 * et « page » gardent leur identifiant. Une relation vers une AUTRE base n'est pas copiée (ni ses cumuls) : la copie ne reste
 * jamais reliée à une base sans que quelqu'un l'ait décidé avec les droits voulus. Une relation de la base vers elle-même est
 * reportée sur la copie (lignes et colonne miroir comprises).
 */
export function copyBaseData(db: DB, srcId: string, dstId: string, userId: string | null): void {
  db.transaction(() => {
    db.prepare('DELETE FROM base_properties WHERE base_id = ?').run(dstId);
    db.prepare('DELETE FROM base_views WHERE base_id = ?').run(dstId);
    const src = db.prepare('SELECT * FROM base_properties WHERE base_id = ? ORDER BY position, created_at').all(srcId) as PropertyRow[];
    const kept = src.filter((p) => p.type !== 'relation' || (parseConfig('relation', p.config) as RelationConfig).targetId === srcId);
    const relIds = new Set(kept.filter((p) => p.type === 'relation').map((p) => p.id));
    const props = kept.filter((p) => p.type !== 'rollup' || relIds.has((parseConfig('rollup', p.config) as RollupConfig).relationId));
    const map = new Map<string, string>(props.map((p) => [p.id, newId()]));
    const insProp = db.prepare('INSERT INTO base_properties (id, base_id, name, type, options, position, created_at, formula, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of props) {
      let config: PropertyConfig = {};
      if (p.type === 'relation') {
        const c = parseConfig('relation', p.config) as RelationConfig;
        config = { targetId: dstId, backPropertyId: c.backPropertyId ? map.get(c.backPropertyId) ?? null : null };
      } else if (p.type === 'rollup') {
        const c = parseConfig('rollup', p.config) as RollupConfig;
        config = { relationId: map.get(c.relationId)!, targetPropertyId: c.targetPropertyId ? map.get(c.targetPropertyId) ?? null : null, fn: c.fn };
      }
      insProp.run(map.get(p.id), dstId, p.name, p.type, p.options, p.position, Date.now(), p.formula, JSON.stringify(config));
    }
    const now = Date.now();
    const srcRows = db.prepare('SELECT * FROM base_rows WHERE base_id = ? ORDER BY position, created_at').all(srcId) as RowRow[];
    const rowMap = new Map<string, string>(srcRows.map((r) => [r.id, newId()]));
    const relations = new Set(props.filter((p) => p.type === 'relation').map((p) => map.get(p.id)!));
    const insRow = db.prepare('INSERT INTO base_rows (id, base_id, position, vals, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of srcRows) {
      const vals: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(JSON.parse(r.vals) as Record<string, unknown>)) {
        const nk = map.get(k);
        if (!nk) continue;
        if (relations.has(nk)) {
          const ids = (Array.isArray(v) ? v : []).map((x) => rowMap.get(String(x))).filter((x): x is string => x !== undefined);
          if (ids.length) vals[nk] = ids;
        } else vals[nk] = v;
      }
      insRow.run(rowMap.get(r.id), dstId, r.position, JSON.stringify(vals), userId, now, userId, now);
    }
    const setParent = db.prepare('UPDATE base_rows SET parent_id = ? WHERE id = ?');
    for (const r of srcRows) if (r.parent_id && rowMap.has(r.parent_id)) setParent.run(rowMap.get(r.parent_id), rowMap.get(r.id));
    const insDep = db.prepare('INSERT OR IGNORE INTO base_row_deps (base_id, row_id, blocker_id) VALUES (?, ?, ?)');
    for (const d of db.prepare('SELECT row_id, blocker_id FROM base_row_deps WHERE base_id = ?').all(srcId) as { row_id: string; blocker_id: string }[]) {
      if (rowMap.has(d.row_id) && rowMap.has(d.blocker_id)) insDep.run(dstId, rowMap.get(d.row_id), rowMap.get(d.blocker_id));
    }
    const st = db.prepare('SELECT * FROM base_settings WHERE base_id = ?').get(srcId) as { subitems: number; dependencies: number; start_property_id: string | null; end_property_id: string | null } | undefined;
    if (st) {
      db.prepare('INSERT OR REPLACE INTO base_settings (base_id, subitems, dependencies, start_property_id, end_property_id) VALUES (?, ?, ?, ?, ?)')
        .run(dstId, st.subitems, st.dependencies, st.start_property_id ? map.get(st.start_property_id) ?? null : null, st.end_property_id ? map.get(st.end_property_id) ?? null : null);
    }
    const insView = db.prepare('INSERT INTO base_views (id, base_id, name, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const v of viewsOf(db, srcId)) insView.run(newId(), dstId, v.name, JSON.stringify(remapView(v.config, (id) => map.get(id))), v.position, now);
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
      if (p.type === 'relation' || COMPUTED.has(p.type)) continue;
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
      case 'rollup': return String(v);
      // Lignes liées déjà filtrées par presentRows (seulement celles que le lecteur peut lire).
      case 'relation': return (v as { title: string }[]).map((l) => l.title || 'Sans titre').join(', ');
      case 'select': case 'status': return p.options.find((o) => o.id === v)?.name ?? '';
      case 'multi_select': return (v as string[]).map((x) => p.options.find((o) => o.id === x)?.name).filter(Boolean).join(', ');
      case 'person': return (v as { name: string }).name;
      case 'page_link': return (v as { title: string }).title || 'Sans titre';
      default: return String(v);
    }
  };
  // Nombres et dates sont validés : ils ne peuvent pas être une formule, et « -5 » doit rester un nombre pour le tableur.
  const cell = (p: Property, v: unknown) => (p.type === 'number' || p.type === 'date' || p.type === 'rollup' || (p.type === 'formula' && typeof v === 'number') ? text(p, v) : csvCell(text(p, v)));
  const lines = [props.map((p) => csvCell(p.name)).join(',')];
  for (const r of rows) lines.push(props.map((p) => cell(p, r.values[p.id])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
