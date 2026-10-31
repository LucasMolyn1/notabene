// Barre latérale : sélecteur d'espace, favoris, arborescence (glisser-déposer), compte.
import { newsPending, onNewsChange } from './news.js';
import { h, modKey } from './util.js';
import { pagePath, spacePath } from './urls.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, currentTheme } from './prefs.js';
import { avatarEl } from './avatar.js';
import { openMenu, pageIcon } from './ui.js';
import * as A from './actions.js';

let dragId = null;

/** @param {string} ico @param {string} label @param {() => void} onClick @param {{ hint?: string, active?: boolean, badge?: boolean | string }} [options] */
const navBtn = (ico, label, onClick, { hint, active, badge } = {}) => h('button', {
  class: `sb-btn${active ? ' active' : ''}`, onClick,
}, icon(ico), h('span', { class: 'sb-btn-label' }, label),
hint ? h('kbd', null, hint) : null,
badge === true ? h('span', { class: 'news-dot', role: 'img', 'aria-label': 'Nouveautés' }) : badge ? h('span', { class: 'badge' }, badge) : null);

const ROLE_LABELS = { admin: 'Administrateur', editor: 'Éditeur', reader: 'Lecteur' };

function spaceMenu(anchor, space) {
  const admin = session.can('admin');
  const canCreatePersonal = !!session.config.personalSpaces && session.can('write') && !store.personalSpace(session.user?.id);
  openMenu(anchor, [
    { heading: 'Espaces' },
    ...store.spaces.map((s) => ({
      label: s.name, icon: s.icon || 'folder', checked: s.id === space.id,
      onClick: () => { prefs.space = s.id; savePrefs(); A.go(`/s/${s.id}`); },
    })),
    (admin || canCreatePersonal || store.canManage(space.id)) && { sep: true },
    canCreatePersonal && { label: 'Créer mon espace personnel', icon: 'home', onClick: () => A.createPersonalSpace() },
    admin && { label: 'Nouvel espace', icon: 'plus', onClick: () => A.spaceForm() },
    (admin || store.canManage(space.id)) && { label: 'Paramètres de l’espace', icon: 'settings', onClick: () => A.spaceForm(space) },
    admin && space.kind !== 'personal' && store.spaces.filter((x) => x.kind !== 'personal').length > 1 && { label: 'Supprimer l’espace', icon: 'trash', danger: true, onClick: () => A.deleteSpace(space) },
    space.kind === 'personal' && space.ownerId === session.user?.id && { label: 'Supprimer mon espace personnel', icon: 'trash', danger: true, onClick: () => A.deletePersonalSpace(space) },
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
    { label: 'Exporter en PDF', icon: 'pdf', onClick: () => A.exportPDF(page.id) },
    others.length && { sep: true },
    ...others.map((s) => ({ label: `Déplacer vers ${s.name}`, icon: 'folder', onClick: () => A.moveToSpace(page.id, s.id) })),
    ...others.map((s) => ({ label: `Copier vers ${s.name}`, icon: 'copy', onClick: () => A.copyToSpace(page.id, s.id) })),
    { sep: true },
    { label: 'Mettre à la corbeille', icon: 'trash', danger: true, onClick: () => A.trash(page.id) },
  ]);
}

