// Barre latérale : sélecteur d'espace, favoris, arborescence (glisser-déposer), compte.
import { h, initials, modKey } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, currentTheme } from './prefs.js';
import { colorFor } from './presence.js';
import { openMenu } from './ui.js';
import * as A from './actions.js';

let dragId = null;

const navBtn = (ico, label, onClick, { hint, active, badge } = {}) => h('button', {
  class: `sb-btn${active ? ' active' : ''}`, onClick,
}, icon(ico), h('span', { class: 'sb-btn-label' }, label),
hint ? h('kbd', null, hint) : null,
badge ? h('span', { class: 'badge' }, badge) : null);

const ROLE_LABELS = { admin: 'Administrateur', editor: 'Éditeur', reader: 'Lecteur' };

function spaceMenu(anchor, space) {
  const admin = session.can('admin');
  openMenu(anchor, [
    { heading: 'Espaces' },
    ...store.spaces.map((s) => ({
      label: s.name, emoji: s.icon, checked: s.id === space.id,
      onClick: () => { prefs.space = s.id; savePrefs(); A.go(`/s/${s.id}`); },
    })),
    admin && { sep: true },
    admin && { label: 'Nouvel espace', icon: 'plus', onClick: () => A.spaceForm() },
    admin && { label: 'Paramètres de l’espace', icon: 'settings', onClick: () => A.spaceForm(space) },
    admin && store.spaces.length > 1 && { label: 'Supprimer l’espace', icon: 'trash', danger: true, onClick: () => A.deleteSpace(space) },
  ]);
}

function pageMenu(anchor, page) {
  const others = store.spaces.filter((s) => s.id !== page.spaceId);
  openMenu(anchor, [
    { label: 'Ajouter une sous-page', icon: 'plus', onClick: () => A.newPage(page.spaceId, page.id) },
    { label: page.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'star', onClick: () => A.attempt(() => store.toggleFavorite(page.id)) },
    { label: 'Renommer', icon: 'edit', onClick: () => startRename(page.id) },
    { label: 'Dupliquer', icon: 'copy', onClick: () => A.duplicate(page.id) },
    { label: 'Copier le lien', icon: 'link', onClick: () => A.copyLink(page.id) },
    { label: 'Exporter en Markdown', icon: 'download', onClick: () => A.exportMarkdown(page.id) },
    others.length && { sep: true },
    ...others.map((s) => ({ label: `Déplacer vers ${s.name}`, emoji: s.icon, onClick: () => A.moveToSpace(page.id, s.id) })),
    { sep: true },
    { label: 'Mettre à la corbeille', icon: 'trash', danger: true, onClick: () => A.trash(page.id) },
  ]);
}

function accountMenu(anchor) {
  const admin = session.can('admin');
  openMenu(anchor, [
    { heading: `${session.user.name} · ${ROLE_LABELS[session.user.role]}` },
    { label: 'Paramètres', icon: 'settings', onClick: () => A.go('/settings') },
    { label: 'Profil et sessions', emoji: '👤', onClick: () => A.go('/settings/profile') },
    { label: 'Jetons d’API', icon: 'code', onClick: () => A.go('/settings/tokens') },
    { label: 'Recherche IA', emoji: '✨', onClick: () => A.go('/settings/ai') },
    admin && { label: 'Administration', emoji: '🛡️', onClick: () => A.go('/settings/instance') },
    { sep: true },
    { label: 'Se déconnecter', icon: 'move', onClick: () => session.logout() },
  ], { align: 'left' });
}

function startRename(id) {
  const title = document.querySelector(`.tree-row[data-id="${id}"] .tree-title`);
  if (!title) return;
  const page = store.page(id);
  const input = h('input', { class: 'tree-rename', value: page.title, maxlength: '300' });
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== page.title) A.attempt(() => store.updatePage(id, { title: input.value.trim() }));
    else renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  title.replaceWith(input);
  input.focus();
  input.select();
}

