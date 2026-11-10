// Vue chronologie d'une base : une barre par ligne entre la colonne de début et la colonne de fin (réglages de la base).
// Échelle jour, semaine, mois ou trimestre ; ligne « Aujourd'hui » ; regroupement et couleur par une colonne Sélection ou Statut ;
// flèches de dépendance ; sous-éléments repliables. Seule la fenêtre visible est construite (jusqu'à 5 000 lignes).
// Écriture : souris (glisser la barre, étirer ses bords), clavier (flèches, Maj + flèches) ou saisie des dates ; toute écriture passe
// par la modification d'une ligne côté serveur (mêmes contrôles). Une version tableau donne les mêmes informations aux lecteurs d'écran.
// Aucune valeur n'est insérée comme HTML.
import { h } from './util.js';
import { icon } from './icons.js';
import { closePopover, openPopover } from './ui.js';
import { dayNum, flattenTree, isDateCol, isoDay, rangeOf, todayNum } from './base-model.js';

const DAY = 86_400_000;
const ROW_H = 36;
const BUFFER = 12; // lignes construites au-delà de la zone visible
const TABLE_PAGE = 300;
export const SCALES = {
  day: { label: 'Jour', ppd: 40, pad: 14 },
  week: { label: 'Semaine', ppd: 14, pad: 28 },
  month: { label: 'Mois', ppd: 4, pad: 92 },
  quarter: { label: 'Trimestre', ppd: 1.6, pad: 184 },
};
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
};
const utc = (n) => new Date(n * DAY);
const fmtLong = (n) => utc(n).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = (n, opts) => utc(n).toLocaleDateString('fr-FR', { timeZone: 'UTC', ...opts });
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
let seq = 0;

/** Graduations visibles entre les jours d0 et d1. */
function ticks(scale, d0, d1) {
  const out = [];
  if (scale === 'day') {
    for (let n = d0; n <= d1; n++) {
      const first = utc(n).getUTCDate() === 1;
      out.push({ n, label: first ? fmtShort(n, { day: 'numeric', month: 'short' }) : String(utc(n).getUTCDate()), major: first || utc(n).getUTCDay() === 1 });
    }
    return out;
  }
  if (scale === 'week') {
    // Le jour 0 (1er janvier 1970) est un jeudi : les lundis sont les jours n tels que n ≡ 4 (mod 7).
    for (let n = d0 + ((4 - (d0 % 7) + 7) % 7); n <= d1; n += 7) out.push({ n, label: fmtShort(n, { day: 'numeric', month: 'short' }), major: utc(n).getUTCDate() <= 7 });
    return out;
  }
  const step = scale === 'quarter' ? 3 : 1;
  const start = utc(d0);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() - (start.getUTCMonth() % step);
  for (;;) {
    const n = Math.round(Date.UTC(y, m, 1) / DAY);
    if (n > d1) break;
    if (n >= d0 - 120) out.push({ n, label: scale === 'quarter' ? `T${Math.floor(m / 3) + 1} ${y}` : fmtShort(n, { month: 'short', year: 'numeric' }), major: m === 0 });
    m += step;
    if (m > 11) { m -= 12; y += 1; }
  }
  return out;
}

/**
 * @param {{
 *   data: any, rows: any[], config: any, canWrite: boolean, titleOf: (row: any) => string,
 *   state: { collapsed: Set<string>, tl: any },
 *   patchRow: (row: any, body: any) => Promise<boolean>,
 *   setConfig: (next: any) => void, openSettings: () => void, announce: (text: string) => void,
 * }} ctx
 */