function accountMenu(anchor) {
  const admin = session.can('admin');
  openMenu(anchor, [
    { heading: `${session.user.name} · ${ROLE_LABELS[session.user.role]}` },
    { label: 'Paramètres', icon: 'settings', onClick: () => A.go('/settings') },
    { label: 'Profil et sessions', icon: 'users', onClick: () => A.go('/settings/profile') },
    { label: 'Jetons d’API', icon: 'code', onClick: () => A.go('/settings/tokens') },
    { label: 'Recherche IA', icon: 'sparkle', onClick: () => A.go('/settings/ai') },
    admin && { label: 'Administration', icon: 'shield', onClick: () => A.go('/settings/instance') },
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

// Focus à rétablir après le prochain rendu (la barre latérale est reconstruite à chaque changement).
let pendingFocus = null;

function setExpanded(id, value) {
  prefs.expanded[id] = value;
  savePrefs();
  pendingFocus = id;
  renderSidebar();
}

// Clavier de l'arbre (modèle ARIA « tree ») : flèches, Début/Fin, Entrée, F2 renommer, menu contextuel,
// Alt+Haut/Bas pour réordonner (équivalent clavier du glisser-déposer).
function onTreeKey(e) {
  const row = e.target;
  if (!(row instanceof HTMLElement) || !row.matches('.tree-row[role=treeitem]')) return;
  const page = store.page(row.dataset.id);
  if (!page) return;
  const rows = /** @type {HTMLElement[]} */ ([...row.closest('[role=tree]').querySelectorAll('.tree-row[role=treeitem]')]);
  const i = rows.indexOf(row);
  const focusRow = (r) => { if (!r) return; rows.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
  const kids = store.children(page.spaceId, page.id);
  const open = !!prefs.expanded[page.id];
  const canWrite = session.can('write') && store.canWriteIn(page.spaceId);

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (!canWrite) return;
    const siblings = store.children(page.spaceId, page.parentId);
    const at = siblings.findIndex((s) => s.id === page.id);
    const target = at + (e.key === 'ArrowDown' ? 1 : -1);
    if (target >= 0 && target < siblings.length) {
      pendingFocus = page.id;
      A.attempt(() => store.movePage(page.id, page.parentId, target));
    }
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'ArrowDown': focusRow(rows[i + 1]); break;
    case 'ArrowUp': focusRow(rows[i - 1]); break;
    case 'Home': focusRow(rows[0]); break;
    case 'End': focusRow(rows.at(-1)); break;
    case 'ArrowRight':
      if (kids.length && !open) setExpanded(page.id, true);
      else if (kids.length) focusRow(rows[i + 1]);
      break;
    case 'ArrowLeft':
      if (kids.length && open) setExpanded(page.id, false);
      else focusRow(rows.find((r) => r.dataset.id === page.parentId));
      break;
    case 'Enter': case ' ': A.go(`/p/${page.id}`); break;
    case 'F2': if (canWrite) startRename(page.id); break;
    case 'ContextMenu': if (canWrite) pageMenu(row, page); break;
    default:
      if (e.key === 'F10' && e.shiftKey && canWrite) { pageMenu(row, page); break; }
      return;
  }
  e.preventDefault();
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
    // Arbre ARIA : un seul élément de l'arbre est dans l'ordre de tabulation, les flèches font le reste (voir onTreeKey).
    role: 'treeitem',
    'aria-level': String(depth + 1),
    'aria-label': page.title || 'Sans titre',
    'aria-selected': page.id === activeId ? 'true' : 'false',
    'aria-expanded': kids.length ? String(open) : null,
    tabindex: page.id === activeId ? '0' : '-1',
    onClick: () => A.go(`/p/${page.id}`),
    onDblClick: (e) => { if (canWrite) { e.preventDefault(); startRename(page.id); } },
  },
  h('button', {
    class: `caret${kids.length ? '' : ' leaf'}${open ? ' open' : ''}`,
    'aria-label': open ? 'Replier' : 'Déplier',
    tabindex: '-1',
    onClick: (e) => {
      e.stopPropagation();
      if (!kids.length) return;
      prefs.expanded[page.id] = !open;
      savePrefs();
      renderSidebar();
    },
  }, icon('chevron', 14)),
  h('span', { class: 'tree-icon' }, pageIcon(page.icon, 15)),
  h('span', { class: 'tree-title' }, page.title || 'Sans titre'),
  canWrite && h('span', { class: 'tree-actions' },
    h('button', { class: 'mini-btn', title: 'Options', tabindex: '-1', onClick: (e) => { e.stopPropagation(); pageMenu(e.currentTarget, page); } }, icon('more', 15)),
    h('button', { class: 'mini-btn', title: 'Ajouter une sous-page', tabindex: '-1', onClick: (e) => { e.stopPropagation(); A.newPage(page.spaceId, page.id); } }, icon('plus', 15))));

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

  return h('li', { role: 'none' }, row, open && kids.length ? h('ul', { class: 'tree', role: 'group' }, kids.map((k) => treeNode(k, depth + 1, activeId, canWrite))) : null);
}

function accountBox() {
  if (!session.user) {
    const { oidc, devLogin, local, ldap, saml } = session.config.auth;
    if (!oidc && !devLogin && !local && !ldap && !saml) return null;
    return h('a', { class: 'btn btn-primary btn-block', href: oidc ? session.loginUrl() : '/?login' }, icon('users', 15), 'Se connecter');
  }
  const u = session.user;
  return h('button', { class: 'account', onClick: (e) => accountMenu(e.currentTarget) },
    avatarEl(u, { cls: 'static' }),
    h('span', { class: 'account-meta' }, h('strong', null, u.name), h('small', null, ROLE_LABELS[u.role])),
    icon('more', 15));
}

export function renderSidebar() {
  const el = document.getElementById('sidebar');
  const scrollTop = el.querySelector('.sb-scroll')?.scrollTop || 0;
  // La barre est reconstruite à chaque changement (y compris ceux venus d'un autre onglet) : le focus clavier doit survivre.
  const focusedRow = el.contains(document.activeElement) ? /** @type {HTMLElement | null | undefined} */ (document.activeElement.closest?.('.tree-row[data-id]'))?.dataset.id : null;
  const space = store.space(prefs.space) || store.spaces[0];
  const dark = currentTheme() === 'dark';
  const brand = h('div', { class: 'sb-brand' },
    h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-logo' }), 'Notabene'),
    h('button', { class: 'icon-btn', title: dark ? 'Thème clair' : 'Thème sombre', onClick: () => { A.toggleTheme(); renderSidebar(); } }, icon(dark ? 'sun' : 'moon')),
    h('button', { class: 'icon-btn', title: `Masquer la barre latérale (${modKey}\\)`, onClick: A.toggleSidebar }, icon('panel')));

  if (!space) {
    el.replaceChildren(brand, h('div', { class: 'sb-scroll' }), h('div', { class: 'sb-foot' }, accountBox()));
    return;
  }

  const canWrite = session.can('write') && store.canWriteIn(space.id);
  const activeId = A.currentPageId();
  const onSpaceHome = location.pathname === spacePath(space);
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
      h('span', { class: 'space-ico' }, pageIcon(space.icon || 'folder', 18)),
      h('span', { class: 'space-meta' },
        h('strong', null, space.name),
        h('small', null, `${space.visibility === 'public' ? 'Public' : 'Privé'} · ${store.pagesIn(space.id).length} pages`)),
      icon('chevrons', 15)),
    h('div', { class: 'sb-nav' },
      navBtn('search', session.can('ai') ? 'Rechercher ou demander' : 'Rechercher', A.search, { hint: `${modKey}K` }),
      navBtn('home', 'Accueil de l’espace', () => A.go(`/s/${space.id}`), { active: onSpaceHome }),
      canWrite && navBtn('plus', 'Nouvelle page', () => A.newPage(space.id), { hint: '⌥N' }),
      canWrite && navBtn('layers', 'Depuis un modèle', () => A.newPageFromTemplate(space.id))),
    h('div', { class: 'sb-scroll' },
      favorites.length > 0 && h('section', { class: 'sb-section' },
        h('div', { class: 'sb-section-head' }, h('span', null, 'Favoris')),
        h('ul', { class: 'tree' }, favorites.map((p) => h('li', null, h('a', {
          class: `tree-row${p.id === activeId ? ' active' : ''}`,
          style: { paddingLeft: '10px' },
          href: pagePath(p),
          'aria-current': p.id === activeId ? 'page' : null,
        }, h('span', { class: 'tree-icon' }, pageIcon(p.icon, 15)), h('span', { class: 'tree-title' }, p.title || 'Sans titre')))))),
      h('section', { class: 'sb-section' },
        h('div', { class: 'sb-section-head' },
          h('span', null, 'Pages'),
          canWrite && h('button', { class: 'mini-btn', title: 'Nouvelle page', onClick: () => A.newPage(space.id) }, icon('plus', 15))),
        roots.length
          ? h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Pages', onKeydown: onTreeKey }, roots.map((p) => treeNode(p, 0, activeId, canWrite)))
          : canWrite
            ? h('button', { class: 'sb-empty', onClick: () => A.newPage(space.id) }, 'Aucune page. Créer la première →')
            : h('p', { class: 'sb-empty' }, 'Aucune page.'),
        rootDrop)),
    h('div', { class: 'sb-foot' },
      // Administrateur : une nouvelle version existe. Le lien mène aux nouveautés (et aux consignes de mise à jour).
      session.updateAvailable && h('a', { class: 'update-banner', href: '/settings/about' }, icon('sparkle', 16),
        h('span', null, h('strong', null, `Version ${session.update.latest.version} disponible`), h('small', null, 'Voir les nouveautés'))),
      canWrite && navBtn('trash', 'Corbeille', A.openTrash),
      session.user && navBtn('settings', 'Paramètres', () => A.go('/settings'), { active: location.pathname.startsWith('/settings'), badge: newsPending(session.version) || session.updateAvailable || undefined }),
      accountBox()));

  el.querySelector('.sb-scroll').scrollTop = scrollTop;
  // L'arbre doit rester atteignable au clavier même si aucune page n'est ouverte : première ligne = point d'entrée.
  const tree = el.querySelector('[role=tree]');
  if (tree && !tree.querySelector('.tree-row[tabindex="0"]')) tree.querySelector('.tree-row[role=treeitem]')?.setAttribute('tabindex', '0');
  const wanted = pendingFocus || focusedRow;
  if (wanted) {
    const target = /** @type {HTMLElement | null | undefined} */ (tree?.querySelector(`.tree-row[data-id="${wanted}"]`));
    pendingFocus = null;
    if (target) { tree.querySelectorAll('.tree-row[tabindex="0"]').forEach((r) => { /** @type {HTMLElement} */ (r).tabIndex = -1; }); target.tabIndex = 0; target.focus(); }
  }
}

// Quand les nouveautés sont consultées, la pastille de « Paramètres » s'éteint.
onNewsChange(() => renderSidebar());
