// Vue calendrier d'une base : grille d'un mois ou d'une semaine (lundi premier), une barre par élément du début à la fin
// (inclus), « +N de plus » quand un jour déborde, couleur selon la première colonne Statut. Écriture : glisser un élément
// (souris, stylet, doigt), Alt + flèches au clavier, saisie des dates ; le bouton « + » d'un jour (ou Entrée sur ce jour)
// ajoute une ligne à cette date. Toute écriture passe par la modification d'une ligne côté serveur (mêmes contrôles).
// La « Liste par date » présente les mêmes informations aux lecteurs d'écran. Aucune valeur n'est insérée comme HTML.
import { h } from './util.js';
import { icon } from './icons.js';
import { closePopover, openPopover } from './ui.js';
import { dayNum, isoDay, todayNum } from './base-model.js';
import { openIcal } from './ical-dialog.js';

const DAY = 86_400_000;
const HEAD_H = 26; // en-tête d'une case (numéro du jour)
const LANE_H = 22;
const MAX_LANES = { month: 3, week: 12 };
const LIST_PAGE = 300;
const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const utc = (n) => new Date(n * DAY);
const fmt = (n, opts) => utc(n).toLocaleDateString('fr-FR', { timeZone: 'UTC', ...opts });
const fmtLong = (n) => fmt(n, { day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = (n) => fmt(n, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
// Le jour 0 (1er janvier 1970) est un jeudi : 0 = lundi, 6 = dimanche.
const weekday = (n) => (((n + 3) % 7) + 7) % 7;
const mondayOf = (n) => n - weekday(n);
const ARROWS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
let seq = 0;

/** Même jour du mois, `k` mois plus tard (borné au dernier jour du mois visé). */
function addMonths(n, k) {
  const d = utc(n);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.round(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)) / DAY);
}

/** Journées de la grille : `from` et `to` (lundi et dimanche), `first` et `last` (mois affiché, ou la semaine). */
export function periodOf(mode, anchor) {
  if (mode === 'week') { const s = mondayOf(anchor); return { from: s, to: s + 6, first: s, last: s + 6 }; }
  const d = utc(anchor);
  const first = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY);
  const last = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / DAY);
  return { from: mondayOf(first), to: mondayOf(last) + 6, first, last };
}

/**
 * @param {{
 *   baseId: string, data: any, rows: any[], config: any, canWrite: boolean, titleOf: (row: any) => string,
 *   state: { cal: any },
 *   patchRow: (row: any, body: any) => Promise<boolean>, addRow: (values: any) => Promise<any>, removeRow: (row: any) => void,
 *   setConfig: (next: any) => void, announce: (text: string) => void,
 * }} ctx
 */
