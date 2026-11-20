// Page Paramètres : routeur des sections (les sections sont dans ./settings/).
import { h } from './util.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { newsPending } from './news.js';
import { reauthNotice } from './provider-settings.js';
import { beginView, setView, topbar } from './views.js';
import { renderAuth, renderMail, renderSpaces, renderUsers } from './settings/access.js';
import { renderAudit, renderRetention, renderSiem } from './settings/audit.js';
import { renderAbout, renderApi, renderAppearance, renderProfile, renderTokens } from './settings/account.js';
import { renderAi } from './settings/ai.js';
import { renderDiagrams, renderEmbed, renderEmbeds, renderForms, renderTools, renderWebhooks } from './settings/features.js';
import { renderImport, renderInstance } from './settings/instance.js';
import { renderImages } from './settings/images.js';
import { renderGroups } from './settings/groups.js';
import { renderScim } from './settings/scim.js';
import { renderShares } from './settings/shares.js';
import { renderSecurity } from './settings/security.js';
import { store } from './store.js';
import { pageIn } from './motion.js';

// ---- Page -----------------------------------------------------------------------------

// Chaque onglet regroupe une ou plusieurs parties ; chaque partie garde son propre contrôle d'accès.
/** @param {string} id @param {string} label @param {(el: HTMLElement) => any} render @param {{ admin?: boolean, nonAdmin?: boolean, manager?: boolean, write?: boolean, sensitive?: boolean }} [opts] */
const P = (id, label, render, opts = {}) => ({ id, label, render, ...opts });
const SECTIONS = [
  { group: 'Compte', id: 'account', label: 'Compte', ico: 'users', parts: [
    P('profile', 'Profil et sessions', renderProfile), P('appearance', 'Apparence', renderAppearance),
    // Sécurité : synthèse ; ici pour une personne non administratrice, dans « Administration » pour un administrateur.
    P('mysecurity', 'Sécurité', renderSecurity, { nonAdmin: true }),
    P('tokens', 'Jetons d’API', renderTokens), P('about', 'À propos', renderAbout)] },
  { group: 'Fonctionnalités', id: 'sharing', label: 'Partage', ico: 'globe', parts: [
    P('shares', 'Pages partagées', renderShares, { write: true }), P('embed', 'Intégration portfolio', renderEmbed, { sensitive: true })] },
  { group: 'Fonctionnalités', id: 'ai', label: 'Recherche IA', ico: 'sparkle', parts: [P('ai', 'Recherche IA', renderAi, { sensitive: true })] },
  { group: 'Fonctionnalités', id: 'tools', label: 'Outils', ico: 'qrcode', parts: [
    P('diagrams', 'Diagrammes', renderDiagrams), P('tools', 'Outils', renderTools), P('api', 'API REST', renderApi)] },
  { group: 'Administration', id: 'security', label: 'Sécurité', ico: 'shield', parts: [P('security', 'Sécurité', renderSecurity, { admin: true })] },
  { group: 'Administration', id: 'spaces', label: 'Espaces', ico: 'folder', parts: [P('spaces', 'Espaces', renderSpaces, { manager: true })] },
  { group: 'Administration', id: 'people', label: 'Utilisateurs et groupes', ico: 'users', parts: [
    P('users', 'Utilisateurs', renderUsers, { admin: true }), P('groups', 'Groupes', renderGroups, { admin: true })] },
  { group: 'Administration', id: 'auth', label: 'Authentification', ico: 'shield', parts: [
    P('auth', 'Authentification', renderAuth, { admin: true, sensitive: true }), P('scim', 'Provisionnement SCIM', renderScim, { admin: true, sensitive: true }),
    P('mail', 'E-mail', renderMail, { admin: true, sensitive: true })] },
  { group: 'Administration', id: 'integrations', label: 'Intégrations', ico: 'webhook', parts: [
    P('webhooks', 'Webhooks', renderWebhooks, { admin: true }), P('embeds', 'Contenus intégrés', renderEmbeds, { admin: true, sensitive: true })] },
  { group: 'Administration', id: 'journal', label: 'Journal et conservation', ico: 'file', parts: [
    P('audit', 'Journal d’audit', renderAudit, { admin: true }), P('retention', 'Conservation', renderRetention, { admin: true }),
    P('siem', 'Envoi au SIEM', renderSiem, { admin: true, sensitive: true })] },
  { group: 'Administration', id: 'content', label: 'Contenu', ico: 'upload', parts: [
    P('import', 'Import', renderImport, { admin: true }), P('images', 'Images des pages', renderImages, { admin: true }),
    P('forms', 'Formulaires', renderForms, { admin: true })] },
  { group: 'Administration', id: 'instance', label: 'Instance', ico: 'settings', parts: [P('instance', 'Instance', renderInstance, { admin: true })] },
];
// Anciens identifiants d'onglet (liens, favoris) : redirigés vers l'onglet qui les contient, au niveau de la partie.
const PART_TO_SECTION = new Map(SECTIONS.flatMap((s) => s.parts.map((p) => [p.id, s.id])));

