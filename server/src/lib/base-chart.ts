// Graphiques d'une base (vue `chart`) : regroupement et calcul côté serveur.
// Règles :
//  - le calcul porte sur les lignes TELLES QUE LE LECTEUR LES VOIT (presentRows : personne illisible, page illisible, lignes liées
//    d'une base illisible = cellule vide), après les filtres de la vue, avec la même sémantique que client/src/base-model.js ;
//  - seuls des libellés de groupes sortent (nom d'option, nom de personne visible, date, texte de cellule tronqué), jamais une ligne ;
//  - au plus `limit` groupes (les plus grands), le reste dans « Autres » ; lignes sans valeur dans « Sans valeur ».
// Ce fichier ne contrôle pas l'accès : la route ouvre la base en lecture et fournit les lignes présentées.
import type { PresentedRow, Property, ViewConfig } from './bases.js';

export interface ChartBucket { key: string; label: string; color?: string; value: number | null; count: number }
export interface ChartResult { buckets: ChartBucket[]; total: number | null; truncated: boolean; other?: { value: number | null; count: number } }

type Filter = ViewConfig['filters'][number];
const LABEL_MAX = 100;
const NONE_KEY = '';
const NONE_LABEL = 'Sans valeur';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// ---------- Filtres : portage fidèle de client/src/base-model.js (textOf, isEmpty, matches) ----------
export const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
const optName = (p: Property, oid: unknown) => p.options.find((o) => o.id === oid)?.name ?? '';

/** Texte d'une cellule présentée, comme le client (les dates restent au format AAAA-MM-JJ, inutilisé par les filtres). */
export function textOf(p: Property, v: unknown): string {
  if (v === undefined || v === null) return '';
  switch (p.type) {
    case 'checkbox': return v ? 'oui' : 'non';
    case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
    case 'select': case 'status': return optName(p, v);
    case 'multi_select': return (v as unknown[]).map((x) => optName(p, x)).join(', ');
    case 'person': case 'created_by': case 'updated_by': return (v as { name: string }).name;
    case 'page_link': return (v as { title: string }).title || 'Sans titre';
    case 'relation': return Array.isArray(v) ? v.map((x: { title: string }) => x.title || 'Sans titre').join(', ') : '';
    case 'date_range': { const r = v as { start: string; end: string | null }; return r.end ? `${r.start} / ${r.end}` : r.start; }
    default: return String(v);
  }
}

