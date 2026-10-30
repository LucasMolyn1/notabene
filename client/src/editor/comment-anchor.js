// Texte commenté : marque `commentAnchor` (identifiant du fil de commentaires) et son état d'affichage.
// L'état (fil ouvert, résolu, disparu) vient du serveur : il se pose par une décoration, jamais dans le document.
import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const anchorStates = new PluginKey('commentAnchorStates');

export const CommentAnchor = Mark.create({
  name: 'commentAnchor',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.id }),
      },
    };
  },

  parseHTML() { return [{ tag: 'span[data-comment-id]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-anchor' }), 0]; },

  addCommands() {
    return {
      /** Pose l'ancre du fil `id` sur la plage donnée. */
      setCommentAnchor: (id, from, to) => ({ tr, state, dispatch }) => {
        if (!dispatch) return true;
        tr.addMark(from, to, state.schema.marks.commentAnchor.create({ id }));
        return true;
      },
      /** Retire l'ancre du fil `id` partout où elle figure. */
      removeCommentAnchor: (id) => ({ tr, state, dispatch }) => {
        if (!dispatch) return true;
        const type = state.schema.marks.commentAnchor;
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          for (const m of node.marks) if (m.type === type && m.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, m);
        });
        return true;
      },
      /** États d'affichage : fils ouverts, fils résolus ; les autres ancres restent neutres. */
      setCommentStates: (live, resolved) => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(anchorStates, { live: new Set(live), resolved: new Set(resolved) });
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: anchorStates,
      state: {
        init: () => ({ live: new Set(), resolved: new Set() }),
        apply: (tr, value) => tr.getMeta(anchorStates) || value,
      },
      props: {
        decorations(state) {
          const states = anchorStates.getState(state);
          const decorations = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.marks) {
              if (m.type.name !== 'commentAnchor') continue;
              const cls = states.resolved.has(m.attrs.id) ? 'comment-resolved' : states.live.has(m.attrs.id) ? 'comment-live' : 'comment-gone';
              decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: cls, 'data-comment-id': m.attrs.id }));
            }
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
