// Canevas de schéma générique (nœuds HTML positionnés, liens en SVG), indépendant de TipTap : réutilisable pour d'autres
// registres de types (automatisations, V2). Aucun innerHTML : libellés par textContent, SVG par createElementNS.
//
// createCanvas({ kinds, graph, editable, constraints, onChange, onUndo, onRedo, renderNodeBody, portLabels, label })
// - kinds : registre { type: { label, in, out: [prises], shape, icon, defaultLabel } } ;
// - graph : graphe courant (voir model.js) ; setGraph() le remplace (mise à jour distante) ;
// - constraints : { canAdd(graph, kind), canConnect(graph, from, port, to) } renvoient un message d'erreur ou null ;
//   afterAdd(graph, node) et afterRemove(graph, removed, before) peuvent renvoyer le graphe corrigé (insertion dans une chaîne,
//   rangement) ; un type peut être figé (`movable: false`) ; edgeLabels: false retire la modification du libellé des liens ;
// - onChange(graph, json) : une action terminée (un déplacement = un seul appel, au relâchement) ;
// - onUndo / onRedo : Ctrl+Z et Ctrl+Maj+Z dans le canevas (l'historique appartient à l'appelant) ;
// - renderNodeBody(node, def, body) : remplace le contenu d'un nœud (par défaut : type et libellé) ;
// - panneau d'explication (clic ou Entrée sur un nœud) : contenu fourni par le registre (`describe`, `fields`, voir kinds.js) ;
//   onField(node, name, value) enregistre un paramètre (libellé et couleur par défaut), renderFields(node, def, host) le remplace
//   (configuration des automatisations). Un type peut interdire la modification du libellé (`labelEditable: false`).
import { h } from '../util.js';
import { icon } from '../icons.js';
import { fadeIn, slideIn } from '../motion.js';
import { createInspector } from './inspector.js';
import { KINDS, LIMITS, PORT_LABELS } from './kinds.js';
import * as M from './model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 160;
const NODE_H = 56;
const MIN_Z = 0.5;
const MAX_Z = 2;
const STEP_Z = 1.25;
// Taille de lecture : un libellé (13 px) ne descend jamais sous ~11 px à l'écran au zoom « ajusté » ; sinon le canevas défile.
const MIN_FIT_Z = 11 / 13;
const DRAG_PX = 4;
let seq = 0;

