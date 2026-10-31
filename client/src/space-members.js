// Membres d'un espace : personnes et groupes avec un rôle (lecture, édition, gestion). Réservé aux administrateurs et aux
// gestionnaires de l'espace ; le serveur refuse tout autre appel, ceci n'est que l'écran.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { toast, openModal } from './ui.js';

const ROLES = [['view', 'Lecture'], ['edit', 'Édition'], ['full', 'Gestion']];
const roleSelect = (value, label, onChange) => {
  const sel = h('select', { class: 'input input-sm', 'aria-label': label, onChange: (e) => onChange(e.target.value) }, ROLES.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = value;
  return sel;
};

export function openSpaceMembers(space) {
  const list = h('div', { class: 'table' }, h('p', { class: 'muted' }, 'Chargement…'));
  const results = h('div', { class: 'table' });
  const q = h('input', { class: 'input', type: 'search', 'aria-label': 'Chercher une personne ou un groupe', placeholder: 'Chercher une personne ou un groupe (2 lettres au moins)…', maxlength: '80' });
  const newRole = roleSelect('view', 'Rôle à donner', () => {});
  let timer = 0;

  const refresh = async () => {
    try {
      const { items } = await api.get(`/spaces/${space.id}/members`);
      list.replaceChildren(...(items.length
        ? items.map((m) => h('div', { class: 'table-row' },
          h('span', { class: 'grow' },
            h('strong', null, m.name || m.id), m.kind === 'group' && h('span', { class: 'pill' }, m.id === 'everyone' ? 'Tout le monde' : m.source === 'local' ? 'Groupe' : `Groupe ${m.source.toUpperCase()}`),
            h('small', null, m.kind === 'user' ? `${m.email || ''}${m.disabled ? ' (désactivé)' : ''}` : '')),
          roleSelect(m.role, `Rôle de ${m.name || m.id}`, async (role) => {
            try { await api.put(`/spaces/${space.id}/members`, m.kind === 'group' ? { groupId: m.id, role } : { userId: m.id, role }); toast('Rôle enregistré'); } catch (err) { toast(err.message, { kind: 'error' }); refresh(); }
          }),
          h('button', { class: 'icon-btn danger', title: 'Retirer', 'aria-label': `Retirer ${m.name || m.id}`, onClick: async () => {
            try { await api.del(`/spaces/${space.id}/members/${m.kind}/${m.id}`); toast('Retiré'); refresh(); search(); } catch (err) { toast(err.message, { kind: 'error' }); }
          } }, icon('x'))))
        : [h('p', { class: 'muted' }, 'Aucun membre : seuls les administrateurs voient cet espace.')]));
    } catch (err) { list.textContent = err.message; }
  };

  const add = async (body) => {
    try { await api.put(`/spaces/${space.id}/members`, { ...body, role: newRole.value }); toast('Ajouté'); q.value = ''; results.replaceChildren(); refresh(); } catch (err) { toast(err.message, { kind: 'error' }); }
  };
  const search = async () => {
    const term = q.value.trim();
    if (term.length < 2) { results.replaceChildren(); return; }
    try {
      const found = await api.get(`/spaces/${space.id}/member-candidates?q=${encodeURIComponent(term)}`);
      const rows = [
        ...found.groups.map((g) => ({ key: `g${g.id}`, label: g.name, sub: g.id === 'everyone' ? 'Tout le monde' : 'Groupe', body: { groupId: g.id } })),
        ...found.users.map((u) => ({ key: `u${u.id}`, label: u.name, sub: u.email || '', body: { userId: u.id } })),
      ];
      results.replaceChildren(...(rows.length
        ? rows.map((r) => h('div', { class: 'table-row' }, h('span', { class: 'grow' }, h('strong', null, r.label), h('small', null, r.sub)),
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': `Ajouter ${r.label}`, onClick: () => add(r.body) }, icon('plus', 14), 'Ajouter')))
        : [h('p', { class: 'muted' }, 'Aucun résultat.')]));
    } catch (err) { results.textContent = err.message; }
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(search, 250); });

  openModal({
    title: `Membres de « ${space.name} »`,
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Lecture : lire. Édition : lire et modifier. Gestion : en plus, gérer les membres et renommer l’espace. Le rôle global de la personne reste un plafond (un lecteur ne peut jamais modifier) et le droit le plus élevé entre ses groupes l’emporte.'),
      space.visibility === 'public' && h('div', { class: 'notice info' }, 'Cet espace est public : tout le monde le lit, même sans adhésion. Les membres ne servent qu’à donner des droits de modification.'),
      list,
      h('div', { class: 'row' }, q, newRole),
      results),
    actions: [{ label: 'Fermer', primary: true }],
  });
  refresh();
}
