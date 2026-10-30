// Diagrammes dans l'éditeur : Mermaid (texte), Excalidraw (dessin) et Draw.io (auto-hébergé).
// Les rendus Excalidraw / Draw.io sont stockés en SVG (data URL) et affichés dans une <img> :
// aucun script d'un diagramme ne peut s'exécuter dans la page.
import { Node } from '@tiptap/core';
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { currentTheme } from './prefs.js';
import { session } from './session.js';
import { toast } from './ui.js';

export const DEFAULT_MERMAID = 'flowchart LR\n  A[Idée] --> B{Validée ?}\n  B -->|oui| C[Documenter]\n  B -->|non| D[Archiver]';

function svgToDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

const updateAttrs = (editor, getPos, attrs) => {
  const pos = typeof getPos === 'function' ? getPos() : null;
  if (pos == null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (node) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
};

function frame(label, body, actions) {
  return h('div', { class: 'diagram', contenteditable: 'false' },
    h('div', { class: 'diagram-bar' }, h('span', { class: 'diagram-label' }, label), h('span', { class: 'diagram-actions' }, actions)),
    body);
}

// ---- Mermaid ----------------------------------------------------------------

let mermaidModule = null;
let renderSeq = 0;

async function renderMermaid(code, target) {
  mermaidModule ||= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidModule;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: currentTheme() === 'dark' ? 'dark' : 'default',
    fontFamily: 'Inter, system-ui, sans-serif',
  });
  const id = `mmd-${++renderSeq}`;
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    // eslint-disable-next-line no-unsanitized/property -- SVG assaini par Mermaid (securityLevel « strict »)
    target.innerHTML = svg;
    target.classList.remove('error');
  } catch (err) {
    target.textContent = `Syntaxe Mermaid invalide : ${String(err?.message || err).split('\n')[0]}`;
    target.classList.add('error');
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

// Nœud « diagramme décrit en texte » : le code est stocké dans l'attribut `code`, le rendu est local.
function textDiagramNode({ name, label, defaultCode, renderer: renderDiagram }) {
  const dataAttr = `data-${name}`;
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,

    addAttributes() {
      return { code: { default: defaultCode } };
    },

    parseHTML() {
      return [{ tag: `div[${dataAttr}]`, getAttrs: (el) => ({ code: el.textContent || '' }) }];
    },

    renderHTML({ node }) {
      return ['div', { [dataAttr]: '', class: 'diagram-static' }, ['pre', {}, node.attrs.code]];
    },

    addNodeView() {
      return ({ node, getPos, editor }) => {
        let current = node;
        const preview = h('div', { class: `diagram-preview ${name}-preview` });
        const textarea = h('textarea', { class: 'mermaid-code', spellcheck: 'false', 'aria-label': `Code ${label}` });
        textarea.value = node.attrs.code;
        const editBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' });
        const body = h('div', { class: 'mermaid-split' }, textarea, preview);
        const dom = frame(label, body, editBtn);

        const render = debounce(() => renderDiagram(textarea.value, preview), 250);
        const setEditing = (on) => {
          dom.classList.toggle('editing', on);
          editBtn.replaceChildren(icon(on ? 'check' : 'edit', 14), on ? 'Terminer' : 'Modifier');
          if (on) textarea.focus();
        };
        const paintEditable = () => { editBtn.hidden = !editor.isEditable; if (!editor.isEditable) setEditing(false); };

        editBtn.addEventListener('click', () => setEditing(!dom.classList.contains('editing')));
        preview.addEventListener('dblclick', () => editor.isEditable && setEditing(true));
        textarea.addEventListener('input', () => {
          render();
          commit();
        });
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); editor.commands.focus(); }
          if (e.key === 'Tab') { e.preventDefault(); textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end'); }
        });
        const commit = debounce(() => updateAttrs(editor, getPos, { code: textarea.value }), 400);

        editor.on('update', paintEditable);
        setEditing(false);
        paintEditable();
        renderDiagram(node.attrs.code, preview);

        return {
          dom,
          update(updated) {
            if (updated.type !== current.type) return false;
            const changed = updated.attrs.code !== current.attrs.code;
            current = updated;
            if (changed && document.activeElement !== textarea) {
              textarea.value = updated.attrs.code;
              renderDiagram(updated.attrs.code, preview);
            }
            return true;
          },
          stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('textarea, button'),
          ignoreMutation: () => true,
          selectNode: () => dom.classList.add('selected'),
          deselectNode: () => dom.classList.remove('selected'),
          destroy: () => { commit.flush(); editor.off('update', paintEditable); },
        };
      };
    },
  });
}

export const Mermaid = textDiagramNode({ name: 'mermaid', label: 'Mermaid', defaultCode: DEFAULT_MERMAID, renderer: renderMermaid });

