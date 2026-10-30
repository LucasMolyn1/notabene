// Validation stricte des documents TipTap reçus : liste blanche de nœuds, de marques
// et d'attributs, URL filtrées. Tout ce qui n'est pas explicitement autorisé est refusé
// ou retiré, pour qu'aucun contenu stocké ne puisse porter de script.
import { HttpError } from './http.js';

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const MAX_DEPTH = 48;
const MAX_NODES = 50_000;
const MAX_TEXT = 200_000;
const MAX_DIAGRAM = 3_000_000;

const str = (max: number) => (v: unknown) => (typeof v === 'string' && v.length <= max ? v : undefined);
const int = (min: number, max: number) => (v: unknown) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v : undefined);
const oneOf = (...values: string[]) => (v: unknown) => (typeof v === 'string' && values.includes(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const nullable = (f: (v: unknown) => unknown) => (v: unknown) => (v === null ? null : f(v));

// Palette fixe : le contenu ne porte qu'un nom de couleur, jamais une valeur CSS (le style est dans la feuille de l'application).
export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
const color = nullable(oneOf(...COLORS));
const align = nullable(oneOf('left', 'center', 'right', 'justify'));

export function isSafeHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length > 2048) return false;
  // eslint-disable-next-line no-control-regex -- on refuse justement les caractères de contrôle (contournement de schéma)
  if (/[\u0000-\u001f\s]/.test(href.slice(0, 16))) return false;
  if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) return true;
  return /^(https?:|mailto:)/i.test(href);
}

export function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  if (src.startsWith('data:')) return src.length <= 4_000_000 && /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(src);
  return src.length <= 2048 && (/^https:\/\//i.test(src) || (src.startsWith('/') && !src.startsWith('//')));
}

const isSvgDataUrl = (v: unknown) =>
  typeof v === 'string' && v.length <= MAX_DIAGRAM && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(v) ? v : undefined;

const colwidth = (v: unknown) =>
  v === null ? null : Array.isArray(v) && v.length <= 64 && v.every((n) => Number.isInteger(n) && n > 0 && n < 10_000) ? v : undefined;

type AttrRules = Record<string, (v: unknown) => unknown>;

const cell: AttrRules = { colspan: int(1, 64), rowspan: int(1, 64), colwidth };

