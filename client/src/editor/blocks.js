// Blocs et mises en forme ajoutés à l'éditeur : bloc dépliable, colonnes, couleur du texte, surlignage coloré, alignement.
// Le contenu ne porte que des noms (palette fixe, alignement) : toute valeur de style vit dans la feuille de l'application.
import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { TextSelection } from '@tiptap/pm/state';
import { h } from '../util.js';
import { icon } from '../icons.js';

/** Même palette que server/src/lib/content.ts (COLORS) ; `label` sert aux noms accessibles. */
export const COLORS = [
  { id: 'gray', label: 'gris' }, { id: 'red', label: 'rouge' }, { id: 'orange', label: 'orange' }, { id: 'yellow', label: 'jaune' },
  { id: 'green', label: 'vert' }, { id: 'blue', label: 'bleu' }, { id: 'purple', label: 'violet' }, { id: 'pink', label: 'rose' },
];
const IDS = COLORS.map((c) => c.id);
const colorAttr = (parse = 'data-color') => ({
  default: null,
  parseHTML: (el) => { const v = el.getAttribute(parse); return IDS.includes(v) ? v : null; },
  renderHTML: (attrs) => (attrs.color ? { 'data-color': attrs.color } : {}),
});

// ---- Couleur du texte et surlignage -----------------------------------------

export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() { return { color: colorAttr() }; },
  parseHTML() { return [{ tag: 'span[data-text-color]', getAttrs: (el) => (IDS.includes(el.getAttribute('data-color')) ? null : false) }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-text-color': '' }), 0]; },
  addCommands() {
    return {
      setTextColor: (color) => ({ commands }) => (IDS.includes(color) ? commands.setMark(this.name, { color }) : false),
      unsetTextColor: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

// Le surlignage de TipTap accepte une couleur CSS libre : ici seule la palette est reconnue.
export const ColoredHighlight = Highlight.extend({
  addAttributes() { return { color: colorAttr() }; },
  addCommands() {
    return {
      setHighlight: (attrs) => ({ commands }) => commands.setMark(this.name, attrs?.color && IDS.includes(attrs.color) ? { color: attrs.color } : {}),
      toggleHighlight: (attrs) => ({ commands }) => commands.toggleMark(this.name, attrs?.color && IDS.includes(attrs.color) ? { color: attrs.color } : {}),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

// ---- Alignement ---------------------------------------------------------------

const ALIGNS = ['left', 'center', 'right', 'justify'];
export const TextAlign = Extension.create({
  name: 'textAlign',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        align: {
          default: null,
          parseHTML: (el) => { const v = el.getAttribute('data-align'); return ALIGNS.includes(v) ? v : null; },
          renderHTML: (attrs) => (attrs.align ? { 'data-align': attrs.align } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setAlign: (align) => ({ commands }) => {
        const value = align === 'left' ? null : align; // « à gauche » est l'état normal : rien à enregistrer
        if (value !== null && !ALIGNS.includes(value)) return false;
        return ['paragraph', 'heading'].map((type) => commands.updateAttributes(type, { align: value })).some(Boolean);
      },
    };
  },
});

// ---- Bloc dépliable -----------------------------------------------------------

const DEFAULT_TITLE = 'Titre du bloc';

export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: 'div[data-details-summary]' }, { tag: 'summary' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-details-summary': '', class: 'details-summary' }), 0]; },
});

export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: 'div[data-details-content]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-details-content': '', class: 'details-content' }), 0]; },
});

// L'état ouvert ou fermé est celui de l'affichage de chacun : le contenu de la page ne change pas quand on déplie.
export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,
  isolating: true,

  parseHTML() { return [{ tag: 'details' }, { tag: 'div[data-details]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-details': '', class: 'details' }), 0]; },

  addCommands() {
    return {
      // Le titre proposé est sélectionné : la première frappe le remplace.
      setDetails: () => ({ chain, state }) => {
        const from = state.selection.from;
        return chain().insertContent({
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: DEFAULT_TITLE }] },
            { type: 'detailsContent', content: [{ type: 'paragraph' }] },
          ],
        }).command(({ tr }) => {
          let at = null;
          tr.doc.descendants((node, pos) => { if (at === null && node.type.name === 'details' && pos >= from - 1) at = pos; return at === null; });
          if (at !== null) tr.setSelection(TextSelection.create(tr.doc, at + 2, at + 2 + DEFAULT_TITLE.length));
          return true;
        }).run();
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const inside = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        const { from } = editor.state.selection;
        return pos != null && from > pos && from < pos + node.nodeSize;
      };
      const toggle = h('button', { class: 'details-toggle', type: 'button', contenteditable: 'false' });
      const body = h('div', { class: 'details-body' });
      const dom = h('div', { class: 'details', 'data-details': '' }, toggle, body);
      const paint = (open) => {
        dom.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Replier le bloc' : 'Déplier le bloc');
        toggle.replaceChildren(icon('chevron', 16));
      };
      // Un bloc qu'on vient d'insérer (curseur dedans) s'ouvre ; les autres restent repliés au chargement.
      paint(inside());
      toggle.addEventListener('mousedown', (e) => e.preventDefault());
      toggle.addEventListener('click', () => paint(!dom.classList.contains('open')));
      return {
        dom,
        contentDOM: body,
        stopEvent: (e) => toggle.contains(/** @type {any} */ (e.target)),
        ignoreMutation: (m) => toggle.contains(m.target) || (m.type === 'attributes' && m.target === dom),
        update: (updated) => updated.type.name === 'details',
      };
    };
  },
});

// ---- Colonnes -------------------------------------------------------------------

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  defining: true,
  parseHTML() { return [{ tag: 'div[data-column]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'column' }), 0]; },
});

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,4}',
  isolating: true,
  defining: true,
  parseHTML() { return [{ tag: 'div[data-columns]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'columns' }), 0]; },
  addCommands() {
    return {
      setColumns: (count = 2) => ({ commands }) => commands.insertContent({
        type: 'columns',
        content: Array.from({ length: Math.min(4, Math.max(2, count)) }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })),
      }),
    };
  },
});
