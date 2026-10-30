// Image redimensionnable à la poignée.
import Image from '@tiptap/extension-image';
import { h } from '../util.js';
import { makeResizable } from '../resize.js';

export const ResizableImage = Image.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const img = h('img', { draggable: 'false' });
      const dom = h('figure', { class: 'img-block' }, img);
      const paint = () => {
        const { src, alt, title } = current.attrs;
        if (img.getAttribute('src') !== src) img.src = src;
        img.alt = alt || '';
        img.title = title || '';
      };
      const commit = (width) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width, height: null }));
      };
      const resizer = makeResizable(dom, { editor, label: 'image', commit });
      const refresh = () => resizer.apply(current.attrs.width);
      paint();
      refresh();
      editor.on('update', refresh);
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          refresh();
          return true;
        },
        stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('.resize-handle'),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => editor.off('update', refresh),
      };
    };
  },
});
