// Modèle du graphe (contrat commun avec le serveur : server/src/lib/workflow.ts). Fonctions pures : chaque modification
// renvoie un nouveau graphe. Lecture défensive : un contenu illisible ou hostile donne un graphe vide, jamais une erreur.
import { KINDS, COLORS, LIMITS, PORT_LABELS } from './kinds.js';

const ID = /^[a-z0-9]{1,12}$/;
// eslint-disable-next-line no-control-regex -- on retire justement les caractères de contrôle
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const emptyGraph = () => ({ v: 1, nodes: [], edges: [] });

/** Texte brut : contrôles retirés (sauf le saut de ligne pour un nœud), 3 lignes et `max` caractères au plus. */
export function cleanLabel(value, max = LIMITS.nodeLabel, multiline = true) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  s = multiline ? s.split('\n').slice(0, LIMITS.nodeLines).join('\n') : s.replace(/\n/g, ' ');
  return s.slice(0, max);
}

const coord = (v) => (Number.isFinite(v) ? clamp(Math.round(v), -LIMITS.coord, LIMITS.coord) : 0);

/** Graphe lu dans une chaîne JSON (ou un objet) : valeurs invalides écartées, plafonds appliqués. Ne lève jamais. */
export function parseGraph(raw, kinds = KINDS) {
  try {
    const data = typeof raw === 'string' ? (raw.length > LIMITS.graphChars ? null : JSON.parse(raw)) : raw;
    if (!data || typeof data !== 'object' || data.v !== 1) return emptyGraph();
    const nodes = [];
    const kindOf = new Map();
    for (const n of Array.isArray(data.nodes) ? data.nodes : []) {
      if (nodes.length >= LIMITS.nodes) break;
      if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !ID.test(n.id) || kindOf.has(n.id)) continue;
      if (typeof n.kind !== 'string' || !has(kinds, n.kind)) continue;
      const color = typeof n.color === 'string' && COLORS.includes(n.color) ? n.color : null;
      nodes.push({ id: n.id, kind: n.kind, label: cleanLabel(n.label), x: coord(n.x), y: coord(n.y), color });
      kindOf.set(n.id, n.kind);
    }
    const edges = [];
    const ids = new Set();
    const links = new Set();
    for (const e of Array.isArray(data.edges) ? data.edges : []) {
      if (edges.length >= LIMITS.edges) break;
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id) || ids.has(e.id)) continue;
      if (typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.port !== 'string' || e.from === e.to) continue;
      if (!kindOf.has(e.from) || !kindOf.has(e.to)) continue;
      if (!kinds[kindOf.get(e.from)].out.includes(e.port) || !kinds[kindOf.get(e.to)].in) continue;
      const key = JSON.stringify([e.from, e.port, e.to]);
      if (links.has(key)) continue;
      const label = cleanLabel(e.label, LIMITS.edgeLabel, false);
      ids.add(e.id);
      links.add(key);
      edges.push({ id: e.id, from: e.from, port: e.port, to: e.to, label: label === '' ? null : label });
    }
    return { v: 1, nodes, edges };
  } catch {
    return emptyGraph();
  }
}

/** JSON du graphe (attribut `graph`), ou null s'il dépasse la taille permise. */
export function serializeGraph(graph) {
  const json = JSON.stringify({
    v: 1,
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, x: n.x, y: n.y, color: n.color ?? null })),
    edges: graph.edges.map((e) => ({ id: e.id, from: e.from, port: e.port, to: e.to, label: e.label ?? null })),
  });
  return json.length <= LIMITS.graphChars ? json : null;
}

export const DEFAULT_GRAPH = JSON.stringify({
  v: 1,
  nodes: [
    { id: 'n1', kind: 'start', label: 'Début', x: 40, y: 120, color: null },
    { id: 'n2', kind: 'step', label: 'Étape', x: 240, y: 120, color: null },
    { id: 'n3', kind: 'end', label: 'Fin', x: 440, y: 120, color: null },
  ],
  edges: [
    { id: 'e1', from: 'n1', port: 'out', to: 'n2', label: null },
    { id: 'e2', from: 'n2', port: 'out', to: 'n3', label: null },
  ],
});

export const defaultGraph = () => parseGraph(DEFAULT_GRAPH);
export const snap = (v) => clamp(Math.round(v / LIMITS.grid) * LIMITS.grid, -LIMITS.coord, LIMITS.coord);
export const nodeById = (graph, id) => graph.nodes.find((n) => n.id === id);

