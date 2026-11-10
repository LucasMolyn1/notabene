// Flux iCalendar d'une base (abonnement en lecture depuis un agenda) : créer, changer ou révoquer l'adresse secrète.
// L'adresse n'est montrée qu'une fois, à la création ou au changement : le serveur ne garde que son empreinte.
// Le serveur décide de tout (droits, partage public de l'instance et de l'espace) ; ceci n'est que l'écran.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { session } from './session.js';
import { confirmModal, openModal, toast } from './ui.js';

const fmtWhen = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

export function openIcal(baseId) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  openModal({ title: 'S’abonner depuis un agenda', size: 'wide', body, actions: [{ label: 'Fermer', primary: true }] });
  let fresh = null; // adresse tout juste créée, affichée jusqu'à la fermeture

  const intro = () => h('p', { class: 'muted' }, 'Une adresse secrète permet d’afficher les éléments datés de cette base dans un agenda (Thunderbird, Outlook, agenda du téléphone), en lecture seule. Seuls le titre et les dates sont publiés. Toute personne qui a l’adresse peut lire ces informations, sans compte.');

  async function create(rotate, confirmRestricted = false) {
    try {
      const res = await api.post(`/bases/${baseId}/ical`, confirmRestricted ? { confirmRestricted: true } : {});
      fresh = typeof res?.url === 'string' ? res.url : null;
      toast(rotate ? 'Nouvelle adresse créée : l’ancienne ne fonctionne plus' : 'Adresse créée');
    } catch (err) {
      // Base aux permissions restreintes : l'adresse la rendrait lisible (titres et dates) de quiconque l'a. Accord explicite exigé.
      if (err.status === 409 && !confirmRestricted) { restrictedWarning(rotate); return; }
      toast(err.message, { kind: 'error' });
    }
    await paint();
    /** @type {HTMLElement | null} */ (body.querySelector('[data-ical-url]'))?.focus();
  }

  function restrictedWarning(rotate) {
    const consent = h('input', { type: 'checkbox', id: 'ical-consent' });
    const err = h('p', { class: 'notice error', role: 'alert', hidden: true });
    const box = h('div', { class: 'notice warning', role: 'group', 'aria-labelledby': 'ical-restricted-title' },
      h('p', { id: 'ical-restricted-title' }, h('strong', null, 'Cette base a des permissions restreintes.')),
      h('p', null, 'Elle n’est visible que de certaines personnes. Une adresse d’abonnement rend les titres et les dates de ses éléments lisibles par quiconque a l’adresse, sans compte.'),
      h('label', { class: 'check-row', for: consent.id }, consent, h('span', null, 'Je confirme publier les titres et les dates de cette base par une adresse secrète')),
      err,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary btn-sm', onClick: () => {
          if (!consent.checked) { err.textContent = 'Cochez la confirmation pour continuer.'; err.hidden = false; consent.focus(); return; }
          create(rotate, true);
        } }, rotate ? 'Changer l’adresse' : 'Créer l’adresse'),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => paint() }, 'Annuler')));
    body.replaceChildren(intro(), box);
    consent.focus();
  }

  async function paint() {
    let state;
    try { state = await api.get(`/bases/${baseId}/ical`); } catch (err) {
      body.replaceChildren(h('p', { class: 'notice error', role: 'alert' }, err.status === 403 ? 'Seules les personnes qui peuvent modifier cette base gèrent son adresse d’abonnement.' : err.message));
      return;
    }
    // Partage public coupé (instance ou espace) : le flux ne répond pas ; on l'explique sans proposer de le créer.
    if (state?.available === false) {
      body.replaceChildren(intro(), h('div', { class: 'notice info' }, state.instanceEnabled === false || !session.config.sharing
        ? 'Le partage public n’est pas activé sur cette instance : l’abonnement ne fonctionne pas. Un administrateur peut l’activer dans Paramètres, Pages partagées.'
        : 'Le partage public est désactivé dans l’espace de cette base : l’abonnement ne fonctionne pas.'));
      return;
    }
    if (!state?.active) {
      fresh = null;
      body.replaceChildren(intro(), h('div', null, h('button', { class: 'btn btn-primary', onClick: () => create(false) }, icon('link', 14), 'Créer une adresse d’abonnement')));
      return;
    }
    const parts = [intro(), h('p', null, `Adresse active depuis le ${fmtWhen(state.createdAt)}.`)];
    if (fresh) {
      const url = fresh;
      const link = h('input', { class: 'input', id: 'ical-url', readonly: true, 'data-ical-url': '', 'aria-describedby': 'ical-once' });
      link.value = url;
      link.addEventListener('focus', () => link.select());
      const status = h('span', { class: 'sr-only', role: 'status' });
      const copy = async () => {
        link.select();
        try { await navigator.clipboard.writeText(url); status.textContent = 'Adresse copiée'; toast('Adresse copiée'); } catch { status.textContent = 'Copie impossible : sélectionnez l’adresse et copiez-la vous-même.'; toast('Copie impossible : sélectionnez l’adresse et copiez-la', { kind: 'error' }); }
      };
      parts.push(
        h('div', { class: 'field' }, h('label', { for: link.id }, 'Adresse d’abonnement'), h('div', { class: 'row' }, link,
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: copy }, icon('copy', 14), 'Copier'))),
        h('p', { id: 'ical-once', class: 'notice warning' }, 'Copiez cette adresse maintenant : elle ne sera plus affichée. En cas de perte, changez-la.'),
        status);
    } else {
      parts.push(h('p', { class: 'muted' }, 'L’adresse n’est montrée qu’à sa création. Si vous l’avez perdue, changez-la : l’ancienne cessera de fonctionner.'));
    }
    parts.push(h('div', { class: 'row' },
      h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => {
        if (await confirmModal({ title: 'Changer l’adresse ?', message: 'L’ancienne adresse cessera de fonctionner tout de suite : les agendas abonnés devront utiliser la nouvelle.', confirm: 'Changer l’adresse' })) create(true);
      } }, 'Changer l’adresse'),
      h('button', { class: 'btn btn-ghost btn-sm danger', onClick: async () => {
        if (!await confirmModal({ title: 'Révoquer l’adresse ?', message: 'Les agendas abonnés ne recevront plus rien. Vous pourrez créer une nouvelle adresse plus tard.', confirm: 'Révoquer', danger: true })) return;
        try { await api.del(`/bases/${baseId}/ical`); fresh = null; toast('Adresse révoquée'); } catch (err) { toast(err.message, { kind: 'error' }); }
        await paint();
      } }, 'Révoquer l’adresse')));
    body.replaceChildren(...parts);
  }
  paint();
}
