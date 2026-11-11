// Calculs communs à la page d'une base et au bloc intégré dans une page : texte d'une cellule, filtres, tris.
// Aucune dépendance à l'interface : uniquement des fonctions sur les colonnes et les lignes reçues du serveur.
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
export const fmtDate = (s) => { const d = new Date(`${s}T00:00:00`); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('fr-FR'); };

/** Cumul : un nombre calculé par le serveur ; le pourcentage de cases cochées est attendu entre 0 et 100. */
export function fmtRollup(p, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const n = Math.round(v * 100) / 100;
  const text = n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  return p.config?.fn === 'percent_checked' ? `${text} %` : text;
}

// ---- Types de colonne : familles ----
/** Colonnes calculées ou tenues par le serveur : jamais modifiables depuis une cellule. */
export const READ_ONLY_TYPES = new Set(['formula', 'rollup', 'created_time', 'updated_time', 'created_by', 'updated_by', 'unique_id']);
/** Colonnes qui ne vont pas dans un modèle de ligne (calculées, liées ou attribuées par le serveur). */
export const NO_TEMPLATE_TYPES = new Set([...READ_ONLY_TYPES, 'relation']);
/** Colonnes de dates lues par la chronologie et le calendrier (une plage porte à la fois le début et la fin). */
export const isDateCol = (p) => !!p && (p.type === 'date' || p.type === 'date_range');

