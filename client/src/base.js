// Base (tableau) : colonnes typées, lignes modifiables sur place, vues (tri, filtres, colonnes masquées), export CSV.
// Les droits viennent du serveur (`canWrite`) ; ici on ne fait qu'afficher et envoyer. Aucune valeur n'est insérée comme HTML.
import { api } from './api.js';
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { pagePath } from './urls.js';
import { closePopover, confirmModal, openMenu, openModal, openPopover, pageIcon, toast } from './ui.js';
import { crumbsFor, setView, topbar } from './views.js';
import * as A from './actions.js';

const main = () => document.getElementById('main');
const PAGE_SIZE = 300;

export const TYPE_LABELS = {
  text: 'Texte', number: 'Nombre', date: 'Date', select: 'Sélection', multi_select: 'Multi-sélection',
  status: 'Statut', checkbox: 'Case à cocher', person: 'Personne', page_link: 'Lien vers une page', formula: 'Formule',
};
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
const opKind = (t) => ({ text: 'text', number: 'number', date: 'date', select: 'option', status: 'option', multi_select: 'multi', checkbox: 'checkbox', person: 'link', page_link: 'link', formula: 'formula' }[t]);
// replaceChildren transforme null, false et les tableaux en texte : on aplatit et on écarte avant.
const put = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter(Boolean));
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
const fmtDate = (s) => { const d = new Date(`${s}T00:00:00`); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('fr-FR'); };

