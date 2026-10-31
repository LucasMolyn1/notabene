// Page Paramètres : routeur des sections (les sections sont dans ./settings/).
import { h } from './util.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { newsPending } from './news.js';
import { reauthNotice } from './provider-settings.js';
import { beginView, setView, topbar } from './views.js';
import { renderAudit, renderAuth, renderMail, renderSpaces, renderUsers } from './settings/access.js';
import { renderAbout, renderApi, renderAppearance, renderProfile, renderTokens } from './settings/account.js';
import { renderAi } from './settings/ai.js';
import { renderDiagrams, renderEmbed, renderEmbeds, renderTools, renderWebhooks } from './settings/features.js';
import { renderImport, renderInstance } from './settings/instance.js';
import { renderGroups } from './settings/groups.js';
import { store } from './store.js';

// ---- Page -----------------------------------------------------------------------------

const SECTIONS = [
  { group: 'Compte', id: 'profile', label: 'Profil et sessions', ico: 'users', render: renderProfile },
  { group: 'Compte', id: 'appearance', label: 'Apparence', ico: 'sun', render: renderAppearance },
  { group: 'Compte', id: 'tokens', label: 'Jetons d’API', ico: 'key', render: renderTokens },
  { group: 'Compte', id: 'about', label: 'À propos', ico: 'sparkle', render: renderAbout },
  { group: 'Fonctionnalités', id: 'ai', label: 'Recherche IA', ico: 'sparkle', sensitive: true, render: renderAi },
  { group: 'Fonctionnalités', id: 'diagrams', label: 'Diagrammes', ico: 'diamond', render: renderDiagrams },
  { group: 'Fonctionnalités', id: 'tools', label: 'Outils', ico: 'qrcode', render: renderTools },
  { group: 'Fonctionnalités', id: 'api', label: 'API REST', ico: 'code', render: renderApi },
  { group: 'Fonctionnalités', id: 'embed', label: 'Intégration portfolio', ico: 'globe', sensitive: true, render: renderEmbed },
  { group: 'Administration', id: 'spaces', label: 'Espaces', ico: 'folder', manager: true, render: renderSpaces },
  { group: 'Administration', id: 'groups', label: 'Groupes', ico: 'users', admin: true, render: renderGroups },
  { group: 'Administration', id: 'auth', label: 'Authentification', ico: 'shield', admin: true, sensitive: true, render: renderAuth },
  { group: 'Administration', id: 'mail', label: 'E-mail', ico: 'mail', admin: true, sensitive: true, render: renderMail },
  { group: 'Administration', id: 'embeds', label: 'Contenus intégrés', ico: 'globe', admin: true, sensitive: true, render: renderEmbeds },
  { group: 'Administration', id: 'webhooks', label: 'Webhooks', ico: 'webhook', admin: true, render: renderWebhooks },
  { group: 'Administration', id: 'import', label: 'Import', ico: 'upload', admin: true, render: renderImport },
  { group: 'Administration', id: 'users', label: 'Utilisateurs', ico: 'users', admin: true, render: renderUsers },
  { group: 'Administration', id: 'audit', label: 'Journal d’audit', ico: 'file', admin: true, render: renderAudit },
  { group: 'Administration', id: 'instance', label: 'Instance', ico: 'settings', admin: true, render: renderInstance },
];

export function showSettings(sectionId) {
  beginView();
  // Un gestionnaire d'espace (rôle « full ») accède aux espaces qu'il gère, sans le reste de l'administration.
  const manager = store.spaces.some((s) => s.role === 'full');
  const sections = SECTIONS.filter((s) => !s.admin || session.can('admin')).filter((s) => !s.manager || session.can('admin') || manager);
  const section = sections.find((s) => s.id === sectionId) || sections[0];
  document.title = `${section.label} · Paramètres · Notabene`;

  let group = null;
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Sections des paramètres' });
  for (const s of sections) {
    if (s.group !== group) { group = s.group; nav.append(h('div', { class: 'set-nav-group' }, group)); }
    nav.append(h('a', { class: `set-nav-item${s.id === section.id ? ' active' : ''}`, href: `/settings/${s.id}` }, h('span', null, icon(s.ico, 16)), s.label, s.id === 'about' && newsPending(session.version) ? h('span', { class: 'news-dot', role: 'img', 'aria-label': 'Nouveautés' }) : null));
  }
  requestAnimationFrame(() => nav.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' })); // téléphone : la section courante reste visible dans la bande
  const content = h('div', { class: 'set-content' });
  document.getElementById('main').replaceChildren(
    topbar(h('nav', { class: 'crumbs' },
      h('a', { class: 'crumb', href: '/settings' }, h('span', { class: 'crumb-ico' }, icon('settings', 14)), 'Paramètres'),
      h('span', { class: 'crumb-sep' }, '/'),
      h('span', { class: 'crumb current' }, section.label))),
    h('div', { class: 'scroller' }, h('div', { class: 'settings' },
      nav,
      h('div', { class: 'set-main' }, h('h1', null, icon(section.ico, 24), ` ${section.label}`), section.sensitive && session.can('admin') ? reauthNotice() : null, content))));
  section.render(content);
  // Les sections qui affichent des espaces se rafraîchissent quand ils changent.
  setView({ kind: 'settings', id: section.id, onStore: (evt) => { if (['spaces', 'groups', 'embed'].includes(section.id) && evt.type !== 'page') section.render(content); } });
}
