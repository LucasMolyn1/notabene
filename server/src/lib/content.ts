// Validation stricte des documents TipTap reçus : liste blanche de nœuds, de marques
// et d'attributs, URL filtrées. Tout ce qui n'est pas explicitement autorisé est refusé
// ou retiré, pour qu'aucun contenu stocké ne puisse porter de script.
import { ATTACHMENT_ID, ATTACHMENT_MIMES } from './attachments.js';
import { embedUrl } from './embed.js';
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

const attachmentId = (v: unknown) => (typeof v === 'string' && ATTACHMENT_ID.test(v) ? v : undefined);

// Identifiant de bloc synchronisé : 16 octets aléatoires en base64url sans remplissage (22 caractères, 128 bits). Le dernier
// caractère ne porte que 2 bits utiles : seules les 4 valeurs possibles d'un encodage canonique sont acceptées.
export const SYNCED_BLOCK_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const syncedBlockId = (v: unknown) => (typeof v === 'string' && SYNCED_BLOCK_ID.test(v) ? v : undefined);

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
  // `checklist` : liste de cases dont le texte coché n'est pas barré (affichage seulement, aucune autre incidence).
  taskList: { checklist: bool },
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
  // Contenu intégré (iframe) : adresse https normalisée ; l'affichage dépend en plus de la liste d'hôtes de l'instance (CSP frame-src).
  embed: { url: (v) => embedUrl(v) ?? undefined },
  // Bloc qui affiche une base (tableau ou Kanban) : seuls l'identifiant de la base et celui de la vue sont enregistrés. Les droits de lecture
  // sont ceux de la base, vérifiés à chaque affichage : le bloc ne contient ni titre, ni cellule, ni nom.
  baseBlock: { id: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined), view: nullable((v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined)) },
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
  // Pièces jointes : seul l'identifiant compte (le fichier, son type et ses droits sont ceux de la ligne en base, revérifiés à chaque
  // lecture). Nom, taille et type ne servent qu'à l'affichage. Un bloc sans identifiant valide est retiré.
  attachment: { id: attachmentId, name: str(200), size: int(0, Number.MAX_SAFE_INTEGER), mime: oneOf(...ATTACHMENT_MIMES) },
  video: { id: attachmentId, name: str(200), width: nullable(int(120, 4000)) },
  audio: { id: attachmentId, name: str(200) },
  // Blocs synchronisés : la source (contenu édité dans sa page) et la copie (atome, identifiant seul, aucun contenu stocké ;
  // son contenu est lu à l'affichage, avec les droits du lecteur sur la page source). Voir lib/synced-blocks.ts.
  syncedSource: { blockId: syncedBlockId },
  syncedCopy: { blockId: syncedBlockId },
};

/** Blocs qui désignent une pièce jointe par son identifiant. */
export const ATTACHMENT_NODES = new Set(['attachment', 'video', 'audio']);

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

// Au plus 20 blocs « base » par page : chacun demande la base entière au serveur à chaque affichage.
export const MAX_BASE_BLOCKS = 20;

// Au plus 20 blocs synchronisés (sources et copies) par page : chaque copie demande sa source au serveur à chaque affichage.
export const MAX_SYNCED_BLOCKS = 20;
// Parents permis pour un bloc synchronisé : les conteneurs de blocs (liste blanche). Jamais dans un texte, une liste ou un tableau
// directement, ni dans un autre bloc synchronisé.
export const SYNCED_PARENTS = new Set(['doc', 'blockquote', 'callout', 'listItem', 'taskItem', 'tableCell', 'tableHeader', 'detailsContent', 'column']);
// Conteneurs qu'un bloc synchronisé peut avoir pour ancêtres (avec `doc`) : TOUTE la chaîne d'ancêtres doit en être. Un bloc caché
// sous un paragraphe, une image, une copie ou une autre source est refusé, ce qui rend identiques par construction le parcours du
// JSON et celui de l'état Yjs (co-édition, lib/synced-blocks.ts).
export const SYNCED_CONTAINERS = new Set([
  'blockquote', 'callout', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table', 'tableRow', 'tableCell', 'tableHeader',
  'details', 'detailsContent', 'columns', 'column',
]);
// Parents sous lesquels une source invalide peut être sortie de son enveloppe (co-édition) : ceux qui acceptent des blocs, et une
// source (source imbriquée). Sous tout autre parent (structure imposée), elle est retirée avec son contenu.
export const UNWRAP_PARENTS = new Set([...SYNCED_PARENTS, 'syncedSource']);
// Enfants interdits dans une source : ce qui n'est pas un bloc autonome.
export const NOT_BLOCK = new Set([...INLINE, 'doc', 'listItem', 'taskItem', 'tableRow', 'tableCell', 'tableHeader', 'detailsSummary', 'detailsContent', 'column']);

/**
 * Nœud retiré en silence par l'assainissement (attributs déjà nettoyés) : image sans adresse sûre, lien de page, mention, intégration
 * ou pièce jointe sans identifiant valide, bloc « base » sans identifiant ou au-delà de MAX_BASE_BLOCKS (`state` compte les blocs
 * « base » dans l'ordre du document). Prédicat unique, partagé avec la co-édition (planCollabSynced, lib/synced-blocks.ts).
 */