export function calendarEl(ctx) {
  const { data, config: c, canWrite, titleOf, announce } = ctx;
  const cal = ctx.state.cal;
  cal.pending ??= new Map();
  const uid = ++seq;
  const helpId = `cal-help-${uid}`;
  const mode = c.mode === 'week' ? 'week' : 'month';
  const settings = data.settings ?? {};
  const dates = data.properties.filter((p) => p.type === 'date');
  const dateProp = (pid) => dates.find((p) => p.id === pid);
  // Colonnes : celles de la vue, sinon celles des réglages de la base, sinon la première colonne Date.
  const startP = dateProp(c.dateId) ?? dateProp(settings.startPropertyId) ?? dates[0] ?? null;
  // Fin : celle de la vue, sinon celle des réglages (différente du début), sinon aucune (l'élément dure un jour).
  const defaultEnd = dateProp(settings.endPropertyId)?.id !== startP?.id ? dateProp(settings.endPropertyId) ?? null : null;
  const viewEnd = c.endId !== undefined && c.endId !== startP?.id ? dateProp(c.endId) ?? null : null;
  const endP = viewEnd ?? defaultEnd;
  const statusP = data.properties.find((p) => p.type === 'status');
  const titleP = data.properties[0];
  const today = todayNum();
  cal.anchor ??= today;
  const { from, to, first, last } = periodOf(mode, cal.anchor);
  if (cal.focus === undefined || cal.focus < from || cal.focus > to) cal.focus = today >= first && today <= last ? today : first;

  // ---- Barre d'outils ----
  const set = (patch) => ctx.setConfig({ ...c, ...patch });
  const without = (next, k) => { const o = { ...next }; delete o[k]; return o; };
  const selectOf = (label, value, options, onChange) => {
    const sel = h('select', { class: 'input tl-select', 'aria-label': label, 'data-focus-key': `cal-${label}` }, options.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };
  const tools = h('div', { class: 'cal-tools' },
    selectOf('Affichage', mode, [['month', 'Affichage : mois'], ['week', 'Affichage : semaine']], (v) => set({ mode: v })),
    // Le début et la fin sont deux colonnes différentes : choisir comme début la colonne de fin retire la fin de la vue.
    dates.length > 0 && selectOf('Colonne de date', startP.id, dates.map((p) => [p.id, `Date : ${p.name}`]), (v) => ctx.setConfig(v === c.endId ? without({ ...c, dateId: v }, 'endId') : { ...c, dateId: v })),
    dates.length > 1 && selectOf('Colonne de fin', viewEnd?.id ?? '',
      [['', defaultEnd ? `Fin : ${defaultEnd.name} (réglages)` : 'Fin : aucune (un jour)'], ...dates.filter((p) => p.id !== startP.id && p.id !== defaultEnd?.id).map((p) => [p.id, `Fin : ${p.name}`])],
      (v) => ctx.setConfig(v ? { ...c, endId: v } : without(c, 'endId'))),
    h('div', { class: 'tl-modes', role: 'group', 'aria-label': 'Présentation' },
      h('button', { class: `btn btn-ghost btn-sm${!cal.list ? ' active' : ''}`, 'aria-pressed': String(!cal.list), onClick: () => { cal.list = false; swap('.tl-modes .btn[aria-pressed="true"]'); } }, 'Grille'),
      h('button', { class: `btn btn-ghost btn-sm${cal.list ? ' active' : ''}`, 'aria-pressed': String(!!cal.list), onClick: () => { cal.list = true; swap('.tl-modes .btn[aria-pressed="true"]'); } }, 'Liste par date')),
    canWrite && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => openIcal(ctx.baseId) }, icon('calendar', 14), 'S’abonner (iCalendar)'));

  if (!startP) {
    return h('div', { class: 'cal' }, tools, h('div', { class: 'empty tl-empty' },
      h('p', null, 'Ajoutez une colonne Date à la base pour afficher le calendrier.')));
  }

  // ---- Dates d'une ligne (un déplacement en cours au clavier prime) ----
  function datesOf(row) {
    const p = cal.pending.get(row.id);
    if (p) return p;
    let s = dayNum(row.values[startP.id]);
    let e = endP ? dayNum(row.values[endP.id]) : null;
    if (s === null && e === null) return null;
    if (s === null) s = e;
    if (e === null || e < s) e = s;
    return { s, e };
  }
  const describe = (row, d) => `${titleOf(row)}, ${d.s === d.e ? `le ${fmtLong(d.s)}` : `du ${fmtLong(d.s)} au ${fmtLong(d.e)}`}`;
  const statusOf = (row) => (statusP ? statusP.options.find((o) => o.id === row.values[statusP.id]) ?? null : null);
  const colorOf = (row) => statusOf(row)?.color || 'default';
  const order = new Map(ctx.rows.map((r, i) => [r.id, i]));
  const events = [];
  const undated = [];
  for (const row of ctx.rows) { const d = datesOf(row); if (d) events.push({ row, ...d }); else undated.push(row); }
  const visible = events.filter((ev) => ev.e >= from && ev.s <= to);

  // ---- Écritures ----
  function commit(row, d) {
    const values = { [startP.id]: isoDay(d.s) };
    // La fin suit le début (une fin vide le reste : l'élément dure alors un jour).
    if (endP && row.values[endP.id]) values[endP.id] = isoDay(d.e);
    cal.pending.delete(row.id);
    cal.focusRow = row.id;
    return ctx.patchRow(row, { values });
  }
  const timers = cal.timers ?? (cal.timers = new Map());
  function schedule(row, d) {
    cal.pending.set(row.id, d);
    clearTimeout(timers.get(row.id));
    timers.set(row.id, setTimeout(() => { timers.delete(row.id); commit(row, d); }, 600));
  }
  async function add(n) {
    if (!canWrite) return;
    if (data.rows.length >= data.limits.rows) { announce('La base a atteint son nombre maximal de lignes.'); return; }
    const row = await ctx.addRow({ [startP.id]: isoDay(n) });
    if (!row) return;
    // La nouvelle ligne s'ouvre pour saisir son titre.
    const target = /** @type {HTMLElement | null} */ (document.querySelector(`.cal [data-focus-key="cal-ev-${CSS.escape(row.id)}"]`)
      ?? document.querySelector(`.cal [data-day="${n}"]`) ?? document.querySelector('.cal-nodate summary'));
    if (target) { target.focus(); editor(target, row); }
  }

  /** Fiche d'une ligne : titre, dates, statut (lecture seule pour un lecteur). */
  function editor(anchor, row) {
    const d = datesOf(row);
    const title = titleOf(row);
    if (!canWrite) {
      const st = statusOf(row);
      openPopover(anchor, h('div', { class: 'bt-pop cal-editor', role: 'group', 'aria-label': `Détails de ${title}` },
        h('strong', null, title),
        h('p', { class: 'muted' }, d ? (d.s === d.e ? `Le ${fmtLong(d.s)}` : `Du ${fmtLong(d.s)} au ${fmtLong(d.e)}`) : 'Sans date'),
        st && h('p', null, `${statusP.name} : ${st.name}`)), { className: 'bt-popover' });
      return;
    }
    const tIn = titleP.type === 'text' && h('input', { class: 'input', id: `cal-t-${uid}`, maxlength: '2000' });
    if (tIn) tIn.value = row.values[titleP.id] ?? '';
    const sIn = h('input', { class: 'input', type: 'date', id: `cal-s-${uid}` });
    sIn.value = d ? isoDay(d.s) : '';
    const eIn = endP && h('input', { class: 'input', type: 'date', id: `cal-e-${uid}` });
    if (eIn) eIn.value = row.values[endP.id] ? isoDay(d.e) : '';
    const stIn = statusP && h('select', { class: 'input', id: `cal-st-${uid}` }, h('option', { value: '' }, '—'), statusP.options.map((o) => h('option', { value: o.id }, o.name)));
    if (stIn) stIn.value = row.values[statusP.id] ?? '';
    const err = h('p', { class: 'notice warning', role: 'alert', hidden: true });
    const save = () => {
      const s = dayNum(sIn.value);
      const e = eIn ? dayNum(eIn.value) : null;
      if (s === null && e !== null) { err.textContent = 'Indiquez une date de début.'; err.hidden = false; sIn.focus(); return; }
      if (s !== null && e !== null && e < s) { err.textContent = 'La fin ne peut pas précéder le début.'; err.hidden = false; eIn.focus(); return; }
      const values = {};
      const same = (a, b) => (a ?? null) === (b ?? null);
      if (tIn) { const t = tIn.value.trim() || null; if (!same(t, row.values[titleP.id])) values[titleP.id] = t; }
      const sIso = s === null ? null : isoDay(s);
      if (!same(sIso, row.values[startP.id])) values[startP.id] = sIso;
      if (eIn) { const eIso = e === null ? null : isoDay(e); if (!same(eIso, row.values[endP.id])) values[endP.id] = eIso; }
      if (stIn && !same(stIn.value || null, row.values[statusP.id])) values[statusP.id] = stIn.value || null;
      closePopover();
      if (!Object.keys(values).length) return;
      cal.focusRow = row.id;
      if (s !== null && (s < from || s > to)) { cal.anchor = s; cal.focus = s; }
      ctx.patchRow(row, { values });
    };
    const field = (input, label) => input && h('div', { class: 'field' }, h('label', { for: input.id }, label), input);
    const form = h('form', { class: 'bt-pop cal-editor', 'aria-label': `Ligne ${title}` },
      field(tIn, titleP.name), field(sIn, startP.name), field(eIn, endP?.name), field(stIn, statusP?.name), err,
      h('div', { class: 'bt-pop-foot cal-editor-foot' },
        h('button', { class: 'btn btn-ghost btn-sm danger', type: 'button', onClick: () => { closePopover(); ctx.removeRow(row); } }, icon('trash', 14), 'Supprimer'),
        h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Enregistrer')));
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    openPopover(anchor, form, { className: 'bt-popover' });
    (tIn || sIn).focus();
  }

  /** Tous les éléments d'un jour (« +N de plus »). */
  function dayList(anchor, n) {
    const all = events.filter((ev) => ev.s <= n && ev.e >= n).sort((a, b) => a.s - b.s || order.get(a.row.id) - order.get(b.row.id));
    openPopover(anchor, h('div', { class: 'bt-pop', role: 'group', 'aria-label': `Éléments du ${fmtDay(n)}` },
      h('strong', null, cap(fmtDay(n))),
      h('ul', { class: 'cal-day-list' }, all.map((ev) => h('li', null, h('button', {
        class: `cal-ev cal-ev-static c-${colorOf(ev.row)}`, type: 'button', 'aria-label': describe(ev.row, ev),
        onClick: () => { closePopover(); const el = /** @type {HTMLElement | null} */ (wrap.querySelector(`[data-focus-key="cal-ev-${CSS.escape(ev.row.id)}"]`)); editor(el && el.isConnected ? el : anchor, ev.row); },
      }, h('span', { class: 'cal-ev-label' }, titleOf(ev.row))))))), { className: 'bt-popover' });
    /** @type {HTMLElement | null} */ (document.querySelector('.popover .cal-ev'))?.focus();
  }

  // ---- Grille ----
  const grid = h('div', { class: `cal-grid cal-${mode}`, role: 'grid', 'aria-label': `Calendrier, ${periodTitle()}`, 'aria-describedby': helpId });
  function periodTitle() {
    return mode === 'week' ? `semaine du ${fmt(from, { day: 'numeric', month: 'long' })} au ${fmtLong(to)}` : fmt(first, { month: 'long', year: 'numeric' });
  }

  /** Placement des éléments d'une semaine en couloirs ; au-delà du plafond, ils sont comptés dans « +N de plus ». */
  function layoutWeek(ws) {
    const we = ws + 6;
    const segs = visible.filter((ev) => ev.e >= ws && ev.s <= we)
      .map((ev) => ({ ev, s: Math.max(ev.s, ws), e: Math.min(ev.e, we), lane: 0 }))
      .sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || order.get(a.ev.row.id) - order.get(b.ev.row.id));
    const ends = [];
    for (const sg of segs) {
      let l = ends.findIndex((end) => end < sg.s);
      if (l < 0) { l = ends.length; ends.push(sg.e); } else ends[l] = sg.e;
      sg.lane = l;
    }
    const max = MAX_LANES[mode];
    const hidden = new Map();
    for (const sg of segs) if (sg.lane >= max) for (let n = sg.s; n <= sg.e; n++) hidden.set(n, (hidden.get(n) ?? 0) + 1);
    return { segs: segs.filter((sg) => sg.lane < max), hidden, lanes: Math.min(ends.length, max) };
  }

  const primary = new Set(); // une seule barre focalisable par élément (la première affichée)
  function evEl(sg) {
    const { ev } = sg;
    const row = ev.row;
    const span = sg.e - sg.s + 1;
    const isPrimary = !primary.has(row.id);
    primary.add(row.id);
    const el = h('button', {
      type: 'button', class: `cal-ev c-${colorOf(row)}${sg.s !== ev.s ? ' cont-start' : ''}${sg.e !== ev.e ? ' cont-end' : ''}`,
      'data-row': row.id, tabindex: isPrimary ? null : '-1', 'aria-hidden': isPrimary ? null : 'true',
      'data-focus-key': isPrimary ? `cal-ev-${row.id}` : null, 'aria-label': describe(row, ev), 'aria-describedby': isPrimary ? helpId : null,
      style: { top: `${HEAD_H + sg.lane * LANE_H}px`, width: `calc(${span} * (100% + 1px) - 5px)` },
    }, h('span', { class: 'cal-ev-label', 'aria-hidden': 'true' }, titleOf(row)));
    // Souris, stylet, doigt : glisser l'élément vers un autre jour le décale (la fin suit).
    let drag = null;
    let suppressClick = false;
    el.addEventListener('pointerdown', (e) => {
      if (!canWrite || e.button !== 0) return;
      const grab = dayAt(e.clientX, e.clientY);
      if (grab === null) return;
      drag = { grab, from: datesOf(row), delta: 0, x0: e.clientX, y0: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      if (!drag.moved) { drag.moved = true; grid.classList.add('cal-dragging'); el.classList.add('dragging'); }
      const n = dayAt(e.clientX, e.clientY);
      if (n === null) return;
      drag.delta = n - drag.grab;
      for (const cell of grid.querySelectorAll('[data-day]')) {
        const d = Number(/** @type {HTMLElement} */ (cell).dataset.day);
        cell.classList.toggle('cal-drop', d >= drag.from.s + drag.delta && d <= drag.from.e + drag.delta);
      }
    });
    const end = (e) => {
      if (!drag) return;
      const { moved, delta, from: d0 } = drag;
      drag = null;
      grid.classList.remove('cal-dragging');
      el.classList.remove('dragging');
      grid.querySelectorAll('.cal-drop').forEach((x) => x.classList.remove('cal-drop'));
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!moved) return;
      suppressClick = true;
      if (e.type === 'pointercancel' || !delta) return;
      const next = { s: d0.s + delta, e: d0.e + delta };
      announce(describe(row, next));
      cal.pending.set(row.id, next);
      swap(null);
      commit(row, next);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => { e.stopPropagation(); if (suppressClick) { suppressClick = false; return; } editor(el, row); });
    return el;
  }

  function dayAt(x, y) {
    for (const cell of grid.querySelectorAll('[data-day]')) {
      const r = cell.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return Number(/** @type {HTMLElement} */ (cell).dataset.day);
    }
    return null;
  }

  function cellEl(n, layout) {
    const starting = layout.segs.filter((sg) => sg.s === n);
    const covering = visible.filter((ev) => ev.s <= n && ev.e >= n).length;
    const more = layout.hidden.get(n) ?? 0;
    const isToday = n === today;
    const outside = n < first || n > last;
    const label = `${cap(fmtDay(n))}${isToday ? ', aujourd’hui' : ''}, ${covering ? plural(covering, 'élément', 'éléments') : 'aucun élément'}`;
    const num = utc(n).getUTCDate() === 1 && mode === 'month' ? fmt(n, { day: 'numeric', month: 'short' }) : String(utc(n).getUTCDate());
    const cell = h('div', {
      role: 'gridcell', class: `cal-cell${outside ? ' out' : ''}${isToday ? ' today' : ''}`, 'data-day': String(n),
      tabindex: n === cal.focus ? '0' : '-1', 'aria-current': isToday ? 'date' : null, 'data-focus-key': `cal-day-${n}`,
    },
    // Nom de la case tiré de son contenu (date complète en texte masqué) : un libellé imposé masquerait le texte visible.
    h('div', { class: 'cal-cell-head' }, h('span', { class: 'cal-num', 'aria-hidden': 'true' }, num), h('span', { class: 'sr-only' }, `${label}.`),
      canWrite && h('button', { class: 'icon-btn cal-add', type: 'button', tabindex: '-1', 'aria-label': `Ajouter une ligne le ${fmtDay(n)}`, title: 'Ajouter une ligne à cette date', onClick: (e) => { e.stopPropagation(); add(n); } }, icon('plus', 13))),
    h('div', { class: 'cal-lanes', style: { height: `${layout.lanes * LANE_H}px` } }),
    starting.map(evEl),
    more > 0 && h('button', { class: 'cal-more', type: 'button', onClick: (e) => dayList(/** @type {HTMLElement} */ (e.currentTarget), n) },
      `+${more} de plus`, h('span', { class: 'sr-only' }, ` : ${plural(more, 'autre élément', 'autres éléments')} le ${fmtDay(n)}`)));
    return cell;
  }

  function gridBody() {
    const head = h('div', { class: 'cal-row cal-headrow', role: 'row' }, WEEKDAYS.map((name, i) => h('div', { class: 'cal-colhead', role: 'columnheader' },
      h('span', { 'aria-hidden': 'true' }, mode === 'week' ? fmt(from + i, { weekday: 'short', day: 'numeric' }) : fmt(from + i, { weekday: 'short' })),
      h('span', { class: 'sr-only' }, mode === 'week' ? fmt(from + i, { weekday: 'long', day: 'numeric', month: 'long' }) : name))));
    const rowsEl = [];
    for (let ws = from; ws <= to; ws += 7) {
      const layout = layoutWeek(ws);
      const days = [];
      for (let n = ws; n < ws + 7; n++) days.push(cellEl(n, layout));
      rowsEl.push(h('div', { class: 'cal-row', role: 'row' }, days));
    }
    grid.replaceChildren(head, ...rowsEl);
  }

  function focusDay(n) {
    cal.focus = n;
    if (n < from || n > to) { cal.anchor = n; swap(`[data-day="${n}"]`); return; }
    for (const el of grid.querySelectorAll('[role=gridcell][tabindex="0"]')) el.setAttribute('tabindex', '-1');
    const cell = /** @type {HTMLElement | null} */ (grid.querySelector(`[data-day="${n}"]`));
    if (cell) { cell.tabIndex = 0; cell.focus(); }
  }

  grid.addEventListener('focusin', (e) => {
    const cell = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[role=gridcell]'));
    if (!cell) return;
    const n = Number(cell.dataset.day);
    if (n === cal.focus && cell.tabIndex === 0) return;
    cal.focus = n;
    for (const el of grid.querySelectorAll('[role=gridcell][tabindex="0"]')) el.setAttribute('tabindex', '-1');
    cell.tabIndex = 0;
  });
  grid.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const cell = /** @type {HTMLElement | null} */ (t.closest('[role=gridcell]'));
    if (!cell) return;
    const evBtn = /** @type {HTMLElement | null} */ (t.closest('.cal-ev'));
    // Alt + flèches sur un élément : le décaler d'un jour (gauche, droite) ou d'une semaine (haut, bas).
    if (evBtn && e.altKey && ARROWS[e.key] !== undefined) {
      e.preventDefault();
      if (!canWrite) return;
      const row = data.rows.find((r) => r.id === evBtn.dataset.row);
      const cur = row && datesOf(row);
      if (!cur) return;
      const next = { s: cur.s + ARROWS[e.key], e: cur.e + ARROWS[e.key] };
      if (next.s < from || next.s > to) cal.anchor = next.s;
      cal.focus = next.s;
      announce(describe(row, next));
      schedule(row, next);
      swap(`[data-focus-key="cal-ev-${CSS.escape(row.id)}"]`);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(cell.dataset.day);
    let next = null;
    if (ARROWS[e.key] !== undefined) next = n + ARROWS[e.key];
    else if (e.key === 'Home') next = mondayOf(n);
    else if (e.key === 'End') next = mondayOf(n) + 6;
    else if (e.key === 'PageUp') next = mode === 'week' ? n - 7 : addMonths(n, -1);
    else if (e.key === 'PageDown') next = mode === 'week' ? n + 7 : addMonths(n, 1);
    else if ((e.key === 'Enter' || e.key === ' ') && t === cell) { e.preventDefault(); add(n); return; }
    if (next === null) return;
    e.preventDefault();
    focusDay(next);
  });

  // ---- Liste par date (mêmes informations, lisible au lecteur d'écran, dates modifiables) ----
  function listEl() {
    const shown = cal.shown ?? LIST_PAGE;
    const items = [...visible].sort((a, b) => a.s - b.s || a.e - b.e || order.get(a.row.id) - order.get(b.row.id));
    const dateCell = (row, p, value, which) => {
      if (!canWrite || !p) return h('td', { class: 'bt-cell' }, value === null ? '' : fmtLong(value));
      const input = h('input', { class: 'input bt-input', type: 'date', 'data-focus-key': `cal-${row.id}-${which}`, 'aria-label': `${which === 'start' ? 'Début' : 'Fin'} de ${titleOf(row)}` });
      input.value = value === null ? '' : isoDay(value);
      input.addEventListener('change', () => {
        const v = dayNum(input.value);
        if (v === null && which === 'start') { input.value = value === null ? '' : isoDay(value); return; }
        ctx.patchRow(row, { values: { [p.id]: v === null ? null : isoDay(v) } });
      });
      return h('td', { class: 'bt-cell' }, input);
    };
    const table = h('table', { class: 'bt-table tl-table cal-table', 'aria-label': `Calendrier sous forme de liste, ${periodTitle()}` },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, 'Élément')),
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, startP.name)),
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, endP ? endP.name : 'Fin')),
        statusP && h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, statusP.name)))),
      h('tbody', null, items.slice(0, shown).map((ev) => h('tr', { 'data-row': ev.row.id },
        h('th', { scope: 'row', class: 'bt-cell tl-cell-name' }, h('button', { class: 'cal-open', type: 'button', 'data-focus-key': `cal-open-${ev.row.id}`, onClick: (e) => editor(/** @type {HTMLElement} */ (e.currentTarget), ev.row) }, titleOf(ev.row))),
        dateCell(ev.row, startP, ev.s, 'start'),
        dateCell(ev.row, endP, endP && ev.row.values[endP.id] ? ev.e : (endP ? null : ev.e), 'end'),
        statusP && h('td', { class: 'bt-cell' }, statusOf(ev.row)?.name ?? '')))));
    return h('div', null,
      items.length ? h('div', { class: 'bt-scroll' }, table) : h('p', { class: 'muted bt-empty' }, `Aucun élément sur la ${mode === 'week' ? 'semaine' : 'période'} affichée.`),
      items.length > shown && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { cal.shown = shown + LIST_PAGE; swap(null); } }, `Afficher ${Math.min(LIST_PAGE, items.length - shown)} lignes de plus (${shown} sur ${items.length})`));
  }

  // ---- Sans date (repliable) ----
  const nodate = undated.length > 0 && h('details', { class: 'cal-nodate', open: !!cal.nodateOpen },
    h('summary', null, `Sans date (${undated.length})`),
    h('ul', { class: 'cal-day-list' }, undated.slice(0, LIST_PAGE).map((row) => h('li', null, h('button', {
      class: 'cal-open', type: 'button', 'data-focus-key': `cal-open-${row.id}`, onClick: (e) => editor(/** @type {HTMLElement} */ (e.currentTarget), row),
    }, titleOf(row))))),
    undated.length > LIST_PAGE && h('p', { class: 'muted' }, `${LIST_PAGE} premières lignes sur ${undated.length}.`));
  if (nodate) nodate.addEventListener('toggle', () => { cal.nodateOpen = nodate.open; });

  // ---- Navigation entre périodes ----
  const shift = (k) => {
    const n = mode === 'week' ? cal.focus + 7 * k : addMonths(cal.focus, k);
    cal.anchor = n;
    cal.focus = n;
    swap(`.cal-nav [data-nav="${k > 0 ? 'next' : 'prev'}"]`);
  };
  const unit = mode === 'week' ? 'Semaine' : 'Mois';
  const nav = h('div', { class: 'cal-nav' },
    h('button', { class: 'icon-btn', 'data-nav': 'prev', 'aria-label': `${unit} précédent${mode === 'week' ? 'e' : ''}`, title: `${unit} précédent${mode === 'week' ? 'e' : ''}`, onClick: () => shift(-1) }, h('span', { class: 'cal-flip' }, icon('chevron', 15))),
    h('button', { class: 'btn btn-ghost btn-sm', 'data-nav': 'today', onClick: () => { cal.anchor = today; cal.focus = today; swap('.cal-nav [data-nav="today"]'); } }, 'Aujourd’hui'),
    h('button', { class: 'icon-btn', 'data-nav': 'next', 'aria-label': `${unit} suivant${mode === 'week' ? 'e' : ''}`, title: `${unit} suivant${mode === 'week' ? 'e' : ''}`, onClick: () => shift(1) }, icon('chevron', 15)),
    h('h2', { class: 'cal-title', 'aria-live': 'polite' }, cap(periodTitle())));

  const help = h('p', { id: helpId, class: 'muted tl-help' }, canWrite
    ? 'Flèches : changer de jour ; Page précédente et Page suivante : changer de mois ; Entrée sur un jour : ajouter une ligne à cette date. Sur un élément : Entrée pour l’ouvrir, Alt et flèches pour le décaler d’un jour (gauche, droite) ou d’une semaine (haut, bas). La souris peut aussi le glisser vers un autre jour. La « Liste par date » présente les mêmes informations.'
    : 'Flèches : changer de jour ; Entrée sur un élément : l’ouvrir. La « Liste par date » présente les mêmes informations.');
  const wrap = h('div', { class: 'cal' }, tools, nav, help);
  if (cal.list) wrap.append(listEl());
  else { gridBody(); wrap.append(grid); }
  if (nodate) wrap.append(nodate);

  /** Reconstruit la vue sans recharger la base ; le focus va à `focusSel` (s'il est donné). */
  function swap(focusSel) {
    const fresh = calendarEl(ctx);
    wrap.replaceWith(fresh);
    if (focusSel) /** @type {HTMLElement | null} */ (fresh.querySelector(focusSel))?.focus();
  }
  return wrap;
}
