// Barre d'outils de l'éditeur pour écran tactile : sans clavier physique, ni raccourcis (⌘B) ni sélection précise pour la bulle de mise en forme.
// Elle se pose au-dessus du clavier virtuel (visualViewport) tant que l'éditeur a le focus.
import { h } from '../util.js';
import { openSelectionSheet } from './selection-sheet.js';

const touch = () => window.matchMedia('(pointer: coarse)').matches;

export function createMobileToolbar(editor, ctx = {}) {
  if (!touch()) return { destroy() {} };

  const c = () => editor.chain().focus();
  // Ajouter « / » ouvre le menu d'insertion (titres, tableaux, diagrammes…) ; une espace le précède si on est collé à un mot.
  const insertSlash = () => {
    const { $from } = editor.state.selection;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
    c().insertContent(before && !/\s/.test(before) ? ' /' : '/').run();
  };
  /** @type {[string, string, () => boolean, () => unknown, string?][]} */
  const tools = [
    ['+', 'Insérer un bloc', () => false, insertSlash, 'plus'],
    ['B', 'Gras', () => editor.isActive('bold'), () => c().toggleBold().run(), 'b'],
    ['I', 'Italique', () => editor.isActive('italic'), () => c().toggleItalic().run(), 'i'],
    ['H1', 'Titre 1', () => editor.isActive('heading', { level: 1 }), () => c().toggleHeading({ level: 1 }).run()],
    ['H2', 'Titre 2', () => editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run()],
    ['•', 'Liste à puces', () => editor.isActive('bulletList'), () => c().toggleBulletList().run()],
    ['1.', 'Liste numérotée', () => editor.isActive('orderedList'), () => c().toggleOrderedList().run()],
    ['☐', 'Liste de tâches', () => editor.isActive('taskList'), () => c().toggleTaskList().run()],
    ['❝', 'Citation', () => editor.isActive('blockquote'), () => c().toggleBlockquote().run()],
    ['</>', 'Code', () => editor.isActive('code'), () => c().toggleCode().run(), 'mono'],
    ['Aa', 'Texte sélectionné : couleur, alignement, commentaire, assistant', () => false, () => openSelectionSheet(editor, ctx), 'small'],
    ['↶', 'Annuler', () => false, () => c().undo().run()],
    ['↷', 'Rétablir', () => false, () => c().redo().run()],
  ];

  const buttons = tools.map(([label, name, active, run, cls = '']) => {
    const b = h('button', { class: `mtb-btn ${cls}`.trim(), type: 'button', 'aria-label': name, title: name });
    b.textContent = label;
    // Pas de perte de focus : le clavier virtuel reste ouvert.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { run(); paint(); });
    return { b, active };
  });
  const el = h('div', { class: 'mtb', role: 'toolbar', 'aria-label': 'Mise en forme', hidden: true }, buttons.map((x) => x.b));
  document.body.append(el);

  const paint = () => buttons.forEach(({ b, active }) => { const on = active(); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  // Le clavier virtuel réduit la zone visible : la barre suit son bord supérieur.
  const place = () => {
    const vv = window.visualViewport;
    el.style.transform = vv ? `translateY(${-(window.innerHeight - vv.height - vv.offsetTop)}px)` : '';
  };
  let hideTimer = 0;
  // Le mode lecture / édition peut changer après la création de l'éditeur : on regarde au moment du focus.
  const show = () => { if (!editor.isEditable) return; clearTimeout(hideTimer); el.hidden = false; document.body.classList.add('mtb-on'); place(); paint(); };
  const hide = () => { hideTimer = window.setTimeout(() => { el.hidden = true; document.body.classList.remove('mtb-on'); }, 150); };

  editor.on('focus', show);
  editor.on('blur', hide);
  editor.on('selectionUpdate', paint);
  editor.on('transaction', paint);
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);

  return {
    destroy() {
      clearTimeout(hideTimer);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      document.body.classList.remove('mtb-on');
      el.remove();
    },
  };
}
