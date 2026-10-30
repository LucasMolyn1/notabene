// Nœuds personnalisés de l'éditeur : encadrés et liens de pages.
import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../util.js';
import { pagePathById } from '../urls.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { pageIcon } from '../ui.js';

// ---- Nœuds personnalisés -------------------------------------------------

const CALLOUTS = {
  info: { glyph: 'i', label: 'Info' },
  warning: { glyph: '!', label: 'Attention' },
  success: { glyph: '✓', label: 'Succès' },
  danger: { glyph: '✗', label: 'Danger' },
};
const CALLOUT_ORDER = Object.keys(CALLOUTS);

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => el.getAttribute('data-type') || 'info',
        renderHTML: (attrs) => ({ 'data-type': attrs.type }),
      },
    };
  },

  parseHTML() { return [{ tag: 'div[data-callout]' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), 0];
  },

  addCommands() {
    return {
      setCallout: (attrs) => ({ commands }) => commands.wrapIn(this.name, attrs),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const iconBtn = h('button', { class: 'callout-icon', contenteditable: 'false', type: 'button', title: 'Changer le type' });
      const content = h('div', { class: 'callout-content' });
      const dom = h('div', { class: 'callout', 'data-callout': '' }, iconBtn, content);
      const paint = () => {
        dom.dataset.type = current.attrs.type;
        iconBtn.textContent = CALLOUTS[current.attrs.type]?.glyph || 'i';
      };
      iconBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const next = CALLOUT_ORDER[(CALLOUT_ORDER.indexOf(current.attrs.type) + 1) % CALLOUT_ORDER.length];
        editor.view.dispatch(editor.state.tr.setNodeMarkup(getPos(), undefined, { ...current.attrs, type: next }));
      });
      paint();
      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type.name !== 'callout') return false;
          current = updated;
          paint();
          return true;
        },
      };
    };
  },
});

// Lien vers une autre page du wiki : affiche toujours le titre et l'icône à jour.
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-link'),
        renderHTML: (attrs) => ({ 'data-page-link': attrs.id, href: `/p/${attrs.id}` }),
      },
    };
  },

  parseHTML() { return [{ tag: 'a[data-page-link]', priority: 60 }]; },

  renderHTML({ node, HTMLAttributes }) {
    const p = store.page(node.attrs.id);
    return ['a', mergeAttributes(HTMLAttributes, { class: 'page-link' }), p?.title || 'Sans titre'];
  },

  renderText({ node }) { return store.page(node.attrs.id)?.title || 'Sans titre'; },

  addNodeView() {
    return ({ node }) => {
      const dom = h('a', { class: 'page-link', href: pagePathById(node.attrs.id), contenteditable: 'false', 'data-page-link': node.attrs.id });
      const paint = () => {
        const p = store.page(node.attrs.id);
        const missing = !p || !!p.deletedAt;
        dom.classList.toggle('missing', missing);
        dom.replaceChildren(
          h('span', { class: 'page-link-icon' }, missing ? icon('ban', 14) : pageIcon(p.icon, 14)),
          h('span', { class: 'page-link-title' }, missing ? 'Page supprimée' : p.title || 'Sans titre'),
        );
      };
      paint();
      const off = store.subscribe(paint);
      return { dom, destroy: off, ignoreMutation: () => true };
    };
  },
});
