// Mention d'une personne dans la page (« @nom »). Le nœud ne garde que l'identifiant (qui désigne et notifie) et un nom de repli ;
// le nom affiché est celui que le serveur renvoie pour cet identifiant.
import { Node, mergeAttributes } from '@tiptap/core';
import { session } from '../session.js';
import { h } from '../util.js';
import { searchMentionable, suggestList } from '../mentions-ui.js';

const names = new Map();
const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) fn(); };

/** Mémorise les noms connus (réponse du serveur ou personne choisie) et repeint les mentions affichées. */
export function rememberMentionNames(users) {
  for (const u of users) names.set(u.id, u.name);
  notify();
}

const nameOf = (attrs) => names.get(attrs.id) || attrs.label || 'utilisateur';

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-mention-id') },
      label: { default: '', parseHTML: (el) => (el.textContent || '').replace(/^@/, '').slice(0, 80) },
    };
  },

  parseHTML() { return [{ tag: 'span[data-mention-id]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'mention', 'data-mention-id': node.attrs.id }), `@${nameOf(node.attrs)}`];
  },
  renderText({ node }) { return `@${nameOf(node.attrs)}`; },

  addNodeView() {
    return ({ node }) => {
      const dom = h('span', { class: 'mention', contenteditable: 'false', 'data-mention-id': node.attrs.id });
      const paint = () => {
        dom.textContent = `@${nameOf(node.attrs)}`;
        dom.classList.toggle('mention-me', node.attrs.id === session.user?.id);
      };
      paint();
      listeners.add(paint);
      return { dom, destroy: () => listeners.delete(paint), ignoreMutation: () => true };
    };
  },
});

/** Menu « @ » de l'éditeur : propose les personnes qui peuvent lire la page. */
export function createMentionMenu(editor, getPageId) {
  let range = null;
  const list = suggestList({
    search: (q) => searchMentionable(getPageId(), q),
    onPick: (user) => {
      if (!range) return;
      rememberMentionNames([user]);
      editor.chain().focus().deleteRange(range).insertContent([{ type: 'mention', attrs: { id: user.id, label: user.name } }, { type: 'text', text: ' ' }]).run();
      range = null;
    },
  });

  function update() {
    const { state, view } = editor;
    const sel = state.selection;
    if (!editor.isEditable || !view.hasFocus() || !sel.empty || sel.$from.parent.type.spec.code || !session.can('write')) { list.close(); return; }
    const $from = sel.$from;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, null, '￼');
    const m = /(?:^|\s)@([^\s@]{0,24})$/u.exec(before);
    if (!m) { list.close(); return; }
    range = { from: $from.pos - m[1].length - 1, to: $from.pos };
    const c = view.coordsAtPos(range.from);
    list.show(m[1], { left: c.left, bottom: c.bottom });
  }

  editor.on('update', update);
  editor.on('selectionUpdate', update);
  editor.on('blur', () => setTimeout(list.close, 120));
  return { onKeyDown: (e) => list.onKeyDown(e), destroy: () => { editor.off('update', update); editor.off('selectionUpdate', update); list.destroy(); } };
}
