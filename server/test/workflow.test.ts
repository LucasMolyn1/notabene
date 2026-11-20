// Bloc « workflow » (V1) : validation du graphe, plafond de blocs, texte extrait, exports Markdown (Mermaid) et HTML, dérive du registre.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docText, MAX_BASE_BLOCKS, sanitizeDoc, type DocNode } from '../src/lib/content.js';
import { EDITOR_NODE_DEFAULTS } from '../src/lib/editor-defaults.js';
import { toMarkdown } from '../src/lib/markdown.js';
import { renderHtml } from '../src/lib/render-html.js';
import {
  DEFAULT_WORKFLOW_GRAPH, MAX_WORKFLOW_BLOCKS, MAX_WORKFLOW_EDGES, MAX_WORKFLOW_GRAPH, MAX_WORKFLOW_NODES, mermaidLabel, parseWorkflowGraph, WORKFLOW_KINDS,
} from '../src/lib/workflow.js';

type N = { id: string; kind: string; label: string; x: number; y: number; color: string | null };
type E = { id: string; from: string; port: string; to: string; label: string | null };
const node = (id: string, kind: string, label = id, extra: Partial<N> = {}): N => ({ id, kind, label, x: 0, y: 0, color: null, ...extra });
const edge = (id: string, from: string, port: string, to: string, label: string | null = null): E => ({ id, from, port, to, label });
const graph = (nodes: unknown[], edges: unknown[] = [], extra: object = {}) => JSON.stringify({ v: 1, nodes, edges, ...extra });
const parse = (g: string) => { const r = parseWorkflowGraph(g); return r === undefined ? undefined : JSON.parse(r); };

const valid = graph(
  [node('a', 'start', 'Demande'), node('b', 'decision', 'Validée ?', { x: 200, y: 20, color: 'blue' }), node('c', 'step', 'Documenter', { x: 400 }), node('d', 'end', 'Fin', { x: 600 }), node('e', 'note', 'Remarque')],
  [edge('e1', 'a', 'out', 'b'), edge('e2', 'b', 'yes', 'c'), edge('e3', 'b', 'no', 'd', 'Refus'), edge('e4', 'c', 'out', 'd')],
);

