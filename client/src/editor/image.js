// Image redimensionnable à la poignée. Une image envoyée en pièce jointe porte l'adresse « /api/v3/attachments/<id> » ;
// les anciennes images en base64 (data:) s'affichent comme avant.
import Image from '@tiptap/extension-image';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { openModal } from '../ui.js';
import { makeResizable } from '../resize.js';
import { attachmentUrl, deleteAttachment, idFromSrc } from './attachments.js';

// Texte alternatif : lu par les lecteurs d'écran à la place de l'image (vide si elle est purement décorative).
function askAlt(current, onOk) {
  const input = h('input', { class: 'input', type: 'text', maxlength: '500' });
  input.value = current || '';
  openModal({
    title: 'Texte alternatif',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Description de l’image'), input),
      h('p', { class: 'muted' }, 'Décrivez ce que montre l’image. Laissez vide si elle est purement décorative.')),
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: () => { onOk(input.value.trim().slice(0, 500)); } }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.closest('dialog')?.querySelector('.btn-primary')?.click(); } });
  setTimeout(() => input.focus(), 30);
}

/** @type {import('@tiptap/core').Node<import('@tiptap/extension-image').ImageOptions & { shareToken: string | null }>} */
export const ResizableImage = Image.extend({
  addOptions() { return { ...this.parent?.(), shareToken: null }; },

  addNodeView() {
    const { shareToken } = this.options;
    return ({ node, getPos, editor }) => {
      let current = node;
      const img = h('img', { draggable: 'false' });
      const altBtn = h('button', { class: 'img-tool', type: 'button' }, 'Texte alternatif');
      const delBtn = h('button', { class: 'img-tool', type: 'button', 'aria-label': 'Supprimer le fichier de l’image' }, icon('trash', 14));
      const tools = h('span', { class: 'img-tools', contenteditable: 'false' }, altBtn, delBtn);
      const dom = h('figure', { class: 'img-block' }, img, tools);
      const pos = () => (typeof getPos === 'function' ? getPos() : null);
      const setAttrs = (attrs) => {
        const at = pos();
        if (at == null) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...current.attrs, ...attrs }));
      };
      altBtn.addEventListener('click', () => askAlt(current.attrs.alt, (alt) => setAttrs({ alt: alt || null })));
      delBtn.addEventListener('click', () => { const id = idFromSrc(current.attrs.src); if (id) deleteAttachment(editor, getPos, id, current.attrs.alt || 'image'); });
      img.addEventListener('error', () => dom.classList.add('broken'));
      img.addEventListener('load', () => dom.classList.remove('broken'));
      const paint = () => {
        const { src, alt, title } = current.attrs;
        // Pièce jointe : adresse reconstruite avec l'identifiant seul (lien public sur une page partagée).
        const id = idFromSrc(src);
        const url = id ? attachmentUrl(id, shareToken) : src;
        if (img.getAttribute('src') !== url) img.src = url;
        img.alt = alt || '';
        img.title = title || '';
        delBtn.hidden = !id;
      };
      const commit = (width) => setAttrs({ width, height: null });
      const resizer = makeResizable(dom, { editor, label: 'image', commit });
      const refresh = () => { resizer.apply(current.attrs.width); tools.hidden = !editor.isEditable; };
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
        stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('.resize-handle, .img-tools'),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => editor.off('update', refresh),
      };
    };
  },
});
