// Point d'entrée : session, chargement des données, temps réel, routage par hash.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/app.css';
import { openEvents } from './api.js';
import { session } from './session.js';
import { store } from './store.js';
import { prefs, savePrefs, app } from './prefs.js';
import { presence } from './presence.js';
import { renderSidebar } from './sidebar.js';
import { showLogin, showMissing, showPage, showSpace, notifyStore, toastAuthError } from './views.js';
import { showSettings } from './settings.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { showMfaSetup, showResetPassword } from './local-auth.js';
import { refreshUnread } from './notifications.js';
import { onCommentEvent } from './comments.js';
import * as A from './actions.js';

// L'accès est contrôlé par la session, pas par la route demandée.
function openSettings(sectionId) {
  if (session.user) showSettings(sectionId);
  else showLogin();
}

function route() {
  const path = location.hash.slice(1) || '/';
  let m;
  if ((m = path.match(/^\/settings$/) || path.match(/^\/settings\/([a-z-]+)$/))) openSettings(m[1]);
  else if (!store.spaces.length) { showNoSpace(); scheduleSidebar(); return; }
  else if ((m = path.match(/^\/p\/([A-Za-z0-9_-]+)/))) showPage(m[1]);
  else if ((m = path.match(/^\/s\/([A-Za-z0-9_-]+)/))) showSpace(m[1]);
  else if (path !== '/') showMissing(null);
  else {
    const last = !app.embed && prefs.lastPage && store.page(prefs.lastPage);
    location.replace(`#${last ? `/p/${last.id}` : `/s/${(store.space(prefs.space) || store.spaces[0]).id}`}`);
    return;
  }
  document.body.classList.remove('sb-mobile-open');
  scheduleSidebar();
}

function showNoSpace() {
  document.getElementById('main').replaceChildren(h('div', { class: 'empty big' },
    h('div', { class: 'empty-emoji' }, icon('folder', 32)),
    h('h2', null, 'Aucun espace'),
    h('p', { class: 'muted' }, session.can('admin') ? 'Créez un premier espace pour commencer.' : 'Aucun espace ne vous est accessible pour le moment.'),
    session.can('admin') && h('button', { class: 'btn btn-primary', onClick: () => A.spaceForm() }, 'Créer un espace')));
}

let sidebarFrame = 0;
function scheduleSidebar() {
  if (app.embed) return;
  cancelAnimationFrame(sidebarFrame);
  sidebarFrame = requestAnimationFrame(renderSidebar);
}

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); A.search(); }
  else if (mod && e.key === '\\') { e.preventDefault(); A.toggleSidebar(); }
  else if (e.altKey && !mod && e.code === 'KeyN' && !app.embed && session.can('write')) { e.preventDefault(); A.newPage(prefs.space); }
}

async function boot() {
  document.body.classList.toggle('embed', app.embed);
  document.body.classList.toggle('sb-collapsed', !prefs.sidebar);

  // Lien de réinitialisation reçu par e-mail : le jeton est dans le fragment (jamais envoyé au serveur) et retiré de l'URL.
  window.addEventListener('hashchange', () => { if (/^#\/reset\//.test(location.hash)) location.reload(); });
  const reset = /^#\/reset\/([\w-]{20,100})$/.exec(location.hash);
  if (reset) {
    history.replaceState(null, '', location.pathname);
    document.body.classList.add('no-sidebar');
    showResetPassword(document.getElementById('main'), reset[1]);
    return;
  }

  await session.load();
  if (session.mfaSetupRequired) {
    document.body.classList.add('no-sidebar');
    await showMfaSetup(document.getElementById('main'), () => session.logout());
    return;
  }
  const params = new URLSearchParams(location.search);
  const wantsLogin = params.has('login') || params.has('dev_login');
  await store.load();

  if (!session.user && (wantsLogin || !store.spaces.length || params.has('auth_error'))) {
    document.body.classList.add('no-sidebar');
    showLogin();
    return;
  }
  toastAuthError();
  if (params.has('auth_error')) history.replaceState(null, '', `/${location.hash}`);
  if (!store.space(prefs.space)) { prefs.space = store.spaces[0]?.id ?? null; savePrefs(); }

  if (session.user) { presence.enable(session.user.id); refreshUnread(); }
  openEvents((type, evt) => {
    if (type === 'presence') { presence.receive(evt.data); return; }
    if (type === 'notification') { refreshUnread(); return; }
    if (type.startsWith('comment.')) { onCommentEvent(evt); return; }
    if (type === 'page.permissions') { store.scheduleRefresh(evt); return; }
    // Nos propres sauvegardes reviennent aussi : inutile de recharger si la version est déjà connue.
    if (type === 'page.updated' && (store.page(evt.pageId)?.version ?? 0) >= (evt.version ?? 0)) return;
    store.scheduleRefresh(evt);
  });

  store.subscribe((evt) => {
    if (prefs.space && !store.space(prefs.space)) prefs.space = store.spaces[0]?.id ?? null;
    scheduleSidebar();
    notifyStore(evt);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  // Le routeur utilise le fragment (#/…) : le lien d'évitement déplace le focus au lieu de changer l'adresse.
  document.getElementById('skip-link').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('main').focus(); });
  document.querySelector('[data-close-sidebar]').addEventListener('click', () => document.body.classList.remove('sb-mobile-open'));
  route();
}

boot()
  .catch((err) => {
    console.error(err);
    document.querySelector('#boot p').textContent = 'Impossible de joindre le serveur. Réessayez dans un instant.';
    return 'failed';
  })
  .then((state) => { if (state !== 'failed') document.getElementById('boot').hidden = true; });