describe('parseWorkflowGraph', () => {
  it('accepte un graphe valide et le réécrit en forme canonique', () => {
    const out = parseWorkflowGraph(valid)!;
    expect(JSON.parse(out).nodes).toHaveLength(5);
    expect(parseWorkflowGraph(out)).toBe(out); // idempotent
    expect(Object.keys(JSON.parse(out).nodes[0])).toEqual(['id', 'kind', 'label', 'x', 'y', 'color']);
  });
  it('accepte le graphe par défaut et un graphe vide', () => {
    expect(parseWorkflowGraph(DEFAULT_WORKFLOW_GRAPH)).toBe(DEFAULT_WORKFLOW_GRAPH);
    expect(parse(graph([]))).toEqual({ v: 1, nodes: [], edges: [] });
  });
  it('retire les clés inconnues, à tous les niveaux', () => {
    const g = parse(graph([{ ...node('a', 'start'), onclick: 'x()', __proto__x: 1 }, node('b', 'end')], [{ ...edge('e1', 'a', 'out', 'b'), style: 'x' }], { extra: 1 }));
    expect(g).toEqual({ v: 1, nodes: [node('a', 'start'), node('b', 'end')], edges: [edge('e1', 'a', 'out', 'b')] });
  });
  it('garde le HTML d’un libellé comme texte', () => {
    const g = parse(graph([node('a', 'step', '<img src=x onerror=alert(1)>')]));
    expect(g.nodes[0].label).toBe('<img src=x onerror=alert(1)>');
  });
  it('retire les caractères de contrôle sauf le saut de ligne', () => {
    const g = parse(graph([node('a', 'step', 'a\u0000b\u0007c\r\nd\ne')]));
    expect(g.nodes[0].label).toBe('abc\nd\ne');
  });
  it('rejette les libellés trop longs ou de plus de 3 lignes', () => {
    expect(parse(graph([node('a', 'step', 'x'.repeat(120))]))).toBeDefined();
    expect(parse(graph([node('a', 'step', 'x'.repeat(121))]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a\nb\nc')]))).toBeDefined();
    expect(parse(graph([node('a', 'step', 'a\nb\nc\nd')]))).toBeUndefined();
    expect(parse(graph([node('a', 'start'), node('b', 'end')], [edge('e1', 'a', 'out', 'b', 'x'.repeat(61))]))).toBeUndefined();
    expect(parse(graph([node('a', 'start'), node('b', 'end')], [edge('e1', 'a', 'out', 'b', 'x'.repeat(60))]))).toBeDefined();
  });
  it('rejette un type inconnu', () => {
    expect(parse(graph([node('a', 'script')]))).toBeUndefined();
    expect(parse(graph([node('a', 'constructor')]))).toBeUndefined();
    expect(parse(graph([node('a', '__proto__')]))).toBeUndefined();
  });
  it('rejette un identifiant hors format ou en double', () => {
    for (const id of ['', 'A1', 'a-b', 'a b', 'x'.repeat(13), 'é']) expect(parse(graph([node(id, 'step')])), id).toBeUndefined();
    expect(parse(graph([node('a', 'step'), node('a', 'step')]))).toBeUndefined();
    expect(parse(graph([node('a', 'start'), node('b', 'end')], [edge('e1', 'a', 'out', 'b'), edge('e1', 'a', 'out', 'b')]))).toBeUndefined();
    // Nœuds et liens ont des espaces d'identifiants distincts.
    expect(parse(graph([node('a', 'start'), node('b', 'end')], [edge('a', 'a', 'out', 'b')]))).toBeDefined();
  });
  it('rejette un lien orphelin', () => {
    expect(parse(graph([node('a', 'start')], [edge('e1', 'a', 'out', 'zz')]))).toBeUndefined();
    expect(parse(graph([node('b', 'end')], [edge('e1', 'zz', 'out', 'b')]))).toBeUndefined();
  });
  it('rejette un port absent du nœud de départ ou une cible sans entrée', () => {
    expect(parse(graph([node('a', 'step'), node('b', 'end')], [edge('e1', 'a', 'yes', 'b')]))).toBeUndefined();
    expect(parse(graph([node('a', 'end'), node('b', 'step')], [edge('e1', 'a', 'out', 'b')]))).toBeUndefined();
    expect(parse(graph([node('a', 'step'), node('b', 'start')], [edge('e1', 'a', 'out', 'b')]))).toBeUndefined();
    expect(parse(graph([node('a', 'note'), node('b', 'step')], [edge('e1', 'a', 'out', 'b')]))).toBeUndefined();
    expect(parse(graph([node('a', 'step'), node('b', 'note')], [edge('e1', 'a', 'out', 'b')]))).toBeUndefined();
    expect(parse(graph([node('a', 'step'), node('b', 'end')], [edge('e1', 'a', '__proto__', 'b')]))).toBeUndefined();
  });
  it('rejette une boucle sur soi-même et un doublon', () => {
    expect(parse(graph([node('a', 'step')], [edge('e1', 'a', 'out', 'a')]))).toBeUndefined();
    expect(parse(graph([node('a', 'step'), node('b', 'end')], [edge('e1', 'a', 'out', 'b'), edge('e2', 'a', 'out', 'b', 'autre')]))).toBeUndefined();
    // Même départ et même cible par deux prises différentes : permis.
    expect(parse(graph([node('a', 'decision'), node('b', 'end')], [edge('e1', 'a', 'yes', 'b'), edge('e2', 'a', 'no', 'b')]))).toBeDefined();
  });
  it('applique les plafonds de nœuds, de liens et de taille', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => node(`n${i}`, 'step'));
    expect(parse(graph(many(MAX_WORKFLOW_NODES)))).toBeDefined();
    expect(parse(graph(many(MAX_WORKFLOW_NODES + 1)))).toBeUndefined();
    const links = (n: number) => Array.from({ length: n }, (_, i) => edge(`e${i}`, 'a', 'out', 'b'));
    expect(parse(graph([node('a', 'start'), node('b', 'end')], links(MAX_WORKFLOW_EDGES + 1)))).toBeUndefined();
    expect(parseWorkflowGraph(graph([node('a', 'step')], [], { pad: 'x'.repeat(MAX_WORKFLOW_GRAPH) }))).toBeUndefined();
  });
  it('rejette coordonnées et couleurs hors liste', () => {
    expect(parse(graph([node('a', 'step', 'a', { x: 10_001 })]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a', { y: -10_001 })]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a', { x: 1.5 })]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a', { x: '5' as never })]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a', { x: -10_000, y: 10_000 })]))).toBeDefined();
    expect(parse(graph([node('a', 'step', 'a', { color: 'red' })]))).toBeDefined();
    expect(parse(graph([node('a', 'step', 'a', { color: '#f00' })]))).toBeUndefined();
    expect(parse(graph([node('a', 'step', 'a', { color: 'url(x)' })]))).toBeUndefined();
  });
  it('rejette version, forme et JSON invalides sans lever', () => {
    for (const bad of ['{"v":2,"nodes":[],"edges":[]}', '{"nodes":[],"edges":[]}', '[]', 'null', '"x"', '{"v":1,"nodes":{},"edges":[]}', '{"v":1,"nodes":[null],"edges":[]}',
      '{"v":1,"nodes":[],"edges":[1]}', '', '{"v":1,"nodes":[', valid.slice(0, 60), '{"v":1,"nodes":[],"edges":[]}x']) {
      expect(parseWorkflowGraph(bad), bad).toBeUndefined();
    }
    for (const bad of [undefined, null, 5, {}, [], true]) expect(parseWorkflowGraph(bad)).toBeUndefined();
  });
});

