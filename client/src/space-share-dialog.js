// Partage d'un espace entier par lien, en lecture seule et sans compte (par exemple pour un client). Réservé aux gestionnaires
// de l'espace et aux administrateurs. Le lien n'est montré qu'une fois, à sa création : le serveur ne garde que son empreinte.
// Il n'est jamais écrit dans l'adresse de cet écran ni dans la console. Le serveur décide de tout ; ceci n'est que l'écran.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { confirmModal, openModal, toast } from './ui.js';

const fmtDate = (ms) => new Date(ms).toLocaleDateString('fr-FR', { dateStyle: 'long' });
const EXPIRATIONS = [['', 'Jamais'], ['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours'], ['365', '1 an']];

export function openSpaceShares(space) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  openModal({ title: 'Partager l’espace par lien', size: 'wide', body, actions: [{ label: 'Fermer', primary: true }] });
  let fresh = null; // lien tout juste créé, affiché jusqu'à la fermeture ou au prochain changement

  const intro = () => h('div', { class: 'notice info' },
    h('p', null, h('strong', null, 'Toute personne ayant le lien peut lire ; les pages restreintes sont exclues.')),
    h('p', { class: 'muted' }, `Un lien donne accès en lecture seule, sans compte, aux pages de l’espace « ${space.name} ». Les pages qui ont leurs propres permissions (et leurs sous-pages) ainsi que les bases n’y figurent pas. Révoquez un lien pour qu’il cesse de fonctionner.`));

  async function create(label, days) {
    try {
      const res = await api.post(`/spaces/${space.id}/shares`, { ...(label ? { label } : {}), ...(days ? { expiresInDays: days } : {}) });
      fresh = typeof res?.url === 'string' ? { id: res.id, url: res.url, label: res.label || '' } : null;
      toast('Lien créé');
    } catch (err) {
      toast(err.status === 409 ? 'Nombre maximal de liens atteint pour cet espace : révoquez-en un avant d’en créer un autre.' : err.message, { kind: 'error' });
    }
    await paint();
    /** @type {HTMLElement | null} */ (body.querySelector('[data-space-share-url]'))?.focus();
  }

  const freshBlock = () => {
    const url = fresh.url;
    const link = h('input', { class: 'input', id: 'space-share-url', readonly: true, 'data-space-share-url': '', 'aria-describedby': 'space-share-once' });
    link.value = url;
    link.addEventListener('focus', () => link.select());
    const status = h('span', { class: 'sr-only', role: 'status' });
    const copy = async () => {
      link.select();
      try { await navigator.clipboard.writeText(url); status.textContent = 'Lien copié'; toast('Lien copié'); } catch { status.textContent = 'Copie impossible : sélectionnez le lien et copiez-le vous-même.'; toast('Copie impossible : sélectionnez le lien et copiez-le', { kind: 'error' }); }
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: link.id }, fresh.label ? `Nouveau lien (${fresh.label})` : 'Nouveau lien'),
        h('div', { class: 'row' }, link, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: copy }, icon('copy', 14), 'Copier le lien'))),
      h('p', { id: 'space-share-once', class: 'notice warning' }, 'Copiez ce lien maintenant : il ne sera plus affiché. En cas de perte, révoquez-le et créez-en un autre.'),
      status);
  };

  const createForm = () => {
    const label = h('input', { class: 'input', id: 'space-share-label', maxlength: '80', placeholder: 'Par exemple : nom du client' });
    const expiry = h('select', { class: 'input', id: 'space-share-expiry' }, EXPIRATIONS.map(([v, l]) => h('option', { value: v }, l)));
    const form = h('form', { class: 'stack', 'aria-label': 'Nouveau lien de partage' },
      h('div', { class: 'row wrap space-share-form' },
        h('div', { class: 'field grow' }, h('label', { for: label.id }, 'Libellé (facultatif)'), label),
        h('div', { class: 'field' }, h('label', { for: expiry.id }, 'Expiration'), expiry)),
      h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, icon('link', 14), 'Créer un lien')));
    form.addEventListener('submit', (e) => { e.preventDefault(); create(label.value.trim().slice(0, 80), expiry.value ? Number(expiry.value) : 0); });
    return form;
  };

  const itemRow = (s) => {
    const name = s.label || 'Lien sans libellé';
    const meta = [
      `créé le ${fmtDate(s.createdAt)}`,
      s.createdBy && `par ${s.createdBy}`,
      s.expiresAt === null ? 'sans expiration' : s.expired ? `expiré le ${fmtDate(s.expiresAt)}` : `expire le ${fmtDate(s.expiresAt)}`,
    ].filter(Boolean).join(' · ');
    return h('li', { class: 'table-row wrap' },
      h('span', { class: 'grow' }, h('span', { class: 'row' }, h('strong', null, name), s.expired && h('span', { class: 'pill off' }, 'Expiré')), h('small', null, meta)),
      h('button', { class: 'btn btn-ghost btn-sm danger', type: 'button', 'aria-label': `Révoquer le lien ${name}`, onClick: async () => {
        if (!await confirmModal({ title: 'Révoquer ce lien ?', message: `Le lien « ${name} » cessera de fonctionner tout de suite. Cette action est définitive.`, confirm: 'Révoquer', danger: true })) return;
        try { await api.del(`/spaces/${space.id}/shares/${s.id}`); if (fresh?.id === s.id) fresh = null; toast('Lien révoqué'); } catch (err) { toast(err.message, { kind: 'error' }); }
        await paint();
      } }, icon('trash', 14), 'Révoquer'));
  };

  async function paint() {
    let state;
    try { state = await api.get(`/spaces/${space.id}/shares`); } catch (err) {
      body.replaceChildren(h('p', { class: 'notice error', role: 'alert' }, err.status === 403 ? 'Seuls les gestionnaires de l’espace et les administrateurs gèrent ses liens de partage.' : err.message));
      return;
    }
    const parts = [intro()];
    if (!state.available) {
      fresh = null;
      parts.push(h('div', { class: 'notice info' }, !state.instanceEnabled
        ? 'Le partage public n’est pas activé sur cette instance. Un administrateur peut l’activer dans Paramètres, Pages partagées.'
        : !state.spaceSharingEnabled
          ? 'Le partage d’espaces entiers n’est pas activé sur cette instance. Un administrateur peut l’activer dans Paramètres, Pages partagées.'
          : 'Le partage public est désactivé dans cet espace (Paramètres de l’espace).'));
    } else {
      if (fresh) parts.push(freshBlock());
      parts.push(createForm());
    }
    const items = state.items || [];
    parts.push(h('h3', { id: 'space-share-list-title' }, 'Liens existants'),
      items.length
        ? h('ul', { class: 'table', 'aria-labelledby': 'space-share-list-title' }, items.map(itemRow))
        : h('p', { class: 'muted' }, 'Aucun lien pour cet espace.'));
    if (items.length) parts.push(h('p', { class: 'muted' }, 'Un lien n’est montré qu’à sa création : il ne peut pas être affiché à nouveau.'));
    body.replaceChildren(...parts);
  }
  paint();
}
