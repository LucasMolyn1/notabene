// Pages partagées publiquement : réglage d'instance (administrateurs) et liens que l'on peut gérer.
import { h, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { session } from '../session.js';
import { toast, confirmModal } from '../ui.js';
import * as A from '../actions.js';
import { card, loadingEl, toggle } from './ui.js';

export async function renderShares(el) {
  el.replaceChildren(loadingEl());
  const [list, admin] = await Promise.all([A.attempt(() => api.get('/shares')), session.can('admin') ? A.attempt(() => api.get('/admin/sharing')) : Promise.resolve(null)]);
  if (!list) return;
  const refresh = () => renderShares(el);
  el.replaceChildren(...[
    admin && card('Partage public', 'Permet de publier une page par un lien que quiconque peut ouvrir, sans compte. Désactivé par défaut. Chaque espace peut aussi le refuser (Paramètres, Espaces, Modifier). Les liens d’un espace entier se gèrent depuis le menu de l’espace.',
      toggle('Autoriser le partage public par lien', 'Désactiver retire tous les liens existants, définitivement.', admin.enabled, async (value) => {
        if (!value && admin.shares > 0 && !(await confirmModal({ title: 'Retirer tous les liens publics ?', message: `${admin.shares} lien${admin.shares > 1 ? 's' : ''} public${admin.shares > 1 ? 's' : ''} seront supprimés et ne fonctionneront plus.`, confirm: 'Tout retirer', danger: true }))) { refresh(); return; }
        try { await api.put('/admin/sharing', { enabled: value }); session.config.sharing = value; toast(value ? 'Partage public activé' : 'Partage public désactivé'); } catch (err) { toast(err.message, { kind: 'error' }); }
        refresh();
      }),
      admin.spaces && toggle('Autoriser le partage d’espaces entiers par lien',
        `Les gestionnaires d’un espace pourront créer des liens de lecture pour tout l’espace : toute personne ayant le lien peut lire ; les pages restreintes sont exclues. Désactiver supprime tous ces liens, définitivement.${admin.enabled ? '' : ' Sans effet tant que le partage public est désactivé.'}`,
        admin.spaces.enabled, async (value) => {
          const n = admin.spaces.links;
          if (!value && !(await confirmModal({
            title: 'Désactiver le partage d’espaces ?',
            message: n > 0 ? `${n} lien${n > 1 ? 's' : ''} de partage d’espace ser${n > 1 ? 'ont' : 'a'} supprimé${n > 1 ? 's' : ''} et ne fonctionner${n > 1 ? 'ont' : 'a'} plus. Les réactiver plus tard n’en fera revivre aucun.` : 'La désactivation supprime tous les liens de partage d’espace. Aucun n’existe pour l’instant.',
            confirm: 'Désactiver', danger: true,
          }))) { refresh(); return; }
          try {
            const res = await api.put('/admin/sharing/spaces', { enabled: value });
            toast(value ? (res?.effective ? 'Partage d’espaces activé' : 'Partage d’espaces activé : il prendra effet avec le partage public') : `Partage d’espaces désactivé${res?.removed ? ` (${res.removed} lien${res.removed > 1 ? 's' : ''} supprimé${res.removed > 1 ? 's' : ''})` : ''}`);
          } catch (err) { toast(err.message, { kind: 'error' }); }
          refresh();
        }),
      admin.spaces && typeof admin.spaces.mail === 'boolean' && toggle('Autoriser l’envoi du lien d’espace par e-mail',
        `À la création d’un lien d’espace, son auteur pourra l’envoyer à une seule adresse. Seul le lien est envoyé, jamais le contenu des pages. Désactivé par défaut.${admin.spaces.smtp ? '' : ' L’envoi d’e-mails (SMTP) n’est pas configuré : l’activation reste sans effet tant qu’il ne l’est pas.'}`,
        admin.spaces.mail, async (value) => {
          try {
            const res = await api.put('/admin/sharing/spaces/mail', { enabled: value });
            toast(!value ? 'Envoi des liens d’espace par e-mail désactivé' : res?.effective ? 'Envoi des liens d’espace par e-mail activé' : 'Envoi par e-mail activé : sans effet tant que le partage d’espaces et le SMTP ne sont pas actifs');
          } catch (err) { toast(err.message, { kind: 'error' }); }
          refresh();
        })),
    card('Pages partagées', list.enabled ? 'Les liens publics des pages que vous pouvez modifier.' : 'Le partage public est désactivé sur cette instance.',
      list.items.length
        ? h('div', { class: 'table' }, list.items.map((s) => h('div', { class: 'table-row' },
          h('span', { class: 'grow' }, h('a', { href: `/p/${s.pageId}` }, h('strong', null, s.title || 'Sans titre')), h('small', null, `${s.spaceName} · ${s.includeChildren ? 'avec sous-pages · ' : ''}${s.indexing ? 'indexable · ' : ''}${s.createdBy ? `par ${s.createdBy} · ` : ''}${timeAgo(s.createdAt)}`)),
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': `Copier le lien de ${s.title}`, onClick: () => navigator.clipboard.writeText(s.url).then(() => toast('Lien copié')) }, icon('copy', 14), 'Copier'),
          h('button', { class: 'icon-btn danger', title: 'Retirer le partage', 'aria-label': `Retirer le partage de ${s.title}`, onClick: async () => {
            if (!(await confirmModal({ title: 'Retirer ce partage ?', message: `Le lien public de « ${s.title || 'Sans titre'} » cessera de fonctionner.`, confirm: 'Retirer', danger: true }))) return;
            if (await A.attempt(() => api.del(`/pages/${s.pageId}/share`).then(() => true))) { toast('Partage retiré'); refresh(); }
          } }, icon('trash')))))
        : h('p', { class: 'muted' }, 'Aucune page n’est partagée publiquement.')),
  ].filter(Boolean));
}