function newId(prefix, used) {
  for (let i = 0; i < 100; i++) {
    const id = prefix + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    if (!used.some((u) => u.id === id)) return id;
  }
  return prefix + Date.now().toString(36).slice(-8);
}

/** Ordre de lecture : de gauche à droite, puis de haut en bas. */
export const readingOrder = (graph) => graph.nodes.map((n, i) => [n, i]).sort(([a, i], [b, j]) => a.x - b.x || a.y - b.y || i - j).map(([n]) => n);

export function addNode(graph, kinds, kind, x, y) {
  if (graph.nodes.length >= LIMITS.nodes) return { error: `Limite de ${LIMITS.nodes} nœuds atteinte.` };
  const def = kinds[kind];
  const node = { id: newId('n', graph.nodes), kind, label: def.defaultLabel || def.label, x: snap(x), y: snap(y), color: null };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

export const moveNode = (graph, id, x, y) => ({ ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, x: coord(x), y: coord(y) } : n)) });
export const setNodeLabel = (graph, id, label) => ({ ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, label: cleanLabel(label) } : n)) });
export const setEdgeLabel = (graph, id, label) => ({ ...graph, edges: graph.edges.map((e) => (e.id === id ? { ...e, label: cleanLabel(label, LIMITS.edgeLabel, false).trim() || null } : e)) });
export const removeEdge = (graph, id) => ({ ...graph, edges: graph.edges.filter((e) => e.id !== id) });
export const removeNode = (graph, id) => ({ ...graph, nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.from !== id && e.to !== id) });

/** Message d'erreur si le lien est impossible, sinon null. */
export function connectError(graph, kinds, from, port, to) {
  const a = nodeById(graph, from);
  const b = nodeById(graph, to);
  if (!a || !b) return 'Nœud introuvable.';
  if (!kinds[a.kind].out.includes(port)) return 'Ce type de nœud n’a pas cette sortie.';
  if (!kinds[b.kind].in) return `Un nœud « ${kinds[b.kind].label} » n’a pas d’entrée.`;
  if (from === to) return 'Un nœud ne peut pas être relié à lui-même.';
  if (graph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return 'Ce lien existe déjà.';
  if (graph.edges.length >= LIMITS.edges) return `Limite de ${LIMITS.edges} liens atteinte.`;
  return null;
}

export function connect(graph, kinds, from, port, to) {
  const error = connectError(graph, kinds, from, port, to);
  if (error) return { error };
  const edge = { id: newId('e', graph.edges), from, port, to, label: null };
  return { graph: { ...graph, edges: [...graph.edges, edge] }, edge };
}

/** Rangement : couches de gauche à droite selon la profondeur (plus long chemin depuis une source) ; notes en rangée dessous. */
export function autoLayout(graph, kinds) {
  const loose = (n) => !kinds[n.kind].in && !kinds[n.kind].out.length;
  const depth = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const e of graph.edges) if (e.to === id) d = Math.max(d, visit(e.from) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const layers = new Map();
  const notes = [];
  for (const n of graph.nodes) {
    if (loose(n)) { notes.push(n); continue; }
    const d = visit(n.id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }
  const pos = new Map();
  let rows = 0;
  for (const [d, list] of layers) {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    list.forEach((n, i) => pos.set(n.id, { x: 40 + d * 240, y: 40 + i * 120 }));
    rows = Math.max(rows, list.length);
  }
  notes.forEach((n, i) => pos.set(n.id, { x: 40 + (i % 6) * 200, y: 40 + rows * 120 + Math.floor(i / 6) * 120 }));
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, ...pos.get(n.id) })) };
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim() || 'sans titre';

/** Plan en texte, un élément par nœud dans l'ordre de lecture (même format que workflowOutline côté serveur). */
/** @param {Record<string, string>} [portLabels] */
export function outline(graph, kinds = KINDS, portLabels = PORT_LABELS) {
  const label = new Map(graph.nodes.map((n) => [n.id, oneLine(n.label)]));
  return readingOrder(graph).map((n) => {
    const nexts = graph.edges.filter((e) => e.from === n.id).map((e) => `${e.label ?? portLabels[e.port] ?? e.port} vers ${label.get(e.to)}`);
    const head = `${kinds[n.kind].label} : ${label.get(n.id)}`;
    if (!nexts.length) return head;
    return n.kind === 'decision' ? `${head} ${nexts.join(', ')}` : `${head}. ${nexts.join(', ')}`;
  });
}
