// Bloc « workflow » de l'éditeur : schéma de processus dessiné dans la page (V1 : rien ne s'exécute).
// L'attribut `graph` est une chaîne JSON (format et plafonds : model.js, contrat avec server/src/lib/workflow.ts). Elle passe
// telle quelle par la co-édition ; la vue la relit de façon défensive à chaque mise à jour.
import { Node } from '@tiptap/core';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { frame, updateAttrs } from '../diagrams.js';
import { makeResizable } from '../resize.js';
import { openModal } from '../ui.js';
import { createCanvas } from './canvas.js';
import { DEFAULT_GRAPH, outline, parseGraph } from './model.js';
import { KINDS } from './kinds.js';

export const DEFAULT_HEIGHT = 360;
// Hauteur par défaut dans la page : 420 px si la fenêtre est assez haute (valeur côté client ; l'attribut serveur ne change pas).
const TALL_HEIGHT = 420;
const heightOf = (attrs) => (attrs.height && attrs.height !== DEFAULT_HEIGHT ? attrs.height : (typeof window !== 'undefined' && window.innerHeight >= 820 ? TALL_HEIGHT : DEFAULT_HEIGHT));
const LABEL = 'Workflow';

export const Workflow = Node.create({
  name: 'workflow',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return { graph: { default: DEFAULT_GRAPH }, width: { default: null }, height: { default: DEFAULT_HEIGHT } };
  },

  parseHTML() {
    return [{
      tag: 'div[data-workflow]',
      getAttrs: (el) => {
        const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
        return { graph: el.getAttribute('data-graph') || '', width: num(el.getAttribute('data-width')), height: num(el.getAttribute('data-height')) ?? DEFAULT_HEIGHT };
      },
    }];
  },

  renderHTML({ node }) {
    const attrs = { 'data-workflow': '', 'data-graph': node.attrs.graph || '', class: 'diagram-static' };
    if (node.attrs.width) attrs['data-width'] = String(node.attrs.width);
    if (node.attrs.height) attrs['data-height'] = String(node.attrs.height);
    return ['div', attrs, ['pre', {}, outline(parseGraph(node.attrs.graph)).join('\n')]];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      let lastRaw = node.attrs.graph;
      let full = null; // { canvas, modal } : vue plein écran modifiable, ouverte par « Agrandir »
      const canvases = [];
      // Une action terminée = une transaction (donc un cran d'historique) ; un déplacement n'en fait qu'une, au relâchement.
      // La page et la vue plein écran montrent le même graphe : l'autre vue est mise à jour après chaque action.
      const options = (self) => ({
        kinds: KINDS,
        label: LABEL,
        onChange: (graph, json) => {
          lastRaw = json;
          updateAttrs(editor, getPos, { graph: json });
          for (const c of canvases) if (c !== self()) c.setGraph(graph);
        },
        onUndo: () => editor.commands.undo(),
        onRedo: () => editor.commands.redo(),
      });
      const canvas = createCanvas({ ...options(() => canvas), graph: parseGraph(node.attrs.graph), editable: editor.isEditable });
      canvases.push(canvas);
      const zoomBtn = h('button', { class: 'btn btn-ghost btn-sm diagram-zoom', type: 'button', 'aria-label': `Agrandir le schéma ${LABEL}`, title: 'Agrandir (modifiable)' },
        icon('search', 14), h('span', { class: 'diagram-zoom-text' }, 'Agrandir'));
      // Vue plein écran : même graphe, mêmes droits, mêmes transactions ; Échap ferme, le focus revient au bouton.
      const openFull = () => {
        if (full) return;
        const big = createCanvas({ ...options(() => big), graph: canvas.getGraph(), editable: editor.isEditable });
        big.el.classList.add('wf-full');
        canvases.push(big);
        const modal = openModal({ title: `Schéma ${LABEL} agrandi`, size: 'wf-modal', body: big.el });
        full = { canvas: big, modal };
        modal.el.addEventListener('close', () => {
          canvases.splice(canvases.indexOf(big), 1);
          big.destroy();
          full = null;
          if (zoomBtn.isConnected) zoomBtn.focus();
        });
        // La fenêtre est affichée : le schéma est ajusté à l'écran à l'ouverture.
        requestAnimationFrame(() => big.fit());
        const first = big.el.querySelector('.wf-node') || big.el.querySelector('.wf-viewport');
        /** @type {HTMLElement | null} */ (first)?.focus({ preventScroll: true });
      };
      zoomBtn.addEventListener('click', openFull);
      const dom = frame(LABEL, canvas.el, [zoomBtn]);
      dom.classList.add('workflow-block');
      const resizer = makeResizable(dom, { editor, label: LABEL, commit: (width) => updateAttrs(editor, getPos, { width }) });

      const paint = () => {
        canvas.el.style.setProperty('--wf-h', `${heightOf(current.attrs)}px`);
        resizer.apply(current.attrs.width);
        for (const c of canvases) c.setEditable(editor.isEditable);
        zoomBtn.hidden = !canvas.getGraph().nodes.length;
      };
      paint();
      editor.on('update', paint);

      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          if (updated.attrs.graph !== lastRaw) {
            lastRaw = updated.attrs.graph;
            const next = parseGraph(updated.attrs.graph);
            for (const c of canvases) c.setGraph(next); // reporté si un déplacement est en cours
          }
          paint();
          return true;
        },
        stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('.wf, button'),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => { editor.off('update', paint); if (full) full.modal.close(); canvas.destroy(); },
      };
    };
  },
});
