// Éditeur riche basé sur TipTap (ProseMirror) : assemblage des extensions et fabrique ; les nœuds et menus sont dans ./editor/.
import { Editor, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Typography from '@tiptap/extension-typography';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { DrawIo, Excalidraw, MathBlock, Mermaid, PlantUml } from './diagrams.js';
import { Column, Columns, ColoredHighlight, Details, DetailsContent, DetailsSummary, TextAlign, TextColor } from './editor/blocks.js';
import { CodeBlockEditor } from './editor/code-block.js';
import { ResizableImage } from './editor/image.js';
import { CommentAnchor } from './editor/comment-anchor.js';
import { createBubbleMenu, createTableMenu } from './editor/menus.js';
import { Embed } from './editor/embed.js';
import { createMentionMenu, Mention } from './editor/mention.js';
import { Callout, PageLink } from './editor/nodes.js';
import { createMobileToolbar } from './editor/mobile-toolbar.js';
import { createSlashMenu, insertImageFile } from './editor/slash.js';

function baseExtensions({ collab = false } = {}) {
  return [
    StarterKit.configure({
      ...(collab ? { undoRedo: false } : {}),
      heading: { levels: [1, 2, 3] },
      codeBlock: false, // remplacé par CodeBlockEditor (CodeMirror)
      dropcursor: { color: 'var(--accent)', width: 2 },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } },
    }),
    CodeBlockEditor,
    ColoredHighlight,
    TextColor,
    TextAlign,
    Details,
    DetailsSummary,
    DetailsContent,
    Columns,
    Column,
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
    Mention,
    CommentAnchor,
    Embed,
    Mermaid,
    MathBlock,
    PlantUml,
    Excalidraw,
    DrawIo,
  ];
}

// Image dont la largeur se règle à la poignée (attribut `width`, la hauteur suit).

const schemaExtensions = baseExtensions();

export function jsonToHTML(json) {
  if (!json || json.type !== 'doc') return '';
  try { return generateHTML(json, schemaExtensions); } catch { return ''; }
}

// ---- Fabrique -------------------------------------------------------------

// `collab` : { ydoc, provider, user } active la co-édition (le contenu vient alors de Yjs, pas de `content`).
/** @param {{ element: HTMLElement, content?: object, editable?: boolean, onChange?: (editor: any) => void, context?: { navigate?: (path: string) => void, [key: string]: any }, collab?: any }} options */
export function createEditor({ element, content, editable = true, onChange, context = {}, collab = null }) {
  let slash = null;
  let mention = null;
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
      handleKeyDown: (_view, event) => slash?.onKeyDown(event) || mention?.onKeyDown(event) || false,
      // Une mention collée depuis un autre site ne doit pas notifier : seule la copie d'une page Notabene (marqueur de
      // ProseMirror) garde ses mentions. Le serveur revérifie de toute façon l'accès de la personne avant d'envoyer.
      transformPastedHTML: (html) => {
        if (!/data-mention-id/i.test(html) || /data-pm-slice/i.test(html)) return html;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const el of doc.querySelectorAll('[data-mention-id]')) el.removeAttribute('data-mention-id');
        return doc.body.innerHTML;
      },
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
  mention = createMentionMenu(editor, () => context.pageId);
  const bubble = createBubbleMenu(editor, context);
  const tableMenu = createTableMenu(editor);
  const mobileToolbar = createMobileToolbar(editor, context);

  // Liens : navigation interne au clic, liens externes avec ⌘/Ctrl (ou en mode lecture).
  const onClick = (e) => {
    const a = e.target.closest('a[href]');
    const anchor = !a && e.target.closest('.comment-live, .comment-resolved'); // l'état est posé par décoration (voir comment-anchor.js)
    if (anchor) { context.onAnchorClick?.(anchor.getAttribute('data-comment-id')); return; }
    if (!a) return;
    const href = a.getAttribute('href');
    if (/^\/(?:p|s)\//.test(href)) {
      e.preventDefault();
      context.navigate ? context.navigate(href) : window.location.assign(href);
    } else if (!editor.isEditable || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      window.open(href, '_blank', 'noopener');
    }
  };
  element.addEventListener('click', onClick);

  editor.on('destroy', () => {
    slash.destroy();
    mention.destroy();
    bubble.destroy();
    tableMenu.destroy();
    mobileToolbar.destroy();
    element.removeEventListener('click', onClick);
  });
  return editor;
}
