// Point d'entrée : session, chargement des données, temps réel, routage par hash.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/app.css';
import './styles/mobile.css';
import { openEvents } from './api.js';
import { session } from './session.js';
import { store } from './store.js';
import { prefs, savePrefs, app } from './prefs.js';
import { presence } from './presence.js';
import { renderSidebar } from './sidebar.js';
import { showLabel, showLogin, showMissing, showPage, showSpace, notifyStore, toastAuthError } from './views.js';
import { showSettings } from './settings.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { showMfaSetup, showResetPassword } from './local-auth.js';
import { refreshUnread } from './notifications.js';
import { onCommentEvent } from './comments.js';
import { showShare } from './share.js';
import * as A from './actions.js';
import { pagePath, parseRoute, spacePath, upgradeLegacyHash } from './urls.js';

// L'accès est contrôlé par la session, pas par la route demandée.
function openSettings(sectionId) {
  if (session.user) showSettings(sectionId);
  else showLogin();
}

function route() {
  upgradeLegacyHash(); // un ancien lien #/… arrivé pendant le démarrage ou dans l'application
  const r = parseRoute(location.pathname);
  document.body.classList.toggle('share', r.kind === 'share');
  if (r.kind === 'share') { showShare(r.token, r.id); return; } // lisible sans compte, sans barre latérale
  if (r.kind === 'settings') openSettings(r.section);
  else if (!store.spaces.length) { showNoSpace(); scheduleSidebar(); return; }
  else if (r.kind === 'page') showPage(r.id);
  else if (r.kind === 'space') showSpace(r.id);
  else if (r.kind === 'label') showLabel(r.id);
  else if (r.kind === 'unknown') showMissing(null);
  else {
    // Racine : dernière page consultée, sinon l'accueil de l'espace courant.
    const last = !app.embed && prefs.lastPage && store.page(prefs.lastPage);
    history.replaceState(null, '', (last ? pagePath(last) : spacePath(store.space(prefs.space) || store.spaces[0])) + location.search);
    route();
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

// Les liens internes (/p/…, /s/…, /settings…) naviguent sans recharger la page ; un clic avec Ctrl, Maj ou la molette garde son sens habituel.
function onLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || a.target || a.hasAttribute('download') || a.getAttribute('href').startsWith('#')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || (url.search && url.search !== '?embed')) return;
  if (parseRoute(url.pathname).kind === 'unknown') return;
  e.preventDefault();
  A.go(url.pathname);
}

async function boot() {
  document.body.classList.toggle('embed', app.embed);
  document.body.classList.toggle('sb-collapsed', !prefs.sidebar);

  // Page partagée publiquement : lisible sans compte, donc sans session, sans espaces, sans flux temps réel ni présence.
  if (parseRoute(location.pathname).kind === 'share') {
    const shareRoute = () => { if (parseRoute(location.pathname).kind === 'share') route(); else location.reload(); }; // sortir du partage : démarrage normal
    window.addEventListener('popstate', shareRoute);
    window.addEventListener('navigate', shareRoute);
    document.addEventListener('click', onLinkClick);
    route();
    return;
  }

  upgradeLegacyHash();
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
  if (params.has('auth_error')) history.replaceState(null, '', location.pathname);
  if (!store.space(prefs.space)) { prefs.space = store.spaces[0]?.id ?? null; savePrefs(); }

  if (session.user) { presence.enable(session.user.id); refreshUnread(); }
  openEvents((type, evt) => {
    if (type === 'presence') { presence.receive(evt.data); return; }
    if (type === 'notification') { refreshUnread(); return; }
    if (type.startsWith('comment.')) { onCommentEvent(evt); return; }
    if (type === 'page.permissions') { store.scheduleRefresh(evt); return; }
    if (type === 'page.labels') { window.dispatchEvent(new CustomEvent('notabene:labels', { detail: evt })); return; }
    // Nos propres sauvegardes reviennent aussi : inutile de recharger si la version est déjà connue.
    if (type === 'page.updated' && (store.page(evt.pageId)?.version ?? 0) >= (evt.version ?? 0)) return;
    store.scheduleRefresh(evt);
  });

  store.subscribe((evt) => {
    if (prefs.space && !store.space(prefs.space)) prefs.space = store.spaces[0]?.id ?? null;
    scheduleSidebar();
    notifyStore(evt);
  });

  window.addEventListener('popstate', route);
  window.addEventListener('navigate', route);
  // Ancien format d'adresse (#/p/…) ouvert pendant que l'application tourne.
  window.addEventListener('hashchange', route);
  document.addEventListener('click', onLinkClick);
  window.addEventListener('avatars-changed', scheduleSidebar);
  document.addEventListener('keydown', onKey);
  // Le lien d'évitement déplace le focus au lieu de changer l'adresse.
  document.getElementById('skip-link').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('main').focus(); });
  document.querySelector('[data-close-sidebar]').addEventListener('click', () => document.body.classList.remove('sb-mobile-open'));
  route();
}

boot()
  .catch((err) => {
    console.error(err);
    // Ouvert en HTTP (par adresse IP, par exemple) : la politique de sécurité réécrit les requêtes en HTTPS et elles échouent.
    document.querySelector('#boot p').textContent = window.isSecureContext
      ? 'Impossible de joindre le serveur. Réessayez dans un instant.'
      : 'Cette page doit être ouverte par l’adresse HTTPS publique de l’instance : depuis cette adresse, le navigateur bloque les requêtes.';
    return 'failed';
  })
  .then((state) => { if (state !== 'failed') document.getElementById('boot').hidden = true; });