const wf = (g: unknown, extra: Record<string, unknown> = {}): DocNode => ({ type: 'workflow', attrs: { graph: g, ...extra } });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

describe('bloc workflow dans le document', () => {
  it('garde le graphe canonique, la largeur et la hauteur ; retire les attributs inconnus', () => {
    const clean = sanitizeDoc(doc(wf(valid, { width: 600, height: 400, onclick: 'x()' })));
    expect(clean.content![0]!.attrs).toEqual({ graph: parseWorkflowGraph(valid), width: 600, height: 400 });
  });
  it('contrôle largeur et hauteur', () => {
    const attrs = (extra: Record<string, unknown>) => sanitizeDoc(doc(wf(valid, extra))).content![0]!.attrs!;
    expect(attrs({ height: 159 })).not.toHaveProperty('height');
    expect(attrs({ height: 2001 })).not.toHaveProperty('height');
    expect(attrs({ height: 160 })).toHaveProperty('height', 160);
    expect(attrs({ width: 119 })).not.toHaveProperty('width');
    expect(attrs({ width: null, height: null })).toMatchObject({ width: null, height: null });
  });
  it('retire l’attribut d’un graphe invalide mais garde le bloc', () => {
    for (const bad of ['{"v":1,"nodes":[', graph([node('a', 'script')]), 42, { v: 1, nodes: [], edges: [] }]) {
      const clean = sanitizeDoc(doc(wf(bad)));
      expect(clean.content).toHaveLength(1);
      expect(clean.content![0]!.type).toBe('workflow');
      expect(clean.content![0]!.attrs?.graph).toBeUndefined();
    }
  });
  it('plafonne à 20 blocs par page', () => {
    const blocks = Array.from({ length: MAX_WORKFLOW_BLOCKS + 5 }, () => wf(valid));
    const clean = sanitizeDoc(doc(...blocks));
    expect(clean.content!.filter((n) => n.type === 'workflow')).toHaveLength(MAX_WORKFLOW_BLOCKS);
    // Le plafond des blocs « base » reste indépendant.
    const mixed = sanitizeDoc(doc(...Array.from({ length: MAX_BASE_BLOCKS }, () => ({ type: 'baseBlock', attrs: { id: 'b1' } })), ...Array.from({ length: MAX_WORKFLOW_BLOCKS }, () => wf(valid))));
    expect(mixed.content).toHaveLength(MAX_BASE_BLOCKS + MAX_WORKFLOW_BLOCKS);
  });
  it('plafonne aussi en co-édition (même prédicat)', () => {
    const clean = sanitizeDoc(doc(...Array.from({ length: MAX_WORKFLOW_BLOCKS + 1 }, () => wf(valid))), { lenientSynced: true });
    expect(clean.content).toHaveLength(MAX_WORKFLOW_BLOCKS);
  });
  it('extrait les libellés des nœuds et des liens pour la recherche', () => {
    const text = docText(sanitizeDoc(doc(wf(valid))));
    for (const w of ['Demande', 'Validée ?', 'Documenter', 'Remarque', 'Refus']) expect(text).toContain(w);
    expect(docText(sanitizeDoc(doc(wf('invalide'))))).toBe('');
  });
});

