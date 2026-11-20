// Bloc « workflow » (V1) : graphe de processus dessiné dans une page. Rien ne s'exécute : le graphe n'est que du texte structuré.
// Contrat commun avec le client (client/src/workflow/kinds.js, copie du registre ci-dessous, vérifiée par test/workflow.test.ts).
// Tout est validé par liste blanche et réécrit en JSON canonique : clés inconnues retirées, références vérifiées, plafonds appliqués.
import { COLORS } from './content.js';

export const MAX_WORKFLOW_GRAPH = 100_000;
export const MAX_WORKFLOW_NODES = 100;
export const MAX_WORKFLOW_EDGES = 200;
/** Au plus 20 blocs « workflow » par page (même principe que MAX_BASE_BLOCKS). */
export const MAX_WORKFLOW_BLOCKS = 20;
const MAX_NODE_LABEL = 120;
const MAX_NODE_LINES = 3;
const MAX_EDGE_LABEL = 60;
const COORD = 10_000;
const ID = /^[a-z0-9]{1,12}$/;

export interface WorkflowKind {
  /** Libellé français du type. */
  label: string;
  /** Le type a-t-il une prise d'entrée ? */
  in: boolean;
  /** Noms des prises de sortie. */
  out: readonly string[];
}

/** Registre des types et de leurs prises (référence). Liste fermée. */
export const WORKFLOW_KINDS: Readonly<Record<string, WorkflowKind>> = {
  start: { label: 'Début', in: false, out: ['out'] },
  step: { label: 'Étape', in: true, out: ['out'] },
  decision: { label: 'Décision', in: true, out: ['yes', 'no'] },
  end: { label: 'Fin', in: true, out: [] },
  note: { label: 'Note', in: false, out: [] },
};

/** Libellé par défaut d'un lien selon sa prise (quand le lien n'a pas de libellé propre). */
export const WORKFLOW_PORT_LABELS: Readonly<Record<string, string>> = { out: 'Suite', yes: 'Oui', no: 'Non' };

export interface WorkflowNode { id: string; kind: string; label: string; x: number; y: number; color: string | null }
export interface WorkflowEdge { id: string; from: string; port: string; to: string; label: string | null }
export interface WorkflowGraph { v: 1; nodes: WorkflowNode[]; edges: WorkflowEdge[] }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const coord = (v: unknown): number | undefined => (Number.isInteger(v) && Math.abs(v as number) <= COORD ? ((v as number) === 0 ? 0 : (v as number)) : undefined);

// Texte brut : caractères de contrôle retirés (le saut de ligne est gardé ou non selon `multiline`). Jamais interprété comme HTML ou Markdown.
// eslint-disable-next-line no-control-regex -- on retire justement les caractères de contrôle
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
function cleanText(v: unknown, max: number, multiline: boolean): string | undefined {
  if (typeof v !== 'string' || v.length > max * 2) return undefined;
  let s = v.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (!multiline) s = s.replace(/\n/g, '');
  if (s.length > max) return undefined;
  if (multiline && s.split('\n').length > MAX_NODE_LINES) return undefined;
  return s;
}

/** Valide un graphe (objet déjà décodé) et renvoie sa forme canonique, ou `undefined` s'il est invalide. */
export function parseWorkflowObject(raw: unknown): WorkflowGraph | undefined {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined;
  if (raw.nodes.length > MAX_WORKFLOW_NODES || raw.edges.length > MAX_WORKFLOW_EDGES) return undefined;
  const nodes: WorkflowNode[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const n of raw.nodes) {
    if (!isRecord(n)) return undefined;
    const { id, kind } = n;
    if (typeof id !== 'string' || !ID.test(id) || byId.has(id)) return undefined;
    if (typeof kind !== 'string' || !Object.hasOwn(WORKFLOW_KINDS, kind)) return undefined;
    const label = cleanText(n.label, MAX_NODE_LABEL, true);
    const x = coord(n.x);
    const y = coord(n.y);
    if (label === undefined || x === undefined || y === undefined) return undefined;
    const color = n.color === null || n.color === undefined ? null : typeof n.color === 'string' && (COLORS as readonly string[]).includes(n.color) ? n.color : undefined;
    if (color === undefined) return undefined;
    const node = { id, kind, label, x, y, color };
    nodes.push(node);
    byId.set(id, node);
  }
  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  const links = new Set<string>();
  for (const e of raw.edges) {
    if (!isRecord(e)) return undefined;
    const { id, from, port, to } = e;
    if (typeof id !== 'string' || !ID.test(id) || edgeIds.has(id)) return undefined;
    if (typeof from !== 'string' || typeof port !== 'string' || typeof to !== 'string') return undefined;
    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target || from === to) return undefined;
    if (!WORKFLOW_KINDS[source.kind]!.out.includes(port) || !WORKFLOW_KINDS[target.kind]!.in) return undefined;
    const key = JSON.stringify([from, port, to]);
    if (links.has(key)) return undefined;
    let label: string | null = null;
    if (e.label !== null && e.label !== undefined) {
      const text = cleanText(e.label, MAX_EDGE_LABEL, false);
      if (text === undefined) return undefined;
      label = text === '' ? null : text;
    }
    edgeIds.add(id);
    links.add(key);
    edges.push({ id, from, port, to, label });
  }
  return { v: 1, nodes, edges };
}

