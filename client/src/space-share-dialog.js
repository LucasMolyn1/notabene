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
  let formError = ''; // dernière erreur de création, annoncée sous le formulaire
  let mailAvailable = false; // envoi du lien par e-mail possible (réglage d'instance et SMTP)

  const intro = () => h('div', { class: 'notice info' },
    h('p', null, h('strong', null, 'Toute personne ayant le lien peut lire ; les pages restreintes sont exclues.')),
    h('p', { class: 'muted' }, `Un lien donne accès en lecture seule, sans compte, aux pages de l’espace « ${space.name} ». Les pages qui ont leurs propres permissions (et leurs sous-pages) ainsi que les bases n’y figurent pas. Révoquez un lien pour qu’il cesse de fonctionner.`));

  // Erreurs de création renvoyées par le serveur. Avec une adresse, un refus (403, 409, 429, 400) ne crée aucun lien.
  const createError = (err, withMail) => {
    if (!withMail) return err.status === 409 ? 'Nombre maximal de liens atteint pour cet espace : révoquez-en un avant d’en créer un autre.' : err.message;
    const none = ' Aucun lien n’a été créé.';
    if (err.status === 403) return `L’envoi du lien par e-mail n’est pas activé sur cette instance.${none}`;
    if (err.status === 409) return /SMTP/i.test(err.message) ? `L’envoi d’e-mails n’est pas configuré sur cette instance (SMTP).${none}` : 'Nombre maximal de liens atteint pour cet espace : révoquez-en un avant d’en créer un autre.';
    if (err.status === 429) return `Trop d’envois de liens par e-mail : réessayez plus tard.${none}`;
    if (err.status === 400) return `Adresse e-mail invalide.${none}`;
    return err.message;
  };

  async function create(label, days, notifyEmail) {
    formError = '';
    try {
      const res = await api.post(`/spaces/${space.id}/shares`, { ...(label ? { label } : {}), ...(days ? { expiresInDays: days } : {}), ...(notifyEmail ? { notifyEmail } : {}) });
      // L'adresse n'est gardée nulle part : seul le résultat de l'envoi est retenu pour l'affichage.
      const mail = notifyEmail ? (res?.mailSent === true ? 'sent' : 'failed') : null;
      fresh = typeof res?.url === 'string' ? { id: res.id, url: res.url, label: res.label || '', mail } : null;
      toast(mail === 'sent' ? 'Lien créé, e-mail envoyé' : mail === 'failed' ? 'Lien créé, e-mail non envoyé' : 'Lien créé', mail === 'failed' ? { kind: 'error' } : undefined);
    } catch (err) {
      formError = createError(err, Boolean(notifyEmail));
      toast(formError, { kind: 'error' });
    }
    await paint();
    /** @type {HTMLElement | null} */ (body.querySelector(fresh ? '[data-space-share-url]' : '#space-share-error'))?.focus();
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
      fresh.mail === 'sent' && h('p', { class: 'notice success', role: 'status' }, 'E-mail envoyé.'),
      fresh.mail === 'failed' && h('p', { class: 'notice warning', role: 'status' }, 'Le lien est créé mais l’e-mail n’a pas pu être envoyé : copiez-le et transmettez-le vous-même.'),
      h('p', { id: 'space-share-once', class: 'notice warning' }, 'Copiez ce lien maintenant : il ne sera plus affiché. En cas de perte, révoquez-le et créez-en un autre.'),
      status);
  };

  // Une seule adresse, sans espace, virgule ni point-virgule ; le serveur revérifie tout.
  const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

  const createForm = () => {
    const label = h('input', { class: 'input', id: 'space-share-label', maxlength: '80', placeholder: 'Par exemple : nom du client' });
    const expiry = h('select', { class: 'input', id: 'space-share-expiry' }, EXPIRATIONS.map(([v, l]) => h('option', { value: v }, l)));
    const email = mailAvailable ? h('input', {
      class: 'input', id: 'space-share-email', type: 'email', autocomplete: 'off', maxlength: '254', spellcheck: 'false',
      inputmode: 'email', 'aria-describedby': 'space-share-email-hint',
    }) : null;
    const emailError = h('p', { class: 'field-error', id: 'space-share-email-error', role: 'alert', hidden: true });
    const error = formError ? h('p', { class: 'notice error', id: 'space-share-error', role: 'alert', tabindex: '-1' }, formError) : null;
    const form = h('form', { class: 'stack', 'aria-label': 'Nouveau lien de partage', novalidate: true },
      h('div', { class: 'row wrap space-share-form' },
        h('div', { class: 'field grow' }, h('label', { for: label.id }, 'Libellé (facultatif)'), label),
        h('div', { class: 'field' }, h('label', { for: expiry.id }, 'Expiration'), expiry)),
      email && h('div', { class: 'field' },
        h('label', { for: email.id }, 'Envoyer le lien par e-mail à (facultatif)'), email,
        h('small', { id: 'space-share-email-hint', class: 'muted' }, 'Une seule adresse. Seul le lien est envoyé, jamais le contenu des pages.'),
        emailError),
      error,
      h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, icon('link', 14), 'Créer un lien')));
    const setEmailError = (msg) => {
      if (!email) return;
      emailError.textContent = msg;
      emailError.hidden = !msg;
      email.setAttribute('aria-invalid', msg ? 'true' : 'false');
      email.setAttribute('aria-describedby', msg ? 'space-share-email-hint space-share-email-error' : 'space-share-email-hint');
    };
    email?.addEventListener('input', () => { if (!emailError.hidden) setEmailError(''); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const address = email ? email.value.trim() : '';
      if (address && (address.length > 254 || !EMAIL_RE.test(address))) {
        setEmailError('Saisissez une seule adresse e-mail valide, par exemple nom@exemple.fr.');
        email.focus();
        return;
      }
      // Le champ est vidé dès l'envoi : l'adresse n'est ni réaffichée ni conservée.
      if (email) email.value = '';
      create(label.value.trim().slice(0, 80), expiry.value ? Number(expiry.value) : 0, address);
    });
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
    mailAvailable = state.mailAvailable === true;
    if (!state.available) {
      fresh = null;
      formError = '';
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
