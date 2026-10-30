// Différences entre deux versions d'une page : comparaison par blocs de texte, puis par mots dans un bloc remplacé.
// Fonctions pures (testées côté serveur) ; l'affichage ne pose que du texte, jamais de HTML.
import { h } from './util.js';

export const MAX_BLOCKS = 1500;
export const MAX_WORDS = 1200;

const textOf = (n) => {
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return ' ';
  if (n.type === 'pageLink') return '[lien vers une page]';
  if (n.type === 'mention') return '@mention';
  return (n.content || []).map(textOf).join('');
};

/** Blocs de texte d'un document, dans l'ordre : { kind: 'h' | 'p' | 'code', text }. */
export function blocksOf(doc) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'detailsSummary') {
      const text = textOf(n);
      if (text.trim()) out.push({ kind: n.type === 'heading' ? 'h' : 'p', text });
      return;
    }
    if (n.type === 'codeBlock') { out.push({ kind: 'code', text: textOf(n) }); return; }
    if (n.type === 'mermaid' || n.type === 'plantuml' || n.type === 'math') { out.push({ kind: 'code', text: `[${n.type}] ${n.attrs?.code ?? ''}` }); return; }
    if (n.type === 'image') { out.push({ kind: 'p', text: '[image]' }); return; }
    if (n.type === 'excalidraw' || n.type === 'drawio') { out.push({ kind: 'p', text: '[dessin]' }); return; }
    for (const c of n.content || []) walk(c);
  };
  walk(doc);
  return out;
}

// Plus longue sous-suite commune ; renvoie la liste d'opérations sur les indices.
function lcsOps(a, b, same) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) { ops.push({ op: 'same', a: i, b: j }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ op: 'del', a: i++ });
    else ops.push({ op: 'add', b: j++ });
  }
  while (i < n) ops.push({ op: 'del', a: i++ });
  while (j < m) ops.push({ op: 'add', b: j++ });
  return ops;
}

/** Différences de mots entre deux textes : [{ op: 'same' | 'del' | 'add', text }]. */
export function diffWords(oldText, newText) {
  const a = oldText.split(/(\s+)/u).filter(Boolean);
  const b = newText.split(/(\s+)/u).filter(Boolean);
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) return [{ op: 'del', text: oldText }, { op: 'add', text: newText }];
  return lcsOps(a, b, (x, y) => x === y).map((o) => (o.op === 'same' ? { op: 'same', text: a[o.a] } : o.op === 'del' ? { op: 'del', text: a[o.a] } : { op: 'add', text: b[o.b] }));
}

/**
 * Différences entre deux listes de blocs. Un bloc supprimé suivi d'un bloc ajouté devient un bloc modifié (`chg`).
 * Renvoie null si les documents sont trop longs pour être comparés.
 */
export function diffBlocks(oldBlocks, newBlocks) {
  if (oldBlocks.length > MAX_BLOCKS || newBlocks.length > MAX_BLOCKS) return null;
  const ops = lcsOps(oldBlocks, newBlocks, (x, y) => x.kind === y.kind && x.text === y.text);
  const out = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === 'same') { out.push({ op: 'same', block: newBlocks[ops[k].b] }); k++; continue; }
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k].op !== 'same') { (ops[k].op === 'del' ? dels : adds).push(ops[k]); k++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) out.push({ op: 'chg', old: oldBlocks[dels[p].a], block: newBlocks[adds[p].b] });
    for (const d of dels.slice(pairs)) out.push({ op: 'del', block: oldBlocks[d.a] });
    for (const a of adds.slice(pairs)) out.push({ op: 'add', block: newBlocks[a.b] });
  }
  return out;
}

/** Affichage : de la version `oldDoc` vers la version `newDoc`. */
export function renderDiff(oldDoc, newDoc) {
  const diff = diffBlocks(blocksOf(oldDoc), blocksOf(newDoc));
  if (!diff) return h('p', { class: 'muted' }, 'Page trop longue pour afficher les différences.');
  const changed = diff.filter((d) => d.op !== 'same');
  const line = (cls, block, ...children) => h('div', { class: `diff-block diff-${cls} diff-k-${block.kind}` }, ...children);
  const rows = diff.map((d) => {
    if (d.op === 'same') return line('same', d.block, d.block.text);
    if (d.op === 'del') return line('del', d.block, d.block.text);
    if (d.op === 'add') return line('add', d.block, d.block.text);
    return line('chg', d.block, ...diffWords(d.old.text, d.block.text).map((w) => (w.op === 'same' ? w.text : h(w.op === 'del' ? 'del' : 'ins', { class: `diff-w-${w.op}` }, w.text))));
  });
  return h('div', { class: 'diff' },
    h('p', { class: 'diff-legend muted' }, changed.length
      ? 'Rouge barré : présent dans cette version, absent de la version actuelle. Vert : ajouté depuis.'
      : 'Aucune différence de texte avec la version actuelle.'),
    ...rows);
}
