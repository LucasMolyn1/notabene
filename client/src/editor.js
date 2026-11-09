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
import { Column, Columns, ColoredHighlight, ContainerDelete, Details, DetailsContent, DetailsSummary, TextAlign, TextColor } from './editor/blocks.js';
import { CodeBlockEditor } from './editor/code-block.js';
import { ResizableImage } from './editor/image.js';
import { AudioBlock, FileBlock, uploadFiles, VideoBlock } from './editor/attachments.js';
import { CommentAnchor } from './editor/comment-anchor.js';
import { createBubbleMenu, createTableMenu } from './editor/menus.js';
import { BaseBlock } from './editor/base-block.js';
import { Embed } from './editor/embed.js';
import { createMentionMenu, Mention } from './editor/mention.js';
import { Callout, PageLink } from './editor/nodes.js';
import { createMobileToolbar } from './editor/mobile-toolbar.js';
import { createSlashMenu, insertImageFile } from './editor/slash.js';
import { SyncedCopy, SyncedGuard, SyncedSource } from './editor/synced.js';

function baseExtensions({ collab = false, shareToken = null } = {}) {
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
    ContainerDelete,
    Details,
    DetailsSummary,
    DetailsContent,
    Columns,
    Column,
    TaskList.extend({
      // Liste de cases : le texte des éléments cochés n'est pas barré (attribut d'affichage, enregistré dans la page).
      addAttributes() {
        return {
          ...this.parent?.(),
          checklist: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-checklist') === 'true',
            renderHTML: (attrs) => (attrs.checklist ? { 'data-checklist': 'true' } : {}),
          },
        };
      },
    }),
    TaskItem.configure({ nested: true }),
    ResizableImage.configure({ allowBase64: true, shareToken }),
    FileBlock.configure({ shareToken }),
    VideoBlock.configure({ shareToken }),
    AudioBlock.configure({ shareToken }),
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
    BaseBlock,
    Mermaid,
    MathBlock,
    PlantUml,
    Excalidraw,
    DrawIo,
    SyncedSource,
    SyncedCopy.configure({ shareToken, createViewer: (element, doc) => createViewer(element, doc, shareToken) }),
    SyncedGuard,
  ];
}

// Contenu d'une copie de bloc synchronisé : éditeur en lecture seule (rendu par le schéma, aucun HTML inséré tel quel).
// Renvoie null si le contenu ne respecte pas le schéma.
function createViewer(element, doc, shareToken) {
  const extensions = baseExtensions({ shareToken });
  let invalid = false;
  let viewer = null;
  try {
    viewer = new Editor({
      element, editable: false, extensions, content: doc,
      enableContentCheck: true, onContentError: () => { invalid = true; },
      // Lecture seule, sans rôle de champ : le texte est lu comme le reste de la page.
      editorProps: { attributes: { class: 'prose synced-prose', role: 'none' } },
    });
  } catch { invalid = true; }
  if (invalid) { viewer?.destroy(); return null; }
  return viewer;
}

const schemaExtensions = baseExtensions();

export function jsonToHTML(json) {
  if (!json || json.type !== 'doc') return '';
  try { return generateHTML(json, schemaExtensions); } catch { return ''; }
}

// ---- Fabrique -------------------------------------------------------------

// `collab` : { ydoc, provider, user } active la co-édition (le contenu vient alors de Yjs, pas de `content`).
// `context.pageId` : page qui reçoit les fichiers déposés ou collés ; `context.shareToken` : lecture par un lien public.
/** @param {{ element: HTMLElement, content?: object, editable?: boolean, onChange?: (editor: any) => void, context?: { navigate?: (path: string) => void, [key: string]: any }, collab?: any }} options */
export function createEditor({ element, content, editable = true, onChange, context = {}, collab = null }) {
  let slash = null;
  let mention = null;
  // Envois en cours : annulés si l'éditeur est détruit (changement de page), pour ne rien insérer ailleurs.
  const uploads = new Set();
  // Fichiers déposés ou collés : pièces jointes de la page ; sans page (cas improbable), seules les images restent possibles, en base64.
  const receive = (files, pos) => {
    if (!files.length || !editor.isEditable) return false;
    if (context.pageId) { uploadFiles(editor, files, { pageId: context.pageId, pos, signals: uploads }); return true; }
    const image = files.find((f) => f.type.startsWith('image/'));
    if (!image) return false;
    insertImageFile(editor, image, pos);
    return true;
  };
  const editor = new Editor({
    element,
    ...(collab ? {} : { content: content || '' }),
    editable,
    extensions: [
      ...baseExtensions({ collab: !!collab, shareToken: context.shareToken || null }),
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
      // Une mention collée depuis un autre site ne doit pas notifier : seule la copie d'une page BeNote (marqueur de
      // ProseMirror) garde ses mentions. Le serveur revérifie de toute façon l'accès de la personne avant d'envoyer.
      transformPastedHTML: (html) => {
        if (!/data-mention-id/i.test(html) || /data-pm-slice/i.test(html)) return html;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const el of doc.querySelectorAll('[data-mention-id]')) el.removeAttribute('data-mention-id');
        return doc.body.innerHTML;
      },
      handlePaste: (_view, event) => receive([...(event.clipboardData?.files || [])], null),
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : [...(event.dataTransfer?.files || [])];
        if (!files.length) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        if (!receive(files, pos ?? null)) return false;
        event.preventDefault();
        return true;
      },
    },
    onUpdate: () => onChange?.(editor),
  });

  slash = createSlashMenu(editor, { ...context, uploads });
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
    for (const ctrl of uploads) ctrl.abort();
    slash.destroy();
    mention.destroy();
    bubble.destroy();
    tableMenu.destroy();
    mobileToolbar.destroy();
    element.removeEventListener('click', onClick);
  });
  return editor;
}
