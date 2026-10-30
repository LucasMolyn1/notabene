// Sélecteur d'icône de page ou d'espace : les icônes de l'interface et tous les emojis (noms et mots-clés en français).
// Les données (emojibase, ~600 Ko) ne se chargent qu'à la première ouverture. La valeur enregistrée est soit le nom
// d'une icône (« folder »), soit le caractère emoji lui-même.
import { h, norm } from './util.js';
import { icon } from './icons.js';
import { closePopover, openPopover, PAGE_ICONS, ICON_LABELS } from './ui.js';

const RECENT_KEY = 'notabene:recent-emojis';
const RECENT_MAX = 16;
const COLUMNS = 8;

// Groupes d'emojibase (0 à 9 ; 2 = composants, écartés), avec le libellé français et un emoji pour l'onglet.
const GROUPS = [
  { id: 0, label: 'Visages et émotions', tab: '😀' }, { id: 1, label: 'Personnes et corps', tab: '👋' }, { id: 3, label: 'Animaux et nature', tab: '🐻' },
  { id: 4, label: 'Nourriture et boissons', tab: '🍔' }, { id: 5, label: 'Voyages et lieux', tab: '🚗' }, { id: 6, label: 'Activités', tab: '⚽' },
  { id: 7, label: 'Objets', tab: '💡' }, { id: 8, label: 'Symboles', tab: '❤️' }, { id: 9, label: 'Drapeaux', tab: '🏁' },
];

const readRecents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string').slice(0, RECENT_MAX); } catch { return []; } };
const pushRecent = (value) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([value, ...readRecents().filter((x) => x !== value)].slice(0, RECENT_MAX))); } catch { /* navigation privée */ } };

let dataset = null;
async function loadEmojis() {
  dataset ||= import('emojibase-data/fr/compact.json').then((m) => /** @type {any[]} */ (m.default ?? m)
    .filter((e) => e.group !== undefined && e.group !== 2 && e.unicode.length <= 16)
    .map((e) => ({ char: e.unicode, label: e.label, group: e.group, order: e.order ?? 0, search: norm(`${e.label} ${(e.tags ?? []).join(' ')}`) }))
    .sort((a, b) => a.order - b.order));
  return dataset;
}

/** @param {HTMLElement} anchor @param {(value: string) => void} onPick @param {{ allowRemove?: boolean }} [options] */
export function iconPicker(anchor, onPick, { allowRemove = true } = {}) {
  const pick = (value) => { if (value) pushRecent(value); closePopover(); onPick(value); };
  const search = h('input', { class: 'input emoji-search', type: 'search', placeholder: 'Rechercher un emoji…', 'aria-label': 'Rechercher un emoji', autocomplete: 'off' });
  const body = h('div', { class: 'emoji-body', tabindex: '-1' });
  const tabs = h('div', { class: 'emoji-tabs', role: 'group', 'aria-label': 'Catégories' });
  let all = [];

  const button = (value, label, content) => h('button', { class: 'emoji-btn', type: 'button', tabindex: '-1', 'aria-label': label, title: label, onClick: () => pick(value) }, content);
  const emojiBtn = (e) => button(e.char, e.label, e.char);
  const section = (id, title, buttons) => h('section', { class: 'emoji-section', 'data-group': id },
    h('h3', { class: 'emoji-title' }, title), h('div', { class: 'emoji-grid', role: 'group', 'aria-label': title }, buttons));

  const paint = () => {
    const q = norm(search.value.trim());
    body.replaceChildren();
    if (q) {
      const words = q.split(/\s+/);
      const iconHits = PAGE_ICONS.filter((n) => words.every((w) => norm(`${n} ${ICON_LABELS[n] ?? ''}`).includes(w)));
      const hits = all.filter((e) => words.every((w) => e.search.includes(w))).slice(0, 160);
      if (iconHits.length) body.append(section('icons', 'Icônes', iconHits.map((n) => button(n, ICON_LABELS[n] || n, icon(n, 20)))));
      if (hits.length) body.append(section('found', 'Emojis', hits.map(emojiBtn)));
      if (!iconHits.length && !hits.length) body.append(h('p', { class: 'muted emoji-empty' }, `Aucun résultat pour « ${search.value.trim()} »`));
    } else {
      const recents = readRecents();
      if (recents.length) {
        body.append(section('recent', 'Récents', recents.map((v) => (PAGE_ICONS.includes(v) ? button(v, ICON_LABELS[v] || v, icon(v, 20)) : button(v, all.find((e) => e.char === v)?.label || v, v)))));
      }
      body.append(section('icons', 'Icônes', PAGE_ICONS.map((n) => button(n, ICON_LABELS[n] || n, icon(n, 20)))));
      if (!all.length) body.append(h('p', { class: 'muted emoji-empty' }, 'Chargement des emojis…'));
      for (const g of GROUPS) {
        const list = all.filter((e) => e.group === g.id);
        if (list.length) body.append(section(g.id, g.label, list.map(emojiBtn)));
      }
    }
    // Un seul arrêt de tabulation dans la grille, les flèches font le reste.
    body.querySelector('.emoji-btn')?.setAttribute('tabindex', '0');
  };

  const tab = (id, label, content) => h('button', { class: 'emoji-tab', type: 'button', 'aria-label': label, title: label, onClick: () => {
    search.value = '';
    paint();
    body.querySelector(`[data-group="${id}"]`)?.scrollIntoView({ block: 'start' });
  } }, content);
  tabs.append(tab('icons', 'Icônes', icon('layers', 16)), ...GROUPS.map((g) => tab(g.id, g.label, g.tab)));

  const random = () => {
    const pool = all.length ? all.map((e) => e.char) : PAGE_ICONS;
    pick(pool[Math.floor(Math.random() * pool.length)]);
  };
  const foot = h('div', { class: 'emoji-foot' },
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: random }, icon('wand', 14), ' Au hasard'),
    allowRemove && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => pick('') }, 'Retirer'));

  const el = openPopover(anchor, h('div', { class: 'emoji-picker' }, search, tabs, body, foot));
  paint();
  search.focus();
  search.addEventListener('input', paint);

  // Flèches dans la grille (par ligne de COLUMNS), depuis le champ de recherche (flèche bas) ou un bouton.
  el.addEventListener('keydown', (e) => {
    const buttons = [...body.querySelectorAll('.emoji-btn')];
    const i = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
    if (!move) return;
    if (i < 0) { if (e.key === 'ArrowDown' && document.activeElement === search) { e.preventDefault(); buttons[0]?.focus(); } return; }
    e.preventDefault();
    const next = buttons[i + move];
    if (next) { buttons.forEach((b) => b.setAttribute('tabindex', '-1')); next.setAttribute('tabindex', '0'); next.focus(); }
    else if (move < 0) search.focus();
  });

  loadEmojis().then((list) => { all = list; if (el.isConnected) paint(); }).catch(() => { body.append(h('p', { class: 'muted emoji-empty' }, 'Liste des emojis indisponible.')); });
}
