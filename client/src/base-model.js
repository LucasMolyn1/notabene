// Calculs communs à la page d'une base et au bloc intégré dans une page : texte d'une cellule, filtres, tris.
// Aucune dépendance à l'interface : uniquement des fonctions sur les colonnes et les lignes reçues du serveur.
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
export const fmtDate = (s) => { const d = new Date(`${s}T00:00:00`); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('fr-FR'); };

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
    case 'text': case 'person': case 'page_link': {
      const t = fold(textOf(p, v));
      const w = fold(want);
      return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : t !== w;
    }
    case 'formula': {
      const n = Number(want);
      if (typeof v === 'number' && want !== null && want !== '' && Number.isFinite(n)) return f.op === 'eq' ? v === n : f.op === 'neq' ? v !== n : f.op === 'gt' ? v > n : f.op === 'lt' ? v < n : textOf(p, v).includes(String(want));
      const t = fold(textOf(p, v));
      const w = fold(want);
      return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : f.op === 'neq' ? t !== w : f.op === 'gt' ? t > w : t < w;
    }
    case 'number': {
      if (v === undefined) return f.op === 'neq';
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
  if (p.type === 'number' || (p.type === 'formula' && typeof va === 'number' && typeof vb === 'number')) return va - vb;
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
