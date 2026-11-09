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

// ---- Valeurs : texte affiché, comparaison, filtre (partagés avec le bloc intégré) ----
const optName = (p, oid) => p.options.find((o) => o.id === oid)?.name ?? '';
export function textOf(p, v) {
  if (v === undefined || v === null) return '';
  switch (p.type) {
    case 'checkbox': return v ? 'oui' : 'non';
    case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
    case 'select': case 'status': return optName(p, v);
    case 'multi_select': return v.map((x) => optName(p, x)).join(', ');
    case 'person': return v.name;
    case 'page_link': return v.title || 'Sans titre';
    case 'relation': return Array.isArray(v) ? v.map((x) => x.title || 'Sans titre').join(', ') : '';
    case 'rollup': return fmtRollup(p, v);
    case 'date': return fmtDate(v);
    default: return String(v);
  }
}
export const isEmpty = (p, v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (p.type === 'checkbox' && v !== true);
function matches(props, row, f) {
  const p = props.find((x) => x.id === f.propertyId);
  if (!p) return true;
  const v = row.values[p.id];
  if (f.op === 'empty') return isEmpty(p, v);
  if (f.op === 'notempty') return !isEmpty(p, v);
  const want = f.value;
  switch (p.type) {
    case 'text': case 'person': case 'page_link': case 'relation': {
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
  if (p.type === 'date') return va < vb ? -1 : va > vb ? 1 : 0;
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