export function droppedNode(type: string, attrs: Record<string, unknown> | undefined, state: { baseBlocks: number }): boolean {
  if (type === 'image') return !attrs?.src;
  if (type === 'pageLink' || type === 'mention' || ATTACHMENT_NODES.has(type)) return !attrs?.id;
  if (type === 'embed') return !attrs?.url;
  if (type === 'baseBlock') return !attrs?.id || ++state.baseBlocks > MAX_BASE_BLOCKS;
  return false;
}

/** Le nœud brut `node` serait-il retiré en silence par l'assainissement ? (Texte vide compris ; type inconnu : non, il est refusé.) */
export function isDroppedBySanitize(node: DocNode, state: { baseBlocks: number }): boolean {
  if (node.type === 'text') return typeof node.text !== 'string' || !node.text;
  if (!Object.hasOwn(NODES, node.type)) return false;
  return droppedNode(node.type, cleanAttrs(NODES[node.type], node.attrs), state);
}

/**
 * `lenientSynced` (co-édition) : un bloc synchronisé invalide ne fait jamais échouer l'assainissement. Les autres structures
 * imposées (colonne, titre ou corps de dépliable forgés hors de leur parent) lèvent toujours, comme sans bloc synchronisé. Une source est sortie de son
 * enveloppe (ses blocs restent, à leur place) sous un parent qui accepte des blocs, et retirée avec son contenu ailleurs (parent à
 * structure imposée : dépliable, colonnes…) ; une copie est retirée. Le JSON enregistré fait foi.
 */
export function sanitizeDoc(input: unknown, opts: { lenientSynced?: boolean } = {}): DocNode {
  const counters = { baseBlocks: 0 };
  let syncedBlocks = 0;
  let count = 0;
  let textLength = 0;

  // `inSynced` : le nœud est dans une source synchronisée (aucun bloc synchronisé n'y est permis : ni cycle, ni profondeur).
  // `chain` : tous les ancêtres du nœud sont `doc` ou des conteneurs de SYNCED_CONTAINERS.
  const walk = (raw: unknown, depth: number, parent = '', inSynced = false, chain = true): DocNode | DocNode[] | null => {
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
    if (droppedNode(type, attrs, counters)) return null;
    const synced = type === 'syncedSource' || type === 'syncedCopy';
    // Bloc synchronisé invalide : refus (API), ou en co-édition copie retirée et source sortie de son enveloppe / retirée.
    const invalid = (message: string, kids: DocNode[] = []): DocNode[] | null => {
      if (!opts.lenientSynced) throw new HttpError(400, message);
      return type === 'syncedSource' && UNWRAP_PARENTS.has(parent) ? kids : null;
    };
    let excess = false;
    if (synced) {
      if (!attrs?.blockId || inSynced || !chain || !SYNCED_PARENTS.has(parent)) {
        if (!opts.lenientSynced || type === 'syncedCopy' || !UNWRAP_PARENTS.has(parent)) return invalid(`Structure invalide pour « ${type} »`);
        excess = true; // source mal placée sous un parent qui accepte des blocs : sortie de son enveloppe après lecture de son contenu
      } else if (++syncedBlocks > MAX_SYNCED_BLOCKS) {
        if (!opts.lenientSynced || type === 'syncedCopy') return invalid(`Une page compte au plus ${MAX_SYNCED_BLOCKS} blocs synchronisés`);
        excess = true;
      }
      // Une copie n'enregistre jamais de contenu : ce qui serait envoyé avec elle est ignoré, sans être lu.
      if (type === 'syncedCopy') return out;
    }
    if (Array.isArray(node.content)) {
      const nested = inSynced || type === 'syncedSource';
      const childChain = chain && (type === 'doc' || SYNCED_CONTAINERS.has(type));
      out.content = node.content.flatMap((c) => walk(c, depth + 1, type, nested, childChain) ?? []);
    }
    if (type === 'syncedSource' && (excess || !out.content?.length || out.content.some((k) => NOT_BLOCK.has(k.type)))) {
      return invalid('Structure invalide pour « syncedSource »', out.content ?? []);
    }
    checkStructure(out, parent);
    return out;
  };

  const root = walk(input, 0);
  const doc = Array.isArray(root) ? null : root;
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

/** Retire les ancres de commentaires : les fils d'une page ne suivent pas son contenu ailleurs (copie, bloc synchronisé). */
export function stripCommentAnchors(node: DocNode): DocNode {
  const out: DocNode = { ...node };
  if (node.marks) {
    const marks = node.marks.filter((m) => m.type !== 'commentAnchor');
    if (marks.length) out.marks = marks; else delete out.marks;
  }
  if (node.content) out.content = node.content.map(stripCommentAnchors);
  return out;
}

export const emptyDoc = (): DocNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

// Texte brut du document : sert à la recherche plein texte et aux extraits.
export function docText(node: DocNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  // Une copie synchronisée n'ajoute rien au texte de sa page (recherche, extraits) : le texte de la source est indexé avec SA page.
  if (node.type === 'syncedCopy') return '';
  if (node.type === 'mermaid' || node.type === 'plantuml' || node.type === 'math') return ` ${String(node.attrs?.code ?? '')} `;
  if (ATTACHMENT_NODES.has(node.type)) return ` ${String(node.attrs?.name ?? '')} `;
  const sep = TEXT_BLOCKS.has(node.type) ? '' : ' ';
  const out = (node.content ?? []).map(docText).join(sep);
  return node.type === 'doc' ? out.replace(/\s+/g, ' ').trim() : out;
}
