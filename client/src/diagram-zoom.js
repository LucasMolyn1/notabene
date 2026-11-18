// Loupe des schémas : le rendu déjà affiché est recopié en grand dans une fenêtre (zoom, déplacement, clavier, tactile).
// La copie est toujours une image (<img>, SVG en data URL) : un SVG affiché comme image n'exécute aucun script et ne
// charge aucune ressource. Aucun nouveau rendu n'est demandé (ni au serveur, ni à Mermaid).
import { h } from './util.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';

export function svgToDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Copie du rendu affiché dans `preview` (SVG en ligne de Mermaid, ou <img> des autres diagrammes) ; null s'il n'y a rien.
 * @param {HTMLElement} preview
 * @returns {{ src: string, width: number, height: number, opaque: boolean } | null}
 */
export function snapshot(preview) {
  const img = /** @type {HTMLImageElement | null} */ (preview.querySelector('img'));
  if (img && !img.hidden && img.getAttribute('src')) {
    const r = img.getBoundingClientRect();
    return { src: img.src, width: img.naturalWidth || r.width || 600, height: img.naturalHeight || r.height || 400, opaque: img.classList.contains('diagram-img') };
  }
  const svg = /** @type {SVGSVGElement | null} */ (preview.querySelector(':scope > svg'));
  if (!svg) return null;
  const box = svg.viewBox?.baseVal;
  const r = svg.getBoundingClientRect();
  const width = box?.width || r.width || 600;
  const height = box?.height || r.height || 400;
  const copy = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  copy.style.removeProperty('max-width');
  // Défense en profondeur (Mermaid assainit déjà en mode strict) : ni script, ni attribut d'évènement dans la copie.
  copy.querySelectorAll('script').forEach((s) => s.remove());
  for (const el of [copy, ...copy.querySelectorAll('*')]) for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  return { src: svgToDataUrl(new XMLSerializer().serializeToString(copy)), width, height, opaque: false };
}

const MAX = 12;
const STEP = 1.25;
const PAN = 48;

/**
 * Fenêtre de la loupe.
 * @param {{ src: string, width: number, height: number, opaque: boolean }} snap
 * @param {{ label?: string, returnFocus?: HTMLElement | null }} [options]
 */
export function openZoom(snap, { label = 'Schéma', returnFocus = null } = {}) {
  const w = snap.width;
  const ht = snap.height;
  const img = h('img', { class: `zoom-img${snap.opaque ? ' opaque' : ''}`, src: snap.src, alt: `${label} agrandi`, draggable: 'false' });
  const stage = h('div', {
    class: 'zoom-stage', tabindex: '0', role: 'region',
    'aria-label': `${label} agrandi. Flèches : déplacer ; plus et moins : zoomer ; zéro : taille initiale.`,
  }, img);
  const level = h('output', { class: 'zoom-level', 'aria-live': 'polite' });
  const btn = (ico, text, onClick, withText = false) => h('button', { class: `btn btn-ghost btn-sm${withText ? '' : ' zoom-icon-btn'}`, type: 'button', 'aria-label': withText ? null : text, title: text, onClick }, icon(ico, 16), withText ? text : null);

  let fit = 1;
  let z = 1;
  let x = 0;
  let y = 0;
  const min = () => Math.min(fit, 1) * 0.25;
  const paint = () => {
    img.style.width = `${w * z}px`;
    img.style.height = `${ht * z}px`;
    img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    level.textContent = `${Math.round((z / fit) * 100)} %`;
  };
  // Taille initiale : le schéma tient dans la fenêtre (agrandi s'il est petit, jusqu'à 4 fois), centré.
  const reset = () => {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    fit = Math.max(0.05, Math.min((sw - 32) / w, (sh - 32) / ht, 4));
    z = fit;
    x = (sw - w * z) / 2;
    y = (sh - ht * z) / 2;
    paint();
  };
  // Zoom autour d'un point de la zone (le point sous le curseur ou les doigts reste en place).
  const zoomTo = (next, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) => {
    const nz = Math.min(Math.max(next, min()), MAX);
    x = cx - ((cx - x) * nz) / z;
    y = cy - ((cy - y) * nz) / z;
    z = nz;
    paint();
  };
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  // Molette : avec Ctrl (ou le pincement d'un pavé tactile), zoom ; sans, déplacement.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomTo(z * Math.exp(-e.deltaY * 0.0025), ...local(e));
    else { x -= e.deltaX; y -= e.deltaY; paint(); }
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => zoomTo(z * STEP * STEP, ...local(e)));

  // Glisser (souris, stylet, un doigt) et pincer (deux doigts).
  const pointers = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    pointers.set(e.pointerId, local(e));
    stage.classList.add('dragging');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const at = local(e);
    pointers.set(e.pointerId, at);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      x += mid[0] - pinch.mid[0];
      y += mid[1] - pinch.mid[1];
      pinch.mid = mid;
      zoomTo(pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.dist), mid[0], mid[1]);
    } else if (pointers.size === 1) {
      x += at[0] - prev[0];
      y += at[1] - prev[1];
      paint();
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // Clavier : flèches (Maj : pas plus grand), + et - pour zoomer, 0 pour revenir à la taille initiale.
  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? PAN * 4 : PAN;
    if (e.key === 'ArrowLeft') x += step;
    else if (e.key === 'ArrowRight') x -= step;
    else if (e.key === 'ArrowUp') y += step;
    else if (e.key === 'ArrowDown') y -= step;
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(z * STEP); return; }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(z / STEP); return; }
    else if (e.key === '0') { e.preventDefault(); reset(); return; }
    else return;
    e.preventDefault();
    paint();
  });

  const modal = openModal({
    title: `${label} agrandi`,
    size: 'zoom-modal',
    body: h('div', { class: 'zoom-body' },
      h('div', { class: 'zoom-tools', role: 'toolbar', 'aria-label': 'Zoom' },
        btn('zoom-out', 'Zoom arrière', () => zoomTo(z / STEP)),
        level,
        btn('zoom-in', 'Zoom avant', () => zoomTo(z * STEP)),
        btn('restore', 'Réinitialiser', reset, true),
        h('span', { class: 'hint zoom-hint' }, 'Glisser pour déplacer, Ctrl et molette ou pincement pour zoomer.')),
      stage),
  });
  modal.el.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); });
  reset();
  // Image pas encore décodée : rien ne change de taille (les dimensions viennent de la copie), on recentre par précaution.
  requestAnimationFrame(reset);
  stage.focus();
  return modal;
}

/** Bouton « Agrandir » d'un schéma : ouvre la loupe sur ce qui est affiché dans `preview`. */
export function zoomButton(preview, label) {
  const b = h('button', { class: 'btn btn-ghost btn-sm diagram-zoom', type: 'button', 'aria-label': `Agrandir le schéma ${label}`, title: 'Agrandir' }, icon('search', 14), h('span', { class: 'diagram-zoom-text' }, 'Agrandir'));
  b.addEventListener('click', () => {
    const snap = snapshot(preview);
    if (snap) openZoom(snap, { label: `Schéma ${label}`, returnFocus: b });
  });
  return b;
}
