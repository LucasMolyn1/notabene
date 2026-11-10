// Vue graphique d'une base : barres, lignes ou anneau, en SVG construit par le DOM (aucune librairie, aucun HTML inséré).
// Le calcul est fait par le serveur sur les lignes telles que la personne connectée les voit, après les filtres de la vue
// enregistrée ; ici on ne fait que dessiner. Accessibilité : titre et description, valeurs écrites (jamais la couleur seule),
// éléments focalisables aux flèches avec « libellé : valeur », infobulle au survol et au focus, et un « Tableau des valeurs »
// qui donne les mêmes informations.
import { api } from './api.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';

export const CHART_GROUP_TYPES = new Set(['select', 'status', 'multi_select', 'checkbox', 'date', 'date_range', 'person', 'text', 'created_by', 'created_time']);
const DATE_GROUPS = new Set(['date', 'date_range', 'created_time']);
const VALUE_TYPES = new Set(['number', 'rollup', 'formula']);
export const CHARTS = { bar: 'Barres', line: 'Lignes', donut: 'Anneau' };
export const METRICS = { count: 'Nombre de lignes', sum: 'Somme', avg: 'Moyenne', min: 'Minimum', max: 'Maximum' };
export const BUCKETS = { day: 'Jour', week: 'Semaine', month: 'Mois', year: 'Année' };
const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
const CYCLE = ['blue', 'green', 'orange', 'purple', 'pink', 'red', 'yellow', 'gray'];
const LIMIT = { min: 5, max: 50, def: 20 };
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return el;
};
const plural = (n, one, many) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
let seq = 0;

/** Réglages d'une vue graphique, bornés aux valeurs connues et aux colonnes existantes. */
export function chartConfig(props, c) {
  const prop = (pid) => props.find((p) => p.id === pid);
  const group = prop(c.groupBy);
  const value = prop(c.valueId);
  const okGroup = !!group && CHART_GROUP_TYPES.has(group.type);
  const okValue = !!value && VALUE_TYPES.has(value.type);
  const metric = METRICS[c.metric] && (c.metric === 'count' || okValue) ? c.metric : 'count';
  const limit = Number.isInteger(c.limit) && c.limit >= LIMIT.min && c.limit <= LIMIT.max ? c.limit : undefined;
  return {
    type: 'chart', chart: CHARTS[c.chart] ? c.chart : 'bar',
    ...(okGroup ? { groupBy: c.groupBy } : {}),
    ...(okGroup && DATE_GROUPS.has(group.type) && BUCKETS[c.bucket] ? { bucket: c.bucket } : {}),
    metric,
    ...(metric !== 'count' ? { valueId: c.valueId } : {}),
    ...(limit ? { limit } : {}),
  };
}

const fmtValue = (metric, v) => (typeof v !== 'number' || !Number.isFinite(v) ? '—'
  : metric === 'count' ? v.toLocaleString('fr-FR') : (Math.round(v * 100) / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }));

/**
 * Assistant de configuration : type, regroupement, intervalle de dates, calcul, colonne de valeur, nombre de groupes.
 * @param {{ properties: any[], config: any, onSave: (cfg: any) => any }} o
 */
