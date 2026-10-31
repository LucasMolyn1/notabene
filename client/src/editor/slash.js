// Menu « / » et insertion d'images.
import { h, norm, pickFile } from '../util.js';
import { icon } from '../icons.js';
import { session } from '../session.js';
import { openModal, toast } from '../ui.js';
import { pickBase } from './base-block.js';
import { allowedHosts, embedUrl } from './embed.js';
import { DEFAULT_MATH, DEFAULT_MERMAID, DEFAULT_PLANTUML, openDrawio, openExcalidraw } from '../diagrams.js';

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

export async function insertImageFile(editor, file, pos) {
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
  { group: 'Blocs', title: 'Bloc dépliable', desc: 'Un titre qui masque ou montre son contenu', glyph: '▸', keys: 'details toggle depliable accordeon', run: chainCmd((c) => c.setDetails()) },
  { group: 'Blocs', title: 'Deux colonnes', desc: 'Contenu côte à côte', glyph: '▥', keys: 'colonnes columns deux 2', run: chainCmd((c) => c.setColumns(2)) },
  { group: 'Blocs', title: 'Trois colonnes', desc: 'Contenu en trois colonnes', glyph: '▦', keys: 'colonnes columns trois 3', run: chainCmd((c) => c.setColumns(3)) },
  { group: 'Blocs', title: 'Séparateur', desc: 'Ligne horizontale', glyph: '—', keys: 'hr divider ligne', run: chainCmd((c) => c.setHorizontalRule()) },
  {
    group: 'Diagrammes', title: 'Mermaid', desc: 'Schéma décrit en texte (flux, séquence…)', ico: 'diamond', keys: 'mermaid diagramme flowchart sequence schema',
    run: chainCmd((c) => c.insertContent({ type: 'mermaid', attrs: { code: DEFAULT_MERMAID } })),
  },
  {
    group: 'Diagrammes', title: 'Formule', desc: 'Formule mathématique (LaTeX)', glyph: 'Σ', keys: 'formule math latex katex equation maths',
    run: chainCmd((c) => c.insertContent({ type: 'math', attrs: { code: DEFAULT_MATH } })),
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
    group: 'Médias', title: 'Intégrer une adresse', desc: 'Vidéo ou contenu d’un site autorisé par un administrateur', ico: 'globe', keys: 'embed integrer iframe video youtube vimeo url',
    when: () => allowedHosts().length > 0,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      askEmbedUrl((url) => editor.chain().focus().insertContent({ type: 'embed', attrs: { url } }).run());
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
    group: 'Bases', title: 'Base', desc: 'Afficher une base (tableau) dans la page', ico: 'table', keys: 'base tableau database table',
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      pickBase({ spaceId: ctx.spaceId }, ({ id, view }) => editor.chain().focus().insertContent({ type: 'baseBlock', attrs: { id, view } }).run());
    },
  },
  {
    group: 'Bases', title: 'Kanban', desc: 'Afficher une base en colonnes (cartes par statut)', ico: 'layers', keys: 'kanban cartes statut board',
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      pickBase({ kanban: true, spaceId: ctx.spaceId }, ({ id, view }) => editor.chain().focus().insertContent({ type: 'baseBlock', attrs: { id, view } }).run());
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

// Demande l'adresse à intégrer ; elle doit être en https et sur un hôte autorisé par un administrateur.
function askEmbedUrl(onOk) {
  const input = h('input', { class: 'input', type: 'url', 'aria-label': 'Adresse à intégrer', placeholder: 'https://…', maxlength: '2048' });
  const error = h('p', { class: 'notice warning', role: 'alert', hidden: true });
  const submit = () => {
    const url = embedUrl(input.value.trim());
    const host = url && new URL(url).hostname;
    if (!url || !allowedHosts().includes(host)) {
      error.hidden = false;
      error.textContent = `Adresse refusée : https obligatoire, sur un de ces hôtes : ${allowedHosts().join(', ')}.`;
      return false;
    }
    onOk(url);
    return undefined;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.closest('dialog')?.querySelector('.btn-primary')?.click(); } });
  openModal({
    title: 'Intégrer une adresse',
    body: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, 'Adresse (https)'), input), error,
      h('p', { class: 'muted' }, `Hôtes autorisés : ${allowedHosts().join(', ')}.`)),
    actions: [{ label: 'Annuler' }, { label: 'Intégrer', primary: true, onClick: submit }],
  });
  setTimeout(() => input.focus(), 30);
}

// Met à jour les attributs du nœud inséré à `pos`, s'il est toujours du bon type.
function updateNodeAt(editor, pos, type, attrs) {
  const resolved = [pos, pos - 1, pos + 1].find((p) => p >= 0 && editor.state.doc.nodeAt(p)?.type.name === type);
  if (resolved == null) return;
  const node = editor.state.doc.nodeAt(resolved);
  editor.view.dispatch(editor.state.tr.setNodeMarkup(resolved, undefined, { ...node.attrs, ...attrs }));
}

export function createSlashMenu(editor, ctx) {
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
