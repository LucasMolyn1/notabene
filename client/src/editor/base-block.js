// Bloc « base » : affiche une base (tableau ou Kanban) dans une page, en lecture seule. Le bloc ne contient que l'identifiant de la base et
// celui de la vue ; le contenu est demandé au serveur à chaque affichage, avec les droits de la personne qui lit. Sans accès (ou sans
// compte), le bloc reste neutre : ni titre, ni cellule. Aucune valeur n'est insérée comme HTML.
import { Node, mergeAttributes } from '@tiptap/core';
import { api } from '../api.js';
import { applyView, textOf } from '../base-model.js';
import { h, debounce } from '../util.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { session } from '../session.js';
import { pagePath } from '../urls.js';
import { openModal, toast } from '../ui.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Un seul chargement par base, partagé par tous les blocs de la page (et réutilisé quelques secondes) : N blocs de la même base ne font pas N requêtes.
const FRESH_MS = 3000;
const loads = new Map();
const fetchBase = (baseId) => {
  const hit = loads.get(baseId);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = api.get(`/bases/${baseId}`);
  const entry = { at: Date.now(), promise };
  loads.set(baseId, entry);
  promise.catch(() => { if (loads.get(baseId) === entry) loads.delete(baseId); });
  return promise;
};
// Une modification annoncée par le serveur invalide le cache (un seul écouteur pour tous les blocs).
window.addEventListener('notabene:base', (e) => { const pageId = /** @type {CustomEvent} */ (e).detail?.pageId; if (pageId) loads.delete(pageId); });
const MAX_ROWS_SHOWN = 8;
const MAX_COLS_SHOWN = 6;

function snapshot(data, viewId) {
  const view = data.views.find((v) => v.id === viewId) ?? data.views[0];
  const known = (id) => data.properties.some((p) => p.id === id);
  const c = {
    type: view.config.type === 'kanban' && known(view.config.groupBy) ? 'kanban' : 'table',
    groupBy: view.config.groupBy,
    sort: view.config.sort.filter((s) => known(s.propertyId)),
    filters: view.config.filters.filter((f) => known(f.propertyId)),
    hidden: view.config.hidden.filter(known),
  };
  const rows = applyView(data.properties, data.rows, c);
  const props = data.properties.filter((p) => !c.hidden.includes(p.id));

  if (c.type === 'kanban') {
    const g = data.properties.find((p) => p.id === c.groupBy);
    const title = data.properties[0];
    const lanes = [...g.options.map((o) => ({ id: o.id, label: o.name, color: o.color })), { id: null, label: 'Sans valeur', color: 'gray' }];
    return h('div', { class: 'bt-board bt-mini', role: 'group', 'aria-label': `Kanban, rangé par ${g.name}` }, lanes.map((lane) => {
      const inLane = rows.filter((r) => (r.values[g.id] ?? null) === lane.id);
      if (lane.id === null && !inLane.length) return null;
      return h('section', { class: 'bt-lane', 'aria-label': `${lane.label}, ${inLane.length} carte${inLane.length > 1 ? 's' : ''}` },
        h('header', { class: 'bt-lane-head' }, h('span', { class: `bt-dot c-${lane.color}` }), h('strong', null, lane.label), h('span', { class: 'muted' }, String(inLane.length))),
        h('ul', { class: 'bt-lane-list' }, inLane.slice(0, MAX_ROWS_SHOWN).map((r) => h('li', { class: 'bt-card' }, h('div', { class: 'bt-card-title' }, textOf(title, r.values[title.id]) || 'Sans titre'))),
          inLane.length > MAX_ROWS_SHOWN && h('li', { class: 'muted' }, `… et ${inLane.length - MAX_ROWS_SHOWN} autres`)));
    }).filter(Boolean));
  }

  const cols = props.slice(0, MAX_COLS_SHOWN);
  return h('div', { class: 'bt-scroll bt-mini' }, h('table', { class: 'bt-table', 'aria-label': `Aperçu de la base ${data.page.title || ''}` },
    h('thead', null, h('tr', null, cols.map((p) => h('th', { scope: 'col', class: 'bt-th' }, h('span', { class: 'bt-th-btn' }, p.name))))),
    h('tbody', null, rows.slice(0, MAX_ROWS_SHOWN).map((r) => h('tr', null, cols.map((p) => h('td', { class: 'bt-cell' }, textOf(p, r.values[p.id]))))))),
  rows.length > MAX_ROWS_SHOWN && h('p', { class: 'muted bt-pad' }, `${rows.length - MAX_ROWS_SHOWN} lignes de plus dans la base`));
}