export const isEmpty = (p: Property, v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (p.type === 'checkbox' && v !== true);

/** Une ligne passe-t-elle un filtre de vue ? Même résultat que la fonction `matches` du client, opérateur par opérateur. */
export function matchesFilter(props: Property[], row: PresentedRow, f: Filter): boolean {
  const p = props.find((x) => x.id === f.propertyId);
  if (!p) return true;
  const v = row.values[p.id];
  if (f.op === 'empty') return isEmpty(p, v);
  if (f.op === 'notempty') return !isEmpty(p, v);
  const want = f.value;
  switch (p.type) {
    case 'text': case 'person': case 'page_link': case 'relation':
    case 'url': case 'email': case 'phone': case 'unique_id': case 'created_by': case 'updated_by': {
      const t = fold(textOf(p, v));
      const w = fold(want);
      return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : t !== w;
    }
    case 'formula': {
      const n = Number(String(want).replace(',', '.'));
      if (typeof v === 'number' && want !== null && want !== '' && Number.isFinite(n)) return f.op === 'eq' ? v === n : f.op === 'neq' ? v !== n : f.op === 'gt' ? v > n : f.op === 'lt' ? v < n : textOf(p, v).includes(String(want));
      const t = fold(textOf(p, v));
      const w = fold(want);
      return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : f.op === 'neq' ? t !== w : f.op === 'gt' ? t > w : t < w;
    }
    case 'number': case 'rollup': {
      if (typeof v !== 'number') return f.op === 'neq';
      const n = Number(want);
      return f.op === 'eq' ? v === n : f.op === 'neq' ? v !== n : f.op === 'gt' ? v > n : v < n;
    }
    // Comparaison de textes AAAA-MM-JJ, comme le client (y compris son repli « < » pour les autres opérateurs).
    case 'date': case 'created_time': case 'updated_time': return dateCmp(v, want, f.op);
    // Plage : filtrée et triée sur son début.
    case 'date_range': return dateCmp(v === undefined || v === null ? undefined : (v as { start: string }).start, want, f.op);
    case 'checkbox': return (v === true) === (want === true);
    case 'select': case 'status': return f.op === 'eq' ? v === want : v !== want;
    case 'multi_select': return Array.isArray(v) && v.includes(want);
    default: return true;
  }
}

function dateCmp(v: unknown, want: unknown, op: Filter['op']): boolean {
  if (v === undefined) return false;
  if (op === 'eq') return v === want;
  // Comparaison de JavaScript entre valeurs quelconques (le client compare de la même manière).
  const a = v as string;
  const b = want as string;
  return op === 'gt' ? a > b : a < b;
}

export const applyFilters = (props: Property[], rows: PresentedRow[], filters: Filter[]) => rows.filter((r) => filters.every((f) => matchesFilter(props, r, f)));

// ---------- Regroupement ----------
interface Acc { count: number; n: number; sum: number; min: number; max: number }
const emptyAcc = (): Acc => ({ count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity });
function feed(acc: Acc, x: number | null) {
  acc.count++;
  if (x === null) return;
  acc.n++;
  acc.sum += x;
  if (x < acc.min) acc.min = x;
  if (x > acc.max) acc.max = x;
}
function merge(into: Acc, a: Acc) {
  into.count += a.count; into.n += a.n; into.sum += a.sum;
  into.min = Math.min(into.min, a.min); into.max = Math.max(into.max, a.max);
}
function valueOf(acc: Acc, metric: ViewConfig['metric']): number | null {
  switch (metric ?? 'count') {
    case 'count': return acc.count;
    case 'sum': return acc.sum;
    case 'avg': return acc.n ? acc.sum / acc.n : null;
    case 'min': return acc.n ? acc.min : null;
    default: return acc.n ? acc.max : null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const frDate = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Clé et libellé d'une date selon l'intervalle (semaine : lundi de la semaine). */
function dateKey(s: string, bucket: NonNullable<ViewConfig['bucket']>): { key: string; label: string } {
  if (bucket === 'year') return { key: s.slice(0, 4), label: s.slice(0, 4) };
  if (bucket === 'month') return { key: s.slice(0, 7), label: `${MONTHS[Number(s.slice(5, 7)) - 1] ?? s.slice(5, 7)} ${s.slice(0, 4)}` };
  if (bucket === 'week') {
    const d = new Date(`${s}T00:00:00Z`);
    const back = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d.getTime() - back * 86_400_000);
    const key = `${String(monday.getUTCFullYear()).padStart(4, '0')}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
    return { key, label: `Semaine du ${frDate(key)}` };
  }
  return { key: s, label: frDate(s) };
}

const cutLabel = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

interface Key { key: string; label: string; color?: string }
/** Groupes d'une ligne (aucun = « Sans valeur » ; une Sélection multiple en donne un par option). */
function keysOf(p: Property, v: unknown, bucket: ViewConfig['bucket']): Key[] {
  switch (p.type) {
    case 'select': case 'status': {
      const o = p.options.find((x) => x.id === v);
      return o ? [{ key: o.id, label: o.name, color: o.color }] : [];
    }
    case 'multi_select': {
      if (!Array.isArray(v)) return [];
      return p.options.filter((o) => v.includes(o.id)).map((o) => ({ key: o.id, label: o.name, color: o.color }));
    }
    case 'checkbox': return v === true ? [{ key: 'true', label: 'Oui' }] : [{ key: 'false', label: 'Non' }];
    case 'date': case 'created_time': case 'date_range': {
      const s = p.type === 'date_range' ? (v && typeof v === 'object' ? (v as { start?: unknown }).start : undefined) : v;
      return typeof s === 'string' && DATE.test(s) ? [dateKey(s, bucket ?? 'month')] : [];
    }
    case 'person': case 'created_by': {
      const u = v as { id?: unknown; name?: unknown } | undefined;
      return u && typeof u.id === 'string' && typeof u.name === 'string' ? [{ key: u.id, label: cutLabel(u.name) }] : [];
    }
    case 'text': {
      if (typeof v !== 'string' || !v.trim()) return [];
      const t = cutLabel(v.trim());
      return [{ key: t, label: t }];
    }
    default: return [];
  }
}

/**
 * Calcule un graphique sur des lignes déjà présentées pour le lecteur. `config` est une vue `chart` validée par checkViewConfig.
 * Les groupes gardés sont les `limit` plus grands (valeur, puis nombre de lignes) ; ils sont rangés dans l'ordre des options
 * (Sélection, Statut), chronologiquement (dates) ou par valeur décroissante (autres). « Sans valeur » vient en dernier.
 */
export function computeChart(props: Property[], allRows: PresentedRow[], config: ViewConfig, maxRows: number): ChartResult {
  const group = props.find((p) => p.id === config.groupBy);
  const metric = config.metric ?? 'count';
  const value = metric === 'count' ? undefined : props.find((p) => p.id === config.valueId);
  const limit = config.limit ?? 20;
  const capped = allRows.length > maxRows;
  const rows = applyFilters(props, capped ? allRows.slice(0, maxRows) : allRows, config.filters);
  const numberOf = (r: PresentedRow): number | null => {
    if (!value) return null;
    const x = r.values[value.id];
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  const totalAcc = emptyAcc();
  const groups = new Map<string, { k: Key; acc: Acc }>();
  const none = emptyAcc();
  for (const r of rows) {
    const x = numberOf(r);
    feed(totalAcc, x);
    const keys = group ? keysOf(group, r.values[group.id], config.bucket) : [];
    if (!keys.length) { feed(none, x); continue; }
    for (const k of keys) {
      let g = groups.get(k.key);
      if (!g) { g = { k, acc: emptyAcc() }; groups.set(k.key, g); }
      feed(g.acc, x);
    }
  }
  const all = [...groups.values()].map((g) => ({ ...g, none: false }));
  if (none.count) all.push({ k: { key: NONE_KEY, label: NONE_LABEL }, acc: none, none: true });
  const bigger = (a: { acc: Acc }, b: { acc: Acc }) => {
    const va = valueOf(a.acc, metric); const vb = valueOf(b.acc, metric);
    if (va !== vb) return va === null ? 1 : vb === null ? -1 : vb - va;
    return b.acc.count - a.acc.count;
  };
  const optionIndex = (key: string) => group?.options.findIndex((o) => o.id === key) ?? -1;
  const natural = (a: { k: Key }, b: { k: Key }) => optionIndex(a.k.key) - optionIndex(b.k.key) || a.k.key.localeCompare(b.k.key);
  const kept = [...all].sort((a, b) => bigger(a, b) || natural(a, b)).slice(0, limit);
  const keptKeys = new Set(kept.map((g) => g.k.key));
  const rest = all.filter((g) => !keptKeys.has(g.k.key));
  const byOptions = group?.type === 'select' || group?.type === 'status';
  const byDate = !!group && (group.type === 'date' || group.type === 'date_range' || group.type === 'created_time');
  kept.sort((a, b) => {
    if (a.none !== b.none) return a.none ? 1 : -1;
    if (byOptions) return optionIndex(a.k.key) - optionIndex(b.k.key);
    if (byDate) return a.k.key < b.k.key ? -1 : a.k.key > b.k.key ? 1 : 0;
    return bigger(a, b) || a.k.label.localeCompare(b.k.label, 'fr');
  });
  const buckets = kept.map((g) => ({ key: g.k.key, label: g.k.label, ...(g.k.color ? { color: g.k.color } : {}), value: valueOf(g.acc, metric), count: g.acc.count }));
  let other: ChartResult['other'];
  if (rest.length) {
    // Une ligne de Sélection multiple compte dans chaque groupe : « Autres » additionne les groupes restants.
    const acc = emptyAcc();
    for (const g of rest) merge(acc, g.acc);
    other = { value: valueOf(acc, metric), count: acc.count };
  }
  return { buckets, total: valueOf(totalAcc, metric), truncated: capped || !!other, ...(other ? { other } : {}) };
}