// ---- PlantUML ---------------------------------------------------------------
// Moteur PlantUML (JS) et Graphviz (WASM) servis par notre serveur, chargés à la première utilisation.
// Le SVG produit est affiché dans une <img> (data URL) : aucun script ni lien ne peut s'exécuter.

export const DEFAULT_PLANTUML = '@startuml\nactor Utilisateur\nUtilisateur -> Notabene : Requête\nNotabene --> Utilisateur : Réponse\n@enduml';

let plantumlEngine = null;

function loadPlantuml() {
  plantumlEngine ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/plantuml/viz-global.js';
    // @ts-expect-error -- fichier servi tel quel depuis /plantuml (copié au build), absent des modules que TypeScript résout
    script.onload = () => import(/* @vite-ignore */ '/plantuml/plantuml.js').then(resolve, reject);
    script.onerror = () => reject(new Error('moteur PlantUML indisponible'));
    document.head.append(script);
  }).catch((err) => { plantumlEngine = null; throw err; });
  return plantumlEngine;
}

// Refuse l'inclusion de fichiers ou d'URL : un diagramme ne doit pas déclencher de requêtes.
const PLANTUML_FORBIDDEN = /^\s*!(include|includeurl|includesub|import|theme\b[^\n]*\bfrom\b)/im;

async function renderPlantuml(code, target) {
  if (PLANTUML_FORBIDDEN.test(code)) {
    target.textContent = 'Les directives !include et !import ne sont pas autorisées.';
    target.classList.add('error');
    return;
  }
  try {
    const engine = await loadPlantuml();
    const svg = await new Promise((resolve, reject) => {
      engine.renderToString(code.split('\n'), resolve, (msg) => reject(new Error(String(msg))), { dark: currentTheme() === 'dark' });
    });
    const img = h('img', { alt: 'Diagramme PlantUML', src: svgToDataUrl(svg) });
    target.replaceChildren(img);
    target.classList.remove('error');
  } catch (err) {
    target.textContent = `PlantUML : ${String(err?.message || err).split('\n')[0]}`;
    target.classList.add('error');
  }
}

export const PlantUml = textDiagramNode({ name: 'plantuml', label: 'PlantUML', defaultCode: DEFAULT_PLANTUML, renderer: renderPlantuml });

// ---- Vues d'image communes (Excalidraw, Draw.io) -------------------------

function imageDiagramView({ label, emptyText, open }) {
  return ({ node, getPos, editor }) => {
    let current = node;
    const img = h('img', { class: 'diagram-img', alt: label, draggable: 'false' });
    const empty = h('div', { class: 'diagram-empty' }, emptyText);
    const editBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('edit', 14), 'Modifier');
    const preview = h('div', { class: 'diagram-preview' }, img, empty);
    const dom = frame(label, preview, editBtn);

    const paint = () => {
      const svg = current.attrs.svg;
      img.hidden = !svg;
      empty.hidden = !!svg;
      if (svg && img.getAttribute('src') !== svg) img.src = svg;
      editBtn.hidden = !editor.isEditable;
    };
    const edit = () => {
      if (!editor.isEditable) return;
      open(current.attrs, (attrs) => updateAttrs(editor, getPos, attrs));
    };
    editBtn.addEventListener('click', edit);
    preview.addEventListener('dblclick', edit);
    editor.on('update', paint);
    paint();

    return {
      dom,
      update(updated) {
        if (updated.type !== current.type) return false;
        current = updated;
        paint();
        return true;
      },
      stopEvent: (e) => !!e.target.closest?.('button'),
      ignoreMutation: () => true,
      selectNode: () => dom.classList.add('selected'),
      deselectNode: () => dom.classList.remove('selected'),
      destroy: () => editor.off('update', paint),
    };
  };
}

/** @param {string} title @param {Node} body @param {{ onSave?: () => unknown, onCancel?: () => void, saveLabel?: string }} [options] */
function overlayShell(title, body, { onSave, onCancel, saveLabel = 'Enregistrer' } = {}) {
  const status = h('span', { class: 'overlay-status' });
  const overlay = h('div', { class: 'diagram-overlay', role: 'dialog', 'aria-label': title },
    h('div', { class: 'diagram-overlay-head' },
      h('strong', null, title),
      status,
      h('span', { class: 'spacer' }),
      onCancel && h('button', { class: 'btn btn-ghost btn-sm', onClick: onCancel }, 'Annuler'),
      onSave && h('button', { class: 'btn btn-primary btn-sm', onClick: onSave }, icon('check', 14), saveLabel)),
    body);
  document.body.append(overlay);
  document.body.classList.add('overlay-open');
  return {
    overlay,
    status,
    close() { overlay.remove(); document.body.classList.remove('overlay-open'); },
  };
}

// ---- Excalidraw (chargé à la demande) ------------------------------------