function clearDrop() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}

function treeNode(page, depth, activeId, canWrite) {
  const kids = store.children(page.spaceId, page.id);
  const open = !!prefs.expanded[page.id];
  const row = h('div', {
    class: `tree-row${page.id === activeId ? ' active' : ''}`,
    style: { paddingLeft: `${6 + depth * 14}px` },
    draggable: canWrite ? 'true' : null,
    'data-id': page.id,
    onClick: () => A.go(`/p/${page.id}`),
    onDblClick: (e) => { if (canWrite) { e.preventDefault(); startRename(page.id); } },
  },
  h('button', {
    class: `caret${kids.length ? '' : ' leaf'}${open ? ' open' : ''}`,
    'aria-label': open ? 'Replier' : 'Déplier',
    onClick: (e) => {
      e.stopPropagation();
      if (!kids.length) return;
      prefs.expanded[page.id] = !open;
      savePrefs();
      renderSidebar();
    },
  }, icon('chevron', 14)),
  h('span', { class: 'tree-icon' }, page.icon || icon('file', 15)),
  h('span', { class: 'tree-title' }, page.title || 'Sans titre'),
  canWrite && h('span', { class: 'tree-actions' },
    h('button', { class: 'mini-btn', title: 'Options', onClick: (e) => { e.stopPropagation(); pageMenu(e.currentTarget, page); } }, icon('more', 15)),
    h('button', { class: 'mini-btn', title: 'Ajouter une sous-page', onClick: (e) => { e.stopPropagation(); A.newPage(page.spaceId, page.id); } }, icon('plus', 15))));

  if (canWrite) {
    // Glisser-déposer : haut = avant, bas = après, milieu = à l'intérieur.
    row.addEventListener('dragstart', (e) => {
      dragId = page.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', page.id);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); clearDrop(); });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === page.id || store.isDescendant(page.id, dragId)) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const zone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
      if (!row.classList.contains(`drop-${zone}`)) { clearDrop(); row.classList.add(`drop-${zone}`); }
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after', 'drop-inside'); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = dragId;
      const zone = ['before', 'after', 'inside'].find((z) => row.classList.contains(`drop-${z}`));
      clearDrop();
      if (!id || !zone) return;
      if (zone === 'inside') {
        prefs.expanded[page.id] = true;
        savePrefs();
        A.attempt(() => store.movePage(id, page.id, kids.filter((k) => k.id !== id).length));
      } else {
        const siblings = store.children(page.spaceId, page.parentId).filter((s) => s.id !== id);
        const idx = siblings.findIndex((s) => s.id === page.id);
        A.attempt(() => store.movePage(id, page.parentId, zone === 'before' ? idx : idx + 1));
      }
    });
  }

  return h('li', null, row, open && kids.length ? h('ul', { class: 'tree' }, kids.map((k) => treeNode(k, depth + 1, activeId, canWrite))) : null);
}

function accountBox() {
  if (!session.user) {
    const { oidc, devLogin } = session.config.auth;
    if (!oidc && !devLogin) return null;
    return h('a', { class: 'btn btn-primary btn-block', href: oidc ? session.loginUrl() : '/?login' }, icon('users', 15), 'Se connecter');
  }
  const u = session.user;
  return h('button', { class: 'account', onClick: (e) => accountMenu(e.currentTarget) },
    h('span', { class: 'avatar static', style: { '--c': colorFor(u.id) } }, initials(u.name)),
    h('span', { class: 'account-meta' }, h('strong', null, u.name), h('small', null, ROLE_LABELS[u.role])),
    icon('more', 15));
}

