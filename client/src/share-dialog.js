// Bouton « Partager » d'une page : lien public (sans compte), sous-pages, moteurs de recherche. Le serveur décide de tout ;
// ceci n'est que l'écran.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { session } from './session.js';
import { toast, openModal, confirmModal } from './ui.js';

export function shareButton(pageId) {
  if (!session.can('write') || !session.config.sharing) return null;
  return h('button', { class: 'icon-btn', title: 'Partager par un lien public', 'aria-label': 'Partager par un lien public', onClick: () => openShare(pageId) }, icon('globe'));
}

async function openShare(pageId) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  const m = openModal({ title: 'Partager cette page', size: 'wide', body, actions: [{ label: 'Fermer', primary: true }] });
  let confirmRestricted = false;

  const put = async (patch) => {
    try { await api.put(`/pages/${pageId}/share`, { confirmRestricted, ...patch }); await paint(); } catch (err) { toast(err.message, { kind: 'error' }); await paint(); }
  };
  const check = (label, hint, checked, onChange) => {
    const input = h('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'check-row' }, input, h('span', null, h('strong', null, label), hint && h('small', { class: 'hint' }, hint)));
  };

  async function paint() {
    let state;
    try { state = await api.get(`/pages/${pageId}/share`); } catch (err) { body.textContent = err.message; return; }
    if (!state.available) {
      body.replaceChildren(h('div', { class: 'notice info' }, state.instanceEnabled
        ? 'Le partage public est désactivé dans l’espace de cette page.'
        : 'Le partage public n’est pas activé sur cette instance. Un administrateur peut l’activer dans Paramètres, Pages partagées.'));
      return;
    }
    if (!state.canManage) { body.replaceChildren(h('p', { class: 'muted' }, 'Vous ne pouvez pas modifier cette page : le partage public est réservé à ceux qui le peuvent.')); return; }
    const share = state.share;
    if (!share) {
      const consent = h('input', { type: 'checkbox', 'aria-label': 'Je confirme rendre cette page publique malgré ses permissions' });
      body.replaceChildren(...[
        h('p', { class: 'muted' }, 'Toute personne qui a le lien pourra lire cette page, sans compte. Vous pourrez retirer le lien à tout moment.'),
        state.restricted && h('div', { class: 'notice warn' },
          h('p', null, 'Cette page a des permissions restreintes : elle n’est visible que de certaines personnes. La partager la rend lisible de quiconque a le lien.'),
          h('label', { class: 'check-row' }, consent, h('span', null, 'Je confirme rendre cette page publique'))),
        h('button', { class: 'btn btn-primary', onClick: async () => {
          if (state.restricted) { if (!consent.checked) { consent.focus(); return; } confirmRestricted = true; }
          await put({});
        } }, 'Créer un lien public'),
      ].filter(Boolean));
      return;
    }
    const link = h('input', { class: 'input', readonly: true, value: share.url, 'aria-label': 'Lien public' });
    body.replaceChildren(...[
      h('div', { class: 'row' }, link, h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { link.select(); navigator.clipboard.writeText(share.url).then(() => toast('Lien copié')); } }, icon('copy', 14), 'Copier')),
      state.restricted && h('div', { class: 'notice warn' }, 'Cette page a des permissions restreintes : le lien la rend pourtant lisible de quiconque l’a.'),
      check('Inclure les sous-pages', 'Les sous-pages qui ont leurs propres permissions restent exclues.', share.includeChildren, (v) => put({ includeChildren: v })),
      check('Autoriser les moteurs de recherche', 'Sinon la page porte « noindex » : les moteurs ne la retiennent pas.', share.indexing, (v) => put({ indexing: v })),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => {
          if (await confirmModal({ title: 'Changer le lien ?', message: 'L’ancien lien cessera de fonctionner tout de suite.', confirm: 'Changer le lien' })) put({ regenerate: true });
        } }, 'Changer le lien'),
        h('button', { class: 'btn btn-ghost btn-sm danger', onClick: async () => {
          try { await api.del(`/pages/${pageId}/share`); toast('Partage retiré'); await paint(); } catch (err) { toast(err.message, { kind: 'error' }); }
        } }, 'Retirer le partage')),
    ].filter(Boolean));
  }
  paint();
  void m;
}