export function openChartWizard({ properties, config, onSave }) {
  /** @type {any} */
  const c = config ? chartConfig(properties, config) : { chart: 'bar', metric: 'count' };
  const groups = properties.filter((p) => CHART_GROUP_TYPES.has(p.type));
  const values = properties.filter((p) => VALUE_TYPES.has(p.type));
  const n = ++seq;
  const typeName = `ch-type-${n}`;
  const types = h('fieldset', { class: 'ch-types' }, h('legend', null, 'Type de graphique'),
    Object.entries(CHARTS).map(([k, label]) => {
      const r = h('input', { type: 'radio', name: typeName, id: `${typeName}-${k}`, value: k });
      r.checked = (c.chart ?? 'bar') === k;
      return h('label', { class: 'ch-type', for: r.id }, r, h('span', null, label));
    }));
  const group = h('select', { id: `ch-group-${n}`, class: 'input' }, groups.map((p) => h('option', { value: p.id }, p.name)));
  group.value = c.groupBy ?? groups.find((p) => p.type === 'status' || p.type === 'select')?.id ?? groups[0]?.id ?? '';
  const bucket = h('select', { id: `ch-bucket-${n}`, class: 'input' }, Object.entries(BUCKETS).map(([k, l]) => h('option', { value: k }, l)));
  bucket.value = c.bucket ?? 'month';
  const metric = h('select', { id: `ch-metric-${n}`, class: 'input' }, Object.entries(METRICS).map(([k, l]) => h('option', { value: k, disabled: k !== 'count' && !values.length }, l)));
  metric.value = c.metric ?? 'count';
  const value = h('select', { id: `ch-value-${n}`, class: 'input' }, values.map((p) => h('option', { value: p.id }, p.name)));
  value.value = c.valueId ?? values[0]?.id ?? '';
  const limit = h('input', { id: `ch-limit-${n}`, class: 'input', type: 'number', min: String(LIMIT.min), max: String(LIMIT.max), step: '1', inputmode: 'numeric', 'aria-describedby': `ch-limit-help-${n}` });
  limit.value = String(c.limit ?? LIMIT.def);
  const field = (input, label, extra) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, extra);
  const bucketBox = field(bucket, 'Intervalle de dates');
  const valueBox = field(value, 'Colonne de valeur');
  const err = h('p', { class: 'notice warning', role: 'alert', hidden: true });
  const sync = () => {
    bucketBox.hidden = !DATE_GROUPS.has(properties.find((p) => p.id === group.value)?.type);
    valueBox.hidden = metric.value === 'count';
  };
  group.addEventListener('change', sync);
  metric.addEventListener('change', sync);
  sync();
  const body = groups.length
    ? h('div', { class: 'stack' }, types, field(group, 'Regrouper par'), bucketBox, field(metric, 'Calcul'), valueBox,
      !values.length && h('p', { class: 'muted bt-formula-help' }, 'Somme, moyenne, minimum et maximum portent sur une colonne Nombre, Cumul ou Formule : ajoutez-en une pour les utiliser.'),
      field(limit, 'Nombre de groupes au plus', h('p', { id: `ch-limit-help-${n}`, class: 'muted bt-formula-help' }, `De ${LIMIT.min} à ${LIMIT.max} ; les groupes suivants sont réunis dans « Autres ».`)),
      err)
    : h('p', { class: 'notice warning' }, 'Ajoutez une colonne Sélection, Statut, Multi-sélection, Case à cocher, Date, Plage de dates, Personne ou Texte pour faire un graphique.');
  openModal({
    title: config ? 'Configurer le graphique' : 'Nouveau graphique',
    body,
    actions: [{ label: 'Annuler' }, groups.length && {
      label: config ? 'Enregistrer' : 'Créer', primary: true,
      onClick: async () => {
        const lim = Number(limit.value);
        if (!Number.isInteger(lim) || lim < LIMIT.min || lim > LIMIT.max) { err.textContent = `Le nombre de groupes va de ${LIMIT.min} à ${LIMIT.max}.`; err.hidden = false; limit.focus(); return false; }
        if (metric.value !== 'count' && !value.value) { err.textContent = 'Choisissez la colonne de valeur.'; err.hidden = false; metric.focus(); return false; }
        const chosen = /** @type {HTMLInputElement | null} */ (types.querySelector('input:checked'))?.value ?? 'bar';
        const gp = properties.find((p) => p.id === group.value);
        const cfg = {
          type: 'chart', chart: chosen, groupBy: group.value,
          ...(DATE_GROUPS.has(gp?.type) ? { bucket: bucket.value } : {}),
          metric: metric.value,
          ...(metric.value !== 'count' ? { valueId: value.value } : {}),
          limit: lim,
        };
        return onSave(cfg);
      },
    }].filter(Boolean),
  });
  /** @type {HTMLElement | null} */ (types.querySelector('input:checked'))?.focus();
}

