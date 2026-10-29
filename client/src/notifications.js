// Notifications : cloche avec compteur, liste de la boîte de réception, suivi de page, préférences d'e-mail.
import { h, timeAgo } from './util.js';
import { icon } from './icons.js';
import { api3 } from './api.js';
import { session } from './session.js';
import { openModal, toast, pageIcon } from './ui.js';

let unread = 0;
const badges = new Set();

function paint() {
  for (const b of badges) {
    b.textContent = unread > 99 ? '99+' : String(unread);
    b.hidden = unread === 0;
  }
}

// Recompte les notifications non lues (appelé au démarrage et à chaque événement « notification »).
export async function refreshUnread() {
  if (!session.user) return;
  try {
    unread = (await api3.get('/notifications/unread-count')).unread;
    for (const b of [...badges]) if (!b.isConnected) badges.delete(b); // cloches des vues remplacées
    paint();
  } catch { /* le compteur reste tel quel */ }
}

const TEXT = {
  comment: (n) => `${n.actor?.name || 'Quelqu’un'} a commenté`,
  reply: (n) => `${n.actor?.name || 'Quelqu’un'} a répondu à votre commentaire sur`,
  'page.updated': (n) => `${n.actor?.name || 'Quelqu’un'} a modifié${n.count > 1 ? ` (${n.count} fois)` : ''}`,
};

async function openInbox() {
  const list = h('div', { class: 'table' }, h('p', { class: 'muted' }, 'Chargement…'));
  const m = openModal({
    title: 'Notifications',
    body: list,
    actions: [
      { label: 'Tout marquer comme lu', onClick: async () => { await api3.post('/notifications/read', { all: true }).catch(() => null); unread = 0; paint(); return false; } },
      { label: 'Fermer' },
    ],
  });
  const render = async () => {
    const { items } = await api3.get('/notifications?limit=30');
    list.replaceChildren(...(items.length
      ? items.map((n) => h('a', {
        class: `table-row notif${n.read ? '' : ' unread'}`,
        href: `#/p/${n.page.id}`,
        onClick: async () => { m.close(); if (!n.read) { await api3.post('/notifications/read', { ids: [n.id] }).catch(() => null); refreshUnread(); } },
      },
      h('span', { class: 'grow' }, h('span', null, `${(TEXT[n.type] || (() => ''))(n)} `), h('strong', null, pageIcon(n.page.icon), ` ${n.page.title || 'Sans titre'}`), h('small', null, timeAgo(n.createdAt))),
      !n.read && h('span', { class: 'pill accent' }, 'Nouveau')))
      : [h('p', { class: 'muted' }, 'Aucune notification pour le moment. Suivez une page pour être prévenu des commentaires.')]));
  };
  render().catch((err) => { list.textContent = err.message; });
}

export function bellButton() {
  if (!session.user) return null;
  const badge = h('span', { class: 'bell-badge', hidden: true });
  badges.add(badge);
  paint();
  return h('button', { class: 'icon-btn bell', title: 'Notifications', 'aria-label': 'Notifications', onClick: openInbox }, icon('bell'), badge);
}

// Bouton « Suivre » d'une page.
export function watchButton(pageId) {
  if (!session.user) return null;
  let watching = false;
  const btn = h('button', { class: 'icon-btn', title: 'Suivre cette page', 'aria-pressed': 'false' }, icon('bell'));
  const paintWatch = () => { btn.classList.toggle('on', watching); btn.setAttribute('aria-pressed', String(watching)); btn.title = watching ? 'Ne plus suivre cette page' : 'Suivre cette page (notifications)'; };
  btn.addEventListener('click', async () => {
    try {
      watching = (await (watching ? api3.del(`/pages/${pageId}/watch`) : api3.put(`/pages/${pageId}/watch`))).watching;
      paintWatch();
      toast(watching ? 'Page suivie : vous serez prévenu des commentaires' : 'Page non suivie');
    } catch (err) { toast(err.message, { kind: 'error' }); }
  });
  api3.get(`/pages/${pageId}/watch`).then((r) => { watching = r.watching; paintWatch(); }).catch(() => paintWatch());
  return btn;
}

// Carte « Notifications » du profil.
export async function preferencesCard(card) {
  const prefs = await api3.get('/notifications/preferences').catch(() => null);
  if (!prefs) return null;
  const box = (label, desc, key) => {
    const input = h('input', { type: 'checkbox', class: 'switch-input' });
    input.checked = prefs[key];
    input.addEventListener('change', async () => {
      prefs[key] = input.checked;
      try { await api3.put('/notifications/preferences', { emailComments: prefs.emailComments, emailChanges: prefs.emailChanges }); toast('Préférences enregistrées'); } catch (err) { input.checked = !input.checked; prefs[key] = input.checked; toast(err.message, { kind: 'error' }); }
    });
    input.disabled = !prefs.emailAvailable;
    return h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('strong', null, label), h('small', null, desc)), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  };
  return card('Notifications', 'La cloche reçoit toujours les notifications des pages que vous suivez (pages que vous créez ou commentez, ou suivies à la main). L’e-mail est facultatif et ne contient jamais le contenu.',
    h('div', { class: 'stack' },
      !prefs.emailAvailable && h('div', { class: 'notice info' }, 'L’envoi d’e-mails n’est pas configuré par votre administrateur.'),
      box('E-mail pour les commentaires et réponses', 'Un e-mail avec un lien à chaque commentaire sur une page suivie.', 'emailComments'),
      box('E-mail pour les modifications', 'Au plus un e-mail par page et par heure.', 'emailChanges')));
}
