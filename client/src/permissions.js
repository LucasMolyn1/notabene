// Permissions fines d'une page (administrateurs) : restreindre une page et ses sous-pages à des personnes ou des groupes.
// La restriction ne fait que réduire l'accès : elle ne donne jamais plus que le rôle de la personne sur l'espace.
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
  let groups;
  try {
    [state, users, groups] = await Promise.all([api.get(`/pages/${pageId}/permissions`), api.get('/admin/users'), api.get('/groups')]);
  } catch (err) { toast(err.message, { kind: 'error' }); return; }

  const byId = new Map(users.map((u) => [u.id, u]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  // Entrées en cours d'édition : { userId | groupId, level }.
  let entries = (state.entries || []).map((e) => (e.groupId ? { groupId: e.groupId, level: e.level } : { userId: e.userId, level: e.level }));
  const has = (value) => entries.some((e) => (value.startsWith('g:') ? e.groupId === value.slice(2) : e.userId === value.slice(2)));
  const inheritedFrom = state.inheritedFrom ? store.page(state.inheritedFrom) : null;

  const body = h('div', { class: 'stack' });
  const addSelect = h('select', { class: 'input', 'aria-label': 'Ajouter une personne ou un groupe' });

  const paint = () => {
    const free = users.filter((u) => !u.disabled && !has(`u:${u.id}`));
    const freeGroups = groups.filter((g) => !has(`g:${g.id}`));
    addSelect.replaceChildren(...[h('option', { value: '' }, 'Ajouter une personne ou un groupe…'),
      freeGroups.length > 0 && h('optgroup', { label: 'Groupes' }, freeGroups.map((g) => h('option', { value: `g:${g.id}` }, g.name))),
      h('optgroup', { label: 'Personnes' }, free.map((u) => h('option', { value: `u:${u.id}` }, `${u.name}${u.email ? ` (${u.email})` : ''}`)))].filter(Boolean));
    body.replaceChildren(...[
      state.inheritedFrom && h('div', { class: 'notice info' }, `Cette page hérite de la restriction de « ${inheritedFrom?.title || 'une page parente'} ». Enregistrer ici crée une restriction propre à cette page.`),
      h('p', { class: 'muted' }, entries.length
        ? 'Seules les personnes et les groupes listés (et les administrateurs) voient cette page et ses sous-pages, à condition d’avoir accès à l’espace. Un niveau « Lecture » empêche de modifier, même pour un éditeur.'
        : 'Aucune restriction : la page suit la visibilité de son espace.'),
      entries.length > 0 && h('div', { class: 'table' }, entries.map((e) => {
        const u = e.groupId ? null : byId.get(e.userId);
        const g = e.groupId ? groupById.get(e.groupId) : null;
        return h('div', { class: 'table-row' },
          h('span', { class: 'grow' }, h('strong', null, g ? g.name : u?.name || e.userId), h('small', null, g ? 'Groupe' : u?.email || '')),
          h('select', { class: 'input input-sm', 'aria-label': 'Niveau', onChange: (ev) => { e.level = ev.target.value; } },
            h('option', { value: 'read', selected: e.level === 'read' }, 'Lecture'), h('option', { value: 'write', selected: e.level === 'write' }, 'Écriture')),
          h('button', { class: 'icon-btn danger', title: 'Retirer', onClick: () => { entries = entries.filter((x) => x !== e); paint(); } }, icon('x')));
      })),
      h('div', { class: 'row' }, addSelect, h('button', { class: 'btn btn-ghost btn-sm', onClick: () => {
        const v = addSelect.value;
        if (v) { entries.push(v.startsWith('g:') ? { groupId: v.slice(2), level: 'read' } : { userId: v.slice(2), level: 'read' }); paint(); }
      } }, icon('plus', 14), 'Ajouter'))].filter(Boolean));
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
