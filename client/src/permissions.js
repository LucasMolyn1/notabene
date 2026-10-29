// Permissions fines d'une page (administrateurs) : restreindre une page et ses sous-pages à des personnes.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { session } from './session.js';
import { store } from './store.js';
import { toast, openModal } from './ui.js';

export function permissionsButton(pageId) {
  if (!session.can('admin')) return null;
  return h('button', { class: 'icon-btn', title: 'Permissions de la page', 'aria-label': 'Permissions de la page', onClick: () => openPermissions(pageId) }, icon('lock'));
}

async function openPermissions(pageId) {
  let state;
  let users;
  try {
    [state, users] = await Promise.all([api.get(`/pages/${pageId}/permissions`), api.get('/admin/users')]);
  } catch (err) { toast(err.message, { kind: 'error' }); return; }

  const byId = new Map(users.map((u) => [u.id, u]));
  // Entrées en cours d'édition : { userId, level }.
  let entries = (state.entries || []).map((e) => ({ userId: e.userId, level: e.level }));
  const inheritedFrom = state.inheritedFrom ? store.page(state.inheritedFrom) : null;

  const body = h('div', { class: 'stack' });
  const addSelect = h('select', { class: 'input', 'aria-label': 'Ajouter une personne' });

  const paint = () => {
    const free = users.filter((u) => !u.disabled && !entries.some((e) => e.userId === u.id));
    addSelect.replaceChildren(h('option', { value: '' }, 'Ajouter une personne…'), ...free.map((u) => h('option', { value: u.id }, `${u.name}${u.email ? ` (${u.email})` : ''}`)));
    body.replaceChildren(
      state.inheritedFrom && h('div', { class: 'notice info' }, `Cette page hérite de la restriction de « ${inheritedFrom?.title || 'une page parente'} ». Enregistrer ici crée une restriction propre à cette page.`),
      h('p', { class: 'muted' }, entries.length
        ? 'Seules les personnes listées (et les administrateurs) voient cette page et ses sous-pages. Un niveau « Lecture » empêche de modifier, même pour un éditeur.'
        : 'Aucune restriction : la page suit la visibilité de son espace.'),
      entries.length > 0 && h('div', { class: 'table' }, entries.map((e) => {
        const u = byId.get(e.userId);
        return h('div', { class: 'table-row' },
          h('span', { class: 'grow' }, h('strong', null, u?.name || e.userId), h('small', null, u?.email || '')),
          h('select', { class: 'input input-sm', 'aria-label': 'Niveau', onChange: (ev) => { e.level = ev.target.value; } },
            h('option', { value: 'read', selected: e.level === 'read' }, 'Lecture'), h('option', { value: 'write', selected: e.level === 'write' }, 'Écriture')),
          h('button', { class: 'icon-btn danger', title: 'Retirer', onClick: () => { entries = entries.filter((x) => x !== e); paint(); } }, icon('x')));
      })),
      h('div', { class: 'row' }, addSelect, h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { if (addSelect.value) { entries.push({ userId: addSelect.value, level: 'read' }); paint(); } } }, icon('plus', 14), 'Ajouter')));
  };
  paint();

  openModal({
    title: 'Permissions de la page',
    body,
    actions: [
      { label: 'Annuler' },
      { label: 'Enregistrer', primary: true, onClick: async () => {
        try {
          await api.put(`/pages/${pageId}/permissions`, { entries });
          toast(entries.length ? 'Page restreinte' : 'Restriction retirée');
          return undefined;
        } catch (err) { toast(err.message, { kind: 'error' }); return false; }
      } },
    ],
  });
}
