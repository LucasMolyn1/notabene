// Redimensionnement des blocs (images, diagrammes) : poignée au pointeur et au clavier, largeur en pixels dans l'attribut `width`.
import { h } from './util.js';

export const MIN_WIDTH = 120;
const STEP = 24;

/**
 * Pose une poignée sur `dom`. `getWidth` / `commit` lisent et enregistrent l'attribut du nœud.
 * @param {HTMLElement} dom bloc redimensionné (largeur appliquée en style)
 * @param {{ editor: any, label: string, commit: (width: number | null) => void }} options
 * @returns {{ apply: (width: number | null) => void }}
 */
export function makeResizable(dom, { editor, label, commit }) {
  dom.classList.add('resizable');
  const handle = h('button', {
    class: 'resize-handle', type: 'button', role: 'slider', contenteditable: 'false',
    'aria-label': `Largeur : ${label}`, 'aria-orientation': 'horizontal', 'aria-valuemin': String(MIN_WIDTH),
    title: 'Glisser pour redimensionner (double-clic : taille d’origine)',
  });
  dom.append(handle);

  const maxWidth = () => Math.max(MIN_WIDTH, Math.floor(dom.parentElement?.clientWidth || dom.offsetWidth));
  const clamp = (w) => Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)));
  const apply = (width) => {
    dom.style.width = width ? `${width}px` : '';
    handle.setAttribute('aria-valuenow', String(Math.round(dom.offsetWidth)));
    handle.hidden = !editor.isEditable;
  };

  handle.addEventListener('pointerdown', (e) => {
    if (!editor.isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = dom.offsetWidth;
    let next = startWidth;
    handle.setPointerCapture(e.pointerId);
    dom.classList.add('resizing');
    const move = (ev) => { next = clamp(startWidth + ev.clientX - startX); dom.style.width = `${next}px`; };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      dom.classList.remove('resizing');
      if (next !== startWidth) commit(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', (e) => { e.stopPropagation(); if (editor.isEditable) commit(null); });
  handle.addEventListener('keydown', (e) => {
    if (!editor.isEditable) return;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Home' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); commit(null); return; }
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    commit(clamp(dom.offsetWidth + dir * STEP));
  });

  return { apply };
}