describe('export Markdown (Mermaid)', () => {
  const md = (g: string) => toMarkdown('T', '', sanitizeDoc(doc(wf(g))), () => null);
  it('exporte un bloc mermaid flowchart LR', () => {
    const out = md(valid);
    expect(out).toContain('```mermaid\nflowchart LR\n');
    expect(out).toContain('n0(["Demande"])');
    expect(out).toContain('n1{"Validée ?"}');
    expect(out).toContain('n1 -->|"Oui"| n2');
    expect(out).toContain('n1 -->|"Refus"| n3');
    expect(out).toContain('n0 --> n1');
  });
  it('neutralise les libellés hostiles', () => {
    const hostile = ['%%{init: {"securityLevel":"loose"}}%%', '"] \n click n0 call alert()', 'a"]\nstyle n0 fill:red', '```\n# titre', '{x}|y|[z](u)<b>', '`;`'];
    const g = graph(hostile.map((l, i) => node(`n${i}`, 'step', l.slice(0, 120))), [edge('e1', 'n0', 'out', 'n1', '"|x|%%')]);
    const out = md(g);
    const block = out.split('```mermaid\n')[1]!.split('\n```')[0]!;
    // Aucune ligne autre que l'en-tête, une déclaration de nœud n<i>[...] ou un lien n<i> --> n<j>.
    for (const line of block.split('\n').slice(1)) {
      expect(line, line).toMatch(/^ {2}n\d+(\(\["[^"]*"\]\)|\{"[^"]*"\}|\["[^"]*"\]|>"[^"]*"\]| -->\|"[^"]*"\| n\d+| --> n\d+)$/);
    }
    expect(block).not.toMatch(/%/);
    expect(block).not.toMatch(/\bclick\b.*\(/);
    expect(out.match(/```/g)).toHaveLength(2); // aucune fermeture anticipée du bloc
  });
  it('mermaidLabel n’émet que la liste blanche et des entités', () => {
    const out = mermaidLabel('a"b[c]{d}(e)|f%g;h#i`j\\k<l>m&n\no');
    expect(out).toMatch(/^[\p{L}\p{N} .,!?'_+/@:#;-]*$/u);
    expect(out).not.toMatch(/["[\]{}()|%`\\<>&]/);
    expect(mermaidLabel('')).toBe(' ');
  });
  it('un bloc sans graphe valide ou vide ne produit pas de bloc mermaid', () => {
    expect(md('invalide')).toContain('_[Workflow vide]_');
    expect(md(graph([]))).toContain('_[Workflow vide]_');
  });
});

describe('export HTML', () => {
  const html = (g: string) => renderHtml(sanitizeDoc(doc(wf(g))), () => null);
  it('rend une liste ordonnée dans une figure', () => {
    const out = html(valid);
    expect(out).toMatch(/^<figure><figcaption>Workflow<\/figcaption><ol>.*<\/ol><\/figure>$/);
    expect(out).toContain('<li>Début : Demande. Suite vers Validée ?</li>');
    expect(out).toContain('<li>Décision : Validée ? Oui vers Documenter, Refus vers Fin</li>');
    expect(out).toContain('<li>Fin : Fin</li>');
  });
  it('échappe tout libellé', () => {
    const out = html(graph([node('a', 'start', '<script>alert(1)</script>'), node('b', 'end', '"><img src=x onerror=1>')], [edge('e1', 'a', 'out', 'b', '<b>x</b>')]));
    expect(out).not.toMatch(/<script|<img|<b>/i);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('un graphe invalide ne rend rien', () => {
    expect(html('invalide')).toBe('');
  });
});

describe('graphe par défaut et dérive du registre', () => {
  it('le graphe par défaut est valide et relie Début, Étape et Fin', () => {
    const g = JSON.parse(parseWorkflowGraph(DEFAULT_WORKFLOW_GRAPH)!);
    expect(g.nodes.map((n: N) => n.kind)).toEqual(['start', 'step', 'end']);
    expect(g.edges).toHaveLength(2);
    expect(EDITOR_NODE_DEFAULTS.workflow).toEqual({ graph: DEFAULT_WORKFLOW_GRAPH, height: 360 });
  });
  it('les types et leurs prises sont ceux du client (client/src/workflow/kinds.js)', async () => {
    const url = new URL('../../client/src/workflow/kinds.js', import.meta.url);
    if (!existsSync(url)) return; // le client n'a pas encore livré son registre
    const client = (await import(url.href)) as { KINDS: Record<string, { in?: boolean; input?: boolean; out?: readonly string[]; outputs?: readonly string[]; label?: string }> };
    const normalize = (k: { in?: boolean; input?: boolean; out?: readonly string[]; outputs?: readonly string[] }) => ({ in: !!(k.in ?? k.input), out: [...(k.out ?? k.outputs ?? [])] });
    expect(Object.keys(client.KINDS).sort()).toEqual(Object.keys(WORKFLOW_KINDS).sort());
    for (const [kind, spec] of Object.entries(WORKFLOW_KINDS)) {
      expect(normalize(client.KINDS[kind]!), kind).toEqual({ in: spec.in, out: [...spec.out] });
    }
  });
});