const NODES: Record<string, AttrRules> = {
  doc: {},
  paragraph: { align },
  text: {},
  hardBreak: {},
  heading: { level: int(1, 3), align },
  blockquote: {},
  bulletList: {},
  orderedList: { start: int(0, 1_000_000), type: nullable(oneOf('1', 'a', 'A', 'i', 'I')) },
  listItem: {},
  taskList: {},
  taskItem: { checked: bool },
  codeBlock: { language: nullable((v) => (typeof v === 'string' && /^[\w+#.-]{0,32}$/.test(v) ? v : undefined)) },
  horizontalRule: {},
  image: {
    src: (v) => (isSafeImageSrc(v) ? v : undefined),
    alt: nullable(str(500)),
    title: nullable(str(500)),
    width: nullable(int(1, 10_000)),
    height: nullable(int(1, 10_000)),
  },
  table: {},
  tableRow: {},
  tableHeader: cell,
  tableCell: cell,
  callout: { type: oneOf('info', 'warning', 'success', 'danger') },
  pageLink: { id: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined) },
  // Mention d'une personne : seul l'identifiant est enregistré. Le nom n'entre jamais dans la page (il vient de la table des utilisateurs).
  mention: { id: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined) },
  mermaid: { code: str(50_000), width: nullable(int(120, 4000)) },
  // Formule LaTeX : seul le texte est enregistré, le rendu (KaTeX) se fait dans le navigateur.
  math: { code: str(5_000), width: nullable(int(120, 4000)) },
  // Bloc dépliable (titre + contenu) et colonnes (2 à 4, vérifiées par l'éditeur ; ici seulement la liste des types).
  details: {},
  detailsSummary: {},
  detailsContent: {},
  columns: {},
  column: {},
  plantuml: { code: str(50_000), width: nullable(int(120, 4000)) },
  excalidraw: { scene: str(MAX_DIAGRAM), svg: isSvgDataUrl, width: nullable(int(120, 4000)) },
  drawio: { xml: str(MAX_DIAGRAM), svg: isSvgDataUrl, width: nullable(int(120, 4000)) },
};

const MARKS: Record<string, AttrRules> = {
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  code: {},
  highlight: { color },
  textColor: { color },
  link: { href: (v) => (isSafeHref(v) ? v : undefined) },
  // Texte commenté : `id` est celui du fil de commentaires (lu seulement s'il existe sur la même page).
  commentAnchor: { id: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined) },
};

function cleanAttrs(rules: AttrRules, attrs: unknown): Record<string, unknown> | undefined {
  if (!attrs || typeof attrs !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(attrs, key)) continue;
    const value = rule((attrs as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// Les blocs à structure imposée (dépliable, colonnes) : un contenu mal formé rendrait l'éditeur muet pour tous les lecteurs.
const INLINE = new Set(['text', 'hardBreak', 'pageLink', 'mention']);
function checkStructure(node: DocNode, parent: string) {
  const kids = node.content ?? [];
  const fail = () => { throw new HttpError(400, `Structure invalide pour « ${node.type} »`); };
  switch (node.type) {
    case 'details': if (kids.length !== 2 || kids[0]!.type !== 'detailsSummary' || kids[1]!.type !== 'detailsContent') fail(); break;
    case 'detailsSummary': if (parent !== 'details' || kids.some((k) => !INLINE.has(k.type))) fail(); break;
    case 'detailsContent': if (parent !== 'details' || !kids.length) fail(); break;
    case 'columns': if (kids.length < 2 || kids.length > 4 || kids.some((k) => k.type !== 'column')) fail(); break;
    case 'column': if (parent !== 'columns' || !kids.length) fail(); break;
    default:
  }
}

export function sanitizeDoc(input: unknown): DocNode {
  let count = 0;
  let textLength = 0;

  const walk = (raw: unknown, depth: number, parent = ''): DocNode | null => {
    if (depth > MAX_DEPTH) throw new HttpError(400, 'Document trop profond');
    if (++count > MAX_NODES) throw new HttpError(400, 'Document trop volumineux');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Nœud de document invalide');
    const node = raw as Record<string, unknown>;
    const type = node.type;
    if (typeof type !== 'string' || !Object.hasOwn(NODES, type)) throw new HttpError(400, `Type de nœud non autorisé : ${String(type).slice(0, 40)}`);

    const out: DocNode = { type };
    if (type === 'text') {
      if (typeof node.text !== 'string' || !node.text) return null;
      textLength += node.text.length;
      if (textLength > MAX_TEXT * 5) throw new HttpError(400, 'Texte trop long');
      out.text = node.text;
      if (Array.isArray(node.marks)) {
        const marks = node.marks.flatMap((m) => {
          if (!m || typeof m !== 'object' || !Object.hasOwn(MARKS, (m as DocNode).type)) return [];
          const mark = m as DocNode;
          const attrs = cleanAttrs(MARKS[mark.type], mark.attrs);
          if (mark.type === 'link' && !attrs?.href) return [];
          if (mark.type === 'commentAnchor' && !attrs?.id) return [];
          if (mark.type === 'textColor' && !attrs?.color) return [];
          return [attrs ? { type: mark.type, attrs } : { type: mark.type }];
        });
        if (marks.length) out.marks = marks;
      }
      return out;
    }

    const attrs = cleanAttrs(NODES[type], node.attrs);
    if (attrs) out.attrs = attrs;
    if (type === 'image' && !attrs?.src) return null;
    if (type === 'pageLink' && !attrs?.id) return null;
    if (type === 'mention' && !attrs?.id) return null;
    if (Array.isArray(node.content)) {
      out.content = node.content.map((c) => walk(c, depth + 1, type)).filter((c): c is DocNode => c !== null);
    }
    checkStructure(out, parent);
    return out;
  };

  const doc = walk(input, 0);
  if (!doc || doc.type !== 'doc') throw new HttpError(400, 'Le contenu doit être un document (type « doc »)');
  if (!doc.content?.length) doc.content = [{ type: 'paragraph' }];
  return doc;
}

/** Identifiants des personnes mentionnées dans un document (sans doublon, dans l'ordre d'apparition). */
export function mentionIds(doc: DocNode | undefined): string[] {
  const ids = new Set<string>();
  const walk = (n: DocNode | undefined) => {
    if (!n) return;
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') ids.add(n.attrs.id);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...ids];
}

/** Le document contient-il un lien vers la page `pageId` ? */
export function hasPageLink(doc: DocNode | undefined, pageId: string): boolean {
  if (!doc) return false;
  if (doc.type === 'pageLink' && doc.attrs?.id === pageId) return true;
  return (doc.content ?? []).some((c) => hasPageLink(c, pageId));
}

export const emptyDoc = (): DocNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

// Texte brut du document : sert à la recherche plein texte et aux extraits.
export function docText(node: DocNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  if (node.type === 'mermaid' || node.type === 'plantuml' || node.type === 'math') return ` ${String(node.attrs?.code ?? '')} `;
  const sep = TEXT_BLOCKS.has(node.type) ? '' : ' ';
  const out = (node.content ?? []).map(docText).join(sep);
  return node.type === 'doc' ? out.replace(/\s+/g, ' ').trim() : out;
}
