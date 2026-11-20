// Remise en forme de l'éditeur à l'ouverture d'une page (co-édition) : le document Yjs est construit sans schéma à partir du JSON
// stocké (yjs-json.ts). L'éditeur du navigateur y ajoute les valeurs par défaut de son schéma (case non cochée, cellule 1 x 1…)
// et un paragraphe vide final (extension TrailingNode de TipTap). Ces ajouts ne changent pas le sens du contenu : ils ne doivent
// créer ni version, ni « modifiée par ». La comparaison passe donc par une forme canonique qui les ignore.
import type { DocNode } from './content.js';
import { DEFAULT_WORKFLOW_GRAPH } from './workflow.js';

// Valeurs par défaut NON nulles du schéma de l'éditeur (client/src/editor.js et ses extensions), limitées aux attributs gardés
// par l'assainissement (content.ts). Un attribut nul n'est jamais écrit dans l'état Yjs (y-prosemirror l'omet) : inutile ici.
// Liste unique côté serveur, vérifiée contre le schéma du client par server/test/editor-defaults.test.ts.
export const EDITOR_NODE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  heading: { level: 1 },
  orderedList: { start: 1 },
  taskList: { checklist: false },
  taskItem: { checked: false },
  tableCell: { colspan: 1, rowspan: 1 },
  tableHeader: { colspan: 1, rowspan: 1 },
  callout: { type: 'info' },
  mermaid: { code: 'flowchart LR\n  A[Idée] --> B{Validée ?}\n  B -->|oui| C[Documenter]\n  B -->|non| D[Archiver]' },
  math: { code: 'E = mc^2' },
  plantuml: { code: '@startuml\nactor Utilisateur\nUtilisateur -> BeNote : Requête\nBeNote --> Utilisateur : Réponse\n@enduml' },
  excalidraw: { scene: '', svg: '' },
  drawio: { xml: '', svg: '' },
  workflow: { graph: DEFAULT_WORKFLOW_GRAPH, height: 360 },
  attachment: { name: '', mime: 'application/octet-stream' },
  video: { name: '' },
  audio: { name: '' },
};

/** Valeurs par défaut non nulles des attributs de marques gardés par l'assainissement (aucune aujourd'hui). */
export const EDITOR_MARK_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {};

type Mark = NonNullable<DocNode['marks']>[number];

// Attributs sans les valeurs nulles ni celles égales au défaut, clés triées (l'ordre des clés n'a pas de sens).
function canonicalAttrs(attrs: Record<string, unknown> | undefined, defaults: Readonly<Record<string, unknown>> | undefined) {
  if (!attrs) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    const value = attrs[key];
    if (value === null || value === undefined) continue;
    if (defaults && Object.hasOwn(defaults, key) && JSON.stringify(defaults[key]) === JSON.stringify(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// Marques triées par type : leur ordre n'a pas de sens (ProseMirror les range selon son schéma, Yjs selon l'ordre d'insertion).
function canonicalMarks(marks: Mark[] | undefined): Mark[] | undefined {
  if (!marks?.length) return undefined;
  const out = marks.map((m) => {
    const attrs = canonicalAttrs(m.attrs, EDITOR_MARK_DEFAULTS[m.type]);
    return attrs ? { type: m.type, attrs } : { type: m.type };
  });
  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return out;
}

const isEmptyParagraph = (n: DocNode) => n.type === 'paragraph' && !n.attrs && !n.content;

function canonicalNode(node: DocNode): DocNode {
  if (node.type === 'text') {
    const marks = canonicalMarks(node.marks);
    return { type: 'text', text: node.text ?? '', ...(marks ? { marks } : {}) };
  }
  const out: DocNode = { type: node.type };
  const attrs = canonicalAttrs(node.attrs, EDITOR_NODE_DEFAULTS[node.type]);
  if (attrs) out.attrs = attrs;
  // Textes voisins aux mêmes marques fusionnés (Yjs les regroupe), textes vides retirés.
  const content: DocNode[] = [];
  for (const child of (node.content ?? []).map(canonicalNode)) {
    if (child.type === 'text' && !child.text) continue;
    const prev = content.at(-1);
    if (child.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks) === JSON.stringify(child.marks)) {
      content[content.length - 1] = { ...prev, text: prev.text! + child.text! };
    } else content.push(child);
  }
  // Paragraphes vides en fin de document : ajoutés par l'éditeur (TrailingNode), sans contenu.
  if (node.type === 'doc') while (content.length && isEmptyParagraph(content.at(-1)!)) content.pop();
  if (content.length) out.content = content;
  return out;
}

/** Forme canonique d'un document : celle qui sert à décider si un contenu a vraiment changé. */
export const canonicalDoc = (doc: DocNode): DocNode => canonicalNode(doc);

/** Deux documents ont-ils le même sens, à la remise en forme de l'éditeur près ? */
export const sameEditorContent = (a: DocNode, b: DocNode): boolean => JSON.stringify(canonicalDoc(a)) === JSON.stringify(canonicalDoc(b));