export function renderSidebar() {
  const el = document.getElementById('sidebar');
  const scrollTop = el.querySelector('.sb-scroll')?.scrollTop || 0;
  const space = store.space(prefs.space) || store.spaces[0];
  const dark = currentTheme() === 'dark';
  const brand = h('div', { class: 'sb-brand' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-logo' }), 'Notabene'),
    h('button', { class: 'icon-btn', title: dark ? 'Thème clair' : 'Thème sombre', onClick: () => { A.toggleTheme(); renderSidebar(); } }, icon(dark ? 'sun' : 'moon')),
    h('button', { class: 'icon-btn', title: `Masquer la barre latérale (${modKey}\\)`, onClick: A.toggleSidebar }, icon('panel')));

  if (!space) {
    el.replaceChildren(brand, h('div', { class: 'sb-scroll' }), h('div', { class: 'sb-foot' }, accountBox()));
    return;
  }

  const canWrite = session.can('write');
  const activeId = A.currentPageId();
  const onSpaceHome = location.hash === `#/s/${space.id}`;
  const roots = store.children(space.id, null);
  const favorites = store.favorites();

  const rootDrop = canWrite && h('div', { class: 'root-drop' }, 'Déposer ici pour placer à la racine');
  if (rootDrop) {
    rootDrop.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); rootDrop.classList.add('over'); } });
    rootDrop.addEventListener('dragleave', () => rootDrop.classList.remove('over'));
    rootDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      rootDrop.classList.remove('over');
      if (dragId) A.attempt(() => store.movePage(dragId, null, roots.length, space.id));
    });
  }

  el.replaceChildren(
    brand,
    h('button', { class: 'space-switch', onClick: (e) => spaceMenu(e.currentTarget, space) },
      h('span', { class: 'space-ico' }, space.icon || '📁'),
      h('span', { class: 'space-meta' },
        h('strong', null, space.name),
        h('small', null, `${space.visibility === 'public' ? 'Public' : 'Privé'} · ${store.pagesIn(space.id).length} pages`)),
      icon('chevrons', 15)),
    h('div', { class: 'sb-nav' },
      navBtn('search', session.can('ai') ? 'Rechercher ou demander' : 'Rechercher', A.search, { hint: `${modKey}K` }),
      navBtn('home', 'Accueil de l’espace', () => A.go(`/s/${space.id}`), { active: onSpaceHome }),
      canWrite && navBtn('plus', 'Nouvelle page', () => A.newPage(space.id), { hint: '⌥N' })),
    h('div', { class: 'sb-scroll' },
      favorites.length > 0 && h('section', { class: 'sb-section' },
        h('div', { class: 'sb-section-head' }, h('span', null, 'Favoris')),
        h('ul', { class: 'tree' }, favorites.map((p) => h('li', null, h('div', {
          class: `tree-row${p.id === activeId ? ' active' : ''}`,
          style: { paddingLeft: '10px' },
          onClick: () => A.go(`/p/${p.id}`),
        }, h('span', { class: 'tree-icon' }, p.icon || icon('file', 15)), h('span', { class: 'tree-title' }, p.title || 'Sans titre')))))),
      h('section', { class: 'sb-section' },
        h('div', { class: 'sb-section-head' },
          h('span', null, 'Pages'),
          canWrite && h('button', { class: 'mini-btn', title: 'Nouvelle page', onClick: () => A.newPage(space.id) }, icon('plus', 15))),
        roots.length
          ? h('ul', { class: 'tree' }, roots.map((p) => treeNode(p, 0, activeId, canWrite)))
          : canWrite
            ? h('button', { class: 'sb-empty', onClick: () => A.newPage(space.id) }, 'Aucune page. Créer la première →')
            : h('p', { class: 'sb-empty' }, 'Aucune page.'),
        rootDrop)),
    h('div', { class: 'sb-foot' },
      canWrite && navBtn('trash', 'Corbeille', A.openTrash),
      session.user && navBtn('settings', 'Paramètres', () => A.go('/settings'), { active: location.hash.startsWith('#/settings') }),
      accountBox()));

  el.querySelector('.sb-scroll').scrollTop = scrollTop;
}