export function showSettings(sectionId) {
  beginView();
  // Un gestionnaire d'espace (rôle « full ») accède aux espaces qu'il gère, sans le reste de l'administration.
  const manager = store.spaces.some((s) => s.role === 'full');
  const allowed = (p) => (!p.admin || session.can('admin')) && (!p.nonAdmin || !session.can('admin')) && (!p.manager || session.can('admin') || manager) && (!p.write || session.can('write'));
  const sections = SECTIONS.map((s) => ({ ...s, parts: s.parts.filter(allowed) })).filter((s) => s.parts.length);
  // « /settings/security » : l'onglet Sécurité d'un administrateur, la partie Sécurité du Compte pour les autres.
  const target = sectionId === 'security' && !session.can('admin') ? 'mysecurity' : sectionId;
  const wanted = sections.find((s) => s.id === target) || sections.find((s) => s.id === PART_TO_SECTION.get(target));
  const section = wanted || sections[0];
  const anchor = section.parts.find((p) => p.id === target)?.id;
  document.title = `${section.label} · Paramètres · BeNote`;

  let group = null;
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Sections des paramètres' });
  for (const s of sections) {
    if (s.group !== group) { group = s.group; nav.append(h('div', { class: 'set-nav-group' }, group)); }
    nav.append(h('a', { class: `set-nav-item${s.id === section.id ? ' active' : ''}`, href: `/settings/${s.id}` }, h('span', null, icon(s.ico, 16)), s.label, s.id === 'account' && newsPending(session.version) ? h('span', { class: 'news-dot', role: 'img', 'aria-label': 'Nouveautés' }) : null));
  }
  requestAnimationFrame(() => nav.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' })); // téléphone : la section courante reste visible dans la bande
  const multi = section.parts.length > 1;
  const slots = section.parts.map((p) => ({ part: p, box: h('div', { class: 'set-content' }) }));
  const body = slots.map(({ part, box }) => h('section', { class: 'set-part', id: `set-${part.id}`, 'aria-label': multi ? part.label : null },
    multi ? h('h2', { class: 'set-part-title' }, part.label) : null,
    part.sensitive && session.can('admin') ? reauthNotice() : null,
    box));
  document.getElementById('main').replaceChildren(
    topbar(h('nav', { class: 'crumbs' },
      h('a', { class: 'crumb', href: '/settings' }, h('span', { class: 'crumb-ico' }, icon('settings', 14)), 'Paramètres'),
      h('span', { class: 'crumb-sep' }, '/'),
      h('span', { class: 'crumb current' }, section.label))),
    h('div', { class: 'scroller' }, h('div', { class: 'settings' },
      nav,
      h('div', { class: 'set-main' }, h('h1', null, icon(section.ico, 24), ` ${section.label}`), ...body))));
  for (const { part, box } of slots) part.render(box);
  pageIn(document.querySelector('#main .set-main'));
  if (anchor && multi) requestAnimationFrame(() => document.getElementById(`set-${anchor}`)?.scrollIntoView({ block: 'start' }));
  // Les parties qui affichent des espaces se rafraîchissent quand ils changent.
  setView({ kind: 'settings', id: section.id, onStore: (evt) => { if (evt.type !== 'page') for (const { part, box } of slots) if (['spaces', 'groups', 'embed'].includes(part.id)) part.render(box); } });
}