export function timelineEl(ctx) {
  const { data, config: c, canWrite, titleOf, state, announce } = ctx;
  const tl = state.tl;
  tl.pending ??= new Map();
  const uid = ++seq;
  const settings = data.settings ?? {};
  const prop = (pid) => data.properties.find((p) => p.id === pid);
  const startP = prop(settings.startPropertyId);
  // Une plage de dates porte le début et la fin : pas de colonne de fin à part.
  const ranged = startP?.type === 'date_range';
  const endP = !ranged && settings.endPropertyId && settings.endPropertyId !== settings.startPropertyId ? prop(settings.endPropertyId) : null;
  const hasEnd = ranged || !!endP;
  const endName = ranged ? 'Fin' : endP?.name;
  const choices = data.properties.filter((p) => p.type === 'select' || p.type === 'status');
  const groupP = c.groupBy ? prop(c.groupBy) : null;
  const colorP = c.colorBy ? prop(c.colorBy) : null;
  const scaleKey = SCALES[c.scale] ? c.scale : 'week';
  const scale = SCALES[scaleKey];
  const ppd = scale.ppd;
  const subitems = !!settings.subitems;
  const deps = !!settings.dependencies;
  const helpId = `tl-help-${uid}`;

  // ---- Barre d'outils ----
  const selectOf = (label, value, options, onChange) => {
    const sel = h('select', { class: 'input tl-select', 'aria-label': label, 'data-focus-key': `tl-${label}` }, options.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };
  const set = (patch) => ctx.setConfig({ ...c, ...patch });
  const without = (k) => { const next = { ...c }; delete next[k]; return next; };
  const tools = h('div', { class: 'tl-tools' },
    selectOf('Échelle', scaleKey, Object.entries(SCALES).map(([k, s]) => [k, `Échelle : ${s.label}`]), (v) => set({ scale: v })),
    selectOf('Regrouper par', groupP?.id ?? '', [['', 'Sans regroupement'], ...choices.map((p) => [p.id, `Regrouper par ${p.name}`])], (v) => ctx.setConfig(v ? { ...c, groupBy: v } : without('groupBy'))),
    selectOf('Couleur des barres', colorP?.id ?? '', [['', 'Couleur unique'], ...choices.map((p) => [p.id, `Couleur selon ${p.name}`])], (v) => ctx.setConfig(v ? { ...c, colorBy: v } : without('colorBy'))),
    h('div', { class: 'tl-modes', role: 'group', 'aria-label': 'Présentation' },
      h('button', { class: `btn btn-ghost btn-sm${tl.mode !== 'table' ? ' active' : ''}`, 'aria-pressed': String(tl.mode !== 'table'), onClick: () => { tl.mode = 'chart'; swap(); } }, 'Barres'),
      h('button', { class: `btn btn-ghost btn-sm${tl.mode === 'table' ? ' active' : ''}`, 'aria-pressed': String(tl.mode === 'table'), onClick: () => { tl.mode = 'table'; swap(); } }, 'Tableau des dates')));

  if (!isDateCol(startP)) {
    return h('div', { class: 'tl' }, tools, h('div', { class: 'empty tl-empty' },
      h('p', null, 'Choisissez la colonne de début (une colonne Date ou Plage de dates) dans les réglages de la base pour afficher la chronologie.'),
      canWrite && h('button', { class: 'btn btn-primary btn-sm', onClick: () => ctx.openSettings() }, icon('settings', 14), 'Réglages de la base')));
  }

  // ---- Dates d'une ligne (une modification en cours au clavier prime) ----
  /** Début et fin écrits dans la ligne (sans compléter l'un par l'autre). */
  function rawOf(row) {
    if (ranged) { const r = rangeOf(row.values[startP.id]); return { s: r ? dayNum(r.start) : null, e: r?.end ? dayNum(r.end) : null }; }
    return { s: dayNum(row.values[startP.id]), e: endP ? dayNum(row.values[endP.id]) : null };
  }
  /** Valeurs à écrire pour des dates (début, fin) ; `null` en fin = pas de fin. */
  function valuesFor(row, s, e, force = false) {
    if (ranged) return { [startP.id]: { start: isoDay(s), end: e === null ? null : isoDay(e) } };
    const before = rawOf(row);
    const values = {};
    if (force || s !== before.s) values[startP.id] = isoDay(s);
    if (endP && (force || e !== before.e)) values[endP.id] = e === null ? null : isoDay(e);
    return values;
  }
  function datesOf(row) {
    const p = tl.pending.get(row.id);
    if (p) return p;
    let { s, e } = rawOf(row);
    if (s === null && e === null) return null;
    if (s === null) s = e;
    if (e === null || e < s) e = s;
    return { s, e };
  }
  const titles = new Map(data.rows.map((r) => [r.id, titleOf(r)]));
  const nameOf = (id) => titles.get(id) ?? 'ligne supprimée';
  const colorOf = (row) => {
    const v = colorP ? row.values[colorP.id] : null;
    return (v && colorP.options.find((o) => o.id === v)?.color) || 'default';
  };

  // ---- Lignes affichées : groupes, puis arborescence des sous-éléments ----
  /** @type {any[]} */
  let lines = [];
  let index = new Map();
  let edges = [];
  function buildLines() {
    const flat = (rows) => (subitems ? flattenTree(rows, state.collapsed) : rows.map((row) => ({ row, level: 1, parent: null, childCount: 0 })));
    lines = [];
    if (groupP) {
      const lanes = [...groupP.options.map((o) => ({ id: o.id, label: o.name, color: o.color })), { id: null, label: 'Sans valeur', color: 'gray' }];
      for (const lane of lanes) {
        const inLane = ctx.rows.filter((r) => (r.values[groupP.id] ?? null) === lane.id);
        if (!inLane.length) continue;
        lines.push({ kind: 'group', label: lane.label, color: lane.color, count: inLane.length });
        for (const l of flat(inLane)) lines.push({ kind: 'row', ...l });
      }
    } else for (const l of flat(ctx.rows)) lines.push({ kind: 'row', ...l });
    index = new Map();
    lines.forEach((l, i) => { if (l.kind === 'row') index.set(l.row.id, i); });
    edges = [];
    if (deps) {
      for (const [i, l] of lines.entries()) {
        if (l.kind !== 'row') continue;
        for (const b of l.row.blockedBy ?? []) { const j = index.get(b); if (j !== undefined) edges.push([j, i]); }
      }
    }
  }
  buildLines();

  // ---- Étendue : toutes les dates, plus aujourd'hui, avec une marge ----
  const today = todayNum();
  let min = today;
  let max = today;
  for (const r of ctx.rows) { const d = datesOf(r); if (d) { if (d.s < min) min = d.s; if (d.e > max) max = d.e; } }
  const origin = min - scale.pad;
  const last = max + scale.pad * 2;
  const chartW = Math.ceil((last - origin + 1) * ppd);
  const labelW = window.innerWidth < 640 ? 150 : 260;
  const xOf = (n) => (n - origin) * ppd;

  // ---- Fenêtre de barres ----
  // Lecteurs : aucune barre n'est focalisable, la zone défilante l'est (défilement au clavier).
  const scroll = h('div', { class: 'tl-scroll', tabindex: canWrite ? null : '0', role: 'group', 'aria-label': `Chronologie, ${plural(ctx.rows.length, 'ligne', 'lignes')}`, 'aria-describedby': helpId });
  const tickHost = h('div', { class: 'tl-ticks', style: { width: `${chartW}px` } });
  const head = h('div', { class: 'tl-head' }, h('div', { class: 'tl-corner', style: { width: `${labelW}px` } }, 'Élément'), tickHost);
  const gridHost = h('div', { class: 'tl-grid', 'aria-hidden': 'true', style: { left: `${labelW}px`, width: `${chartW}px` } });
  const arrows = svgEl('svg', { class: 'tl-arrows', 'aria-hidden': 'true', focusable: 'false' });
  const lineHost = h('div', { class: 'tl-lines' });
  const bodyEl = h('div', { class: 'tl-body' }, gridHost,
    h('div', { class: 'tl-today', 'aria-hidden': 'true', style: { left: `${labelW + xOf(today) + ppd / 2}px` } }),
    arrows, lineHost);
  const canvas = h('div', { class: 'tl-canvas', style: { width: `${labelW + chartW}px` } }, head, bodyEl);
  scroll.append(canvas);
  const sizeBody = () => {
    const height = Math.max(lines.length * ROW_H, ROW_H);
    bodyEl.style.height = `${height}px`;
    arrows.setAttribute('width', String(chartW));
    arrows.setAttribute('height', String(height));
    arrows.style.left = `${labelW}px`;
  };
  sizeBody();

  const describe = (row, d) => `${titleOf(row)}, ${d.s === d.e ? `le ${fmtLong(d.s)}` : `du ${fmtLong(d.s)} au ${fmtLong(d.e)}`}`;
  const place = (bar, d) => {
    bar.style.left = `${xOf(d.s)}px`;
    bar.style.width = `${Math.max((d.e - d.s + 1) * ppd, 8)}px`;
  };

  // Enregistrement : une seule requête après une rafale de touches.
  const timers = new Map();
  function commit(row, d) {
    let values = {};
    if (ranged) {
      // Plage : une barre d'un jour sans fin écrite le reste ; sinon la fin suit.
      const raw = rawOf(row);
      values = valuesFor(row, d.s, raw.e === null && d.e === d.s ? null : d.e);
    } else {
      const before = datesOf({ ...row, id: '' }) ?? { s: null, e: null };
      if (d.s !== before.s || !row.values[startP.id]) values[startP.id] = isoDay(d.s);
      if (endP && (d.e !== before.e || !row.values[endP.id])) values[endP.id] = isoDay(d.e);
    }
    tl.pending.delete(row.id);
    if (!Object.keys(values).length) return;
    tl.focusRow = row.id;
    tl.refocus = true;
    ctx.patchRow(row, { values });
  }
  function schedule(row, d) {
    tl.pending.set(row.id, d);
    clearTimeout(timers.get(row.id));
    timers.set(row.id, setTimeout(() => { timers.delete(row.id); commit(row, d); }, 600));
  }

  function editor(anchor, row) {
    if (!canWrite) return;
    const d = datesOf(row);
    const sIn = h('input', { class: 'input', type: 'date', id: `tl-s-${uid}`, required: true });
    sIn.value = d ? isoDay(d.s) : isoDay(today);
    const eIn = hasEnd && h('input', { class: 'input', type: 'date', id: `tl-e-${uid}` });
    if (eIn) { const raw = rawOf(row); eIn.value = raw.e !== null ? isoDay(raw.e) : (d && !ranged ? isoDay(d.e) : ''); }
    const err = h('p', { class: 'notice warning', role: 'alert', hidden: true });
    const save = () => {
      const s = dayNum(sIn.value);
      const e = eIn ? dayNum(eIn.value) : null;
      if (s === null) { err.textContent = 'Indiquez une date de début.'; err.hidden = false; sIn.focus(); return; }
      if (e !== null && e < s) { err.textContent = 'La fin ne peut pas précéder le début.'; err.hidden = false; eIn.focus(); return; }
      closePopover();
      const values = valuesFor(row, s, e, true);
      tl.focusRow = row.id;
      tl.refocus = true;
      ctx.patchRow(row, { values });
    };
    const form = h('form', { class: 'bt-pop tl-editor', 'aria-label': `Dates de ${titleOf(row)}` },
      h('strong', null, titleOf(row)),
      h('div', { class: 'field' }, h('label', { for: sIn.id }, ranged ? `${startP.name} : début` : startP.name), sIn),
      eIn && h('div', { class: 'field' }, h('label', { for: eIn.id }, ranged ? `${startP.name} : fin` : endName), eIn),
      err,
      h('div', { class: 'bt-pop-foot' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Enregistrer')));
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    openPopover(anchor, form);
    sIn.focus();
  }

  function focusLine(i, dir) {
    for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
      if (lines[j].kind !== 'row') continue;
      tl.focusRow = lines[j].row.id;
      const top = j * ROW_H;
      const headH = head.offsetHeight;
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (top + ROW_H + headH > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW_H + headH - scroll.clientHeight;
      paint();
      const target = lineHost.querySelector(`[data-row="${CSS.escape(tl.focusRow)}"].tl-item`) ?? lineHost.querySelector(`.tl-line[data-line="${j}"] .tl-name`);
      /** @type {HTMLElement} */ (target)?.focus();
      return;
    }
  }

  function barEl(line, i, d) {
    const row = line.row;
    const color = colorOf(row);
    const late = deps && (row.blockedBy ?? []).some((b) => { const br = data.rows.find((r) => r.id === b); const bd = br && datesOf(br); return bd && bd.e >= d.s; });
    const label = `${describe(row, d)}${late ? ', commence avant la fin de ce qui la bloque' : ''}`;
    const inner = h('span', { class: 'tl-item-label', 'aria-hidden': 'true' }, titleOf(row));
    if (!canWrite) {
      const el = h('div', { class: `tl-item c-${color}${late ? ' late' : ''}`, role: 'img', 'aria-label': label, 'data-row': row.id }, inner);
      place(el, d);
      return el;
    }
    const bar = h('button', { class: `tl-item c-${color}${late ? ' late' : ''}`, type: 'button', 'data-row': row.id, 'aria-label': label, 'aria-describedby': helpId },
      hasEnd && h('span', { class: 'tl-handle tl-handle-start', 'aria-hidden': 'true' }), inner,
      hasEnd && h('span', { class: 'tl-handle tl-handle-end', 'aria-hidden': 'true' }));
    place(bar, d);
    // Souris, stylet, doigt : glisser la barre la décale, glisser un bord l'étire.
    let drag = null;
    let suppressClick = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = /** @type {Element} */ (e.target);
      const mode = t.closest('.tl-handle-end') ? 'end' : t.closest('.tl-handle-start') ? 'start' : 'move';
      const from = datesOf(row);
      drag = { mode, x0: e.clientX, from, to: from, moved: false };
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x0;
      if (Math.abs(dx) > 3) drag.moved = true;
      const n = Math.round(dx / ppd);
      const f = drag.from;
      drag.to = drag.mode === 'move' ? { s: f.s + n, e: f.e + n }
        : drag.mode === 'end' ? { s: f.s, e: Math.max(f.s, f.e + n) }
          : { s: Math.min(f.e, f.s + n), e: f.e };
      place(bar, drag.to);
    });
    const end = (e) => {
      if (!drag) return;
      const { moved, to, from } = drag;
      drag = null;
      bar.classList.remove('dragging');
      if (bar.hasPointerCapture?.(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      if (!moved) return;
      suppressClick = true;
      if (e.type === 'pointercancel' || (to.s === from.s && to.e === from.e)) { place(bar, from); return; }
      announce(describe(row, to));
      commit(row, to);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } editor(bar, row); });
    // Clavier : flèches = décaler d'un jour, Maj + flèches = étirer (fin), haut et bas = ligne voisine, Entrée = saisir les dates.
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); focusLine(i, e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const cur = datesOf(row);
      let next;
      if (e.shiftKey) {
        if (!hasEnd) { announce('Pas de colonne de fin : la barre dure un jour. Ajoutez une colonne de fin dans les réglages.'); return; }
        next = { s: cur.s, e: Math.max(cur.s, cur.e + step) };
        if (next.e === cur.e) { announce('La fin ne peut pas précéder le début.'); return; }
      } else next = { s: cur.s + step, e: cur.e + step };
      place(bar, next);
      bar.setAttribute('aria-label', describe(row, next));
      tl.focusRow = row.id;
      announce(describe(row, next));
      schedule(row, next);
    });
    bar.addEventListener('focus', () => { tl.focusRow = row.id; });
    return bar;
  }

  function lineEl(line, i) {
    if (line.kind === 'group') {
      return h('div', { class: 'tl-line tl-group', 'data-line': String(i), style: { top: `${i * ROW_H}px` } },
        h('div', { class: 'tl-label', style: { width: `${labelW}px` } }, h('span', { class: `bt-dot c-${line.color}` }), h('strong', null, line.label), h('span', { class: 'muted' }, String(line.count))));
    }
    const row = line.row;
    const title = titleOf(row);
    const d = datesOf(row);
    const open = !state.collapsed.has(row.id);
    const label = h('div', { class: 'tl-label', style: { width: `${labelW}px`, paddingLeft: `${8 + (line.level - 1) * 16}px` } },
      line.childCount ? h('button', {
        class: 'icon-btn tl-toggle', 'aria-expanded': String(open), 'aria-label': `${open ? 'Replier' : 'Déplier'} les sous-éléments de ${title}`,
        onClick: () => { if (open) state.collapsed.add(row.id); else state.collapsed.delete(row.id); tl.focusRow = row.id; rebuild(); lineHost.querySelector(`.tl-line[data-line="${index.get(row.id)}"] .tl-toggle`)?.focus(); },
      }, icon('chevron', 13)) : h('span', { class: 'tl-toggle-space' }),
      canWrite ? h('button', { class: 'tl-name', type: 'button', 'aria-label': `${title} : saisir les dates`, onClick: (e) => editor(e.currentTarget, row),
        onKeydown: (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); focusLine(i, e.key === 'ArrowUp' ? -1 : 1); } } }, title)
        : h('span', { class: 'tl-name' }, title),
      !d && h('span', { class: 'tl-nodate muted' }, 'Sans date'));
    return h('div', { class: 'tl-line', 'data-line': String(i), style: { top: `${i * ROW_H}px` } }, label,
      h('div', { class: 'tl-track', style: { width: `${chartW}px` } }, d && barEl(line, i, d)));
  }

  // Lignes construites, par indice : une ligne déjà affichée n'est jamais retirée ni déplacée tant qu'elle reste dans la fenêtre
  // (le focus et une barre saisie à la souris survivent au défilement).
  const built = new Map();
  function paint(force = false) {
    const viewH = scroll.clientHeight || 600;
    const viewW = scroll.clientWidth || 1000;
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - BUFFER);
    const lastLine = Math.min(lines.length - 1, Math.ceil((scroll.scrollTop + viewH) / ROW_H) + BUFFER);
    const shown = new Set();
    for (let i = first; i <= lastLine; i++) shown.add(i);
    // La ligne qui a le focus reste construite même hors de la zone visible (le focus ne se perd pas au défilement).
    const keep = tl.focusRow ? index.get(tl.focusRow) : undefined;
    if (keep !== undefined) shown.add(keep);
    const hadFocus = lineHost.contains(document.activeElement);
    if (force) { built.clear(); lineHost.replaceChildren(); }
    for (const [i, el] of built) if (!shown.has(i)) { el.remove(); built.delete(i); }
    let k = 0;
    for (const i of [...shown].sort((a, b) => a - b)) {
      let el = built.get(i);
      if (!el) { el = lineEl(lines[i], i); built.set(i, el); }
      if (lineHost.children[k] !== el) lineHost.insertBefore(el, lineHost.children[k] ?? null);
      k += 1;
    }
    // Graduations et repères de la zone visible.
    const d0 = origin + Math.floor(Math.max(0, scroll.scrollLeft - labelW) / ppd) - 2;
    const d1 = origin + Math.ceil((scroll.scrollLeft + viewW) / ppd) + 2;
    const tk = ticks(scaleKey, Math.max(origin, d0), Math.min(last, d1));
    tickHost.replaceChildren(...tk.map((t) => h('span', { class: `tl-tick${t.major ? ' major' : ''}`, style: { left: `${xOf(t.n)}px` } }, t.label)),
      today >= d0 && today <= d1 && h('span', { class: 'tl-today-label', style: { left: `${xOf(today) + ppd / 2}px` } }, 'Aujourd’hui'));
    gridHost.replaceChildren(...tk.map((t) => h('span', { class: `tl-gridline${t.major ? ' major' : ''}`, style: { left: `${xOf(t.n)}px` } })));
    // Flèches de dépendance : celles qui traversent la zone visible.
    const marker = `tl-arrow-${uid}`;
    const markerLate = `tl-arrow-late-${uid}`;
    const paths = [];
    for (const [j, i] of edges) {
      if (Math.max(i, j) < first || Math.min(i, j) > lastLine) continue;
      const a = datesOf(lines[j].row);
      const b = datesOf(lines[i].row);
      if (!a || !b) continue;
      const x1 = xOf(a.e + 1);
      const y1 = j * ROW_H + ROW_H / 2;
      const x2 = xOf(b.s);
      const y2 = i * ROW_H + ROW_H / 2;
      const late = b.s <= a.e;
      const dpath = x2 - x1 >= 16 ? `M${x1} ${y1}H${x1 + 8}V${y2}H${x2 - 2}`
        : `M${x1} ${y1}H${x1 + 8}V${y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2)}H${x2 - 10}V${y2}H${x2 - 2}`;
      paths.push(svgEl('path', { d: dpath, class: `tl-dep${late ? ' late' : ''}`, 'marker-end': `url(#${late ? markerLate : marker})` }));
    }
    arrows.replaceChildren(
      svgEl('defs', {},
        svgEl('marker', { id: marker, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto' }, svgEl('path', { d: 'M0 0L8 4L0 8z', class: 'tl-head-mark' })),
        svgEl('marker', { id: markerLate, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto' }, svgEl('path', { d: 'M0 0L8 4L0 8z', class: 'tl-head-mark late' }))),
      ...paths);
    if ((hadFocus || tl.refocus) && tl.focusRow && scroll.isConnected) {
      tl.refocus = false;
      const target = lineHost.querySelector(`.tl-item[data-row="${CSS.escape(tl.focusRow)}"]`) ?? lineHost.querySelector(`.tl-line[data-line="${index.get(tl.focusRow)}"] .tl-name`);
      if (target && document.activeElement !== target) /** @type {HTMLElement} */ (target).focus({ preventScroll: true });
    }
  }
  function rebuild() { buildLines(); sizeBody(); paint(true); }

  let frame = 0;
  scroll.addEventListener('scroll', () => {
    // Position gardée en jours (le jour au centre, et non des pixels) : elle survit à un changement d'échelle.
    tl.anchor = origin + (scroll.scrollLeft + (scroll.clientWidth - labelW) / 2) / ppd;
    tl.scrollTop = scroll.scrollTop;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
  });
  const goToday = () => { scroll.scrollLeft = Math.max(0, xOf(today) - (scroll.clientWidth - labelW) / 3); };

  // ---- Version tableau (mêmes informations, lisible au lecteur d'écran, dates modifiables) ----
  function tableEl() {
    const shown = tl.shown ?? TABLE_PAGE;
    const rowsLines = lines.filter((l) => l.kind === 'row');
    const groupOf = (row) => (groupP ? (groupP.options.find((o) => o.id === row.values[groupP.id])?.name ?? 'Sans valeur') : null);
    const dateCell = (row, p, value, which) => {
      if (!canWrite || (which === 'end' && !hasEnd)) return h('td', { class: 'bt-cell' }, value === null ? '' : fmtLong(value));
      const input = h('input', { class: 'input bt-input', type: 'date', 'data-focus-key': `tl-${row.id}-${which}`, 'aria-label': `${which === 'start' ? 'Début' : 'Fin'} de ${titleOf(row)}` });
      input.value = value === null ? '' : isoDay(value);
      input.addEventListener('change', () => {
        const n = dayNum(input.value);
        if (n === null && which === 'start') { input.value = value === null ? '' : isoDay(value); return; }
        if (ranged) {
          const raw = rawOf(row);
          const s = which === 'start' ? n : raw.s;
          const e = which === 'end' ? n : raw.e;
          if (s === null) { input.value = ''; return; }
          if (e !== null && e < s) { input.value = value === null ? '' : isoDay(value); announce('La fin ne peut pas précéder le début.'); return; }
          ctx.patchRow(row, { values: valuesFor(row, s, e, true) });
          return;
        }
        ctx.patchRow(row, { values: { [p.id]: n === null ? null : isoDay(n) } });
      });
      return h('td', { class: 'bt-cell' }, input);
    };
    const table = h('table', { class: 'bt-table tl-table', 'aria-label': 'Chronologie sous forme de tableau' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, 'Élément')),
        groupP && h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, groupP.name)),
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, ranged ? 'Début' : startP.name)),
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, endP ? endP.name : 'Fin')),
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, 'Durée')),
        deps && h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, 'Bloqué par')))),
      h('tbody', null, rowsLines.slice(0, shown).map((l) => {
        const d = datesOf(l.row);
        const raw = rawOf(l.row);
        return h('tr', { 'data-row': l.row.id },
          h('th', { scope: 'row', class: 'bt-cell tl-cell-name' }, h('span', { class: 'tl-indent', style: { paddingLeft: `${(l.level - 1) * 16}px` } },
            l.level > 1 && h('span', { class: 'sr-only' }, `Niveau ${l.level}, sous-élément de ${titleOf(l.parent)} : `), titleOf(l.row))),
          groupP && h('td', { class: 'bt-cell' }, groupOf(l.row)),
          dateCell(l.row, startP, raw.s, 'start'),
          dateCell(l.row, endP ?? startP, hasEnd ? raw.e : null, 'end'),
          h('td', { class: 'bt-cell' }, d ? plural(d.e - d.s + 1, 'jour', 'jours') : ''),
          deps && h('td', { class: 'bt-cell' }, (l.row.blockedBy ?? []).map(nameOf).join(', ')));
      })));
    return h('div', null, h('div', { class: 'bt-scroll' }, table),
      rowsLines.length > shown && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { tl.shown = shown + TABLE_PAGE; swap(); } }, `Afficher ${Math.min(TABLE_PAGE, rowsLines.length - shown)} lignes de plus (${shown} sur ${rowsLines.length})`));
  }

  const help = h('p', { id: helpId, class: 'muted tl-help' }, canWrite
    ? 'Glissez une barre pour la déplacer, ses bords pour l’étirer. Au clavier : flèches gauche et droite pour décaler d’un jour, Maj et flèches pour étirer la fin, haut et bas pour changer de ligne, Entrée pour saisir les dates. Le bouton « Tableau des dates » présente les mêmes informations en tableau.'
    : 'Le bouton « Tableau des dates » présente les mêmes informations en tableau.');
  const host = h('div', { class: 'tl-host' });
  const wrap = h('div', { class: 'tl' }, tools,
    h('div', { class: 'tl-sub' }, help, tl.mode !== 'table' && h('button', { class: 'btn btn-ghost btn-sm', onClick: goToday }, 'Aujourd’hui')),
    host);
  function swap() {
    // Bascule barres / tableau sans reconstruire toute la base.
    const fresh = timelineEl(ctx);
    wrap.replaceWith(fresh);
    fresh.querySelector(`.tl-modes .btn[aria-pressed="true"]`)?.focus();
  }
  if (tl.mode === 'table') { host.append(tableEl()); return wrap; }
  host.append(scroll);
  paint();
  // Première mise en page : position de défilement gardée d'un rendu à l'autre, sinon aujourd'hui.
  requestAnimationFrame(() => {
    if (!scroll.isConnected) return;
    if (tl.anchor === undefined) goToday(); else scroll.scrollLeft = Math.max(0, (tl.anchor - origin) * ppd - (scroll.clientWidth - labelW) / 2);
    if (tl.scrollTop) scroll.scrollTop = tl.scrollTop;
    paint();
  });
  return wrap;
}