/**
 * Règle de l'attribut `graph` : chaîne JSON en entrée, chaîne JSON canonique en sortie. Invalide (JSON mal formé, trop gros,
 * type inconnu, référence orpheline…) : `undefined`, l'attribut est alors retiré. Ne lève jamais.
 */
export function parseWorkflowGraph(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > MAX_WORKFLOW_GRAPH) return undefined;
  let data: unknown;
  try { data = JSON.parse(v); } catch { return undefined; }
  const graph = parseWorkflowObject(data);
  if (!graph) return undefined;
  const out = JSON.stringify(graph);
  return out.length <= MAX_WORKFLOW_GRAPH ? out : undefined;
}

/** Graphe lu dans l'attribut d'un bloc (déjà assaini en principe) : `undefined` si absent ou invalide. */
export const readWorkflowGraph = (v: unknown): WorkflowGraph | undefined => {
  const s = parseWorkflowGraph(v);
  return s === undefined ? undefined : (JSON.parse(s) as WorkflowGraph);
};

/** Graphe par défaut d'un nouveau bloc : Début, Étape et Fin reliés (valeur de EDITOR_NODE_DEFAULTS). */
export const DEFAULT_WORKFLOW_GRAPH = JSON.stringify({
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
} satisfies WorkflowGraph);

/** Libellés (nœuds puis liens) pour la recherche plein texte et l'IA. */
export function workflowText(graph: WorkflowGraph | undefined): string {
  if (!graph) return '';
  const parts = [...graph.nodes.map((n) => n.label), ...graph.edges.map((e) => e.label ?? '')];
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
}

// Entité Mermaid « #N; » pour tout caractère hors liste blanche. Dans un libellé entre guillemets, seuls lettres, chiffres, espace et
// quelques signes inoffensifs restent tels quels : plus de guillemet, crochet, accolade, parenthèse, chevron, barre, %, ;, #, `, \ ni saut de ligne,
// donc aucune directive (%%{init}%%, click, style) ni fermeture de bloc de code ne peut passer.
const MERMAID_SAFE = /^[\p{L}\p{N} .,!?'_+/@:-]$/u;
export function mermaidLabel(text: string): string {
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ')) out += MERMAID_SAFE.test(ch) ? ch : `#${ch.codePointAt(0)};`;
  return out.trim() === '' ? ' ' : out;
}

/** Bloc Mermaid (`flowchart LR`) du graphe, ou `undefined` s'il est vide. Identifiants régénérés (n0, n1…) : jamais ceux du contenu. */
export function workflowToMermaid(graph: WorkflowGraph | undefined): string | undefined {
  if (!graph?.nodes.length) return undefined;
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const shape = (n: WorkflowNode) => {
    const l = `"${mermaidLabel(n.label)}"`;
    switch (n.kind) {
      case 'start': case 'end': return `([${l}])`;
      case 'decision': return `{${l}}`;
      case 'note': return `>${l}]`;
      default: return `[${l}]`;
    }
  };
  const lines = ['flowchart LR', ...graph.nodes.map((n) => `  ${ids.get(n.id)}${shape(n)}`)];
  for (const e of graph.edges) {
    const label = e.label ?? (e.port === 'out' ? null : WORKFLOW_PORT_LABELS[e.port] ?? null);
    lines.push(`  ${ids.get(e.from)} -->${label ? `|"${mermaidLabel(label)}"|` : ''} ${ids.get(e.to)}`);
  }
  return lines.join('\n');
}

/**
 * Plan en texte : une ligne par nœud, dans l'ordre de lecture (de gauche à droite, puis de haut en bas), avec ses suites.
 * Sert à l'export HTML (même texte que la « Vue texte » du client). Texte brut : l'appelant échappe.
 */
export function workflowOutline(graph: WorkflowGraph | undefined): string[] {
  if (!graph) return [];
  const label = new Map(graph.nodes.map((n) => [n.id, n.label.replace(/\s+/g, ' ').trim() || 'sans titre']));
  const ordered = [...graph.nodes].sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1));
  return ordered.map((n) => {
    const nexts = graph.edges.filter((e) => e.from === n.id).map((e) => `${e.label ?? WORKFLOW_PORT_LABELS[e.port] ?? e.port} vers ${label.get(e.to)}`);
    const head = `${WORKFLOW_KINDS[n.kind]!.label} : ${label.get(n.id)}`;
    if (!nexts.length) return head;
    return n.kind === 'decision' ? `${head} ${nexts.join(', ')}` : `${head}. ${nexts.join(', ')}`;
  });
}
