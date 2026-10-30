// Barre de mise en forme flottante et outils de tableau.
import { posToDOMRect } from '@tiptap/core';
import { h } from '../util.js';
import { icon } from '../icons.js';

// ---- Barre de mise en forme flottante ------------------------------------

export function createBubbleMenu(editor, ctx = {}) {
  const el = h('div', { class: 'bubble', hidden: true });
  document.body.append(el);
  let linkMode = false;

  const btn = (label, title, isActive, run, cls = '') => h('button', {
    class: `bubble-btn ${cls}${isActive() ? ' active' : ''}`,
    type: 'button',
    title,
    onMouseDown: (e) => { e.preventDefault(); run(); },
  }, label);

  const c = () => editor.chain().focus();
  function renderButtons() {
    el.replaceChildren(
      btn('B', 'Gras (⌘B)', () => editor.isActive('bold'), () => c().toggleBold().run(), 'b'),
      btn('I', 'Italique (⌘I)', () => editor.isActive('italic'), () => c().toggleItalic().run(), 'i'),
      btn('U', 'Souligné (⌘U)', () => editor.isActive('underline'), () => c().toggleUnderline().run(), 'u'),
      btn('S', 'Barré', () => editor.isActive('strike'), () => c().toggleStrike().run(), 's'),
      btn('</>', 'Code', () => editor.isActive('code'), () => c().toggleCode().run(), 'mono'),
      btn('✎', 'Surligner (⌘⇧H)', () => editor.isActive('highlight'), () => c().toggleHighlight().run(), 'hl'),
      h('span', { class: 'bubble-sep' }),
      btn('H1', 'Titre 1', () => editor.isActive('heading', { level: 1 }), () => c().toggleHeading({ level: 1 }).run(), 'small'),
      btn('H2', 'Titre 2', () => editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run(), 'small'),
      btn('❝', 'Citation', () => editor.isActive('blockquote'), () => c().toggleBlockquote().run()),
      h('span', { class: 'bubble-sep' }),
      btn('↗', 'Lien', () => editor.isActive('link'), () => { linkMode = true; renderLink(); }),
      ...(ctx.onComment ? [
        h('span', { class: 'bubble-sep' }),
        btn(icon('comment', 15), 'Commenter la sélection', () => false, () => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ').trim().slice(0, 200);
          if (text) ctx.onComment({ from, to, text });
        }),
      ] : []),
    );
  }

  function renderLink() {
    const input = h('input', {
      class: 'bubble-input',
      'aria-label': 'Adresse du lien',
      placeholder: 'Coller un lien…',
      value: editor.getAttributes('link').href || '',
    });
    const apply = () => {
      let href = input.value.trim();
      if (href && !/^(https?:|mailto:|#|\/)/i.test(href)) href = `https://${href}`;
      const ch = editor.chain().focus().extendMarkRange('link');
      (href ? ch.setLink({ href }) : ch.unsetLink()).run();
      linkMode = false;
      update();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); linkMode = false; editor.commands.focus(); update(); }
    });
    input.addEventListener('blur', (e) => {
      if (el.contains(e.relatedTarget)) return;
      linkMode = false;
      hide();
    });
    el.replaceChildren(
      input,
      h('button', { class: 'bubble-btn', type: 'button', title: 'Valider', onMouseDown: (e) => { e.preventDefault(); apply(); } }, '↵'),
      editor.isActive('link') && h('button', {
        class: 'bubble-btn', type: 'button', title: 'Retirer le lien',
        onMouseDown: (e) => { e.preventDefault(); input.value = ''; apply(); },
      }, icon('x', 14)),
    );
    position();
    input.focus();
    input.select();
  }

  const hide = () => { el.hidden = true; };

  function position() {
    const { from, to } = editor.state.selection;
    const rect = posToDOMRect(editor.view, from, to);
    el.hidden = false;
    const w = el.offsetWidth;
    let top = rect.top - el.offsetHeight - 8;
    if (top < 56) top = rect.bottom + 8;
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
  }

  function update() {
    if (linkMode) return;
    const { selection } = editor.state;
    const show = editor.isEditable && editor.view.hasFocus() && !selection.empty && !selection.node && !editor.isActive('codeBlock');
    if (!show) return hide();
    renderButtons();
    position();
  }

  editor.on('selectionUpdate', update);
  editor.on('transaction', () => { if (!el.hidden && !linkMode) update(); });
  editor.on('blur', ({ event }) => { if (!el.contains(event?.relatedTarget) && !linkMode) hide(); });
  const onScroll = () => { if (!el.hidden) position(); };
  document.addEventListener('scroll', onScroll, true);
  return { destroy: () => { el.remove(); document.removeEventListener('scroll', onScroll, true); } };
}

// ---- Outils de tableau ----------------------------------------------------

export function createTableMenu(editor) {
  const c = () => editor.chain().focus();
  const btn = (label, title, run, cls = '') => h('button', {
    class: `bubble-btn small ${cls}`, type: 'button', title,
    onMouseDown: (e) => { e.preventDefault(); run(); },
  }, label);
  const el = h('div', { class: 'bubble table-menu', hidden: true },
    btn('+ Ligne', 'Ajouter une ligne', () => c().addRowAfter().run()),
    btn('+ Colonne', 'Ajouter une colonne', () => c().addColumnAfter().run()),
    btn('− Ligne', 'Supprimer la ligne', () => c().deleteRow().run()),
    btn('− Colonne', 'Supprimer la colonne', () => c().deleteColumn().run()),
    btn('En-tête', 'Basculer la ligne d’en-tête', () => c().toggleHeaderRow().run()),
    h('span', { class: 'bubble-sep' }),
    btn('Supprimer', 'Supprimer le tableau', () => c().deleteTable().run(), 'danger'),
  );
  document.body.append(el);

  function update() {
    if (!editor.isEditable || !editor.view.hasFocus() || !editor.isActive('table')) { el.hidden = true; return; }
    const at = editor.view.domAtPos(editor.state.selection.from).node;
    const table = (at.nodeType === 3 ? at.parentElement : at)?.closest?.('table');
    if (!table) { el.hidden = true; return; }
    const r = table.getBoundingClientRect();
    el.hidden = false;
    el.style.left = `${Math.max(8, r.left)}px`;
    el.style.top = `${Math.max(60, r.top - el.offsetHeight - 8)}px`;
  }

  editor.on('selectionUpdate', update);
  editor.on('update', update);
  editor.on('focus', update);
  editor.on('blur', ({ event }) => { if (!el.contains(event?.relatedTarget)) el.hidden = true; });
  document.addEventListener('scroll', update, true);
  return { destroy: () => { el.remove(); document.removeEventListener('scroll', update, true); } };
}
