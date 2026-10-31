// Groupes (administrateurs) : listes de personnes auxquelles on accorde un rôle sur un espace ou une page.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { toast, confirmModal, openModal } from '../ui.js';
import * as A from '../actions.js';
import { card, loadingEl, pill } from './ui.js';

const SOURCES = { local: 'Local', oidc: 'OIDC', ldap: 'LDAP', saml: 'SAML', system: 'Système' };

export async function renderGroups(el) {
  el.replaceChildren(loadingEl());
  const groups = await A.attempt(() => api.get('/groups'));
  if (!groups) return;
  const refresh = () => renderGroups(el);
  el.replaceChildren(
    card('Groupes', 'Un groupe réunit des personnes pour leur donner un rôle sur un espace ou une page en une seule fois. « Tout le monde » contient tous les comptes. Un groupe lié à un fournisseur d’identité (OIDC, LDAP, SAML) est rempli à chaque connexion d’après les groupes de la personne chez le fournisseur.',
      h('div', { class: 'table' }, groups.map((g) => h('div', { class: 'table-row' },
        h('span', { class: 'space-ico' }, icon('users', 18)),
        h('span', { class: 'grow' }, h('strong', null, g.name),
          h('small', null, `${g.id === 'everyone' ? 'Tous les comptes' : `${g.memberCount ?? 0} membre${(g.memberCount ?? 0) > 1 ? 's' : ''}`}${g.externalId ? ` · groupe « ${g.externalId} » chez le fournisseur` : ''}${g.description ? ` · ${g.description}` : ''}`)),
        pill(SOURCES[g.source] || g.source, g.source === 'local' || g.source === 'system' ? 'off' : 'ok'),
        g.id !== 'everyone' && h('button', { class: 'icon-btn', title: 'Membres', 'aria-label': `Membres de ${g.name}`, onClick: () => openMembers(g, refresh) }, icon('users')),
        g.id !== 'everyone' && h('button', { class: 'icon-btn danger', title: 'Supprimer', 'aria-label': `Supprimer ${g.name}`, onClick: async () => {
          if (!(await confirmModal({ title: 'Supprimer ce groupe ?', message: `« ${g.name} » sera retiré de tous les espaces et pages où il a des droits. Les personnes ne sont pas supprimées.`, confirm: 'Supprimer', danger: true }))) return;
          if (await A.attempt(() => api.del(`/groups/${g.id}`).then(() => true))) { toast('Groupe supprimé'); refresh(); }
        } }, icon('trash'))))),
      h('button', { class: 'btn btn-primary btn-sm', onClick: () => openForm(refresh) }, icon('plus', 15), 'Nouveau groupe')));
}

function openForm(done) {
  const name = h('input', { class: 'input', 'aria-label': 'Nom du groupe', maxlength: '80', placeholder: 'Ex. Équipe infra' });
  const desc = h('input', { class: 'input', 'aria-label': 'Description', maxlength: '300', placeholder: 'Facultatif' });
  const source = h('select', { class: 'input', 'aria-label': 'Origine des membres' },
    h('option', { value: 'local' }, 'Local : je choisis les membres'),
    h('option', { value: 'oidc' }, 'Lié à un groupe OIDC'), h('option', { value: 'ldap' }, 'Lié à un groupe LDAP'), h('option', { value: 'saml' }, 'Lié à un groupe SAML'));
  const external = h('input', { class: 'input', 'aria-label': 'Nom du groupe chez le fournisseur', maxlength: '512', placeholder: 'Ex. notabene-infra (tel qu’il apparaît dans la connexion)' });
  const externalField = h('label', { class: 'field', hidden: true }, h('span', null, 'Groupe chez le fournisseur'), external,
    h('small', { class: 'hint' }, 'Les membres sont mis à jour à chaque connexion. La casse compte pour OIDC et SAML, pas pour LDAP.'));
  source.addEventListener('change', () => { externalField.hidden = source.value === 'local'; });
  openModal({
    title: 'Nouveau groupe',
    body: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, 'Nom'), name), h('label', { class: 'field' }, h('span', null, 'Description'), desc),
      h('label', { class: 'field' }, h('span', null, 'Membres'), source), externalField),
    actions: [{ label: 'Annuler' }, { label: 'Créer', primary: true, onClick: async () => {
      const body = { name: name.value.trim(), description: desc.value.trim(), source: source.value, ...(source.value === 'local' ? {} : { externalId: external.value.trim() }) };
      if (!body.name) { name.focus(); return false; }
      if (!(await A.attempt(() => api.post('/groups', body).then(() => true)))) return false;
      toast('Groupe créé'); done(); return undefined;
    } }],
  });
  setTimeout(() => name.focus(), 30);
}

async function openMembers(group, done) {
  const body = h('div', { class: 'stack' }, loadingEl());
  const paint = async () => {
    const [data, users] = await Promise.all([api.get(`/groups/${group.id}/members`), group.source === 'local' ? api.get('/admin/users') : Promise.resolve([])]);
    const inGroup = new Set(data.items.map((u) => u.id));
    const free = users.filter((u) => !u.disabled && !inGroup.has(u.id));
    const select = h('select', { class: 'input', 'aria-label': 'Ajouter une personne' }, h('option', { value: '' }, 'Ajouter une personne…'), ...free.map((u) => h('option', { value: u.id }, `${u.name}${u.email ? ` (${u.email})` : ''}`)));
    body.replaceChildren(...[
      group.source !== 'local' && h('div', { class: 'notice info' }, `L’adhésion vient du fournisseur d’identité (groupe « ${group.externalId} ») et se met à jour à la connexion de chaque personne : elle ne se modifie pas ici, et un retrait chez le fournisseur ne prend effet qu’à la prochaine connexion.`),
      h('div', { class: 'table' }, data.items.length ? data.items.map((u) => h('div', { class: 'table-row' },
        h('span', { class: 'grow' }, h('strong', null, u.name), h('small', null, `${u.email || ''}${u.disabled ? ' (désactivé)' : ''}`)),
        group.source === 'local' && h('button', { class: 'icon-btn danger', title: 'Retirer', 'aria-label': `Retirer ${u.name}`, onClick: async () => {
          if (await A.attempt(() => api.del(`/groups/${group.id}/members/${u.id}`).then(() => true))) paint();
        } }, icon('x')))) : [h('p', { class: 'muted' }, 'Aucun membre pour le moment.')]),
      group.source === 'local' && h('div', { class: 'row' }, select, h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => {
        if (select.value && await A.attempt(() => api.put(`/groups/${group.id}/members/${select.value}`).then(() => true))) paint();
      } }, icon('plus', 14), 'Ajouter'))].filter(Boolean));
  };
  const m = openModal({ title: `Membres de « ${group.name} »`, size: 'wide', body, actions: [{ label: 'Fermer', primary: true }] });
  m.el.addEventListener('close', done);
  paint().catch((err) => { body.textContent = err.message; });
}