export const BaseBlock = Node.create({
  name: 'baseBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      id: { default: null, renderHTML: () => ({}), parseHTML: (el) => (ID.test(el.getAttribute('data-base') ?? '') ? el.getAttribute('data-base') : null) },
      view: { default: null, renderHTML: () => ({}), parseHTML: (el) => (ID.test(el.getAttribute('data-view') ?? '') ? el.getAttribute('data-view') : null) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-base-block]', getAttrs: (el) => (ID.test(el.getAttribute('data-base') ?? '') ? null : false) }]; },
  // Copie et export HTML : un repère sans contenu (le contenu d'une base ne quitte pas l'application avec le presse-papiers).
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-base-block': '', 'data-base': node.attrs.id ?? '', 'data-view': node.attrs.view ?? '', class: 'base-block' }), 'Base'];
  },
  renderText() { return ''; },

  addNodeView() {
    return ({ node }) => {
      const baseId = ID.test(String(node.attrs.id)) ? node.attrs.id : null;
      const viewId = ID.test(String(node.attrs.view)) ? node.attrs.view : null;
      const dom = h('div', { class: 'base-block', contenteditable: 'false', 'data-base-block': '' });
      let alive = true;

      const neutral = (text) => dom.replaceChildren(h('div', { class: 'embed-card' }, h('p', { class: 'muted' }, text)));
      async function paint() {
        if (!baseId || !session.user) { neutral('Base non affichée : connexion requise.'); return; }
        try {
          const data = await fetchBase(baseId);
          if (!alive) return;
          dom.replaceChildren(
            h('div', { class: 'embed-bar' },
              h('span', { class: 'embed-host' }, icon('table', 14), ` ${data.page.title || 'Sans titre'}`),
              h('a', { class: 'embed-open', href: pagePath({ id: baseId, title: data.page.title }) }, 'Ouvrir la base')),
            snapshot(data, viewId));
        } catch {
          if (alive) neutral('Base introuvable, ou vous n’y avez pas accès.');
        }
      }
      const later = debounce(paint, 500);
      const onRemote = (e) => { if (e.detail?.pageId === baseId) later(); };
      window.addEventListener('notabene:base', onRemote);
      paint();

      return {
        dom,
        stopEvent: () => false,
        ignoreMutation: () => true,
        destroy() { alive = false; later.cancel?.(); window.removeEventListener('notabene:base', onRemote); },
      };
    };
  },
});

// ---- Choix d'une base depuis le menu « / » ----

const allBases = () => store.spaces.flatMap((s) => store.pagesIn(s.id)).filter((p) => p.kind === 'base').sort((a, b) => (a.title || '').localeCompare(b.title || '', 'fr'));

/**
 * Propose les bases lisibles ; `onPick({ id, view })` reçoit la base choisie. Pour un Kanban, la vue Kanban de la base est utilisée
 * (ou créée si la base a une colonne Statut ou Sélection).
 */
export function pickBase({ kanban = false, spaceId }, onPick) {
  const bases = allBases();
  const list = h('div', { class: 'bt-pick', role: 'listbox', 'aria-label': 'Bases' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une base', 'aria-label': 'Rechercher une base', maxlength: '60' });
  let modal;
  const choose = async (page) => {
    modal.close();
    try {
      if (!kanban) { onPick({ id: page.id, view: null }); return; }
      const data = await api.get(`/bases/${page.id}`);
      let view = data.views.find((v) => v.config.type === 'kanban');
      if (!view) {
        const group = data.properties.find((p) => p.type === 'status' || p.type === 'select');
        if (!group) { toast('Cette base n’a pas de colonne Statut ou Sélection : ajoutez-en une pour en faire un Kanban.', { kind: 'error' }); return; }
        if (!data.canWrite) { toast('Cette base n’a pas de vue Kanban et vous ne pouvez pas la modifier.', { kind: 'error' }); return; }
        view = await api.post(`/bases/${page.id}/views`, { name: 'Kanban', config: { type: 'kanban', groupBy: group.id, sort: [], filters: [], hidden: [] } });
      }
      onPick({ id: page.id, view: view.id });
    } catch (err) { toast(err?.message || 'Impossible de lire cette base.', { kind: 'error' }); }
  };
  const draw = () => {
    const q = search.value.trim().toLocaleLowerCase('fr');
    const items = bases.filter((p) => !q || (p.title || 'Sans titre').toLocaleLowerCase('fr').includes(q));
    list.replaceChildren(...(items.length
      ? items.map((p) => h('button', { class: 'menu-item', role: 'option', onClick: () => choose(p) }, h('span', { class: 'menu-ico' }, icon('table', 15)), h('span', { class: 'menu-label' }, p.title || 'Sans titre')))
      : [h('p', { class: 'muted bt-pad' }, bases.length ? 'Aucune base ne correspond.' : 'Aucune base pour le moment.')]));
  };
  search.addEventListener('input', draw);
  draw();
  modal = openModal({
    title: kanban ? 'Insérer un Kanban' : 'Insérer une base',
    body: h('div', { class: 'stack' }, search, list),
    actions: [{ label: 'Annuler' }, session.can('write') && store.canWriteIn(spaceId) && {
      label: 'Nouvelle base', primary: true,
      onClick: async () => {
        try {
          const created = await api.post('/bases', { spaceId, title: 'Nouvelle base' });
          await store.fetchPage(created.page.id);
          if (!kanban) { onPick({ id: created.page.id, view: null }); return; }
          const status = await api.post(`/bases/${created.page.id}/properties`, { name: 'Statut', type: 'status' });
          const view = await api.post(`/bases/${created.page.id}/views`, { name: 'Kanban', config: { type: 'kanban', groupBy: status.id, sort: [], filters: [], hidden: [] } });
          onPick({ id: created.page.id, view: view.id });
        } catch (err) { toast(err?.message || 'Impossible de créer la base.', { kind: 'error' }); return false; }
      },
    }].filter(Boolean),
  });
  search.focus();
}