// ---- Filtres : conditions proposées selon le type de colonne (vues et automatisations) ----
export const OPERATORS = {
  text: [['contains', 'contient'], ['eq', 'est'], ['neq', 'n’est pas'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  date: [['eq', 'le'], ['gt', 'après le'], ['lt', 'avant le'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  option: [['eq', 'est'], ['neq', 'n’est pas'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  multi: [['contains', 'contient'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  checkbox: [['eq', 'est']],
  link: [['contains', 'contient'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  formula: [['contains', 'contient'], ['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
};
export const opKind = (t) => ({
  text: 'text', number: 'number', date: 'date', select: 'option', status: 'option', multi_select: 'multi', checkbox: 'checkbox', person: 'link', page_link: 'link',
  formula: 'formula', relation: 'link', rollup: 'number', url: 'text', email: 'text', phone: 'text', unique_id: 'text', created_by: 'link', updated_by: 'link',
  created_time: 'date', updated_time: 'date', date_range: 'date',
}[t] ?? 'text');
export const DATE_FILTER_TYPES = new Set(['date', 'created_time', 'updated_time', 'date_range']);

/** Plage de dates : { start, end } (fin facultative) ; null si la valeur n'en est pas une. */
export function rangeOf(v) {
  if (!v || typeof v !== 'object' || typeof v.start !== 'string') return null;
  return { start: v.start, end: typeof v.end === 'string' ? v.end : null };
}
/** Identifiant unique : le serveur le présente en texte (« PRJ-12 ») ; un nombre seul reçoit le préfixe de la colonne. */
export function uniqueText(p, v) {
  if (typeof v === 'number') return p.config?.prefix ? `${p.config.prefix}-${v}` : String(v);
  return typeof v === 'string' ? v : '';
}

// ---- Liens tirés des cellules : construits ici, jamais insérés comme HTML ----
const hasControl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };
/** Adresse web sûre (http ou https, sans identifiants), ou null. */
export function safeUrl(v) {
  if (typeof v !== 'string' || v.length > 2000 || hasControl(v)) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  return u;
}
/** Texte montré pour une adresse web : hôte et chemin, tronqués. */
export function urlLabel(v) {
  const u = safeUrl(v);
  if (!u) return String(v ?? '');
  const path = u.pathname === '/' ? '' : u.pathname;
  const text = `${u.host}${path}${u.search}`;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}
/** Courriel : contrôle linéaire (une seule arobase, pas d'espace ni de caractère de contrôle), sans expression régulière. */
export function safeEmail(v) {
  if (typeof v !== 'string' || !v || v.length > 254) return null;
  let at = -1;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 32 || c === 127 || v[i] === '<' || v[i] === '>' || v[i] === '"' || v[i] === '\\') return null;
    if (v[i] === '@') { if (at >= 0) return null; at = i; }
  }
  if (at <= 0 || at === v.length - 1 || !v.slice(at + 1).includes('.')) return null;
  return { local: v.slice(0, at), domain: v.slice(at + 1) };
}
export function mailtoHref(v) {
  const e = safeEmail(v);
  return e ? `mailto:${encodeURIComponent(e.local)}@${encodeURIComponent(e.domain)}` : null;
}
/** Téléphone : chiffres, + ( ) - . et espaces, 5 à 30 caractères ; le lien ne garde que les chiffres et un + initial. */
export function safePhone(v) {
  if (typeof v !== 'string' || v.length < 5 || v.length > 30) return null;
  for (const ch of v) if (!'0123456789+()-. '.includes(ch)) return null;
  const digits = v.replace(/[^0-9]/g, '');
  return digits.length ? `${v.trim().startsWith('+') ? '+' : ''}${digits}` : null;
}
export function telHref(v) {
  const n = safePhone(v);
  return n ? `tel:${n}` : null;
}

// ---- Valeurs : texte affiché, comparaison, filtre (partagés avec le bloc intégré) ----
const optName = (p, oid) => p.options.find((o) => o.id === oid)?.name ?? '';
export function textOf(p, v) {
  if (v === undefined || v === null) return '';
  switch (p.type) {
    case 'checkbox': return v ? 'oui' : 'non';
    case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
    case 'select': case 'status': return optName(p, v);
    case 'multi_select': return v.map((x) => optName(p, x)).join(', ');
    case 'person': case 'created_by': case 'updated_by': return typeof v === 'object' ? v.name ?? '' : '';
    case 'page_link': return v.title || 'Sans titre';
    case 'relation': return Array.isArray(v) ? v.map((x) => x.title || 'Sans titre').join(', ') : '';
    case 'rollup': return fmtRollup(p, v);
    case 'date': case 'created_time': case 'updated_time': return fmtDate(v);
    case 'date_range': { const r = rangeOf(v); return r ? (r.end && r.end !== r.start ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : fmtDate(r.start)) : ''; }
    case 'unique_id': return uniqueText(p, v);
    default: return String(v);
  }
}
/** Valeur comparable d'une date : le jour lui-même, ou le début d'une plage. */
const dateKey = (p, v) => (p.type === 'date_range' ? rangeOf(v)?.start : typeof v === 'string' ? v : undefined);
export const isEmpty = (p, v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (p.type === 'checkbox' && v !== true) || (p.type === 'date_range' && !rangeOf(v));
function matches(props, row, f) {
  const p = props.find((x) => x.id === f.propertyId);
  if (!p) return true;
  const v = row.values[p.id];
  if (f.op === 'empty') return isEmpty(p, v);
  if (f.op === 'notempty') return !isEmpty(p, v);
  const want = f.value;
  switch (p.type) {
    case 'text': case 'person': case 'page_link': case 'relation': case 'url': case 'email': case 'phone':
    case 'created_by': case 'updated_by': case 'unique_id': {
      const t = fold(textOf(p, v));
      const w = fold(want);
      return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : t !== w;
    }
    case 'created_time': case 'updated_time': case 'date_range': {
      const d = dateKey(p, v);
      return d !== undefined && (f.op === 'eq' ? d === want : f.op === 'gt' ? d > want : d < want);
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
    case 'date': return v !== undefined && (f.op === 'eq' ? v === want : f.op === 'gt' ? v > want : v < want);
    case 'checkbox': return (v === true) === (want === true);
    case 'select': case 'status': return f.op === 'eq' ? v === want : v !== want;
    case 'multi_select': return Array.isArray(v) && v.includes(want);
    default: return true;
  }
}
function compare(a, b, p) {
  const va = a.values[p.id];
  const vb = b.values[p.id];
  if (isEmpty(p, va) && isEmpty(p, vb)) return 0;
  if (isEmpty(p, va)) return 1; // les cellules vides vont toujours en dernier
  if (isEmpty(p, vb)) return -1;
  if (p.type === 'number' || p.type === 'rollup' || (p.type === 'formula' && typeof va === 'number' && typeof vb === 'number')) return va - vb;
  if (p.type === 'date' || p.type === 'created_time' || p.type === 'updated_time' || p.type === 'date_range') {
    const da = dateKey(p, va) ?? '';
    const db = dateKey(p, vb) ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  }
  if (p.type === 'unique_id' && typeof va === 'number' && typeof vb === 'number') return va - vb;
  if (p.type === 'checkbox') return Number(va === true) - Number(vb === true);
  if (p.type === 'select' || p.type === 'status') return p.options.findIndex((o) => o.id === va) - p.options.findIndex((o) => o.id === vb);
  return textOf(p, va).localeCompare(textOf(p, vb), 'fr', { numeric: true, sensitivity: 'base' });
}
/** Lignes d'une vue : filtres puis tris (les cellules vides vont toujours en dernier). */
export function applyView(props, allRows, c) {
  let rows = allRows.filter((r) => c.filters.every((f) => matches(props, r, f)));
  for (const s of [...c.sort].reverse()) {
    const p = props.find((x) => x.id === s.propertyId);
    if (!p) continue;
    const dir = s.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const ea = isEmpty(p, a.values[p.id]);
      const eb = isEmpty(p, b.values[p.id]);
      if (ea || eb) return compare(a, b, p); // vides toujours en dernier, quel que soit le sens
      return dir * compare(a, b, p);
    });
  }
  return rows;
}

// ---- Sous-éléments : arborescence affichée ----
function childrenMap(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map();
  const top = [];
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
      if (!kids.has(r.parentId)) kids.set(r.parentId, []);
      kids.get(r.parentId).push(r);
    } else top.push(r);
  }
  // Un cycle (donnée incohérente) ne doit faire disparaître aucune ligne : les lignes inatteignables remontent au premier niveau.
  const reach = new Set();
  const visit = (r) => { if (reach.has(r.id)) return; reach.add(r.id); for (const c of kids.get(r.id) ?? []) visit(c); };
  top.forEach(visit);
  for (const r of rows) if (!reach.has(r.id)) { top.push(r); visit(r); }
  return { kids, top };
}

/**
 * Lignes dans l'ordre d'affichage : une ligne dont le parent est affiché se range sous lui, sinon au premier niveau.
 * Les descendants d'une ligne repliée (`collapsed`) sont omis. Niveau 1 = premier niveau.
 * @returns {{ row: any, level: number, parent: any, childCount: number }[]}
 */
export function flattenTree(rows, collapsed = new Set()) {
  const { kids, top } = childrenMap(rows);
  const out = [];
  const seen = new Set();
  const walk = (r, level, parent) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const children = kids.get(r.id) ?? [];
    out.push({ row: r, level, parent, childCount: children.length });
    if (!collapsed.has(r.id)) for (const c of children) walk(c, level + 1, r);
  };
  for (const r of top) walk(r, 1, null);
  return out;
}

/** Identifiants des descendants d'une ligne (toutes les lignes de la base). */
export function descendantsOf(rows, id) {
  const kids = new Map();
  for (const r of rows) if (r.parentId) { if (!kids.has(r.parentId)) kids.set(r.parentId, []); kids.get(r.parentId).push(r.id); }
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) ?? []) if (c !== id && !out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

// ---- Dates (jours entiers, en UTC : pas de décalage de fuseau) ----
const DAY = 86_400_000;
/** « AAAA-MM-JJ » en numéro de jour, ou null. */
export function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.round(t / DAY);
}
/** Numéro de jour en « AAAA-MM-JJ ». */
export const isoDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const todayNum = () => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