export async function showBase(initial) {
  const id = initial.id;
  let data = null;
  let activeView = null;
  let shown = PAGE_SIZE;
  let editing = false;
  let pendingFocus = null; // cellule à refocaliser après le rendu qui suit une saisie
  let destroyed = false;
  let lastOwnWrite = 0; // les écritures de cet écran reviennent aussi par le flux : on n'y réagit pas
  let localConfigs = {}; // lecteurs : réglages de vue gardés en mémoire seulement

  const body = h('div', { class: 'bt-body' });
  const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Fil d’Ariane' });
  const root = h('div', { class: 'scroller' }, h('div', { class: 'page-wrap bt-wrap' }, body));
  main().replaceChildren(topbar(crumbsEl, []), root);
  document.title = `${initial.title || 'Base'} · Notabene`;

  const canWrite = () => !!data?.canWrite;
  const props = () => data.properties;
  const propById = (pid) => props().find((p) => p.id === pid);
  const view = () => data.views.find((v) => v.id === activeView) ?? data.views[0];
  // Une colonne supprimée par quelqu'un d'autre ne doit rester ni dans un filtre ni dans un tri.
  const config = () => {
    const c = localConfigs[view().id] ?? view().config;
    const known = (pid) => !!propById(pid);
    return { sort: c.sort.filter((x) => known(x.propertyId)), filters: c.filters.filter((x) => known(x.propertyId)), hidden: c.hidden.filter(known) };
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
    if (!data.views.some((v) => v.id === activeView)) activeView = data.views[0]?.id ?? null;
    render();
  }

  // ---- Valeurs : texte affiché, comparaison, filtre ----
  const optName = (p, oid) => p.options.find((o) => o.id === oid)?.name ?? '';
  function textOf(p, v) {
    if (v === undefined || v === null) return '';
    switch (p.type) {
      case 'checkbox': return v ? 'oui' : 'non';
      case 'formula': return typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v);
      case 'select': case 'status': return optName(p, v);
      case 'multi_select': return v.map((x) => optName(p, x)).join(', ');
      case 'person': return v.name;
      case 'page_link': return v.title || 'Sans titre';
      case 'date': return fmtDate(v);
      default: return String(v);
    }
  }
  const isEmpty = (p, v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (p.type === 'checkbox' && v !== true);
  function matches(row, f) {
    const p = propById(f.propertyId);
    if (!p) return true;
    const v = row.values[p.id];
    if (f.op === 'empty') return isEmpty(p, v);
    if (f.op === 'notempty') return !isEmpty(p, v);
    const want = f.value;
    switch (p.type) {
      case 'text': case 'person': case 'page_link': {
        const t = fold(textOf(p, v));
        const w = fold(want);
        return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : t !== w;
      }
      case 'formula': {
        const n = Number(want);
        if (typeof v === 'number' && want !== null && want !== '' && Number.isFinite(n)) return f.op === 'eq' ? v === n : f.op === 'neq' ? v !== n : f.op === 'gt' ? v > n : f.op === 'lt' ? v < n : textOf(p, v).includes(String(want));
        const t = fold(textOf(p, v));
        const w = fold(want);
        return f.op === 'contains' ? t.includes(w) : f.op === 'eq' ? t === w : f.op === 'neq' ? t !== w : f.op === 'gt' ? t > w : t < w;
      }
      case 'number': {
        if (v === undefined) return f.op === 'neq';
        const n = Number(want);
        return f.op === 'eq' ? v === n : f.op === 'neq' ? v !== n : f.op === 'gt' ? v > n : v < n;
      }
      case 'date': return v !== undefined && (f.op === 'eq' ? v === want : f.op === 'gt' ? v > want : v < want);
      case 'checkbox': return (v === true) === (want === true);
      case 'select': case 'status': return f.op === 'eq' ? v === want : v !== want;
      case 'multi_select': return Array.isArray(v) && v.includes(want);
      default: return true;
    }
  }
  function compare(a, b, p) {
    const va = a.values[p.id];
    const vb = b.values[p.id];
    if (isEmpty(p, va) && isEmpty(p, vb)) return 0;
    if (isEmpty(p, va)) return 1; // les cellules vides vont toujours en dernier
    if (isEmpty(p, vb)) return -1;
    if (p.type === 'number' || (p.type === 'formula' && typeof va === 'number' && typeof vb === 'number')) return va - vb;
    if (p.type === 'date') return va < vb ? -1 : va > vb ? 1 : 0;
    if (p.type === 'checkbox') return Number(va === true) - Number(vb === true);
    if (p.type === 'select' || p.type === 'status') return p.options.findIndex((o) => o.id === va) - p.options.findIndex((o) => o.id === vb);
    return textOf(p, va).localeCompare(textOf(p, vb), 'fr', { numeric: true, sensitivity: 'base' });
  }
  function visibleRows() {
    const c = config();
    let rows = data.rows.filter((r) => c.filters.every((f) => matches(r, f)));
    for (const s of [...c.sort].reverse()) {
      const p = propById(s.propertyId);
      if (!p) continue;
      const dir = s.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const ea = isEmpty(p, a.values[p.id]);
        const eb = isEmpty(p, b.values[p.id]);
        if (ea || eb) return compare(a, b, p); // vides toujours en dernier, quel que soit le sens
        return dir * compare(a, b, p);
      });
    }
    return rows;
  }

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
      default: return String(v);
    }
  }

  async function commit(row, p, value) {
    lastOwnWrite = Date.now();
    try {
      const updated = await api.patch(`/bases/${id}/rows/${row.id}`, { values: { [p.id]: value } });
      const i = data.rows.findIndex((r) => r.id === row.id);
      if (i >= 0 && updated) data.rows[i] = updated;
    } catch (err) {
      editing = false;
      fail(err);
      await load(true);
      return;
    }
    editing = false;
    render();
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
      default: break;
    }
    // Un menu fermé sans choix (clic ailleurs, Échap) ramène l'affichage normal.
    if (['multi_select', 'person', 'page_link'].includes(p.type)) {
      const watch = setInterval(() => { if (!document.querySelector('.popover')) { clearInterval(watch); if (editing) done(); } }, 200);
    }
  }

  function cellEl(row, p) {
    const v = row.values[p.id];
    if (p.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox', 'aria-label': p.name, disabled: !canWrite() });
      cb.checked = v === true;
      cb.addEventListener('change', () => commit(row, p, cb.checked ? true : null));
      return h('td', { class: 'bt-cell bt-check' }, cb);
    }
    const content = display(p, v);
    const td = h('td', { class: `bt-cell bt-t-${p.type}` });
    // Une colonne calculée ne se modifie pas : pas de bouton, le résultat est du texte.
    if (canWrite() && p.type !== 'formula') {
      const shownText = textOf(p, v);
      const btn = h('button', { class: 'bt-cell-btn', 'data-prop': p.id, 'aria-label': shownText ? `${shownText} (modifier ${p.name})` : `Modifier ${p.name}`, onClick: () => editCell(td, row, p) }, content ?? h('span', { class: 'bt-placeholder' }, ' '));
      td.append(btn);
    } else td.append(content ?? '');
    return td;
  }

  // ---- Colonnes ----
  function propertyForm(existing) {
    const name = h('input', { class: 'input', maxlength: '60', 'aria-label': 'Nom de la colonne' });
    name.value = existing?.name ?? '';
    const type = h('select', { class: 'input', 'aria-label': 'Type', disabled: !!existing }, Object.entries(TYPE_LABELS).map(([k, l]) => h('option', { value: k }, l)));
    type.value = existing?.type ?? 'text';
    const formula = h('textarea', { class: 'input bt-formula-input', rows: '3', maxlength: '500', spellcheck: 'false', 'aria-label': 'Formule', placeholder: 'prop("Prix") * prop("Quantité")' });
    formula.value = existing?.formula ?? '';
    const formulaHelp = h('p', { class: 'muted bt-formula-help' }, 'Lisez une colonne avec prop("Nom"). Opérateurs : + - * / % == != < > <= >= && || !. Fonctions : if, round, floor, ceil, abs, min, max, length, upper, lower, concat, contains, isEmpty, number, text, dateDiff, year, month. Une cellule vide donne un résultat vide.');
    const formulaBox = h('div', { class: 'field' }, h('span', null, 'Formule'), formula, formulaHelp);
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
    type.addEventListener('change', () => { showFormula(); if (type.value === 'status' && !opts.length) opts = [{ name: 'À faire', color: 'gray' }, { name: 'En cours', color: 'blue' }, { name: 'Terminé', color: 'green' }]; drawOptions(); });
    drawOptions();
    showFormula();
    const el = h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Nom'), name),
      h('label', { class: 'field' }, h('span', null, 'Type'), type),
      optionsHost, formulaBox);
    const payload = () => ({
      name: name.value.trim(),
      ...(existing ? {} : { type: type.value }),
      ...(isFormula() ? { formula: formula.value.trim() } : {}),
      ...(hasOptions() ? { options: opts.filter((o) => o.name.trim()).map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), color: o.color })) } : {}),
    });
    return { el, payload, focus: () => name.focus() };
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
          try {
            if (existing) await api.patch(`/bases/${id}/properties/${existing.id}`, payload);
            else await api.post(`/bases/${id}/properties`, payload);
          } catch (err) { fail(err); return false; }
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
      canWrite() && { label: 'Renommer, modifier les options', icon: 'pencil', onClick: () => openPropertyDialog(p) },
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
  async function addRow() {
    lastOwnWrite = Date.now();
    try {
      const row = await api.post(`/bases/${id}/rows`, { values: {} });
      data.rows.push(row);
      render();
      const first = body.querySelector(`tr[data-row="${row.id}"] .bt-cell-btn`);
      first?.focus();
    } catch (err) { fail(err); }
  }
  async function removeRow(row) {
    if (!await confirmModal({ title: 'Supprimer la ligne', message: 'Cette ligne sera supprimée définitivement.', confirm: 'Supprimer', danger: true })) return;
    try {
      await api.post(`/bases/${id}/rows/delete`, { ids: [row.id] });
      data.rows = data.rows.filter((r) => r.id !== row.id);
      render();
    } catch (err) { fail(err); await load(true); }
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
      onClick: async () => {
        try { const v = await api.post(`/bases/${id}/views`, { name: `Vue ${data.views.length + 1}`, config: { sort: [], filters: [], hidden: [] } }); activeView = v.id; await load(true); } catch (err) { fail(err); }
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
    titleEl.addEventListener('change', () => A.attempt(() => store.updatePage(id, { title: titleEl.value })).then(() => { document.title = `${titleEl.value || 'Base'} · Notabene`; }));
    const iconBtn = h('button', { class: 'page-icon', title: 'Changer l’icône', disabled: !canWrite(), onClick: (e) => A.pickIcon(e.currentTarget, id) }, pageIcon(store.page(id)?.icon || 'table', 26));

    const filtersOn = c.filters.length;
    const head = h('thead', null, h('tr', null,
      cols.map((p) => h('th', { scope: 'col', class: `bt-th bt-t-${p.type}` },
        h('button', { class: 'bt-th-btn', title: `${p.name} (${TYPE_LABELS[p.type]})`, onClick: (e) => propertyMenu(e.currentTarget, p) },
          h('span', { class: 'bt-th-name' }, p.name),
          c.sort.some((s) => s.propertyId === p.id) && h('span', { class: 'bt-sort', 'aria-hidden': 'true' }, c.sort.find((s) => s.propertyId === p.id).dir === 'asc' ? '↑' : '↓')))),
      canWrite() && h('th', { scope: 'col', class: 'bt-th bt-add-col' }, h('button', {
        class: 'icon-btn', 'aria-label': 'Ajouter une colonne', title: 'Ajouter une colonne', disabled: props().length >= data.limits.properties,
        onClick: () => openPropertyDialog(null),
      }, icon('plus', 15))),
      canWrite() && h('th', { scope: 'col', class: 'bt-th bt-row-actions-th' }, h('span', { class: 'sr-only' }, 'Actions'))));

    const shownRows = rows.slice(0, shown);
    const tbody = h('tbody', null, shownRows.map((row) => h('tr', { 'data-row': row.id },
      cols.map((p) => cellEl(row, p)),
      canWrite() && h('td', { class: 'bt-cell' }),
      canWrite() && h('td', { class: 'bt-cell bt-row-actions' }, h('button', { class: 'icon-btn', 'aria-label': 'Supprimer la ligne', title: 'Supprimer la ligne', onClick: () => removeRow(row) }, icon('trash', 14))))));

    body.replaceChildren(...[
      h('div', { class: 'bt-head' }, iconBtn, titleEl),
      h('div', { class: 'bt-toolbar' },
        viewTabs(),
        h('div', { class: 'bt-tools' },
          h('button', { class: `btn btn-ghost btn-sm${filtersOn ? ' active' : ''}`, onClick: (e) => filterPopover(e.currentTarget) }, `Filtrer${filtersOn ? ` (${filtersOn})` : ''}`),
          h('button', { class: `btn btn-ghost btn-sm${c.sort.length ? ' active' : ''}`, onClick: (e) => sortPopover(e.currentTarget) }, `Trier${c.sort.length ? ` (${c.sort.length})` : ''}`),
          h('button', { class: `btn btn-ghost btn-sm${c.hidden.length ? ' active' : ''}`, onClick: (e) => columnsPopover(e.currentTarget) }, `Colonnes${c.hidden.length ? ` (${props().length - c.hidden.length}/${props().length})` : ''}`),
          h('a', { class: 'btn btn-ghost btn-sm', href: `/api/v3/bases/${id}/export`, download: '' }, icon('download', 14), 'CSV'))),
      h('div', { class: 'bt-scroll' }, h('table', { class: 'bt-table', 'aria-label': 'Lignes de la base', 'aria-rowcount': String(rows.length + 1) }, head, tbody)),
      rows.length === 0 && h('p', { class: 'muted bt-empty' }, data.rows.length ? 'Aucune ligne ne correspond aux filtres.' : 'Aucune ligne pour le moment.'),
      rows.length > shown && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { shown += PAGE_SIZE; render(); } }, `Afficher ${Math.min(PAGE_SIZE, rows.length - shown)} lignes de plus (${shown} sur ${rows.length})`),
      h('div', { class: 'bt-foot' },
        canWrite() && h('button', { class: 'btn btn-ghost btn-sm', disabled: data.rows.length >= data.limits.rows, onClick: addRow }, icon('plus', 14), 'Nouvelle ligne'),
        h('span', { class: 'muted' }, `${data.rows.length} ${data.rows.length > 1 ? 'lignes' : 'ligne'}${rows.length !== data.rows.length ? `, ${rows.length} affichées` : ''}`)),
    ].filter(Boolean));
    if (pendingFocus && !editing) {
      const target = [...body.querySelectorAll(`tr[data-row="${pendingFocus.rowId}"] .bt-cell-btn`)].find((b) => b.dataset.prop === pendingFocus.propId);
      pendingFocus = null;
      target?.focus();
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
