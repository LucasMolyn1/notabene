// Éditeur riche basé sur TipTap (ProseMirror) : extensions, menu « / »,
// barre de mise en forme flottante, outils de tableau, callouts et liens de pages.
import { Editor, Node, mergeAttributes, generateHTML, posToDOMRect } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import Image from '@tiptap/extension-image';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { h, norm, pickFile } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { toast, pageIcon } from './ui.js';
import { makeResizable } from './resize.js';
import { DEFAULT_MERMAID, DEFAULT_PLANTUML, DrawIo, Excalidraw, Mermaid, PlantUml, openDrawio, openExcalidraw } from './diagrams.js';

// ---- Nœuds personnalisés -------------------------------------------------

const CALLOUTS = {
  info: { glyph: 'i', label: 'Info' },
  warning: { glyph: '!', label: 'Attention' },
  success: { glyph: '✓', label: 'Succès' },
  danger: { glyph: '✗', label: 'Danger' },
};
const CALLOUT_ORDER = Object.keys(CALLOUTS);

const Callout = Node.create({
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
const PageLink = Node.create({
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
        renderHTML: (attrs) => ({ 'data-page-link': attrs.id, href: `#/p/${attrs.id}` }),
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
      const dom = h('a', { class: 'page-link', href: `#/p/${node.attrs.id}`, contenteditable: 'false', 'data-page-link': node.attrs.id });
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

function baseExtensions({ collab = false } = {}) {
  return [
    StarterKit.configure({
      ...(collab ? { undoRedo: false } : {}),
      heading: { levels: [1, 2, 3] },
      codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
      dropcursor: { color: 'var(--accent)', width: 2 },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } },
    }),
    Highlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    ResizableImage.configure({ allowBase64: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Typography.configure({ openDoubleQuote: '« ', closeDoubleQuote: ' »' }),
    Callout,
    PageLink,
    Mermaid,
    PlantUml,
    Excalidraw,
    DrawIo,
  ];
}

// Image dont la largeur se règle à la poignée (attribut `width`, la hauteur suit).
const ResizableImage = Image.extend({
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

const schemaExtensions = baseExtensions();

export function jsonToHTML(json) {
  if (!json || json.type !== 'doc') return '';
  try { return generateHTML(json, schemaExtensions); } catch { return ''; }
}

// ---- Images ---------------------------------------------------------------

// Redimensionne et compresse : les images vivent dans localStorage, donc on reste léger.
async function imageToDataURL(file, maxSize = 1400) {
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  if (/gif|svg/.test(file.type)) return raw;
  const img = await new Promise((resolve, reject) => {
    const i = new window.Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = raw;
  });
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', 0.82);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.82);
}

async function insertImageFile(editor, file, pos) {
  if (!file?.type.startsWith('image/')) return;
  try {
    const src = await imageToDataURL(file);
    if (src.length > 2_500_000) { toast('Image trop lourde, même après compression.', { kind: 'error' }); return; }
    const node = { type: 'image', attrs: { src, alt: file.name } };
    if (pos == null) editor.chain().focus().insertContent(node).run();
    else editor.chain().focus().insertContentAt(pos, node).run();
  } catch {
    toast('Impossible de lire cette image.', { kind: 'error' });
  }
}

// ---- Menu « / » -----------------------------------------------------------

const chainCmd = (fn) => (editor, range) => fn(editor.chain().focus().deleteRange(range)).run();

const SLASH_ITEMS = [
  { group: 'Texte', title: 'Texte', desc: 'Paragraphe simple', glyph: 'T', keys: 'paragraphe text', run: chainCmd((c) => c.setParagraph()) },
  { group: 'Texte', title: 'Titre 1', desc: 'Grand titre de section', glyph: 'H1', keys: 'h1 heading', run: chainCmd((c) => c.setHeading({ level: 1 })) },
  { group: 'Texte', title: 'Titre 2', desc: 'Titre moyen', glyph: 'H2', keys: 'h2 heading', run: chainCmd((c) => c.setHeading({ level: 2 })) },
  { group: 'Texte', title: 'Titre 3', desc: 'Petit titre', glyph: 'H3', keys: 'h3 heading', run: chainCmd((c) => c.setHeading({ level: 3 })) },
  { group: 'Listes', title: 'Liste à puces', desc: 'Liste non ordonnée', glyph: '•', keys: 'bullet ul', run: chainCmd((c) => c.toggleBulletList()) },
  { group: 'Listes', title: 'Liste numérotée', desc: 'Liste ordonnée', glyph: '1.', keys: 'ordered ol', run: chainCmd((c) => c.toggleOrderedList()) },
  { group: 'Listes', title: 'Liste de tâches', desc: 'Cases à cocher', glyph: '☑', keys: 'todo checklist taches', run: chainCmd((c) => c.toggleTaskList()) },
  { group: 'Blocs', title: 'Citation', desc: 'Mettre une citation en avant', glyph: '❝', keys: 'quote blockquote', run: chainCmd((c) => c.toggleBlockquote()) },
  { group: 'Blocs', title: 'Bloc de code', desc: 'Code avec police à chasse fixe', glyph: '</>', keys: 'code pre', run: chainCmd((c) => c.toggleCodeBlock()) },
  { group: 'Blocs', title: 'Callout info', desc: 'Encadré d’information', glyph: 'i', keys: 'callout note info', run: chainCmd((c) => c.setCallout({ type: 'info' })) },
  { group: 'Blocs', title: 'Callout attention', desc: 'Encadré d’avertissement', glyph: '!', keys: 'callout warning avertissement', run: chainCmd((c) => c.setCallout({ type: 'warning' })) },
  { group: 'Blocs', title: 'Callout succès', desc: 'Encadré positif', glyph: '✓', keys: 'callout success tip astuce', run: chainCmd((c) => c.setCallout({ type: 'success' })) },
  { group: 'Blocs', title: 'Callout danger', desc: 'Encadré critique', glyph: '✗', keys: 'callout danger erreur', run: chainCmd((c) => c.setCallout({ type: 'danger' })) },
  { group: 'Blocs', title: 'Tableau', desc: 'Tableau 3 × 3 avec en-tête', glyph: '▦', keys: 'table grille', run: chainCmd((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
  { group: 'Blocs', title: 'Séparateur', desc: 'Ligne horizontale', glyph: '—', keys: 'hr divider ligne', run: chainCmd((c) => c.setHorizontalRule()) },
  {
    group: 'Diagrammes', title: 'Mermaid', desc: 'Schéma décrit en texte (flux, séquence…)', ico: 'diamond', keys: 'mermaid diagramme flowchart sequence schema',
    run: chainCmd((c) => c.insertContent({ type: 'mermaid', attrs: { code: DEFAULT_MERMAID } })),
  },
  {
    group: 'Diagrammes', title: 'PlantUML', desc: 'Diagrammes UML décrits en texte (classes, séquence…)', ico: 'code', keys: 'plantuml uml diagramme classe sequence',
    run: chainCmd((c) => c.insertContent({ type: 'plantuml', attrs: { code: DEFAULT_PLANTUML } })),
  },
  {
    group: 'Diagrammes', title: 'Excalidraw', desc: 'Dessin à main levée', ico: 'pencil', keys: 'excalidraw dessin croquis sketch whiteboard',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'excalidraw' }).run();
      const pos = editor.state.selection.from - 1;
      openExcalidraw({ scene: '', svg: '' }, (attrs) => updateNodeAt(editor, pos, 'excalidraw', attrs));
    },
  },
  {
    group: 'Diagrammes', title: 'Draw.io', desc: 'Diagramme d’architecture (instance auto-hébergée)', ico: 'hexagon', keys: 'drawio diagrams.net architecture uml',
    when: () => !!session.config.drawioUrl,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'drawio' }).run();
      const pos = editor.state.selection.from - 1;
      openDrawio({ xml: '', svg: '' }, (attrs) => updateNodeAt(editor, pos, 'drawio', attrs));
    },
  },
  {
    group: 'Médias', title: 'Image', desc: 'Importer depuis votre ordinateur', ico: 'upload', keys: 'image photo upload',
    run: async (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      const file = await pickFile('image/*');
      if (file) insertImageFile(editor, file);
    },
  },
  {
    group: 'Pages', title: 'Sous-page', desc: 'Créer une page enfant et y accéder', ico: 'file', keys: 'subpage page enfant nouvelle',
    run: async (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      const id = await ctx.createSubpage?.();
      if (!id) return;
      editor.chain().focus().insertContent([{ type: 'pageLink', attrs: { id } }, { type: 'text', text: ' ' }]).run();
      ctx.open?.(id);
    },
  },
  {
    group: 'Pages', title: 'Lien vers une page', desc: 'Mentionner une page existante', ico: 'link', keys: 'mention lien page link',
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      ctx.pickPage?.((page) => {
        editor.chain().focus().insertContent([{ type: 'pageLink', attrs: { id: page.id } }, { type: 'text', text: ' ' }]).run();
      });
    },
  },
];

// Met à jour les attributs du nœud inséré à `pos`, s'il est toujours du bon type.
function updateNodeAt(editor, pos, type, attrs) {
  const resolved = [pos, pos - 1, pos + 1].find((p) => p >= 0 && editor.state.doc.nodeAt(p)?.type.name === type);
  if (resolved == null) return;
  const node = editor.state.doc.nodeAt(resolved);
  editor.view.dispatch(editor.state.tr.setNodeMarkup(resolved, undefined, { ...node.attrs, ...attrs }));
}

function createSlashMenu(editor, ctx) {
  const el = h('div', { class: 'slash-menu', role: 'listbox', hidden: true });
  document.body.append(el);
  let open = false;
  let items = [];
  let active = 0;
  let range = null;
  let dismissedAt = null;

  const close = () => { if (open) { open = false; el.hidden = true; } };

  function filter(q) {
    const nq = norm(q);
    const available = SLASH_ITEMS.filter((it) => !it.when || it.when());
    if (!nq) return available;
    return available.filter((it) => norm(`${it.title} ${it.keys} ${it.group}`).includes(nq));
  }

  function render() {
    el.replaceChildren();
    let group = null;
    items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; el.append(h('div', { class: 'slash-group' }, group)); }
      el.append(h('button', {
        class: `slash-item${i === active ? ' active' : ''}`,
        type: 'button',
        onMouseDown: (e) => { e.preventDefault(); select(i); },
        onMouseMove: () => { if (active !== i) { active = i; render(); } },
      },
      h('span', { class: 'slash-glyph' }, it.ico ? icon(it.ico, 18) : it.glyph),
      h('span', { class: 'slash-text' }, h('strong', null, it.title), h('small', null, it.desc))));
    });
    el.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function position() {
    const c = editor.view.coordsAtPos(range.from);
    const mh = el.offsetHeight;
    const mw = el.offsetWidth;
    let top = c.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, c.top - mh - 6);
    el.style.top = `${top}px`;
    el.style.left = `${Math.min(c.left, window.innerWidth - mw - 8)}px`;
  }

  function update() {
    const { state, view } = editor;
    const sel = state.selection;
    if (!editor.isEditable || !view.hasFocus() || !sel.empty || sel.$from.parent.type.spec.code) return close();
    const $from = sel.$from;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, null, '￼');
    const m = /(?:^|\s)\/([^\s/]{0,24})$/.exec(before);
    if (!m) { dismissedAt = null; return close(); }
    const from = $from.pos - m[1].length - 1;
    if (dismissedAt === from) return close();
    const next = filter(m[1]);
    if (!next.length) return close();
    if (!open || range?.from !== from || items.length !== next.length) active = 0;
    range = { from, to: $from.pos };
    items = next;
    active = Math.min(active, items.length - 1);
    open = true;
    el.hidden = false;
    render();
    position();
  }

  function select(i) {
    const it = items[i];
    if (!it || !range) return;
    const r = range;
    close();
    it.run(editor, r, ctx);
  }

  function onKeyDown(e) {
    if (!open) return false;
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; render(); return true; }
    if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { select(active); return true; }
    if (e.key === 'Escape') { dismissedAt = range.from; close(); return true; }
    return false;
  }

  editor.on('transaction', update);
  editor.on('blur', close);
  return { onKeyDown, destroy: () => el.remove() };
}