const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
};
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const short = (s, n = 40) => { const t = oneLine(s) || 'sans titre'; return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const clampZ = (z) => Math.min(MAX_Z, Math.max(MIN_Z, z));

/** Courbe de la sortie (a) vers l'entrée (b) : chemin SVG et milieu. */
function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return { d: `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

/**
 * @param {{ kinds?: any, graph?: any, editable?: boolean, constraints?: { canAdd?: (graph: any, kind: string) => string | null | undefined, canConnect?: (graph: any, from: string, port: string, to: string) => string | null | undefined,
 *     afterAdd?: (graph: any, node: any) => any, afterRemove?: (graph: any, removed: any, before: any) => any },
 *   onChange?: (graph: any, json: string) => void, onUndo?: () => void, onRedo?: () => void, renderNodeBody?: (node: any, def: any, body: HTMLElement) => void, portLabels?: Record<string, string>, label?: string, edgeLabels?: boolean,
 *   onField?: (node: any, name: string, value: string) => void, renderFields?: (node: any, def: any, host: HTMLElement) => void }} [options]
 */
export function createCanvas({
  kinds = KINDS, graph, editable = false, constraints = {}, onChange, onUndo, onRedo, renderNodeBody, portLabels = PORT_LABELS, label = 'Schéma', onField, renderFields, edgeLabels = true,
} = {}) {
  const uid = ++seq;
  let g = graph || M.emptyGraph();
  let canEdit = !!editable;
  const view = { x: 20, y: 20, z: 1 };
  let userView = false; // vue déplacée ou zoomée à la main : plus d'ajustement automatique
  let fitted = false;
  let selection = null; // { type: 'node' | 'edge', id }
  let drag = null;
  let editing = null;
  let deferred = null; // mise à jour distante reçue pendant un déplacement
  let showText = false;
  let lastTap = { id: null, at: 0 };
  let frame = 0;
  let menu = null;
  let statusTimer = 0;
  const pointers = new Map();
  let pinch = null;
  let panelOpen = false; // panneau d'explication ouvert (suit le nœud choisi)
  let frozen = null; // ancêtre déplaçable (bloc d'éditeur) dont le glisser natif est suspendu pendant un geste
  const nodeEls = new Map();
  const edgeEls = new Map();

  const portName = (p) => portLabels[p] ?? p;
  const nodeById = (id) => M.nodeById(g, id);
  const palette = Object.keys(kinds);

  // ---- Structure ----
  const markerId = `wf-arrow-${uid}`;
  const markerSel = `wf-arrow-sel-${uid}`;
  const marker = (id, cls) => {
    const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    return m;
  };
  const defs = svgEl('defs');
  defs.append(marker(markerId, 'wf-arrow'), marker(markerSel, 'wf-arrow wf-arrow-sel'));
  const edgeLayer = svgEl('g');
  const tempPath = svgEl('path', { class: 'wf-temp' });
  tempPath.style.display = 'none';
  const links = svgEl('svg', { class: 'wf-links', width: 1, height: 1, 'aria-hidden': 'true', focusable: 'false' });
  links.append(defs, edgeLayer, tempPath);

  const world = h('div', { class: 'wf-world' }, links);
  const empty = h('div', { class: 'wf-empty' }, 'Schéma vide');
  const viewport = h('div', { class: 'wf-viewport', tabindex: '-1' }, world, empty);
  const inspector = createInspector({
    kinds, portLabels, isEditable: () => canEdit, renderFields,
    onField: (id, name, value) => applyField(id, name, value),
    onGoto: (id) => gotoNode(id),
    onDelete: (id) => { select({ type: 'node', id }); deleteSelection(); },
    onClose: () => closePanel(true),
  });
  const main = h('div', { class: 'wf-main' }, viewport, inspector.el);
  const bar = h('div', { class: 'wf-bar', role: 'toolbar', 'aria-label': `Outils du schéma ${label}` });
  const textList = h('ol', { class: 'wf-text sr-only', 'aria-label': `Vue texte du schéma ${label}` });
  const status = h('div', { class: 'wf-status sr-only', role: 'status' });
  const el = h('div', { class: 'wf', role: 'group', 'aria-label': label }, bar, main, textList, status);

  // ---- Messages ----
  function say(message, isError = false) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.classList.toggle('sr-only', !isError);
    status.classList.toggle('wf-status-error', isError);
    if (isError) statusTimer = setTimeout(() => { status.classList.add('sr-only'); status.classList.remove('wf-status-error'); }, 5000);
  }

  // ---- Géométrie ----
  const at = (n) => (drag && drag.type === 'move' && drag.id === n.id ? { x: drag.x, y: drag.y } : n);
  const sizeOf = (id) => { const e = nodeEls.get(id); return { w: e?.offsetWidth || NODE_W, h: e?.offsetHeight || NODE_H }; };
  function outPos(n, port) {
    const p = at(n);
    const { w, h: hh } = sizeOf(n.id);
    const outs = kinds[n.kind].out;
    return { x: p.x + w, y: p.y + (hh * (outs.indexOf(port) + 1)) / (outs.length + 1) };
  }
  function inPos(n) {
    const p = at(n);
    return { x: p.x, y: p.y + sizeOf(n.id).h / 2 };
  }
  const toWorld = (cx, cy) => { const r = viewport.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }; };

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    const s = LIMITS.grid * view.z;
    viewport.style.backgroundSize = `${s}px ${s}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    const lv = bar.querySelector('.wf-level');
    if (lv) lv.textContent = `${Math.round(view.z * 100)} %`;
  }
  function zoomTo(next, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
    const nz = clampZ(next);
    view.x = cx - ((cx - view.x) * nz) / view.z;
    view.y = cy - ((cy - view.y) * nz) / view.z;
    view.z = nz;
    userView = true;
    applyView();
  }
  function bounds() {
    if (!g.nodes.length) return null;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of g.nodes) {
      const p = at(n);
      const s = sizeOf(n.id);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + s.w); y1 = Math.max(y1, p.y + s.h);
    }
    return { x0, y0, x1, y1 };
  }
  function fit() {
    const b = bounds();
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    userView = false;
    if (!vw || !vh) return;
    if (!b) { view.x = 20; view.y = 20; view.z = 1; applyView(); return; }
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    // Jamais sous la taille de lecture : si le schéma ne tient pas, il commence en haut à gauche et se fait défiler.
    view.z = Math.min(1.25, Math.max(MIN_FIT_Z, Math.min((vw - 48) / bw, (vh - 48) / bh)));
    view.x = bw * view.z <= vw ? (vw - bw * view.z) / 2 - b.x0 * view.z : 24 - b.x0 * view.z;
    view.y = bh * view.z <= vh ? (vh - bh * view.z) / 2 - b.y0 * view.z : 24 - b.y0 * view.z;
    fitted = true;
    applyView();
  }
  function reveal(id) {
    const n = nodeById(id);
    if (!n || !viewport.clientWidth) return;
    const p = at(n);
    const s = sizeOf(id);
    const m = 16;
    const left = p.x * view.z + view.x;
    const top = p.y * view.z + view.y;
    const right = left + s.w * view.z;
    const bottom = top + s.h * view.z;
    let moved = false;
    if (left < m) { view.x += m - left; moved = true; } else if (right > viewport.clientWidth - m) { view.x -= right - viewport.clientWidth + m; moved = true; }
    if (top < m) { view.y += m - top; moved = true; } else if (bottom > viewport.clientHeight - m) { view.y -= bottom - viewport.clientHeight + m; moved = true; }
    if (moved) { userView = true; applyView(); }
  }

  // ---- Rendu ----
  function defaultBody(n, def, body) {
    const kind = h('span', { class: 'wf-node-kind' }, icon(def.icon || 'file', 12), def.label);
    const text = h('span', { class: 'wf-node-label' });
    text.textContent = n.label || 'Sans titre';
    body.replaceChildren(kind, text);
  }

  function syncPorts(elN, n, def) {
    const key = `${canEdit}|${def.out.join(',')}`;
    if (elN.dataset.ports === key) return;
    elN.dataset.ports = key;
    for (const p of elN.querySelectorAll('.wf-port, .wf-in')) p.remove();
    if (def.in) elN.append(h('span', { class: 'wf-in', 'aria-hidden': 'true' }));
    if (!canEdit) return;
    def.out.forEach((port, i) => {
      const multi = def.out.length > 1;
      const b = h('button', {
        class: `wf-port${multi ? ' wf-port-label' : ''}`, type: 'button', tabindex: '-1', 'data-port': port,
        'aria-label': multi ? `Relier la sortie ${portName(port)}` : 'Relier à…', title: `Glisser vers un nœud pour relier (${portName(port)})`,
      });
      if (multi) b.textContent = portName(port);
      b.style.top = `${((i + 1) / (def.out.length + 1)) * 100}%`;
      b.addEventListener('click', (e) => { if (e.detail === 0) openLinkMenu(elN.dataset.id, b, port); });
      elN.append(b);
    });
  }

  function renderNodes() {
    const seen = new Set();
    for (const n of g.nodes) {
      const def = kinds[n.kind];
      seen.add(n.id);
      let elN = nodeEls.get(n.id);
      if (!elN) {
        elN = h('div', { class: 'wf-node', tabindex: '0', role: 'group', 'data-id': n.id }, h('div', { class: 'wf-node-body' }));
        nodeEls.set(n.id, elN);
        world.append(elN);
        if (typeof ResizeObserver !== 'undefined') resizeObs?.observe(elN);
      }
      elN.className = `wf-node wf-kind-${n.kind} wf-shape-${def.shape}${n.color ? ` wf-color-${n.color}` : ''}${editing?.id === n.id ? ' editing' : ''}`;
      const p = at(n);
      elN.style.left = `${p.x}px`;
      elN.style.top = `${p.y}px`;
      elN.setAttribute('aria-label', `${def.label} : ${short(n.label, 80)}`);
      if (editing?.id !== n.id) (renderNodeBody || defaultBody)(n, def, elN.querySelector('.wf-node-body'));
      syncPorts(elN, n, def);
    }
    for (const [id, e] of nodeEls) if (!seen.has(id)) { resizeObs?.unobserve(e); e.remove(); nodeEls.delete(id); }
    // Ordre dans le DOM = ordre de lecture (Tab parcourt les nœuds de gauche à droite, puis de haut en bas).
    const order = M.readingOrder(g).map((n) => nodeEls.get(n.id));
    const current = [...world.querySelectorAll(':scope > .wf-node')];
    if (order.some((e, i) => e !== current[i])) {
      const active = document.activeElement;
      for (const e of order) world.append(e);
      if (active && active !== document.activeElement && world.contains(active)) /** @type {HTMLElement} */ (active).focus({ preventScroll: true });
    }
  }

  function edgeText(e) {
    const n = nodeById(e.from);
    const multi = n && kinds[n.kind].out.length > 1;
    return e.label ?? (multi ? portName(e.port) : '');
  }

  function renderEdges() {
    const seen = new Set();
    for (const e of g.edges) {
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) continue;
      seen.add(e.id);
      let rec = edgeEls.get(e.id);
      if (!rec) {
        const hit = svgEl('path', { class: 'wf-edge-hit' });
        const line = svgEl('path', { class: 'wf-edge-line' });
        const gEl = svgEl('g', { class: 'wf-edge', 'data-id': e.id });
        gEl.append(hit, line);
        edgeLayer.append(gEl);
        const chip = h('div', { class: 'wf-chip', 'data-id': e.id });
        chip.addEventListener('click', () => { select({ type: 'edge', id: e.id }); });
        chip.addEventListener('dblclick', () => editEdge(e.id));
        chip.addEventListener('focus', () => select({ type: 'edge', id: e.id }));
        world.append(chip);
        rec = { g: gEl, hit, line, chip };
        edgeEls.set(e.id, rec);
      }
      const c = curve(outPos(a, e.port), inPos(b));
      rec.hit.setAttribute('d', c.d);
      rec.line.setAttribute('d', c.d);
      rec.chip.style.left = `${c.mx}px`;
      rec.chip.style.top = `${c.my}px`;
      if (editing?.id !== e.id) {
        const text = edgeText(e);
        rec.chip.textContent = text;
        rec.chip.classList.toggle('wf-chip-dot', !text);
        rec.chip.hidden = !text && !canEdit;
        if (canEdit) {
          rec.chip.setAttribute('role', 'button');
          rec.chip.tabIndex = 0;
          rec.chip.removeAttribute('aria-hidden');
          rec.chip.setAttribute('aria-label', `Lien de « ${short(a.label, 30)} » vers « ${short(b.label, 30)} »${text ? ` : ${text}` : ''}. ${edgeLabels ? 'Entrée : modifier le libellé. ' : ''}Suppr : supprimer.`);
        } else {
          rec.chip.removeAttribute('role');
          rec.chip.removeAttribute('tabindex');
          rec.chip.removeAttribute('aria-label');
          rec.chip.setAttribute('aria-hidden', 'true');
        }
      }
    }
    for (const [id, rec] of edgeEls) if (!seen.has(id)) { rec.g.remove(); rec.chip.remove(); edgeEls.delete(id); }
  }

  function renderText() {
    textList.replaceChildren(...M.outline(g, kinds, portLabels).map((line) => { const li = h('li'); li.textContent = line; return li; }));
  }

  function applySelection() {
    for (const [id, e] of nodeEls) e.classList.toggle('selected', selection?.type === 'node' && selection.id === id);
    for (const [id, rec] of edgeEls) {
      const on = selection?.type === 'edge' && selection.id === id;
      rec.g.classList.toggle('selected', on);
      rec.chip.classList.toggle('selected', on);
      rec.line.setAttribute('marker-end', `url(#${on ? markerSel : markerId})`);
    }
  }

  function render() {
    if (selection && !(selection.type === 'node' ? nodeById(selection.id) : g.edges.some((e) => e.id === selection.id))) { selection = null; panelOpen = false; }
    renderNodes();
    renderEdges();
    renderText();
    applySelection();
    empty.hidden = g.nodes.length > 0;
    updateBar();
    syncPanel();
  }

  function redraw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag?.type === 'move') return;
      renderEdges();
      applySelection();
      if (!userView && (!canEdit || !fitted) && g.nodes.length) fit();
    });
  }
  const resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redraw) : null;
  resizeObs?.observe(viewport);

  // ---- Barre d'outils ----
  const tools = {};
  /** @param {{ title?: string, pressed?: boolean }} [opts] */
  function tool(ico, text, aria, onClick, opts = {}) {
    const { title = aria, pressed } = opts;
    const b = h('button', { class: 'btn btn-ghost btn-sm wf-tool', type: 'button', 'aria-label': aria, title, onClick }, icon(ico, 14), text ? h('span', { class: 'wf-tool-text' }, text) : null);
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    return b;
  }
  const sep = () => h('span', { class: 'wf-sep', role: 'separator', 'aria-hidden': 'true' });

  function buildBar() {
    bar.replaceChildren();
    viewport.classList.toggle('readonly', !canEdit);
    if (canEdit) {
      for (const kind of palette) {
        const def = kinds[kind];
        const b = tool(def.icon || 'plus', def.label, `Ajouter ${def.label}`, () => addAtCenter(kind), { title: `Ajouter un nœud « ${def.label} »` });
        b.dataset.kind = kind;
        bar.append(b);
      }
      tools.link = tool('link', 'Relier à…', 'Relier à…', () => selection?.type === 'node' && openLinkMenu(selection.id, tools.link), { title: 'Relier le nœud choisi à un autre (ou touche L)' });
      tools.del = tool('trash', 'Supprimer', 'Supprimer la sélection', deleteSelection, { title: 'Supprimer le nœud ou le lien choisi (Suppr)' });
      tools.layout = tool('layers', 'Ranger', 'Ranger automatiquement', autoLayout, { title: 'Ranger les nœuds de gauche à droite' });
      bar.append(sep(), tools.link, tools.del, tools.layout, sep());
    }
    tools.fit = tool('restore', 'Ajuster', 'Ajuster à l’écran', fit, { title: 'Ajuster le schéma à l’écran' });
    tools.out = tool('zoom-out', null, 'Zoom arrière', () => zoomTo(view.z / STEP_Z));
    tools.in = tool('zoom-in', null, 'Zoom avant', () => zoomTo(view.z * STEP_Z));
    tools.text = tool('file', 'Vue texte', 'Vue texte', toggleText, { pressed: showText, title: 'Afficher le plan du schéma en texte' });
    bar.append(tools.fit, tools.out, h('output', { class: 'wf-level', 'aria-label': 'Niveau de zoom' }), tools.in, sep(), tools.text);
    updateBar();
    applyView();
  }

  // Une seule butée de tabulation dans la barre ; flèches, Début et Fin pour parcourir les boutons.
  const items = () => [...bar.querySelectorAll('button:not(:disabled)')];
  function syncRoving(active) {
    const list = items();
    const cur = list.includes(active) ? active : list.includes(bar._cur) ? bar._cur : list[0];
    for (const b of bar.querySelectorAll('button')) b.tabIndex = b === cur ? 0 : -1;
    bar._cur = cur;
  }
  bar.addEventListener('focusin', (e) => { if (e.target.matches?.('button')) syncRoving(e.target); });
  bar.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? list[(i + 1) % list.length] : e.key === 'ArrowLeft' ? list[(i - 1 + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list[list.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  });

  function updateBar() {
    if (canEdit) {
      for (const b of bar.querySelectorAll('[data-kind]')) b.disabled = g.nodes.length >= LIMITS.nodes;
      const n = selection?.type === 'node' ? nodeById(selection.id) : null;
      tools.link.disabled = !n || !(kinds[n.kind].out.length);
      tools.del.disabled = !selection;
      tools.layout.disabled = g.nodes.length < 2;
    }
    tools.fit.disabled = !g.nodes.length;
    tools.out.disabled = view.z <= MIN_Z;
    tools.in.disabled = view.z >= MAX_Z;
    syncRoving(document.activeElement);
    applyView();
  }

  function toggleText() {
    showText = !showText;
    textList.classList.toggle('sr-only', !showText);
    tools.text.setAttribute('aria-pressed', String(showText));
  }

  // ---- Modifications ----
  function commit(next, message) {
    const json = M.serializeGraph(next);
    if (json === null) { say('Schéma trop volumineux : modification refusée.', true); render(); return false; }
    g = next;
    render();
    if (message) say(message);
    onChange?.(next, json);
    return true;
  }

  function select(sel) {
    if (selection?.type === sel?.type && selection?.id === sel?.id) return;
    selection = sel;
    applySelection();
    updateBar();
    if (!sel) panelOpen = false;
    syncPanel();
  }

  // ---- Panneau d'explication ----
  function syncPanel() {
    const n = panelOpen && selection?.type === 'node' ? nodeById(selection.id) : null;
    if (!n) { inspector.hide(); return; }
    if (inspector.show(n, g)) (el.classList.contains('wf-full') ? slideIn : fadeIn)(inspector.el, el.classList.contains('wf-full') ? { x: 16 } : { y: 6 });
  }
  /** Ouvre le panneau sur un nœud (clic, Entrée) ; `focus` y place le focus (clavier). */
  function openPanel(id, focus = false) {
    if (!nodeById(id)) return;
    panelOpen = true;
    if (selection?.type === 'node' && selection.id === id) syncPanel(); else select({ type: 'node', id });
    if (focus) inspector.focusFirst();
  }
  function closePanel(refocus = false) {
    const id = inspector.nodeId;
    panelOpen = false;
    syncPanel();
    if (refocus) (id && nodeEls.get(id) ? nodeEls.get(id) : viewport).focus({ preventScroll: true });
  }
  function gotoNode(id) {
    if (!nodeById(id)) return;
    select({ type: 'node', id });
    reveal(id);
    nodeEls.get(id)?.focus({ preventScroll: true });
  }
  /** Enregistre un paramètre du nœud (libellé, couleur par nom, ou champ propre au registre via onField). */
  function applyField(id, name, value) {
    if (!canEdit) return;
    const n = nodeById(id);
    if (!n) return;
    if (onField) { onField(n, name, value); return; }
    if (name === 'label') {
      const label = M.cleanLabel(value).trim();
      if (!label) { say('Le libellé ne peut pas être vide.', true); syncPanel(); return; }
      if (label !== n.label) commit(M.setNodeLabel(g, id, label), `Libellé modifié : ${short(label, 30)}.`);
    } else if (name === 'color') {
      const color = value || null;
      if (color !== (n.color ?? null)) commit(M.setNodeColor(g, id, color), color ? 'Couleur modifiée.' : 'Couleur retirée.');
    }
  }

  function addAtCenter(kind) {
    const err = constraints.canAdd?.(g, kind);
    if (err) { say(err, true); return; }
    const c = viewport.clientWidth ? toWorld(viewport.getBoundingClientRect().left + viewport.clientWidth / 2, viewport.getBoundingClientRect().top + viewport.clientHeight / 2) : { x: 120, y: 120 };
    let x = M.snap(c.x - NODE_W / 2);
    let y = M.snap(c.y - NODE_H / 2);
    for (let i = 0; i < 50 && g.nodes.some((n) => n.x === x && n.y === y); i++) { x += LIMITS.grid; y += LIMITS.grid; }
    const r = M.addNode(g, kinds, kind, x, y);
    if (r.error) { say(r.error, true); return; }
    const graphAfter = constraints.afterAdd?.(r.graph, r.node) ?? r.graph;
    if (commit(graphAfter, `${kinds[kind].label} ajouté.`)) {
      select({ type: 'node', id: r.node.id });
      nodeEls.get(r.node.id)?.focus({ preventScroll: true });
      reveal(r.node.id);
    }
  }

  function connectTo(from, port, to) {
    const err = M.connectError(g, kinds, from, port, to) || constraints.canConnect?.(g, from, port, to);
    if (err) { say(err, true); return false; }
    const r = M.connect(g, kinds, from, port, to);
    return commit(r.graph, `Lien créé de « ${short(nodeById(from).label, 30)} » vers « ${short(nodeById(to).label, 30)} ».`);
  }

  function deleteSelection() {
    if (!canEdit || !selection) return;
    if (selection.type === 'node') {
      const order = M.readingOrder(g);
      const i = order.findIndex((n) => n.id === selection.id);
      const nextId = (order[i + 1] || order[i - 1])?.id;
      const n = nodeById(selection.id);
      const removed = M.removeNode(g, selection.id);
      if (commit(constraints.afterRemove?.(removed, n, g) ?? removed, `« ${short(n.label, 30)} » supprimé.`)) {
        selection = null;
        const target = nextId && nodeEls.get(nextId);
        (target || viewport).focus({ preventScroll: true });
        updateBar();
      }
    } else if (commit(M.removeEdge(g, selection.id), 'Lien supprimé.')) {
      selection = null;
      viewport.focus({ preventScroll: true });
      updateBar();
    }
  }

  function autoLayout() {
    if (!canEdit) return;
    if (commit(M.autoLayout(g, kinds), 'Schéma rangé.')) fit();
  }

  function moveBy(id, dx, dy) {
    const n = nodeById(id);
    if (!n) return;
    const x = Math.min(LIMITS.coord, Math.max(-LIMITS.coord, n.x + dx));
    const y = Math.min(LIMITS.coord, Math.max(-LIMITS.coord, n.y + dy));
    if (x === n.x && y === n.y) return;
    commit(M.moveNode(g, id, x, y), `Déplacé en ${x}, ${y}.`);
    reveal(id);
  }

  // ---- Édition d'un libellé en place ----
  function startEdit(type, id) {
    if (!canEdit) return;
    if (type === 'node' && nodeById(id) && kinds[nodeById(id).kind].labelEditable === false) return;
    if (type === 'edge' && !edgeLabels) return;
    finishEdit(true);
    const isNode = type === 'node';
    const host = isNode ? nodeEls.get(id) : edgeEls.get(id)?.chip;
    const data = isNode ? nodeById(id) : g.edges.find((e) => e.id === id);
    if (!host || !data) return;
    const field = isNode
      ? h('textarea', { class: 'wf-edit', rows: '3', maxlength: String(LIMITS.nodeLabel), spellcheck: 'false', 'aria-label': `Libellé : ${kinds[data.kind].label}` })
      : h('input', { class: 'wf-edit', type: 'text', maxlength: String(LIMITS.edgeLabel), spellcheck: 'false', 'aria-label': 'Libellé du lien' });
    field.value = isNode ? data.label : (data.label ?? portName(data.port));
    editing = { type, id, field, host, done: false };
    host.classList.add('editing');
    if (isNode) host.append(field); else host.replaceChildren(field);
    field.focus();
    field.select();
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !(isNode && e.shiftKey)) { e.preventDefault(); finishEdit(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false, true); }
    });
    if (isNode) field.addEventListener('input', () => { const c = M.cleanLabel(field.value); if (c !== field.value) field.value = c; });
    field.addEventListener('blur', () => finishEdit(true));
  }
  const editNode = (id) => startEdit('node', id);
  const editEdge = (id) => startEdit('edge', id);

  function finishEdit(save, refocus = false) {
    if (!editing || editing.done) return;
    const { type, id, field, host } = editing;
    editing.done = true;
    const value = field.value;
    editing = null;
    host.classList.remove('editing');
    field.remove();
    if (deferred && !save) { const d = deferred; deferred = null; g = d; }
    if (save) {
      if (type === 'node') {
        const label = M.cleanLabel(value).trim();
        const n = nodeById(id);
        if (label && n && label !== n.label) commit(M.setNodeLabel(g, id, label), `Libellé modifié : ${short(label, 30)}.`);
      } else {
        const e = g.edges.find((x) => x.id === id);
        const def = e && edgeText({ ...e, label: null });
        const text = M.cleanLabel(value, LIMITS.edgeLabel, false).trim();
        const next = text === def ? null : text || null;
        if (e && next !== e.label) commit(M.setEdgeLabel(g, id, next ?? ''), 'Libellé du lien modifié.');
      }
    }
    render();
    if (refocus) (type === 'node' ? nodeEls.get(id) : edgeEls.get(id)?.chip)?.focus({ preventScroll: true });
  }

  // ---- Menu « Relier à… » ----
  function closeMenu(refocus = false) {
    if (!menu) return;
    const { el: m, anchor } = menu;
    menu = null;
    m.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (refocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }
  function outside(e) { if (menu && !menu.el.contains(e.target)) closeMenu(); }

  function openLinkMenu(fromId, anchor, onlyPort = null) {
    closeMenu();
    const n = nodeById(fromId);
    if (!canEdit || !n) return;
    const def = kinds[n.kind];
    const multi = def.out.length > 1;
    const choices = [];
    for (const port of def.out) {
      if (onlyPort && port !== onlyPort) continue;
      for (const t of M.readingOrder(g)) {
        if (M.connectError(g, kinds, fromId, port, t.id) || constraints.canConnect?.(g, fromId, port, t.id)) continue;
        choices.push({ port, t });
      }
    }
    const m = h('div', { class: 'wf-menu', role: 'menu', 'aria-label': `Relier « ${short(n.label, 30)} » à…` });
    if (!choices.length) m.append(h('button', { class: 'wf-menu-item', type: 'button', role: 'menuitem', disabled: true, 'aria-disabled': 'true' }, 'Aucune cible possible'));
    for (const { port, t } of choices) {
      const b = h('button', { class: 'wf-menu-item', type: 'button', role: 'menuitem', tabindex: '-1' });
      b.textContent = `${multi ? `${portName(port)} vers ` : ''}${kinds[t.kind].label} : ${short(t.label)}`;
      b.addEventListener('click', () => { closeMenu(); connectTo(fromId, port, t.id); (nodeEls.get(fromId) || anchor)?.focus({ preventScroll: true }); });
      m.append(b);
    }
    const list = () => [...m.querySelectorAll('button:not(:disabled)')];
    m.addEventListener('keydown', (e) => {
      const items2 = list();
      const i = items2.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items2[(i + 1) % items2.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items2[(i - 1 + items2.length) % items2.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items2[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); items2[items2.length - 1]?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
    });
    el.append(m);
    const r = anchor.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(r.left - er.left, er.width - 244))}px`;
    m.style.top = `${r.bottom - er.top + 4}px`;
    menu = { el: m, anchor };
    document.addEventListener('pointerdown', outside, true);
    (list()[0] || m.querySelector('button'))?.focus();
  }

  // ---- Souris, stylet et toucher ----
  const local = (e) => { const r = viewport.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  function startPinch() {
    if (drag?.type === 'move') { drag = null; render(); }
    drag = null;
    tempPath.style.display = 'none';
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: view.z, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target;
    if (t.closest('.wf-chip') || t.closest('.wf-edit')) return;
    closeMenu();
    // Le bloc de l'éditeur est déplaçable : sans cela, le navigateur lance un glisser natif et annule nos gestes.
    if (!frozen) { frozen = el.closest('[draggable="true"]'); if (frozen) frozen.draggable = false; }
    pointers.set(e.pointerId, local(e));
    try { viewport.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2 || drag) return;
    finishEdit(true);
    const portEl = t.closest('.wf-port');
    const nodeEl = t.closest('.wf-node');
    const edgeEl = t.closest('.wf-edge');
    const base = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    if (portEl && canEdit) {
      const id = nodeEl.dataset.id;
      select({ type: 'node', id });
      drag = { ...base, type: 'connect', from: id, port: portEl.dataset.port, anchor: portEl, target: null };
    } else if (nodeEl) {
      const id = nodeEl.dataset.id;
      const n = nodeById(id);
      select({ type: 'node', id });
      nodeEl.focus({ preventScroll: true });
      drag = canEdit && kinds[n.kind].movable !== false ? { ...base, type: 'move', id, ox: n.x, oy: n.y, x: n.x, y: n.y } : { ...base, type: 'pan', id, vx: view.x, vy: view.y };
    } else if (edgeEl) {
      select({ type: 'edge', id: edgeEl.dataset.id });
      edgeEls.get(edgeEl.dataset.id)?.chip.focus({ preventScroll: true });
    } else {
      select(null);
      viewport.focus({ preventScroll: true });
      drag = { ...base, type: 'pan', vx: view.x, vy: view.y };
    }
  });

  // Suit le pointeur pendant un glisser (appelé à chaque déplacement, et au relâchement pour tenir compte de la position finale).
  function track(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const px = e.clientX - drag.sx;
    const py = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(px, py) < DRAG_PX) return;
    drag.moved = true;
    if (drag.type === 'pan') {
      view.x = drag.vx + px;
      view.y = drag.vy + py;
      userView = true;
      applyView();
    } else if (drag.type === 'move') {
      drag.x = M.snap(drag.ox + px / view.z);
      drag.y = M.snap(drag.oy + py / view.z);
      const elN = nodeEls.get(drag.id);
      elN.classList.add('dragging');
      elN.style.left = `${drag.x}px`;
      elN.style.top = `${drag.y}px`;
      renderEdges();
    } else if (drag.type === 'connect') {
      const from = nodeById(drag.from);
      const c = curve(outPos(from, drag.port), toWorld(e.clientX, e.clientY));
      tempPath.setAttribute('d', c.d);
      tempPath.style.display = '';
      const hit = /** @type {HTMLElement | null} */ (document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.wf-node'));
      const id = hit && world.contains(hit) ? hit.dataset.id : null;
      const ok = id && id !== drag.from && !M.connectError(g, kinds, drag.from, drag.port, id) && !constraints.canConnect?.(g, drag.from, drag.port, id);
      drag.target = ok ? id : null;
      for (const [nid, ne] of nodeEls) ne.classList.toggle('wf-drop', nid === drag.target);
    }
  }

  viewport.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.x += mid[0] - pinch.mid[0];
      view.y += mid[1] - pinch.mid[1];
      pinch.mid = mid;
      zoomTo(pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.dist), mid[0], mid[1]);
      return;
    }
    track(e);
  });

  function release(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size && frozen) { frozen.draggable = true; frozen = null; }
    if (!drag || e.pointerId !== drag.pid) return;
    if (e.type === 'pointerup') track(e);
    const d = drag;
    drag = null;
    tempPath.style.display = 'none';
    for (const ne of nodeEls.values()) ne.classList.remove('dragging', 'wf-drop');
    if (e.type === 'pointercancel') { render(); return; }
    if (d.type === 'move' && d.moved && (d.x !== d.ox || d.y !== d.oy)) { commit(M.moveNode(g, d.id, d.x, d.y), `Déplacé en ${d.x}, ${d.y}.`); }
    else if (d.type === 'connect') {
      if (d.moved && d.target) connectTo(d.from, d.port, d.target);
      else if (!d.moved) openLinkMenu(d.from, d.anchor, d.port);
    } else if (d.moved) render();
    else if (d.id) {
      // Double appui (souris ou doigt) sur un nœud : modifier le libellé.
      openPanel(d.id);
      const now = Date.now();
      if (lastTap.id === d.id && now - lastTap.at < 400) { lastTap = { id: null, at: 0 }; editNode(d.id); }
      else lastTap = { id: d.id, at: now };
    }
    if (deferred && !editing) { const next = deferred; deferred = null; if (next !== g) { g = next; render(); } }
  }
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);

  viewport.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // sans Ctrl ni Cmd, la page défile normalement
    e.preventDefault();
    const [x, y] = local(e);
    zoomTo(view.z * Math.exp(-e.deltaY * 0.0025), x, y);
  }, { passive: false });

  // ---- Clavier ----
  world.addEventListener('focusin', (e) => {
    const nodeEl = e.target.closest?.('.wf-node');
    if (nodeEl && e.target === nodeEl) { select({ type: 'node', id: nodeEl.dataset.id }); reveal(nodeEl.dataset.id); }
  });

  el.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Escape' && menu) { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; } // menu sans élément actif : Échap ne ferme que lui
    if (e.key === 'Escape' && inspector.contains(t)) {
      // Échap dans le panneau : annule la saisie non validée, ferme le panneau et rend le focus au nœud (ne ferme pas la fenêtre).
      e.preventDefault();
      e.stopPropagation();
      const n = selection?.type === 'node' ? nodeById(selection.id) : null;
      if (n) inspector.revertActive(n, g);
      closePanel(true);
      return;
    }
    if (t.matches?.('textarea, input, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) onRedo?.(); else onUndo?.();
      return;
    }
    if (mod || e.altKey) return;
    const chip = t.closest?.('.wf-chip');
    if (chip && canEdit) {
      if ((e.key === 'Enter' || e.key === 'F2') && edgeLabels) { e.preventDefault(); editEdge(chip.dataset.id); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); select({ type: 'edge', id: chip.dataset.id }); deleteSelection(); }
      return;
    }
    if (!t.classList?.contains('wf-node')) return;
    const id = t.dataset.id;
    if (e.key === 'Enter') { e.preventDefault(); openPanel(id, true); return; }
    if (!canEdit) return;
    if (kinds[nodeById(id)?.kind]?.movable === false && e.key.startsWith('Arrow')) return;
    const step = e.shiftKey ? 100 : LIMITS.grid;
    if (e.key === 'ArrowLeft') moveBy(id, -step, 0);
    else if (e.key === 'ArrowRight') moveBy(id, step, 0);
    else if (e.key === 'ArrowUp') moveBy(id, 0, -step);
    else if (e.key === 'ArrowDown') moveBy(id, 0, step);
    else if (e.key === 'F2') editNode(id);
    else if (e.key === 'Delete' || e.key === 'Backspace') { select({ type: 'node', id }); deleteSelection(); }
    else if (k === 'l' && !e.shiftKey) openLinkMenu(id, t);
    else return;
    e.preventDefault();
  });

  // ---- API ----
  buildBar();
  render();
  requestAnimationFrame(() => { if (!userView) fit(); });

  return {
    el,
    /** Remplace le graphe (mise à jour distante) ; reporté tant qu'un déplacement est en cours. */
    setGraph(next) {
      if (drag?.type === 'move' || drag?.type === 'connect') { deferred = next; return; }
      if (editing) { deferred = next; return; }
      g = next;
      render();
      if (!canEdit && !userView) fit();
    },
    getGraph: () => g,
    setEditable(value) {
      if (!!value === canEdit) return;
      finishEdit(true);
      closeMenu();
      canEdit = !!value;
      buildBar();
      render();
    },
    fit,
    /** Redessine les nœuds (le contenu affiché dépend d'un état extérieur, par exemple la configuration d'une automatisation). */
    refresh: render,
    openPanel,
    closePanel,
    select: (id) => select(id ? { type: 'node', id } : null),
    /** Vrai pendant un déplacement ou une liaison (la vue ne doit pas être redessinée). */
    isBusy: () => !!drag || !!editing,
    destroy() {
      cancelAnimationFrame(frame);
      clearTimeout(statusTimer);
      resizeObs?.disconnect();
      closeMenu();
    },
  };
}

// ---- Export SVG statique (loupe plein écran) ----
// Rendu autonome en couleurs fixes (clair) : il est affiché dans une <img>, donc sans feuille de style ni jeton de thème.
const FILL = { gray: '#dedcd6', red: '#ffc9c4', orange: '#ffd9b0', yellow: '#fff1a8', green: '#bfe9c9', blue: '#c3dbff', purple: '#dccdfb', pink: '#ffcde4' };
const SHAPE = {
  pill: { fill: '#e9f7ee', stroke: '#2f7d4f' },
  rect: { fill: '#ffffff', stroke: '#6b6a65' },
  decision: { fill: '#fff6e0', stroke: '#a8730a' },
  note: { fill: '#eef3ff', stroke: '#5a73b5', dash: '4 3' },
};

function wrap(text, max) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    let cur = '';
    for (let word of raw.split(/\s+/).filter(Boolean)) {
      while (word.length > max) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, max)); word = word.slice(max); }
      if (!cur) cur = word; else if (cur.length + 1 + word.length <= max) cur += ` ${word}`; else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  return lines.length ? lines : [''];
}

/** SVG du graphe (chaîne), avec ses dimensions, ou null si le graphe est vide. */
export function toSvg(graph, kinds = KINDS, portLabels = PORT_LABELS) {
  if (!graph.nodes.length) return null;
  const box = new Map();
  for (const n of graph.nodes) {
    const lines = wrap(n.label || kinds[n.kind].label, 22).slice(0, 8);
    box.set(n.id, { w: NODE_W, h: Math.max(NODE_H, 24 + lines.length * 17), lines });
  }
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of graph.nodes) {
    const b = box.get(n.id);
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + b.w); y1 = Math.max(y1, n.y + b.h);
  }
  const pad = 28;
  const width = Math.round(x1 - x0 + pad * 2);
  const height = Math.round(y1 - y0 + pad * 2);
  const svg = svgEl('svg', { xmlns: SVG_NS, width, height, viewBox: `${x0 - pad} ${y0 - pad} ${width} ${height}`, 'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif', 'font-size': 13 });
  const defs = svgEl('defs');
  const mk = svgEl('marker', { id: 'a', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  mk.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#6b6a65' }));
  defs.append(mk);
  svg.append(defs);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const outs = kinds[a.kind].out;
    const ba = box.get(a.id);
    const bb = box.get(b.id);
    const p1 = { x: a.x + ba.w, y: a.y + (ba.h * (outs.indexOf(e.port) + 1)) / (outs.length + 1) };
    const p2 = { x: b.x, y: b.y + bb.h / 2 };
    const c = curve(p1, p2);
    svg.append(svgEl('path', { d: c.d, fill: 'none', stroke: '#6b6a65', 'stroke-width': 1.6, 'marker-end': 'url(#a)' }));
    const text = e.label ?? (outs.length > 1 ? portLabels[e.port] ?? e.port : '');
    if (text) {
      const t = svgEl('text', { x: c.mx, y: c.my + 4, 'text-anchor': 'middle', fill: '#1f1f1d', stroke: '#ffffff', 'stroke-width': 4, 'paint-order': 'stroke', 'font-size': 12 });
      t.textContent = text;
      svg.append(t);
    }
  }
  for (const n of graph.nodes) {
    const b = box.get(n.id);
    const def = kinds[n.kind];
    const style = SHAPE[def.shape] || SHAPE.rect;
    const attrs = { x: n.x, y: n.y, width: b.w, height: b.h, rx: def.shape === 'pill' ? b.h / 2 : 8, fill: FILL[n.color] || style.fill, stroke: style.stroke, 'stroke-width': def.shape === 'decision' ? 2.4 : 1.6 };
    if (style.dash) attrs['stroke-dasharray'] = style.dash;
    svg.append(svgEl('rect', attrs));
    const t = svgEl('text', { 'text-anchor': 'middle', fill: '#1f1f1d' });
    b.lines.forEach((line, i) => {
      const s = svgEl('tspan', { x: n.x + b.w / 2, y: n.y + b.h / 2 - ((b.lines.length - 1) * 17) / 2 + i * 17 + 5 });
      s.textContent = line;
      t.append(s);
    });
    svg.append(t);
  }
  return { svg: new XMLSerializer().serializeToString(svg), width, height };
}
