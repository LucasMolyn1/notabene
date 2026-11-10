// Base (tableau) : colonnes typées, lignes modifiables sur place, vues (tri, filtres, colonnes masquées), export CSV.
// Les droits viennent du serveur (`canWrite`) ; ici on ne fait qu'afficher et envoyer. Aucune valeur n'est insérée comme HTML.
import { api } from './api.js';
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { pagePath } from './urls.js';
import { closePopover, confirmModal, openMenu, openModal, openPopover, pageIcon, toast } from './ui.js';
import { applyView, descendantsOf, flattenTree, fmtDate, fmtRollup, fold, textOf } from './base-model.js';
import { SCALES, timelineEl } from './timeline.js';
import { calendarEl } from './calendar.js';
import { crumbsFor, setView, topbar } from './views.js';
import * as A from './actions.js';

const main = () => document.getElementById('main');
const PAGE_SIZE = 300;
const CARD_TYPE = 'application/x-notabene-card';

export const TYPE_LABELS = {
  text: 'Texte', number: 'Nombre', date: 'Date', select: 'Sélection', multi_select: 'Multi-sélection',
  status: 'Statut', checkbox: 'Case à cocher', person: 'Personne', page_link: 'Lien vers une page', formula: 'Formule',
  relation: 'Relation', rollup: 'Cumul',
};
const ROLLUP_FNS = { count: 'Nombre de liens', sum: 'Somme', avg: 'Moyenne', min: 'Minimum', max: 'Maximum', percent_checked: 'Pourcentage coché' };
const MAX_LINKS = 50;
const MAX_BLOCKERS = 10;
const PICK_SHOWN = 200;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const COLORS = { gray: 'Gris', red: 'Rouge', orange: 'Orange', yellow: 'Jaune', green: 'Vert', blue: 'Bleu', purple: 'Violet', pink: 'Rose' };
const OPERATORS = {
  text: [['contains', 'contient'], ['eq', 'est'], ['neq', 'n’est pas'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  date: [['eq', 'le'], ['gt', 'après le'], ['lt', 'avant le'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  option: [['eq', 'est'], ['neq', 'n’est pas'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  multi: [['contains', 'contient'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  checkbox: [['eq', 'est']],
  link: [['contains', 'contient'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
  formula: [['contains', 'contient'], ['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']],
};
const opKind = (t) => ({ text: 'text', number: 'number', date: 'date', select: 'option', status: 'option', multi_select: 'multi', checkbox: 'checkbox', person: 'link', page_link: 'link', formula: 'formula', relation: 'link', rollup: 'number' }[t]);
// replaceChildren transforme null, false et les tableaux en texte : on aplatit et on écarte avant.
const put = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter(Boolean));

export async function showBase(initial) {
  const id = initial.id;
  let data = null;
  let activeView = null;
  let shown = PAGE_SIZE;
  let editing = false;
  const laneShown = new Map(); // cartes affichées par colonne (Kanban)
  let pendingFocus = null; // cellule à refocaliser après le rendu qui suit une saisie
  let destroyed = false;
  let lastOwnWrite = 0; // les écritures de cet écran reviennent aussi par le flux : on n'y réagit pas
  let localConfigs = {}; // lecteurs : réglages de vue gardés en mémoire seulement
  // Sous-éléments repliés et état de la chronologie (défilement, présentation) : gardés d'un rendu à l'autre.
  const tree = { collapsed: new Set(), tl: {}, cal: {} };
  const targets = new Map(); // bases liées par une relation, lues à la demande

  const body = h('div', { class: 'bt-body' });
  const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Fil d’Ariane' });
  // Annonce aux lecteurs d'écran (déplacement d'une carte) : la région vit hors du tableau, que chaque rendu reconstruit.
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const announce = (text) => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); };
  const root = h('div', { class: 'scroller' }, h('div', { class: 'page-wrap bt-wrap' }, body, live));
  main().replaceChildren(topbar(crumbsEl, []), root);
  document.title = `${initial.title || 'Base'} · BeNote`;

  const canWrite = () => !!data?.canWrite;
  const props = () => data.properties;
  const propById = (pid) => props().find((p) => p.id === pid);
  const view = () => data.views.find((v) => v.id === activeView) ?? data.views[0];
  // Une colonne supprimée par quelqu'un d'autre ne doit rester ni dans un filtre ni dans un tri.
  const config = () => {
    const c = localConfigs[view().id] ?? view().config;
    const known = (pid) => !!propById(pid);
    if (c.type === 'calendar') {
      const dated = (pid) => propById(pid)?.type === 'date';
      return {
        type: 'calendar', mode: c.mode === 'week' ? 'week' : 'month',
        ...(dated(c.dateId) ? { dateId: c.dateId } : {}), ...(dated(c.endId) ? { endId: c.endId } : {}),
        sort: c.sort.filter((x) => known(x.propertyId)), filters: c.filters.filter((x) => known(x.propertyId)), hidden: c.hidden.filter(known),
      };
    }
    if (c.type === 'timeline') {
      const groupable = (pid) => { const p = pid && propById(pid); return !!p && (p.type === 'select' || p.type === 'status'); };
      return {
        type: 'timeline', scale: SCALES[c.scale] ? c.scale : 'week',
        ...(groupable(c.groupBy) ? { groupBy: c.groupBy } : {}), ...(groupable(c.colorBy) ? { colorBy: c.colorBy } : {}),
        sort: c.sort.filter((x) => known(x.propertyId)), filters: c.filters.filter((x) => known(x.propertyId)), hidden: c.hidden.filter(known),
      };
    }
    const group = c.groupBy && propById(c.groupBy);
    const board = c.type === 'kanban' && group && (group.type === 'select' || group.type === 'status');
    return { type: board ? 'kanban' : 'table', ...(board ? { groupBy: c.groupBy } : {}), sort: c.sort.filter((x) => known(x.propertyId)), filters: c.filters.filter((x) => known(x.propertyId)), hidden: c.hidden.filter(known) };
  };
  const fail = (err) => toast(err?.message || 'Une erreur est survenue', { kind: 'error' });

  async function load(silent = false) {
    try {
      data = await api.get(`/bases/${id}`);
    } catch (err) {
      if (!silent) { body.replaceChildren(h('div', { class: 'empty big' }, h('h2', null, 'Base introuvable'), h('p', { class: 'muted' }, err.status === 404 ? 'Elle a été supprimée, ou vous n’y avez pas accès.' : 'Impossible de la charger.'))); }
      return;
    }
    if (destroyed) return;
    targets.clear();
    if (!data.views.some((v) => v.id === activeView)) activeView = data.views[0]?.id ?? null;
    render();
  }

  const visibleRows = () => applyView(props(), data.rows, config());

  // ---- Vue : enregistrement (écrivains) ou mémoire locale (lecteurs) ----
  // Un envoi différé par vue : passer à une autre vue pendant l'attente ne perd pas le réglage de la première.
  const saveTimers = new Map();
  function saveConfig(viewId) {
    clearTimeout(saveTimers.get(viewId));
    saveTimers.set(viewId, setTimeout(async () => {
      saveTimers.delete(viewId);
      const v = data?.views.find((x) => x.id === viewId);
      if (!v || destroyed) return;
      try { await api.patch(`/bases/${id}/views/${viewId}`, { config: v.config }); } catch (err) { fail(err); load(true); }
    }, 500));
  }
  function setConfig(next) {
    if (canWrite()) { view().config = next; saveConfig(view().id); } else localConfigs[view().id] = next;
    render();
  }

  // ---- Cellules ----
  const badge = (p, oid) => {
    const o = p.options.find((x) => x.id === oid);
    return o && h('span', { class: `bt-badge c-${o.color}` }, o.name);
  };
  function display(p, v) {
    if (v === undefined || v === null) return null;
    switch (p.type) {
      case 'select': case 'status': return badge(p, v);
      case 'multi_select': return h('span', { class: 'bt-badges' }, v.map((x) => badge(p, x)));
      case 'person': return h('span', { class: 'bt-person' }, v.name);
      case 'page_link': return h('a', { class: 'bt-link', href: pagePath({ id: v.id, title: v.title }), onClick: (e) => e.stopPropagation() }, v.title || 'Sans titre');
      case 'date': return fmtDate(v);
      case 'number': return String(v);
      case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
      case 'relation': return Array.isArray(v) && v.length ? h('span', { class: 'bt-badges' }, v.map((x) => h('span', { class: 'bt-rel' }, x.title || 'Sans titre'))) : null;
      case 'rollup': return fmtRollup(p, v) || null;
      default: return String(v);
    }
  }
  const titleProp = () => props()[0];
  const titleOf = (row) => (row ? textOf(titleProp(), row.values[titleProp().id]) || 'Sans titre' : '');
  const rowById = (rid) => data.rows.find((r) => r.id === rid);

  /** Base liée par une relation (lecture avec les droits de la personne connectée), gardée jusqu'au prochain chargement. */
  function targetBase(tid) {
    if (tid === id) return Promise.resolve(data);
    if (!targets.has(tid)) {
      const pr = api.get(`/bases/${tid}`);
      pr.catch(() => targets.delete(tid));
      targets.set(tid, pr);
    }
    return targets.get(tid);
  }

  /** Modification d'une ligne (valeurs, parent, « Bloqué par ») ; les lignes décalées par les dépendances reviennent avec la réponse. */
  async function patchRow(row, body) {
    lastOwnWrite = Date.now();
    try {
      const res = await api.patch(`/bases/${id}/rows/${row.id}`, body);
      const merge = (r) => { const i = data.rows.findIndex((x) => x.id === r?.id); if (i >= 0) data.rows[i] = r; };
      merge(res?.row ?? res);
      const shifted = Array.isArray(res?.shifted) ? res.shifted : [];
      shifted.forEach(merge);
      if (shifted.length) announce(`${plural(shifted.length, 'ligne décalée', 'lignes décalées')} par les dépendances`);
    } catch (err) {
      editing = false;
      fail(err);
      await load(true);
      return false;
    }
    editing = false;
    render();
    // Un cumul peut dépendre de la ligne modifiée (relation vers cette même base) : relecture discrète.
    if (props().some((p) => p.type === 'rollup')) reloadSoon();
    return true;
  }
  const commit = (row, p, value) => patchRow(row, { values: { [p.id]: value } });

  /**
   * Choix de plusieurs lignes (relation, « Bloqué par ») : recherche, cases à cocher, plafond.
   * @param {HTMLElement} anchor @param {{ title: string, items: { id: string, label: string }[], chosen: Set<string>, max: number, onApply: (ids: string[]) => void }} o
   */
  function rowChooser(anchor, { title, items, chosen, max, onApply }) {
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher', 'aria-label': `Rechercher (${title})`, maxlength: '60' });
    const list = h('div', { class: 'bt-pick', role: 'group', 'aria-label': title });
    const status = h('p', { class: 'muted bt-pad', role: 'status' });
    // Les lignes déjà choisies à l'ouverture d'abord (ordre fixe ensuite : cocher ne déplace rien).
    const first = new Set(chosen);
    const ordered = [...items].sort((a, b) => Number(first.has(b.id)) - Number(first.has(a.id)));
    const draw = () => {
      const term = fold(q.value.trim());
      const found = ordered.filter((it) => !term || fold(it.label).includes(term));
      const full = chosen.size >= max;
      put(list, found.length ? found.slice(0, PICK_SHOWN).map((it) => {
        const cb = h('input', { type: 'checkbox', id: `bt-pick-${it.id}`, disabled: full && !chosen.has(it.id) });
        cb.checked = chosen.has(it.id);
        cb.addEventListener('change', () => { if (cb.checked) chosen.add(it.id); else chosen.delete(it.id); draw(); document.getElementById(cb.id)?.focus(); });
        return h('label', { class: 'menu-item', for: cb.id }, cb, h('span', { class: 'menu-label' }, it.label));
      }) : h('p', { class: 'muted bt-pad' }, items.length ? 'Aucune ligne ne correspond.' : 'Aucune ligne disponible.'));
      status.textContent = `${chosen.size} sur ${max} au plus${found.length > PICK_SHOWN ? ` ; ${found.length} résultats, affinez la recherche` : ''}`;
    };
    q.addEventListener('input', draw);
    draw();
    openPopover(anchor, h('div', { class: 'bt-pop' }, q, list, status, h('div', { class: 'bt-pop-foot' },
      h('button', { class: 'btn btn-primary btn-sm', onClick: () => { closePopover(); onApply([...chosen]); } }, 'Appliquer'))), { className: 'bt-popover' });
    q.focus();
  }
  // Un menu fermé sans choix (clic ailleurs, Échap) ramène l'affichage normal.
  const watchClose = () => {
    const watch = setInterval(() => { if (!document.querySelector('.popover')) { clearInterval(watch); if (editing) { editing = false; render(); } } }, 200);
  };

  async function editRelation(cell, row, p) {
    let target;
    try { target = await targetBase(p.config.targetId); } catch (err) { editing = false; fail(err); render(); return; }
    if (destroyed) return;
    const tp = target.properties.find((x) => x.type === 'text');
    const items = target.rows.filter((r) => r.id !== row.id).map((r) => ({ id: r.id, label: (tp ? textOf(tp, r.values[tp.id]) : '') || 'Sans titre' }));
    rowChooser(cell, {
      title: `Lignes de ${p.config.targetTitle || 'la base liée'}`, items, max: data.limits?.links ?? MAX_LINKS,
      chosen: new Set((row.values[p.id] ?? []).map((x) => x.id)),
      onApply: (ids) => commit(row, p, ids.length ? ids : null),
    });
    watchClose();
  }

  function editBlockers(cell, row) {
    editing = true;
    pendingFocus = { rowId: row.id, propId: '__blocked' };
    // Les cycles (A bloque B qui bloque A) sont refusés par le serveur, avec un message.
    rowChooser(cell, {
      title: `Bloqué par (${titleOf(row)})`, max: data.limits?.blockers ?? MAX_BLOCKERS,
      items: data.rows.filter((r) => r.id !== row.id).map((r) => ({ id: r.id, label: titleOf(r) })),
      chosen: new Set(row.blockedBy ?? []),
      onApply: (ids) => patchRow(row, { blockedBy: ids }),
    });
    watchClose();
  }

  /** @param {{ value: string, label: string }[]} items @param {(v: string | null) => void} onPick @param {{ none?: string }} [opts] */
  function pickerList(items, onPick, { none } = /** @type {{ none?: string }} */ ({})) {
    return h('div', { class: 'bt-pick' }, none && h('button', { class: 'menu-item', onClick: () => onPick(null) }, h('span', { class: 'menu-label muted' }, none)),
      items.map((it) => h('button', { class: 'menu-item', onClick: () => onPick(it.value) }, h('span', { class: 'menu-label' }, it.label))));
  }

  function editCell(cell, row, p) {
    if (!canWrite()) return;
    const v = row.values[p.id];
    editing = true;
    pendingFocus = { rowId: row.id, propId: p.id };
    const done = () => { editing = false; render(); };
    switch (p.type) {
      case 'text': case 'number': case 'date': {
        const input = h('input', {
          class: 'input bt-input', type: p.type === 'text' ? 'text' : p.type, maxlength: p.type === 'text' ? '2000' : null,
          step: p.type === 'number' ? 'any' : null, 'aria-label': p.name,
        });
        input.value = v === undefined ? '' : String(v);
        let finished = false;
        const save = () => {
          if (finished) return;
          finished = true;
          const raw = input.value.trim();
          const next = raw === '' ? null : p.type === 'number' ? Number(raw) : raw;
          if (p.type === 'number' && next !== null && !Number.isFinite(next)) { done(); return; }
          if ((next ?? undefined) === v) done(); else commit(row, p, next);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); finished = true; done(); }
        });
        input.addEventListener('blur', save);
        cell.replaceChildren(input);
        input.focus();
        input.select?.();
        break;
      }
      case 'select': case 'status': {
        const sel = h('select', { class: 'input bt-input', 'aria-label': p.name },
          h('option', { value: '' }, '—'), p.options.map((o) => h('option', { value: o.id }, o.name)));
        sel.value = v ?? '';
        sel.addEventListener('change', () => commit(row, p, sel.value || null));
        sel.addEventListener('blur', () => setTimeout(() => { if (editing && document.activeElement !== sel) done(); }, 120));
        sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
        cell.replaceChildren(sel);
        sel.focus();
        break;
      }
      case 'multi_select': {
        const chosen = new Set(v ?? []);
        const list = h('div', { class: 'bt-pick' }, p.options.length ? p.options.map((o) => {
          const cb = h('input', { type: 'checkbox', id: `bt-${row.id}-${o.id}` });
          cb.checked = chosen.has(o.id);
          cb.addEventListener('change', () => { if (cb.checked) chosen.add(o.id); else chosen.delete(o.id); });
          return h('label', { class: 'menu-item', for: cb.id }, cb, badge(p, o.id));
        }) : h('p', { class: 'muted bt-pad' }, 'Aucune option. Ajoutez-en depuis le menu de la colonne.'));
        const pop = openPopover(cell, h('div', null, list, h('div', { class: 'bt-pop-foot' },
          h('button', { class: 'btn btn-primary btn-sm', onClick: () => { closePopover(); commit(row, p, chosen.size ? [...chosen] : null); } }, 'Appliquer'))));
        pop.querySelector('input')?.focus();
        break;
      }
      case 'person': {
        const q = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une personne', 'aria-label': 'Rechercher une personne', maxlength: '40' });
        const results = h('div', null);
        const run = debounce(async () => {
          try {
            const { items } = await api.get(`/pages/${id}/mentionable?q=${encodeURIComponent(q.value.trim())}`);
            results.replaceChildren(pickerList(items.map((u) => ({ value: u.id, label: u.name })), (uid) => { closePopover(); commit(row, p, uid); }, { none: 'Personne' }));
          } catch (err) { fail(err); }
        }, 200);
        q.addEventListener('input', run);
        openPopover(cell, h('div', { class: 'bt-pop' }, q, results));
        run();
        q.focus();
        break;
      }
      case 'page_link': {
        const q = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une page', 'aria-label': 'Rechercher une page', maxlength: '60' });
        const results = h('div', null);
        const run = debounce(async () => {
          const term = q.value.trim();
          try {
            const items = term ? (await api.get(`/search?q=${encodeURIComponent(term)}&limit=10`)).items.filter((x) => x.id !== id) : [];
            results.replaceChildren(pickerList(items.map((x) => ({ value: x.id, label: x.title || 'Sans titre' })), (pid) => { closePopover(); commit(row, p, pid); }, { none: 'Aucune page' }));
          } catch (err) { fail(err); }
        }, 250);
        q.addEventListener('input', run);
        openPopover(cell, h('div', { class: 'bt-pop' }, q, results));
        run();
        q.focus();
        break;
      }
      case 'relation': editRelation(cell, row, p); break;
      default: break;
    }
    // Un menu fermé sans choix (clic ailleurs, Échap) ramène l'affichage normal.
    if (['multi_select', 'person', 'page_link'].includes(p.type)) {
      const watch = setInterval(() => { if (!document.querySelector('.popover')) { clearInterval(watch); if (editing) done(); } }, 200);
    }
  }

  // Une colonne calculée (formule, cumul) ne se modifie pas ; une relation vers une base illisible non plus.
  const editable = (p) => canWrite() && p.type !== 'formula' && p.type !== 'rollup' && (p.type !== 'relation' || p.config?.targetTitle != null);

  /** @param {any} row @param {any} p @param {any[] | null} [prefix] éléments placés avant la valeur (arborescence des sous-éléments) */
  function cellEl(row, p, prefix = null) {
    const v = row.values[p.id];
    const wrap = (td, ...inner) => { if (prefix) td.append(h('div', { class: 'bt-tree' }, prefix, inner)); else td.append(...inner.filter((x) => x != null)); return td; };
    if (p.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox', 'aria-label': p.name, disabled: !canWrite() });
      cb.checked = v === true;
      cb.addEventListener('change', () => commit(row, p, cb.checked ? true : null));
      return wrap(h('td', { class: 'bt-cell bt-check' }), cb);
    }
    const content = display(p, v);
    const td = h('td', { class: `bt-cell bt-t-${p.type}` });
    if (editable(p)) {
      const shownText = textOf(p, v);
      const btn = h('button', { class: 'bt-cell-btn', 'data-prop': p.id, 'aria-label': shownText ? `${shownText} (modifier ${p.name})` : `Modifier ${p.name}`, onClick: () => editCell(td, row, p) }, content ?? h('span', { class: 'bt-placeholder' }, ' '));
      return wrap(td, btn);
    }
    return wrap(td, prefix ? h('span', { class: 'bt-tree-text' }, content ?? '') : content ?? '');
  }

  /** Cellule « Bloqué par » (réglage Dépendances de la base). */
  function blockedCell(row) {
    const names = (row.blockedBy ?? []).map((b) => rowById(b)).filter(Boolean).map(titleOf);
    const content = names.length ? h('span', { class: 'bt-badges' }, names.map((n) => h('span', { class: 'bt-rel' }, n))) : null;
    const td = h('td', { class: 'bt-cell bt-t-blocked' });
    if (!canWrite()) { td.append(content ?? ''); return td; }
    td.append(h('button', {
      class: 'bt-cell-btn', 'data-prop': '__blocked', 'aria-label': names.length ? `Bloqué par ${names.join(', ')} (modifier)` : 'Modifier Bloqué par',
      onClick: () => editBlockers(td, row),
    }, content ?? h('span', { class: 'bt-placeholder' }, ' ')));
    return td;
  }

  // ---- Colonnes ----
  function propertyForm(existing) {
    const name = h('input', { class: 'input', maxlength: '60', 'aria-label': 'Nom de la colonne' });
    name.value = existing?.name ?? '';
    const type = h('select', { class: 'input', 'aria-label': 'Type', disabled: !!existing }, Object.entries(TYPE_LABELS).map(([k, l]) => h('option', { value: k }, l)));
    type.value = existing?.type ?? 'text';
    const formula = h('textarea', { id: 'bt-formula', class: 'input bt-formula-input', rows: '3', maxlength: '500', spellcheck: 'false', 'aria-describedby': 'bt-formula-help bt-formula-error', placeholder: 'prop("Prix") * prop("Quantité")' });
    formula.value = existing?.formula ?? '';
    const formulaHelp = h('p', { id: 'bt-formula-help', class: 'muted bt-formula-help' }, 'Lisez une colonne avec prop("Nom"). Opérateurs : + - * / % == != < > <= >= && || !. Fonctions : if, round, floor, ceil, abs, min, max, length, upper, lower, concat, contains, isEmpty, number, text, dateDiff, year, month. Une cellule vide donne un résultat vide.');
    const errorEl = h('p', { id: 'bt-formula-error', class: 'notice warning', role: 'alert', hidden: true });
    const formulaBox = h('div', { class: 'field' }, h('label', { for: 'bt-formula' }, 'Formule'), formula, errorEl, formulaHelp);

    // Relation : base cible choisie à la création (elle ne change plus ensuite), relation double facultative.
    const bases = store.spaces.flatMap((sp) => store.pagesIn(sp.id)).filter((pg) => pg.kind === 'base')
      .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : (a.title || '').localeCompare(b.title || '', 'fr')));
    if (!bases.some((b) => b.id === id)) bases.unshift({ id, title: data.page.title });
    const target = h('select', { id: 'bt-rel-target', class: 'input' }, bases.map((b) => h('option', { value: b.id }, b.id === id ? `${b.title || 'Sans titre'} (cette base)` : b.title || 'Sans titre')));
    const twoWay = h('input', { type: 'checkbox', id: 'bt-rel-two' });
    const relationBox = h('div', { class: 'stack' }, existing
      ? h('p', { class: 'muted' }, existing.type === 'relation' ? `Base liée : ${existing.config?.targetTitle ?? 'inaccessible pour vous'}. La base liée ne peut pas être changée.` : '')
      : [h('div', { class: 'field' }, h('label', { for: target.id }, 'Base liée'), target),
        h('label', { class: 'zip-check', for: twoWay.id }, twoWay, h('span', null, h('strong', null, 'Relation double'),
          h('span', { class: 'muted' }, 'Ajoute aussi une colonne dans la base liée, qui montre les liens dans l’autre sens. Il faut pouvoir modifier la base liée.')))]);

    // Cumul : relation de cette base, colonne de la base liée, calcul.
    const relations = props().filter((x) => x.type === 'relation' && x.id !== existing?.id);
    const rollRel = h('select', { id: 'bt-roll-rel', class: 'input' }, relations.map((x) => h('option', { value: x.id }, x.name)));
    const rollProp = h('select', { id: 'bt-roll-prop', class: 'input' });
    const rollFn = h('select', { id: 'bt-roll-fn', class: 'input' });
    const rollNote = h('p', { class: 'muted bt-formula-help', role: 'status' });
    let targetProps = [];
    const drawFns = () => {
      const tp = targetProps.find((x) => x.id === rollProp.value);
      const allowed = !tp ? ['count'] : tp.type === 'number' ? ['count', 'sum', 'avg', 'min', 'max'] : tp.type === 'checkbox' ? ['count', 'percent_checked'] : ['count'];
      const keep = allowed.includes(rollFn.value) ? rollFn.value : (allowed.includes(existing?.config?.fn) ? existing.config.fn : allowed[1] ?? 'count');
      rollFn.replaceChildren(...allowed.map((k) => h('option', { value: k }, ROLLUP_FNS[k])));
      rollFn.value = keep;
    };
    const loadTargetProps = async (first) => {
      const rel = propById(rollRel.value);
      targetProps = [];
      rollProp.replaceChildren(h('option', { value: '' }, 'Aucune (compter les liens)'));
      rollNote.textContent = '';
      if (rel) {
        try {
          const t = await targetBase(rel.config.targetId);
          targetProps = t.properties.filter((x) => x.type === 'number' || x.type === 'checkbox');
          rollProp.append(...targetProps.map((x) => h('option', { value: x.id }, `${x.name} (${TYPE_LABELS[x.type]})`)));
        } catch { rollNote.textContent = 'La base liée n’est pas lisible : seul le nombre de liens est possible.'; }
      }
      if (first && existing?.config?.targetPropertyId && targetProps.some((x) => x.id === existing.config.targetPropertyId)) rollProp.value = existing.config.targetPropertyId;
      drawFns();
    };
    rollRel.addEventListener('change', () => loadTargetProps(false));
    rollProp.addEventListener('change', drawFns);
    if (existing?.type === 'rollup' && relations.some((x) => x.id === existing.config?.relationId)) rollRel.value = existing.config.relationId;
    const rollupBox = h('div', { class: 'stack' }, relations.length
      ? [h('div', { class: 'field' }, h('label', { for: rollRel.id }, 'Relation'), rollRel),
        h('div', { class: 'field' }, h('label', { for: rollProp.id }, 'Colonne de la base liée'), rollProp),
        h('div', { class: 'field' }, h('label', { for: rollFn.id }, 'Calcul'), rollFn), rollNote,
        h('p', { class: 'muted bt-formula-help' }, 'Somme, moyenne, minimum et maximum portent sur une colonne Nombre ; le pourcentage, sur une Case à cocher. Seules les lignes que vous pouvez lire comptent.')]
      : h('p', { class: 'notice warning' }, 'Ajoutez d’abord une colonne Relation : un cumul calcule sur les lignes liées.'));
    const isRelation = () => type.value === 'relation';
    const isRollup = () => type.value === 'rollup';
    let rollupLoaded = false;
    const showLinked = () => {
      relationBox.hidden = !isRelation();
      rollupBox.hidden = !isRollup();
      if (isRollup() && !rollupLoaded && relations.length) { rollupLoaded = true; loadTargetProps(true); }
    };
    const optionsHost = h('div', { class: 'bt-options' });
    let opts = (existing?.options ?? []).map((o) => ({ ...o }));
    const hasOptions = () => ['select', 'multi_select', 'status'].includes(type.value);
    const isFormula = () => type.value === 'formula';
    const showFormula = () => { formulaBox.hidden = !isFormula(); };
    const drawOptions = () => {
      optionsHost.replaceChildren();
      if (!hasOptions()) return;
      optionsHost.append(h('div', { class: 'muted bt-opt-title' }, 'Options'));
      opts.forEach((o, i) => {
        const n = h('input', { class: 'input', maxlength: '40', 'aria-label': `Option ${i + 1}` });
        n.value = o.name;
        n.addEventListener('input', () => { o.name = n.value; });
        const c = h('select', { class: 'input bt-color', 'aria-label': `Couleur de l’option ${i + 1}` }, Object.entries(COLORS).map(([k, l]) => h('option', { value: k }, l)));
        c.value = o.color;
        c.addEventListener('change', () => { o.color = c.value; });
        optionsHost.append(h('div', { class: 'row bt-opt' }, h('span', { class: `bt-dot c-${o.color}` }), n, c,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Retirer l’option ${i + 1}`, onClick: () => { opts.splice(i, 1); drawOptions(); } }, icon('x', 14))));
      });
      optionsHost.append(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { opts.push({ name: '', color: 'gray' }); drawOptions(); } }, icon('plus', 14), 'Ajouter une option'));
    };
    type.addEventListener('change', () => { showFormula(); showLinked(); if (type.value === 'status' && !opts.length) opts = [{ name: 'À faire', color: 'gray' }, { name: 'En cours', color: 'blue' }, { name: 'Terminé', color: 'green' }]; drawOptions(); });
    drawOptions();
    showFormula();
    showLinked();
    const el = h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Nom'), name),
      h('label', { class: 'field' }, h('span', null, 'Type'), type),
      optionsHost, formulaBox, relationBox, rollupBox);
    const payload = () => ({
      name: name.value.trim(),
      ...(existing ? {} : { type: type.value }),
      ...(isFormula() ? { formula: formula.value.trim() } : {}),
      ...(isRelation() && !existing ? { config: { targetId: target.value, twoWay: twoWay.checked } } : {}),
      ...(isRollup() && relations.length ? { config: { relationId: rollRel.value, targetPropertyId: rollProp.value || null, fn: rollFn.value || 'count' } } : {}),
      ...(hasOptions() ? { options: opts.filter((o) => o.name.trim()).map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), color: o.color })) } : {}),
    });
    // Le message d'erreur s'affiche près du champ et est annoncé aux lecteurs d'écran ; le focus y revient.
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; if (isFormula()) formula.focus(); else toast(msg, { kind: 'error' }); };
    return { el, payload, focus: () => name.focus(), showError };
  }

  function openPropertyDialog(existing) {
    const f = propertyForm(existing);
    const m = openModal({
      title: existing ? 'Modifier la colonne' : 'Nouvelle colonne',
      body: f.el,
      actions: [{ label: 'Annuler' }, {
        label: existing ? 'Enregistrer' : 'Ajouter', primary: true,
        onClick: async () => {
          const payload = f.payload();
          if (!payload.name) { toast('Donnez un nom à la colonne', { kind: 'error' }); return false; }
          if (payload.type === 'rollup' && !payload.config) { toast('Ajoutez d’abord une colonne Relation', { kind: 'error' }); return false; }
          try {
            if (existing) await api.patch(`/bases/${id}/properties/${existing.id}`, payload);
            else await api.post(`/bases/${id}/properties`, payload);
          } catch (err) { f.showError(err?.message || 'Une erreur est survenue'); return false; }
          await load(true);
        },
      }],
    });
    f.focus();
    return m;
  }

  function propertyMenu(anchor, p) {
    const c = config();
    const sorted = c.sort.find((s) => s.propertyId === p.id);
    const sortBy = (dir) => setConfig({ ...c, sort: [{ propertyId: p.id, dir }, ...c.sort.filter((s) => s.propertyId !== p.id)].slice(0, 3) });
    openMenu(anchor, [
      { label: 'Trier de A à Z', icon: 'chevrons', checked: sorted?.dir === 'asc', onClick: () => sortBy('asc') },
      { label: 'Trier de Z à A', icon: 'chevrons', checked: sorted?.dir === 'desc', onClick: () => sortBy('desc') },
      { label: 'Masquer la colonne', icon: 'eye', onClick: () => setConfig({ ...c, hidden: [...c.hidden, p.id] }) },
      canWrite() && { sep: true },
      canWrite() && { label: p.type === 'rollup' ? 'Renommer, modifier le calcul' : p.type === 'relation' ? 'Renommer' : 'Renommer, modifier les options', icon: 'pencil', onClick: () => openPropertyDialog(p) },
      canWrite() && {
        label: 'Supprimer la colonne', icon: 'trash', danger: true,
        onClick: async () => {
          if (!await confirmModal({ title: 'Supprimer la colonne', message: `La colonne « ${p.name} » et toutes ses valeurs seront supprimées.`, confirm: 'Supprimer', danger: true })) return;
          try { await api.del(`/bases/${id}/properties/${p.id}`); await load(true); } catch (err) { fail(err); }
        },
      },
    ]);
  }

  // ---- Lignes ----
  async function addRow(values = {}, parentId = null) {
    lastOwnWrite = Date.now();
    try {
      const res = await api.post(`/bases/${id}/rows`, parentId ? { values, parentId } : { values });
      const row = res?.row ?? res;
      data.rows.push(row);
      if (parentId) tree.collapsed.delete(parentId);
      const type = config().type;
      pendingFocus = { rowId: row.id, card: type === 'kanban' };
      render();
      if (type === 'table') body.querySelector(`tr[data-row="${row.id}"] .bt-cell-btn`)?.focus();
      else announce(type === 'kanban' ? 'Carte ajoutée' : parentId ? 'Sous-élément ajouté' : 'Ligne ajoutée');
      return row;
    } catch (err) { fail(err); return null; }
  }
  async function removeRow(row) {
    const kids = descendantsOf(data.rows, row.id).size;
    const message = kids ? `Cette ligne et ${plural(kids, 'sous-élément', 'sous-éléments')} seront supprimés définitivement.` : 'Cette ligne sera supprimée définitivement.';
    if (!await confirmModal({ title: 'Supprimer la ligne', message, confirm: 'Supprimer', danger: true })) return;
    try {
      await api.post(`/bases/${id}/rows/delete`, { ids: [row.id] });
      // Les sous-éléments partent avec la ligne ; les dépendances qui la visaient sont nettoyées par le serveur.
      if (kids || data.settings?.dependencies) await load(true);
      else { data.rows = data.rows.filter((r) => r.id !== row.id); render(); }
    } catch (err) { fail(err); await load(true); }
  }

  /** Choix de l'élément parent : toute ligne sauf elle-même et ses descendants. */
  function chooseParent(anchor, row) {
    const banned = descendantsOf(data.rows, row.id);
    banned.add(row.id);
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une ligne', 'aria-label': 'Rechercher l’élément parent', maxlength: '60' });
    const results = h('div', null);
    const draw = () => {
      const term = fold(q.value.trim());
      const items = data.rows.filter((r) => !banned.has(r.id) && (!term || fold(titleOf(r)).includes(term))).slice(0, PICK_SHOWN);
      results.replaceChildren(pickerList(items.map((r) => ({ value: r.id, label: titleOf(r) })), (pid) => {
        closePopover();
        if (pid) tree.collapsed.delete(pid);
        patchRow(row, { parentId: pid });
      }, { none: 'Premier niveau (aucun parent)' }));
    };
    q.addEventListener('input', draw);
    draw();
    openPopover(anchor, h('div', { class: 'bt-pop' }, q, results), { className: 'bt-popover' });
    q.focus();
  }

  function rowMenu(anchor, row) {
    openMenu(anchor, [
      { label: 'Ajouter un sous-élément', icon: 'plus', disabled: data.rows.length >= data.limits.rows, onClick: () => addRow({}, row.id) },
      { label: 'Placer sous un autre élément', icon: 'move', onClick: () => chooseParent(anchor, row) },
      row.parentId && { label: 'Remonter au premier niveau', icon: 'chevrons', onClick: () => patchRow(row, { parentId: null }) },
      { sep: true },
      { label: 'Supprimer la ligne', icon: 'trash', danger: true, onClick: () => removeRow(row) },
    ]);
  }

  // ---- Réglages de la base : sous-éléments, dépendances, colonnes de la chronologie ----
  function openSettings() {
    const st = data.settings ?? {};
    const dates = props().filter((p) => p.type === 'date');
    const sub = h('input', { type: 'checkbox', id: 'bt-set-sub' });
    sub.checked = !!st.subitems;
    const dep = h('input', { type: 'checkbox', id: 'bt-set-dep' });
    dep.checked = !!st.dependencies;
    const start = h('select', { id: 'bt-set-start', class: 'input' }, h('option', { value: '' }, 'Aucune'), dates.map((p) => h('option', { value: p.id }, p.name)));
    start.value = dates.some((p) => p.id === st.startPropertyId) ? st.startPropertyId : '';
    const end = h('select', { id: 'bt-set-end', class: 'input' }, h('option', { value: '' }, 'Aucune (barre d’un jour)'), dates.map((p) => h('option', { value: p.id }, p.name)));
    end.value = dates.some((p) => p.id === st.endPropertyId) ? st.endPropertyId : '';
    const err = h('p', { class: 'notice warning', role: 'alert', hidden: true });
    const check = (cb, title, text) => h('label', { class: 'zip-check', for: cb.id }, cb, h('span', null, h('strong', null, title), h('span', { class: 'muted' }, text)));
    openModal({
      title: 'Réglages de la base',
      body: h('div', { class: 'stack' },
        check(sub, 'Sous-éléments', 'Une ligne peut contenir d’autres lignes, affichées en retrait (quatre niveaux au plus). Supprimer une ligne supprime ses sous-éléments.'),
        check(dep, 'Dépendances', 'Colonne « Bloqué par » : une ligne bloquée commence au plus tôt le lendemain de la fin de ce qui la bloque ; elle est décalée automatiquement.'),
        h('div', { class: 'field' }, h('label', { for: start.id }, 'Colonne de début (chronologie)'), start),
        h('div', { class: 'field' }, h('label', { for: end.id }, 'Colonne de fin (chronologie)'), end),
        !dates.length && h('p', { class: 'muted' }, 'Ajoutez une colonne Date pour utiliser la chronologie.'),
        err),
      actions: [{ label: 'Annuler' }, {
        label: 'Enregistrer', primary: true,
        onClick: async () => {
          if (end.value && !start.value) { err.textContent = 'Choisissez une colonne de début avant une colonne de fin.'; err.hidden = false; start.focus(); return false; }
          if (end.value && end.value === start.value) { err.textContent = 'Les colonnes de début et de fin doivent être différentes.'; err.hidden = false; end.focus(); return false; }
          try {
            await api.patch(`/bases/${id}/settings`, { subitems: sub.checked, dependencies: dep.checked, startPropertyId: start.value || null, endPropertyId: end.value || null });
          } catch (e) { err.textContent = e?.message || 'Une erreur est survenue'; err.hidden = false; return false; }
          await load(true);
        },
      }],
    });
    sub.focus();
  }

  // ---- Kanban : une colonne par option de la colonne de rangement, une carte par ligne ----
  function boardEl(c, rows) {
    const g = propById(c.groupBy);
    const titleProp = props()[0];
    const fields = props().filter((p) => p.id !== titleProp.id && p.id !== g.id && !c.hidden.includes(p.id)).slice(0, 3);
    const lanes = [...g.options.map((o) => ({ id: o.id, label: o.name, color: o.color })), { id: null, label: 'Sans valeur', color: 'gray' }];
    const move = (row, laneId) => {
      if ((row.values[g.id] ?? null) === laneId) return;
      pendingFocus = { rowId: row.id, card: true };
      const name = textOf(titleProp, row.values[titleProp.id]) || 'Sans titre';
      announce(`Carte « ${name} » déplacée vers ${lanes.find((l) => l.id === laneId)?.label ?? 'Sans valeur'}`);
      commit(row, g, laneId);
    };

    const card = (row, lane) => {
      const title = textOf(titleProp, row.values[titleProp.id]) || 'Sans titre';
      const head = h('div', { class: 'bt-card-head' });
      const titleEl = h('div', { class: 'bt-card-title' }, title);
      const el = h('li', { class: 'bt-card', 'data-row': row.id, draggable: canWrite() ? 'true' : null }, head,
        fields.map((p) => {
          const shown = display(p, row.values[p.id]);
          return shown && h('div', { class: 'bt-card-field' }, h('span', { class: 'muted' }, `${p.name} : `), shown);
        }),
        canWrite() && h('button', {
          class: 'icon-btn bt-card-menu', 'aria-label': `Actions de la carte ${title}`, title: 'Déplacer ou supprimer',
          onClick: (e) => openMenu(e.currentTarget, [
            { heading: 'Déplacer vers' },
            ...lanes.map((l) => ({ label: l.label, checked: l.id === lane.id, onClick: () => move(row, l.id) })),
            { sep: true },
            { label: 'Supprimer la carte', icon: 'trash', danger: true, onClick: () => removeRow(row) },
          ]),
        }, icon('more', 15)));
      // Le titre se modifie dans son propre conteneur ; pendant la saisie la carte n'est plus déplaçable (on peut alors cliquer et sélectionner dans le champ).
      if (canWrite() && titleProp.type === 'text') {
        head.append(h('button', { class: 'bt-card-name', 'aria-label': `${title} (modifier le titre)`, onClick: () => { el.removeAttribute('draggable'); editCell(head, row, titleProp); } }, titleEl));
      } else head.append(titleEl);
      if (canWrite()) {
        // Type propre à cette application, avec la base : un texte glissé depuis ailleurs n'est jamais pris pour une carte.
        el.addEventListener('dragstart', (e) => { e.dataTransfer.setData(CARD_TYPE, JSON.stringify({ baseId: id, rowId: row.id })); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
      }
      return el;
    };

    return h('div', { class: 'bt-board', role: 'group', 'aria-label': `Kanban, rangé par ${g.name}` }, lanes.map((lane) => {
      const inLane = rows.filter((r) => (r.values[g.id] ?? null) === lane.id);
      if (lane.id === null && !inLane.length && canWrite() === false) return null;
      const cap = laneShown.get(lane.id) ?? PAGE_SIZE;
      const list = h('ul', { class: 'bt-lane-list', 'aria-label': `${lane.label}, ${inLane.length} carte${inLane.length > 1 ? 's' : ''}` }, inLane.slice(0, cap).map((r) => card(r, lane)));
      const laneEl = h('section', { class: 'bt-lane', 'data-lane': lane.id ?? '' },
        h('header', { class: 'bt-lane-head' }, h('span', { class: `bt-dot c-${lane.color}` }), h('strong', null, lane.label), h('span', { class: 'muted' }, String(inLane.length))),
        list,
        inLane.length > cap && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { laneShown.set(lane.id, cap + PAGE_SIZE); render(); } }, `Afficher ${Math.min(PAGE_SIZE, inLane.length - cap)} cartes de plus (${cap} sur ${inLane.length})`),
        canWrite() && h('button', { class: 'btn btn-ghost btn-sm bt-lane-add', disabled: data.rows.length >= data.limits.rows, onClick: () => addRow(lane.id ? { [g.id]: lane.id } : {}) }, icon('plus', 14), `Nouvelle carte (${lane.label})`));
      if (canWrite()) {
        laneEl.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes(CARD_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; laneEl.classList.add('over'); });
        laneEl.addEventListener('dragleave', (e) => { if (!laneEl.contains(e.relatedTarget)) laneEl.classList.remove('over'); });
        laneEl.addEventListener('drop', (e) => {
          laneEl.classList.remove('over');
          if (!e.dataTransfer.types.includes(CARD_TYPE)) return;
          e.preventDefault();
          let drop = null;
          try { drop = JSON.parse(e.dataTransfer.getData(CARD_TYPE)); } catch { /* donnée étrangère */ }
          const row = drop?.baseId === id ? data.rows.find((r) => r.id === drop.rowId) : null;
          if (row) move(row, lane.id);
        });
      }
      return laneEl;
    }).filter(Boolean));
  }

  /** Choix de la colonne de rangement d'un Kanban (Sélection ou Statut). */
  function groupSelect(c) {
    const choices = props().filter((p) => p.type === 'status' || p.type === 'select');
    const sel = h('select', { class: 'input bt-group', 'aria-label': 'Ranger par' }, choices.map((p) => h('option', { value: p.id }, `Ranger par ${p.name}`)));
    sel.value = c.groupBy;
    sel.addEventListener('change', () => setConfig({ ...config(), groupBy: sel.value }));
    return sel;
  }

  // ---- Barre d'outils : vues, filtres, tri, colonnes ----
  function filterPopover(anchor) {
    const host = h('div', { class: 'bt-pop bt-filters' });
    const draw = () => {
      const c = config();
      put(host,
        c.filters.length ? null : h('p', { class: 'muted bt-pad' }, 'Aucun filtre.'),
        c.filters.map((f, i) => {
          const p = propById(f.propertyId);
          const col = h('select', { class: 'input', 'aria-label': 'Colonne' }, props().map((x) => h('option', { value: x.id }, x.name)));
          col.value = f.propertyId;
          const ops = OPERATORS[opKind(p.type)];
          const op = h('select', { class: 'input', 'aria-label': 'Condition' }, ops.map(([k, l]) => h('option', { value: k }, l)));
          op.value = f.op;
          const update = (patch) => { const next = c.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)); setConfig({ ...c, filters: next }); draw(); };
          col.addEventListener('change', () => { const np = propById(col.value); update({ propertyId: np.id, op: OPERATORS[opKind(np.type)][0][0], value: null }); });
          op.addEventListener('change', () => update({ op: op.value }));
          let valueEl = null;
          if (f.op !== 'empty' && f.op !== 'notempty') {
            if (p.type === 'checkbox') {
              valueEl = h('select', { class: 'input', 'aria-label': 'Valeur' }, h('option', { value: 'true' }, 'coché'), h('option', { value: 'false' }, 'non coché'));
              valueEl.value = String(f.value === true);
              valueEl.addEventListener('change', () => update({ value: valueEl.value === 'true' }));
            } else if (['select', 'status', 'multi_select'].includes(p.type)) {
              valueEl = h('select', { class: 'input', 'aria-label': 'Valeur' }, p.options.map((o) => h('option', { value: o.id }, o.name)));
              valueEl.value = f.value ?? p.options[0]?.id ?? '';
              if (f.value == null && p.options[0]) queueMicrotask(() => update({ value: p.options[0].id }));
              valueEl.addEventListener('change', () => update({ value: valueEl.value }));
            } else {
              valueEl = h('input', { class: 'input', type: p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text', maxlength: '200', 'aria-label': 'Valeur', step: p.type === 'number' ? 'any' : null });
              valueEl.value = f.value ?? '';
              valueEl.addEventListener('change', () => update({ value: p.type === 'number' ? (valueEl.value === '' ? null : Number(valueEl.value)) : valueEl.value }));
            }
          }
          return h('div', { class: 'row bt-filter' }, col, op, valueEl,
            h('button', { class: 'icon-btn', 'aria-label': 'Retirer le filtre', onClick: () => { setConfig({ ...c, filters: c.filters.filter((_, j) => j !== i) }); draw(); } }, icon('x', 14)));
        }),
        h('div', { class: 'bt-pop-foot' }, h('button', {
          class: 'btn btn-ghost btn-sm', disabled: c.filters.length >= 10,
          onClick: () => { const p = props()[0]; setConfig({ ...c, filters: [...c.filters, { propertyId: p.id, op: OPERATORS[opKind(p.type)][0][0], value: ['select', 'status', 'multi_select'].includes(p.type) ? p.options[0]?.id ?? null : p.type === 'checkbox' ? true : '' }] }); draw(); },
        }, icon('plus', 14), 'Ajouter un filtre')));
    };
    draw();
    openPopover(anchor, host, { className: 'bt-popover' });
  }

  function sortPopover(anchor) {
    const host = h('div', { class: 'bt-pop bt-filters' });
    const draw = () => {
      const c = config();
      put(host,
        c.sort.length ? null : h('p', { class: 'muted bt-pad' }, 'Aucun tri.'),
        c.sort.map((s, i) => {
          const col = h('select', { class: 'input', 'aria-label': 'Colonne' }, props().map((x) => h('option', { value: x.id }, x.name)));
          col.value = s.propertyId;
          const dir = h('select', { class: 'input', 'aria-label': 'Sens' }, h('option', { value: 'asc' }, 'croissant'), h('option', { value: 'desc' }, 'décroissant'));
          dir.value = s.dir;
          const update = (patch) => { setConfig({ ...c, sort: c.sort.map((x, j) => (j === i ? { ...x, ...patch } : x)) }); draw(); };
          col.addEventListener('change', () => update({ propertyId: col.value }));
          dir.addEventListener('change', () => update({ dir: dir.value }));
          return h('div', { class: 'row bt-filter' }, col, dir,
            h('button', { class: 'icon-btn', 'aria-label': 'Retirer le tri', onClick: () => { setConfig({ ...c, sort: c.sort.filter((_, j) => j !== i) }); draw(); } }, icon('x', 14)));
        }),
        h('div', { class: 'bt-pop-foot' }, h('button', {
          class: 'btn btn-ghost btn-sm', disabled: c.sort.length >= 3,
          onClick: () => { const used = new Set(c.sort.map((s) => s.propertyId)); const p = props().find((x) => !used.has(x.id)) ?? props()[0]; setConfig({ ...c, sort: [...c.sort, { propertyId: p.id, dir: 'asc' }] }); draw(); },
        }, icon('plus', 14), 'Ajouter un tri')));
    };
    draw();
    openPopover(anchor, host, { className: 'bt-popover' });
  }

  function columnsPopover(anchor) {
    const c = config();
    const host = h('div', { class: 'bt-pick' }, props().map((p) => {
      const cb = h('input', { type: 'checkbox', id: `bt-col-${p.id}` });
      cb.checked = !c.hidden.includes(p.id);
      cb.addEventListener('change', () => { const cur = config(); setConfig({ ...cur, hidden: cb.checked ? cur.hidden.filter((x) => x !== p.id) : [...cur.hidden, p.id] }); });
      return h('label', { class: 'menu-item', for: cb.id }, cb, h('span', { class: 'menu-label' }, p.name));
    }));
    openPopover(anchor, host, { className: 'bt-popover' });
  }

  function viewTabs() {
    return h('div', { class: 'bt-views' }, h('div', { class: 'bt-tabs', role: 'tablist', 'aria-label': 'Vues' }, data.views.map((v) => {
      const active = v.id === view().id;
      return h('button', {
        class: `bt-view${active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(active),
        onClick: (e) => { if (active && canWrite()) viewMenu(e.currentTarget, v); else { activeView = v.id; render(); } },
      }, v.name, active && canWrite() && icon('chevron', 12));
    })), canWrite() && data.views.length < 10 && h('button', {
      class: 'icon-btn', 'aria-label': 'Nouvelle vue', title: 'Nouvelle vue',
      onClick: (e) => {
        const groupable = props().find((p) => p.type === 'status' || p.type === 'select');
        const dated = props().find((p) => p.type === 'date');
        const create = async (name, config) => {
          try { const v = await api.post(`/bases/${id}/views`, { name, config }); activeView = v.id; await load(true); } catch (err) { fail(err); }
        };
        openMenu(e.currentTarget, [
          { label: 'Nouveau tableau', icon: 'table', onClick: () => create(`Vue ${data.views.length + 1}`, { type: 'table', sort: [], filters: [], hidden: [] }) },
          { label: groupable ? 'Nouveau Kanban' : 'Kanban : ajoutez une colonne Statut ou Sélection', icon: 'layers', disabled: !groupable, onClick: () => create('Kanban', { type: 'kanban', groupBy: groupable.id, sort: [], filters: [], hidden: [] }) },
          {
            label: dated ? 'Nouvelle chronologie' : 'Chronologie : ajoutez une colonne Date', icon: 'calendar', disabled: !dated,
            onClick: async () => {
              // Sans colonne de début réglée, la première colonne Date de la base sert de début.
              if (!propById(data.settings?.startPropertyId)) {
                try { await api.patch(`/bases/${id}/settings`, { startPropertyId: dated.id }); } catch (err) { fail(err); return; }
              }
              create('Chronologie', { type: 'timeline', scale: 'week', sort: [], filters: [], hidden: [] });
            },
          },
          { label: dated ? 'Nouveau calendrier' : 'Calendrier : ajoutez une colonne Date', icon: 'calendar', disabled: !dated, onClick: () => create('Calendrier', { type: 'calendar', mode: 'month', sort: [], filters: [], hidden: [] }) },
        ]);
      },
    }, icon('plus', 15)));
  }

  function viewMenu(anchor, v) {
    openMenu(anchor, [
      {
        label: 'Renommer la vue', icon: 'pencil',
        onClick: () => {
          const input = h('input', { class: 'input', maxlength: '60', 'aria-label': 'Nom de la vue' });
          input.value = v.name;
          openModal({ title: 'Renommer la vue', body: input, actions: [{ label: 'Annuler' }, {
            label: 'Enregistrer', primary: true,
            onClick: async () => { const name = input.value.trim(); if (!name) return false; try { await api.patch(`/bases/${id}/views/${v.id}`, { name }); await load(true); } catch (err) { fail(err); return false; } },
          }] });
          input.focus();
        },
      },
      data.views.length > 1 && {
        label: 'Supprimer la vue', icon: 'trash', danger: true,
        onClick: async () => { try { await api.del(`/bases/${id}/views/${v.id}`); await load(true); } catch (err) { fail(err); } },
      },
    ]);
  }

  // ---- Progression : lignes terminées (dernière option du statut, ou case cochée), recalculée après chaque écriture ----
  function progressEl() {
    const pr = data.progress;
    if (!pr) return null;
    const p = propById(pr.propertyId);
    let done = pr.done;
    let total = pr.total;
    if (p && (p.type === 'status' || p.type === 'checkbox')) {
      const lastOpt = p.type === 'status' ? p.options.at(-1)?.id : undefined;
      total = data.rows.length;
      done = data.rows.filter((r) => (p.type === 'status' ? lastOpt !== undefined && r.values[p.id] === lastOpt : r.values[p.id] === true)).length;
    }
    if (!total) return null;
    const pct = Math.round((done / total) * 100);
    const label = `${done} sur ${total} terminées`;
    return h('div', { class: 'bt-progress' },
      h('div', { class: 'bt-progress-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-valuetext': `${label} (${pct} %)` },
        h('span', { class: 'bt-progress-fill', style: { width: `${pct}%` } })),
      h('span', { class: 'bt-progress-text', 'aria-hidden': 'true' }, `${label} (${pct} %)`));
  }

  // ---- Rendu ----
  function render() {
    if (destroyed || !data) return;
    const c = config();
    const cols = props().filter((p) => !c.hidden.includes(p.id));
    const rows = visibleRows();
    const page = data.page;
    crumbsEl.replaceChildren(...crumbsFor({ ...page, ...(store.page(id) ?? {}) }));

    const titleEl = h('input', { class: 'bt-title', 'aria-label': 'Titre de la base', placeholder: 'Sans titre', maxlength: '300', disabled: !canWrite() });
    titleEl.value = store.page(id)?.title ?? page.title;
    titleEl.addEventListener('change', () => A.attempt(() => store.updatePage(id, { title: titleEl.value })).then(() => { document.title = `${titleEl.value || 'Base'} · BeNote`; }));
    const iconBtn = h('button', { class: 'page-icon', title: 'Changer l’icône', disabled: !canWrite(), onClick: (e) => A.pickIcon(e.currentTarget, id) }, pageIcon(store.page(id)?.icon || 'table', 26));

    const filtersOn = c.filters.length;
    const subitems = !!data.settings?.subitems;
    const deps = !!data.settings?.dependencies;
    const head = h('thead', null, h('tr', null,
      cols.map((p) => h('th', { scope: 'col', class: `bt-th bt-t-${p.type}` },
        h('button', { class: 'bt-th-btn', title: `${p.name} (${TYPE_LABELS[p.type]})`, onClick: (e) => propertyMenu(e.currentTarget, p) },
          h('span', { class: 'bt-th-name' }, p.name),
          c.sort.some((s) => s.propertyId === p.id) && h('span', { class: 'bt-sort', 'aria-hidden': 'true' }, c.sort.find((s) => s.propertyId === p.id).dir === 'asc' ? '↑' : '↓')))),
      deps && h('th', { scope: 'col', class: 'bt-th bt-t-blocked' }, h('span', { class: 'bt-th-btn' }, h('span', { class: 'bt-th-name' }, 'Bloqué par'))),
      canWrite() && h('th', { scope: 'col', class: 'bt-th bt-add-col' }, h('button', {
        class: 'icon-btn', 'aria-label': 'Ajouter une colonne', title: 'Ajouter une colonne', disabled: props().length >= data.limits.properties,
        onClick: () => openPropertyDialog(null),
      }, icon('plus', 15))),
      canWrite() && h('th', { scope: 'col', class: 'bt-th bt-row-actions-th' }, h('span', { class: 'sr-only' }, 'Actions'))));

    // Sous-éléments : arborescence (retrait, repli) ; sinon une ligne par niveau 1.
    const lines = subitems ? flattenTree(rows, tree.collapsed) : rows.map((row) => ({ row, level: 1, parent: null, childCount: 0 }));
    const treePrefix = (l) => {
      if (!subitems) return null;
      const open = !tree.collapsed.has(l.row.id);
      const title = titleOf(l.row);
      return [
        l.level > 1 && h('span', { class: 'bt-indent', style: { width: `${(l.level - 1) * 18}px` } }),
        l.childCount ? h('button', {
          class: `icon-btn bt-toggle${open ? ' open' : ''}`, 'aria-expanded': String(open), 'data-focus-key': `toggle-${l.row.id}`,
          'aria-label': `${open ? 'Replier' : 'Déplier'} les sous-éléments de ${title} (${l.childCount})`,
          onClick: () => { if (open) tree.collapsed.add(l.row.id); else tree.collapsed.delete(l.row.id); render(); },
        }, icon('chevron', 13)) : h('span', { class: 'bt-toggle-space' }),
        l.level > 1 && h('span', { class: 'sr-only' }, `Sous-élément de ${titleOf(l.parent)} : `),
      ];
    };
    const shownRows = lines.slice(0, shown);
    const tbody = h('tbody', null, shownRows.map((l) => h('tr', { 'data-row': l.row.id },
      cols.map((p, i) => cellEl(l.row, p, i === 0 ? treePrefix(l) : null)),
      deps && blockedCell(l.row),
      canWrite() && h('td', { class: 'bt-cell bt-row-more' }, subitems && h('button', {
        class: 'icon-btn', 'aria-label': `Actions de la ligne ${titleOf(l.row)}`, title: 'Sous-éléments', onClick: (e) => rowMenu(e.currentTarget, l.row),
      }, icon('more', 14))),
      canWrite() && h('td', { class: 'bt-cell bt-row-actions' }, h('button', { class: 'icon-btn', 'aria-label': 'Supprimer la ligne', title: 'Supprimer la ligne', onClick: () => removeRow(l.row) }, icon('trash', 14))))));

    const mainEl = c.type === 'kanban' ? boardEl(c, rows)
      : c.type === 'timeline' ? timelineEl({ data, rows, config: c, canWrite: canWrite(), titleOf, state: tree, patchRow, setConfig, openSettings, announce })
        : c.type === 'calendar' ? calendarEl({ baseId: id, data, rows, config: c, canWrite: canWrite(), titleOf, state: tree, patchRow, addRow, removeRow, setConfig, announce })
        : h('div', { class: 'bt-scroll' }, h('table', { class: 'bt-table', 'aria-label': 'Lignes de la base', 'aria-rowcount': String(lines.length + 1) }, head, tbody));
    // Le focus survit au rendu : élément repéré par une clé, ou barre de la chronologie.
    const active = document.activeElement;
    const inside = active && body.contains(active);
    const focusKey = inside ? active.closest('[data-focus-key]')?.getAttribute('data-focus-key') : null;
    if (inside && active.closest('.tl-lines')) tree.tl.refocus = true;
    body.replaceChildren(...[
      h('div', { class: 'bt-head' }, iconBtn, titleEl),
      progressEl(),
      h('div', { class: 'bt-toolbar' },
        viewTabs(),
        h('div', { class: 'bt-tools' },
          c.type === 'kanban' && groupSelect(c),
          h('button', { class: `btn btn-ghost btn-sm${filtersOn ? ' active' : ''}`, onClick: (e) => filterPopover(e.currentTarget) }, `Filtrer${filtersOn ? ` (${filtersOn})` : ''}`),
          h('button', { class: `btn btn-ghost btn-sm${c.sort.length ? ' active' : ''}`, onClick: (e) => sortPopover(e.currentTarget) }, `Trier${c.sort.length ? ` (${c.sort.length})` : ''}`),
          c.type !== 'timeline' && c.type !== 'calendar' && h('button', { class: `btn btn-ghost btn-sm${c.hidden.length ? ' active' : ''}`, onClick: (e) => columnsPopover(e.currentTarget) }, `Colonnes${c.hidden.length ? ` (${props().length - c.hidden.length}/${props().length})` : ''}`),
          h('a', { class: 'btn btn-ghost btn-sm', href: `/api/v3/bases/${id}/export`, download: '' }, icon('download', 14), 'CSV'),
          canWrite() && h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Réglages de la base', title: 'Sous-éléments, dépendances, chronologie', onClick: () => openSettings() }, icon('settings', 14), 'Réglages'))),
      mainEl,
      rows.length === 0 && h('p', { class: 'muted bt-empty' }, data.rows.length ? 'Aucune ligne ne correspond aux filtres.' : 'Aucune ligne pour le moment.'),
      c.type === 'table' && lines.length > shown && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { shown += PAGE_SIZE; render(); } }, `Afficher ${Math.min(PAGE_SIZE, lines.length - shown)} lignes de plus (${shown} sur ${lines.length})`),
      h('div', { class: 'bt-foot' },
        canWrite() && c.type !== 'kanban' && h('button', { class: 'btn btn-ghost btn-sm', disabled: data.rows.length >= data.limits.rows, onClick: () => addRow() }, icon('plus', 14), 'Nouvelle ligne'),
        h('span', { class: 'muted' }, `${data.rows.length} ${data.rows.length > 1 ? 'lignes' : 'ligne'}${rows.length !== data.rows.length ? `, ${rows.length} affichées` : ''}`)),
    ].filter(Boolean));
    if (pendingFocus?.card && !editing) {
      const card = body.querySelector(`li[data-row="${pendingFocus.rowId}"]`);
      pendingFocus = null;
      (card?.querySelector('.bt-card-name') ?? card?.querySelector('.bt-card-menu'))?.focus();
    } else if (pendingFocus && !editing) {
      const target = [...body.querySelectorAll(`tr[data-row="${pendingFocus.rowId}"] .bt-cell-btn, li[data-row="${pendingFocus.rowId}"] .bt-card-name`)].find((b) => !b.dataset.prop || b.dataset.prop === pendingFocus.propId);
      pendingFocus = null;
      target?.focus();
    } else if (focusKey && !editing) {
      /** @type {HTMLElement} */ (body.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`))?.focus();
    }
  }

  // Un autre écran a modifié la base : on recharge, sauf pendant une saisie (la saisie prime, le rechargement suivra).
  const reloadSoon = debounce(() => { if (!editing && !destroyed) load(true); }, 400);
  const onRemote = (e) => {
    const evt = e.detail;
    // Un autre écran du même compte compte aussi : on ne saute que l'écho d'une écriture faite à l'instant ici.
    if (evt?.pageId !== id) return;
    if (evt.by?.id === session.user?.id && Date.now() - lastOwnWrite < 1500) return;
    reloadSoon();
  };
  window.addEventListener('notabene:base', onRemote);

  setView({
    kind: 'base',
    id,
    destroy() { destroyed = true; for (const t of saveTimers.values()) clearTimeout(t); window.removeEventListener('notabene:base', onRemote); closePopover(); },
    onStore() { if (!destroyed && data && !editing) render(); },
  });
  await load();
}