let excalidrawModules = null;
function loadExcalidraw() {
  // EXCALIDRAW_ASSET_PATH est défini dans public/theme.js (polices servies localement, CSP).
  excalidrawModules ||= Promise.all([
    import('react'),
    import('react-dom/client'),
    import('@excalidraw/excalidraw'),
    import('@excalidraw/excalidraw/index.css'),
  ]);
  return excalidrawModules;
}

export async function openExcalidraw(attrs, onSave) {
  const container = h('div', { class: 'excalidraw-host' });
  let api = null;
  let root = null;
  const shell = overlayShell('Dessin Excalidraw', container, {
    onCancel: () => { root?.unmount(); shell.close(); },
    onSave: async () => {
      if (!api) return;
      shell.status.textContent = 'Export…';
      const [, , ex] = await loadExcalidraw();
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      const svgEl = await ex.exportToSvg({ elements, appState: { ...appState, exportBackground: true, exportWithDarkMode: false }, files });
      onSave({
        scene: ex.serializeAsJSON(elements, appState, files, 'local'),
        svg: svgToDataUrl(new XMLSerializer().serializeToString(svgEl)),
      });
      root.unmount();
      shell.close();
    },
  });
  shell.status.textContent = 'Chargement…';
  try {
    const [React, ReactDOM, ex] = await loadExcalidraw();
    let initialData = null;
    try { initialData = attrs.scene ? JSON.parse(attrs.scene) : null; } catch { /* scène illisible */ }
    root = ReactDOM.createRoot(container);
    root.render(React.createElement(ex.Excalidraw, {
      initialData: { ...(initialData || {}), scrollToContent: true },
      excalidrawAPI: (instance) => { api = instance; },
      theme: currentTheme() === 'dark' ? 'dark' : 'light',
      langCode: 'fr-FR',
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } },
    }));
    shell.status.textContent = '';
  } catch (err) {
    console.error(err);
    shell.status.textContent = 'Impossible de charger Excalidraw';
  }
}

export const Excalidraw = Node.create({
  name: 'excalidraw',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { scene: { default: '' }, svg: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'figure[data-excalidraw]' }];
  },
  renderHTML({ node }) {
    return ['figure', { 'data-excalidraw': '', class: 'diagram-static' }, ['img', { src: node.attrs.svg || '', alt: 'Dessin Excalidraw' }]];
  },
  addNodeView() {
    return imageDiagramView({ label: 'Excalidraw', emptyText: 'Dessin vide : double-cliquez pour dessiner', open: openExcalidraw });
  },
});

// ---- Draw.io (instance auto-hébergée, protocole d'intégration JSON) -------

export function openDrawio(attrs, onSave) {
  const base = session.config.drawioUrl;
  if (!base) { toast('Draw.io n’est pas configuré sur ce serveur (DRAWIO_URL).', { kind: 'error' }); return; }
  const origin = new URL(base).origin;
  const params = new URLSearchParams({ embed: '1', proto: 'json', spin: '1', ui: currentTheme() === 'dark' ? 'dark' : 'kennedy', libraries: '1', saveAndExit: '1', noExitBtn: '0', lang: 'fr' });
  const iframe = h('iframe', { class: 'drawio-frame', src: `${base}/?${params}`, title: 'Éditeur Draw.io' });
  const shell = overlayShell('Diagramme Draw.io', iframe, { onCancel: () => close() });
  let xml = attrs.xml || '';
  let exitAfterExport = false;

  const post = (msg) => iframe.contentWindow?.postMessage(JSON.stringify(msg), origin);
  function onMessage(e) {
    if (e.origin !== origin || e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.event === 'init') post({ action: 'load', xml, autosave: 0, title: 'Diagramme' });
    else if (msg.event === 'save') {
      xml = String(msg.xml || '');
      exitAfterExport = !!msg.exit;
      post({ action: 'export', format: 'xmlsvg', xml, spinKey: 'saving' });
    } else if (msg.event === 'export') {
      if (typeof msg.data === 'string' && msg.data.startsWith('data:image/svg+xml;base64,')) onSave({ xml, svg: msg.data });
      if (exitAfterExport) close();
      else post({ action: 'status', message: 'Enregistré', modified: false });
    } else if (msg.event === 'exit') close();
  }
  function close() {
    window.removeEventListener('message', onMessage);
    shell.close();
  }
  window.addEventListener('message', onMessage);
}

export const DrawIo = Node.create({
  name: 'drawio',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { xml: { default: '' }, svg: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'figure[data-drawio]' }];
  },
  renderHTML({ node }) {
    return ['figure', { 'data-drawio': '', class: 'diagram-static' }, ['img', { src: node.attrs.svg || '', alt: 'Diagramme Draw.io' }]];
  },
  addNodeView() {
    return imageDiagramView({ label: 'Draw.io', emptyText: 'Diagramme vide : double-cliquez pour le dessiner', open: openDrawio });
  },
});