/**
 * @param {{
 *   baseId: string, viewId: string, data: any, config: any, canWrite: boolean, state: any, stamp: number,
 *   setConfig: (next: any) => void, whenSaved: (viewId: string) => Promise<void>, announce: (text: string) => void,
 * }} ctx
 */
export function chartEl(ctx) {
  const { data, config: c, canWrite } = ctx;
  const st = ctx.state.ch ?? (ctx.state.ch = { mode: 'chart', focus: 0 });
  const uid = ++seq;
  const prop = (pid) => data.properties.find((p) => p.id === pid);
  const groupP = prop(c.groupBy);
  const valueP = c.metric !== 'count' ? prop(c.valueId) : null;

  const configure = () => openChartWizard({
    properties: data.properties, config: c,
    onSave: (cfg) => ctx.setConfig({ ...cfg, sort: [], filters: c.filters ?? [], hidden: [] }),
  });
  const modeBtn = (mode, label) => h('button', {
    class: `btn btn-ghost btn-sm${st.mode === mode ? ' active' : ''}`, 'aria-pressed': String(st.mode === mode),
    onClick: () => { st.mode = mode; swap('.ch-tools .tl-modes .btn[aria-pressed="true"]'); },
  }, label);
  const tools = h('div', { class: 'ch-tools' },
    canWrite && h('button', { class: 'btn btn-ghost btn-sm', 'data-focus-key': 'ch-config', onClick: configure }, icon('settings', 14), 'Configurer le graphique'),
    h('div', { class: 'tl-modes', role: 'group', 'aria-label': 'Présentation' }, modeBtn('chart', 'Graphique'), modeBtn('table', 'Tableau des valeurs')));
  const wrap = h('div', { class: 'ch' }, tools);
  function swap(focusSel) {
    const fresh = chartEl(ctx);
    wrap.replaceWith(fresh);
    if (focusSel) /** @type {HTMLElement | null} */ (fresh.querySelector(focusSel))?.focus();
  }

  if (!groupP) {
    wrap.append(h('div', { class: 'empty tl-empty' },
      h('p', null, 'Choisissez la colonne qui regroupe les lignes pour afficher le graphique.'),
      canWrite && h('button', { class: 'btn btn-primary btn-sm', onClick: configure }, icon('settings', 14), 'Configurer le graphique')));
    return wrap;
  }

  // ---- Lecture (une seule à la fois ; relue quand la vue, la base ou ses lignes changent) ----
  let maxUpdated = 0;
  for (const r of data.rows) if (r.updatedAt > maxUpdated) maxUpdated = r.updatedAt;
  const key = `${ctx.viewId}|${JSON.stringify({ ...c, sort: undefined, hidden: undefined })}|${ctx.stamp}|${data.rows.length}|${maxUpdated}`;
  if (st.key !== key) {
    st.key = key;
    st.result = null;
    st.error = null;
    const mine = key;
    ctx.whenSaved(ctx.viewId)
      .then(() => api.get(`/bases/${ctx.baseId}/views/${ctx.viewId}/chart`))
      .then((res) => { if (st.key === mine) { st.result = res; redraw(); } })
      .catch((err) => { if (st.key === mine) { st.error = err; redraw(); } });
  }
  // La vue a peut-être été reconstruite entre-temps : on remplace la plus récente encore affichée.
  function redraw() {
    const current = document.querySelector(`.ch[data-ch="${CSS.escape(ctx.viewId)}"]`);
    if (!current) return;
    const hadFocus = current.contains(document.activeElement);
    const fresh = chartEl(ctx);
    current.replaceWith(fresh);
    if (hadFocus) /** @type {HTMLElement | null} */ (fresh.querySelector('.ch-tools .btn'))?.focus();
  }
  wrap.setAttribute('data-ch', ctx.viewId);
  if (st.error) {
    wrap.append(h('p', { class: 'notice warning', role: 'alert' }, st.error?.message || 'Impossible de calculer le graphique.'),
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { st.key = null; swap(null); } }, 'Réessayer'));
    return wrap;
  }
  if (!st.result) {
    wrap.append(h('p', { class: 'muted ch-loading', role: 'status' }, 'Calcul du graphique…'));
    return wrap;
  }

  // ---- Données ----
  const res = st.result;
  const metric = c.metric ?? 'count';
  const buckets = (Array.isArray(res.buckets) ? res.buckets : []).map((b, i) => ({
    key: String(b.key ?? i), label: String(b.label ?? ''), value: Number(b.value), count: Number(b.count) || 0, color: '',
    hue: COLORS.includes(b.color) ? b.color : null,
  }));
  const other = res.other && typeof res.other === 'object' ? { key: '__other', label: 'Autres', value: Number(res.other.value), count: Number(res.other.count) || 0, color: '', hue: 'gray' } : null;
  const items = other ? [...buckets, other] : buckets;
  // Couleur : celle de l'option ; sinon, pour l'anneau, une couleur par part ; sinon la couleur d'accent.
  items.forEach((b, i) => { b.color = b.hue ?? (c.chart === 'donut' ? CYCLE[i % CYCLE.length] : 'default'); });
  const additive = metric === 'count' || metric === 'sum';
  const sum = items.reduce((acc, b) => acc + (Number.isFinite(b.value) ? b.value : 0), 0);
  const canShare = additive && sum > 0 && items.every((b) => !(b.value < 0));
  const share = (b) => (canShare && Number.isFinite(b.value) ? `${(Math.round((b.value / sum) * 1000) / 10).toLocaleString('fr-FR')} %` : null);
  // `total` : le calcul sur toutes les lignes retenues (nombre, somme, moyenne générale, minimum ou maximum).
  const total = typeof res.total === 'number' && Number.isFinite(res.total) ? res.total : null;
  const TOTAL_WORD = { count: 'Total', sum: 'Total', avg: 'Moyenne générale', min: 'Minimum général', max: 'Maximum général' };
  const totalText = total === null ? null : metric === 'count' ? plural(total, 'ligne', 'lignes') : `${TOTAL_WORD[metric].toLowerCase()} ${fmtValue(metric, total)}`;
  const metricLabel = `${METRICS[metric]}${valueP ? ` de ${valueP.name}` : ''}`;
  const title = `${metricLabel} par ${groupP.name}${c.bucket && BUCKETS[c.bucket] ? ` (${BUCKETS[c.bucket].toLowerCase()})` : ''}`;
  const descText = `${CHARTS[c.chart] ?? 'Barres'}, ${plural(items.length, 'groupe', 'groupes')}${totalText ? `, ${totalText}` : ''}.${res.truncated && other ? ` Au-delà de ${buckets.length} groupes, les suivants sont réunis dans « Autres ».` : ''}${res.truncated && !other ? ' Base trop grande : le calcul porte sur une partie des lignes.' : ''}`;
  const labelOf = (b) => `${b.label || 'Sans libellé'} : ${fmtValue(metric, b.value)}`;
  const detailOf = (b) => [plural(b.count, 'ligne', 'lignes'), share(b)].filter(Boolean).join(', ');

  const titleId = `ch-title-${uid}`;
  const descId = `ch-desc-${uid}`;
  const helpId = `ch-help-${uid}`;
  const tipId = `ch-tip-${uid}`;
  const head = h('div', { class: 'ch-head' },
    h('h2', { id: titleId, class: 'ch-title' }, title),
    h('p', { id: descId, class: 'muted ch-desc' }, descText));
  wrap.append(head);

  if (!items.length) {
    wrap.append(h('p', { class: 'muted bt-empty' }, 'Aucune ligne à représenter.'));
    return wrap;
  }

  // ---- Tableau des valeurs (mêmes informations) ----
  if (st.mode === 'table') {
    wrap.append(h('div', { class: 'bt-scroll' }, h('table', { class: 'bt-table ch-table', 'aria-labelledby': titleId, 'aria-describedby': descId },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, groupP.name)),
        h('th', { scope: 'col', class: 'bt-th ch-num' }, h('span', { class: 'bt-th-btn' }, metricLabel)),
        h('th', { scope: 'col', class: 'bt-th ch-num' }, h('span', { class: 'bt-th-btn' }, 'Lignes')),
        canShare && h('th', { scope: 'col', class: 'bt-th ch-num' }, h('span', { class: 'bt-th-btn' }, 'Part')))),
      h('tbody', null, items.map((b) => h('tr', null,
        h('th', { scope: 'row', class: 'bt-cell ch-label-cell' }, h('span', { class: `bt-dot c-${b.color}`, 'aria-hidden': 'true' }), b.label || 'Sans libellé'),
        h('td', { class: 'bt-cell ch-num' }, fmtValue(metric, b.value)),
        h('td', { class: 'bt-cell ch-num' }, b.count.toLocaleString('fr-FR')),
        canShare && h('td', { class: 'bt-cell ch-num' }, share(b))))),
      total !== null && h('tfoot', null, h('tr', null,
        h('th', { scope: 'row', class: 'bt-cell ch-label-cell' }, TOTAL_WORD[metric]),
        h('td', { class: 'bt-cell ch-num' }, fmtValue(metric, total)),
        h('td', { class: 'bt-cell ch-num' }, metric === 'count' ? total.toLocaleString('fr-FR') : ''),
        canShare && h('td', { class: 'bt-cell ch-num' }, '100 %'))))));
    return wrap;
  }

  // ---- Graphique ----
  const help = h('p', { id: helpId, class: 'muted tl-help' }, 'Flèches : passer d’un groupe à l’autre ; Échap : masquer l’infobulle. Le bouton « Tableau des valeurs » présente les mêmes informations en tableau.');
  const tip = h('div', { id: tipId, class: 'ch-tip', role: 'tooltip', hidden: true });
  const canvas = h('div', { class: 'ch-canvas' });
  const legend = c.chart === 'donut' ? h('ul', { class: 'ch-legend', 'aria-label': 'Légende' }, items.map((b) => h('li', null,
    h('span', { class: `ch-swatch c-${b.color}`, 'aria-hidden': 'true' }),
    h('span', { class: 'ch-legend-label' }, b.label || 'Sans libellé'),
    h('span', { class: 'ch-legend-value' }, [fmtValue(metric, b.value), share(b)].filter(Boolean).join(' · '))))) : null;
  const figure = h('div', { class: 'ch-figure' }, canvas, tip, legend);
  wrap.append(help, figure);

  const showTip = (b, anchor) => {
    tip.replaceChildren(h('strong', null, labelOf(b)), h('span', null, detailOf(b)));
    tip.hidden = false;
    const fr = figure.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const x = Math.min(Math.max(ar.left + ar.width / 2 - fr.left, 80), Math.max(fr.width - 80, 80));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(ar.top - fr.top - 8, 0)}px`;
  };
  const hideTip = () => { tip.hidden = true; };

  /** Élément focalisable : role img nommé « libellé : valeur », infobulle au survol et au focus. */
  const item = (b, i, shapes) => {
    const g = svg('g', {
      class: 'ch-item', role: 'img', 'aria-label': labelOf(b), 'aria-describedby': `${tipId} ${helpId}`,
      tabindex: i === st.focus ? '0' : '-1', 'data-index': i,
    }, ...shapes);
    g.addEventListener('focus', () => { st.focus = i; showTip(b, g); });
    g.addEventListener('blur', hideTip);
    g.addEventListener('mouseenter', () => showTip(b, g));
    g.addEventListener('mouseleave', () => { if (document.activeElement !== g) hideTip(); });
    return g;
  };

  function draw(width) {
    const W = Math.max(Math.floor(width), 260);
    let root;
    if (c.chart === 'donut') root = donut(W);
    else if (c.chart === 'line') root = line(W);
    else root = bars(W);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-labelledby', titleId);
    root.setAttribute('aria-describedby', descId);
    root.setAttribute('class', 'ch-svg');
    const active = document.activeElement;
    const refocus = active && canvas.contains(active);
    canvas.replaceChildren(root);
    if (refocus) /** @type {SVGElement | null} */ (root.querySelector(`[data-index="${st.focus}"]`))?.focus();
    root.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    const t = /** @type {Element} */ (e.target).closest('.ch-item');
    if (!t) return;
    if (e.key === 'Escape') { if (!tip.hidden) { e.preventDefault(); e.stopPropagation(); hideTip(); } return; }
    const i = Number(t.getAttribute('data-index'));
    const last = items.length - 1;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(i + 1, last)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(i - 1, 0)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    const all = canvas.querySelectorAll('.ch-item');
    all.forEach((el) => el.setAttribute('tabindex', '-1'));
    const target = /** @type {SVGElement} */ (all[next]);
    target.setAttribute('tabindex', '0');
    target.focus();
  }

  const finite = items.map((b) => (Number.isFinite(b.value) ? b.value : 0));
  const vmax = Math.max(0, ...finite);
  const vmin = Math.min(0, ...finite);
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function bars(W) {
    const ROW = 30;
    const labelW = Math.min(Math.round(W * 0.34), 180);
    const valueW = 72;
    const plotW = Math.max(W - labelW - valueW - 12, 60);
    const span = vmax - vmin || 1;
    const x = (v) => labelW + 8 + ((v - vmin) / span) * plotW;
    const H = items.length * ROW + 8;
    const chars = Math.max(Math.floor(labelW / 7.2), 6);
    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    root.append(svg('line', { x1: x(0), x2: x(0), y1: 2, y2: H - 4, class: 'ch-axis' }));
    items.forEach((b, i) => {
      const y = 4 + i * ROW;
      const v = finite[i];
      const x0 = Math.min(x(0), x(v));
      const w = Math.max(Math.abs(x(v) - x(0)), v === 0 ? 0 : 2);
      root.append(item(b, i, [
        svg('rect', { x: 0, y, width: W, height: ROW, class: 'ch-hit' }),
        svg('text', { x: labelW, y: y + ROW / 2, class: 'ch-label', 'text-anchor': 'end', 'dominant-baseline': 'central', 'aria-hidden': 'true' }, short(b.label || 'Sans libellé', chars)),
        svg('rect', { x: x0, y: y + 5, width: w, height: ROW - 10, rx: 3, class: `ch-bar c-${b.color}` }),
        svg('text', { x: Math.max(x(v), x(0)) + 6, y: y + ROW / 2, class: 'ch-value', 'dominant-baseline': 'central', 'aria-hidden': 'true' }, fmtValue(metric, b.value)),
        svg('rect', { x: 1, y: y + 1, width: W - 2, height: ROW - 2, rx: 4, class: 'ch-focus' }),
      ]));
    });
    return root;
  }

  function line(W) {
    const top = 28;
    const bottom = 40;
    const left = 52;
    const right = 18;
    const H = 260;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const span = vmax - vmin || 1;
    const y = (v) => top + plotH - ((v - vmin) / span) * plotH;
    const step = items.length > 1 ? plotW / (items.length - 1) : 0;
    const x = (i) => left + (items.length > 1 ? i * step : plotW / 2);
    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    // Repères horizontaux et valeurs de l'axe (décoratifs : les valeurs exactes sont sur chaque point).
    const grid = svg('g', { 'aria-hidden': 'true' });
    for (let k = 0; k <= 4; k++) {
      const v = vmin + (span * k) / 4;
      grid.append(svg('line', { x1: left, x2: W - right, y1: y(v), y2: y(v), class: k === 0 ? 'ch-axis' : 'ch-grid' }),
        svg('text', { x: left - 6, y: y(v), class: 'ch-tick', 'text-anchor': 'end', 'dominant-baseline': 'central' }, fmtValue(metric === 'count' ? 'avg' : metric, v)));
    }
    // Libellés de l'axe des groupes : un sur k, pour qu'ils ne se chevauchent pas.
    const every = Math.max(1, Math.ceil(items.length / Math.max(Math.floor(plotW / 84), 1)));
    items.forEach((b, i) => {
      if (i % every !== 0 && i !== items.length - 1) return;
      // « Semaine du 09/02/2026 » : la date seule suffit sous l'axe (le libellé complet est sur le point et dans l'infobulle).
      const axis = (b.label || 'Sans libellé').replace(/^Semaine du /, '');
      grid.append(svg('text', { x: x(i), y: H - bottom + 18, class: 'ch-tick', 'text-anchor': i === 0 && items.length > 1 ? 'start' : i === items.length - 1 && items.length > 1 ? 'end' : 'middle' }, short(axis, 12)));
    });
    root.append(grid);
    root.append(svg('polyline', { points: items.map((_, i) => `${x(i)},${y(finite[i])}`).join(' '), class: 'ch-line', 'aria-hidden': 'true' }));
    items.forEach((b, i) => {
      root.append(item(b, i, [
        svg('circle', { cx: x(i), cy: y(finite[i]), r: 12, class: 'ch-hit' }),
        svg('circle', { cx: x(i), cy: y(finite[i]), r: 4.5, class: 'ch-point' }),
        items.length <= 12 && svg('text', { x: x(i), y: y(finite[i]) - 10, class: 'ch-value', 'text-anchor': 'middle', 'aria-hidden': 'true' }, fmtValue(metric, b.value)),
        svg('circle', { cx: x(i), cy: y(finite[i]), r: 9, class: 'ch-focus' }),
      ]));
    });
    return root;
  }

  function donut(W) {
    const size = Math.min(W, 280);
    const R = size / 2 - 6;
    const r = R * 0.6;
    const cx = W / 2;
    const cy = size / 2;
    const root = svg('svg', { width: W, height: size, viewBox: `0 0 ${W} ${size}` });
    const positive = finite.reduce((a, v) => a + (v > 0 ? v : 0), 0);
    root.append(svg('text', { x: cx, y: cy - 8, class: 'ch-center', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'aria-hidden': 'true' }, fmtValue(metric, total ?? (additive ? sum : positive))),
      svg('text', { x: cx, y: cy + 12, class: 'ch-tick', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'aria-hidden': 'true' }, total !== null ? TOTAL_WORD[metric] : 'Total'));
    let a0 = -Math.PI / 2;
    const pt = (rad, a) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
    items.forEach((b, i) => {
      const v = finite[i] > 0 ? finite[i] : 0;
      const frac = positive > 0 ? v / positive : 0;
      // Une part nulle reste focalisable (valeur 0) : un arc minuscule, invisible.
      const a1 = a0 + Math.max(frac * Math.PI * 2, 0.0001);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const full = frac >= 0.9999;
      const d = full
        ? `M${pt(R, a0)} A${R} ${R} 0 1 1 ${pt(R, a0 + Math.PI)} A${R} ${R} 0 1 1 ${pt(R, a0)} Z M${pt(r, a0)} A${r} ${r} 0 1 0 ${pt(r, a0 + Math.PI)} A${r} ${r} 0 1 0 ${pt(r, a0)} Z`
        : `M${pt(R, a0)} A${R} ${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
      root.append(item(b, i, [svg('path', { d, class: `ch-slice c-${b.color}`, 'fill-rule': 'evenodd' }), svg('path', { d, class: 'ch-focus ch-focus-slice', 'fill-rule': 'evenodd' })]));
      a0 = a1;
    });
    return root;
  }

  // Dessin à la largeur réelle (texte lisible sur téléphone), redessiné quand la largeur change.
  let lastW = 0;
  const ro = new ResizeObserver((entries) => {
    if (!canvas.isConnected) { ro.disconnect(); return; }
    const w = Math.floor(entries[0].contentRect.width);
    if (w && Math.abs(w - lastW) > 4) { lastW = w; draw(w); }
  });
  ro.observe(canvas);
  return wrap;
}
