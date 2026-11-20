// Bloc « workflow » de l'éditeur : schéma de processus dessiné dans la page (V1 : rien ne s'exécute).
// L'attribut `graph` est une chaîne JSON (format et plafonds : model.js, contrat avec server/src/lib/workflow.ts). Elle passe
// telle quelle par la co-édition ; la vue la relit de façon défensive à chaque mise à jour.
import { Node } from '@tiptap/core';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { frame, updateAttrs } from '../diagrams.js';
import { makeResizable } from '../resize.js';
import { openZoom, svgToDataUrl } from '../diagram-zoom.js';
import { createCanvas, toSvg } from './canvas.js';
import { DEFAULT_GRAPH, outline, parseGraph } from './model.js';
import { KINDS } from './kinds.js';

export const DEFAULT_HEIGHT = 360;
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
      const canvas = createCanvas({
        kinds: KINDS,
        graph: parseGraph(node.attrs.graph),
        editable: editor.isEditable,
        label: LABEL,
        // Une action terminée = une transaction (donc un cran d'historique) ; un déplacement n'en fait qu'une, au relâchement.
        onChange: (_graph, json) => { lastRaw = json; updateAttrs(editor, getPos, { graph: json }); },
        onUndo: () => editor.commands.undo(),
        onRedo: () => editor.commands.redo(),
      });
      const zoomBtn = h('button', { class: 'btn btn-ghost btn-sm diagram-zoom', type: 'button', 'aria-label': `Agrandir le schéma ${LABEL}`, title: 'Agrandir' },
        icon('search', 14), h('span', { class: 'diagram-zoom-text' }, 'Agrandir'));
      zoomBtn.addEventListener('click', () => {
        const out = toSvg(canvas.getGraph(), KINDS);
        if (out) openZoom({ src: svgToDataUrl(out.svg), width: out.width, height: out.height, opaque: true }, { label: `Schéma ${LABEL}`, returnFocus: zoomBtn });
      });
      const dom = frame(LABEL, canvas.el, [zoomBtn]);
      dom.classList.add('workflow-block');
      const resizer = makeResizable(dom, { editor, label: LABEL, commit: (width) => updateAttrs(editor, getPos, { width }) });

      const paint = () => {
        canvas.el.style.setProperty('--wf-h', `${current.attrs.height || DEFAULT_HEIGHT}px`);
        resizer.apply(current.attrs.width);
        canvas.setEditable(editor.isEditable);
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
            canvas.setGraph(parseGraph(updated.attrs.graph)); // reporté si un déplacement est en cours
          }
          paint();
          return true;
        },
        stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('.wf, button'),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => { editor.off('update', paint); canvas.destroy(); },
      };
    };
  },
});