// ---- Barre de mise en forme flottante ------------------------------------

function createBubbleMenu(editor) {
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

function createTableMenu(editor) {
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

// ---- Fabrique -------------------------------------------------------------

// `collab` : { ydoc, provider, user } active la co-édition (le contenu vient alors de Yjs, pas de `content`).
/** @param {{ element: HTMLElement, content?: object, editable?: boolean, onChange?: (editor: any) => void, context?: { navigate?: (path: string) => void, [key: string]: any }, collab?: any }} options */
export function createEditor({ element, content, editable = true, onChange, context = {}, collab = null }) {
  let slash = null;
  const editor = new Editor({
    element,
    ...(collab ? {} : { content: content || '' }),
    editable,
    extensions: [
      ...baseExtensions({ collab: !!collab }),
      ...(collab ? [
        Collaboration.configure({ document: collab.ydoc }),
        CollaborationCaret.configure({ provider: collab.provider, user: collab.user }),
      ] : []),
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading'
          ? `Titre ${node.attrs.level}`
          : 'Écrivez, ou tapez « / » pour insérer un bloc…'),
      }),
    ],
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Contenu de la page' },
      handleKeyDown: (_view, event) => slash?.onKeyDown(event) || false,
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
        if (!file) return false;
        insertImageFile(editor, file);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const file = !moved && [...(event.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
        if (!file) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImageFile(editor, file, pos);
        return true;
      },
    },
    onUpdate: () => onChange?.(editor),
  });

  slash = createSlashMenu(editor, context);
  const bubble = createBubbleMenu(editor);
  const tableMenu = createTableMenu(editor);

  // Liens : navigation interne au clic, liens externes avec ⌘/Ctrl (ou en mode lecture).
  const onClick = (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#/')) {
      e.preventDefault();
      context.navigate ? context.navigate(href.slice(1)) : (location.hash = href);
    } else if (!editor.isEditable || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      window.open(href, '_blank', 'noopener');
    }
  };
  element.addEventListener('click', onClick);

  editor.on('destroy', () => {
    slash.destroy();
    bubble.destroy();
    tableMenu.destroy();
    element.removeEventListener('click', onClick);
  });
  return editor;
}
