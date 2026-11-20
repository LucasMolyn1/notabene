// Primitives d'interface : toasts, menus contextuels, modales, sélecteur d'emoji.
import { h } from './util.js';
import { icon } from './icons.js';
import { leave, modalIn, modalOut, popIn, rememberDialog, toastIn } from './motion.js';

// ---- Toasts ---------------------------------------------------------------

/** @param {string} message @param {{ action?: { label: string, onClick: () => void }, timeout?: number, kind?: string }} [options] */
export function toast(message, { action, timeout = 3800, kind = '' } = {}) {
  const host = document.querySelector('.toasts') || document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  let gone = false;
  const dismiss = () => { if (gone) return; gone = true; leave(el, { y: 6, duration: 0.18 }); };
  const el = h('div', { class: `toast ${kind}` },
    h('span', null, message),
    action && h('button', { class: 'toast-action', onClick: () => { action.onClick(); dismiss(); } }, action.label));
  host.append(el);
  toastIn(el);
  setTimeout(dismiss, timeout);
}

// ---- Popovers & menus -----------------------------------------------------

let activePopover = null;

export function closePopover() {
  if (!activePopover) return;
  const { anchor, el } = activePopover;
  const hadFocus = el.contains(document.activeElement);
  anchor.setAttribute('aria-expanded', 'false');
  leave(el); // retiré de l'interaction tout de suite, effacé ensuite
  document.removeEventListener('mousedown', activePopover.outside, true);
  document.removeEventListener('keydown', activePopover.esc, true);
  activePopover = null;
  // Le focus revient au déclencheur (sinon il retomberait au début de la page).
  if (hadFocus && anchor.isConnected) anchor.focus();
}

export function openPopover(anchor, content, { align = 'left', className = '' } = {}) {
  closePopover();
  const el = h('div', { class: `popover ${className}` }, content);
  // Dans une boîte de dialogue ouverte (couche supérieure du navigateur), le menu doit s'y trouver : placé dans <body>, il
  // s'afficherait derrière la boîte et resterait inerte.
  (anchor.closest('dialog[open]') ?? document.body).append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  let top = r.bottom + 6;
  if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 6);
  left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
  activePopover = { el, outside, esc, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  popIn(el, { y: top < r.top ? 4 : -4 });
  return el;
}

// items : { label, icon?, emoji?, onClick, danger?, checked?, hint?, disabled? } | { sep: true } | { heading }
export function openMenu(anchor, items, opts) {
  if (activePopover?.anchor === anchor) { closePopover(); return; }
  const list = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => {
    if (it.sep) return h('div', { class: 'menu-sep' });
    if (it.heading) return h('div', { class: 'menu-heading' }, it.heading);
    return h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}`,
      role: 'menuitem',
      disabled: !!it.disabled,
      onClick: () => { closePopover(); it.onClick?.(); },
    },
    h('span', { class: 'menu-ico' }, it.emoji || (it.icon ? icon(it.icon) : null)),
    h('span', { class: 'menu-label' }, it.label),
    it.checked != null ? h('span', { class: 'menu-check' }, it.checked ? icon('check') : null)
      : it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
  }));
  anchor.setAttribute('aria-haspopup', 'menu');
  openPopover(anchor, list, opts);
  // Clavier : le focus entre dans le menu ; flèches, Début/Fin pour naviguer, Tab ferme, Échap ferme (voir openPopover).
  const enabled = () => [...list.querySelectorAll('.menu-item:not(:disabled)')];
  enabled()[0]?.focus();
  list.addEventListener('keydown', (e) => {
    const all = enabled();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus();
    else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus();
    else if (e.key === 'Home') all[0]?.focus();
    else if (e.key === 'End') all.at(-1)?.focus();
    else if (e.key === 'Tab') { closePopover(); return; }
    else return;
    e.preventDefault();
  });
}

export const ICON_LABELS = {
  benote: 'BeNote', file: 'Page', folder: 'Dossier', home: 'Accueil', star: 'Étoile', layers: 'Couches', code: 'Code', settings: 'Réglages', shield: 'Bouclier',
  key: 'Clé', lock: 'Cadenas', globe: 'Globe', eye: 'Œil', search: 'Loupe', link: 'Lien', pencil: 'Crayon', download: 'Téléchargement',
  upload: 'Envoi', users: 'Personnes', sparkle: 'Étincelle', diamond: 'Diamant', hexagon: 'Hexagone', webhook: 'Webhook', pdf: 'PDF', wand: 'Baguette', table: 'Tableau',
};

export const PAGE_ICONS = [
  'benote', 'file', 'folder', 'home', 'star', 'layers', 'code', 'settings', 'shield',
  'key', 'lock', 'globe', 'eye', 'search', 'link', 'pencil', 'download',
  'upload', 'users', 'sparkle', 'diamond', 'hexagon', 'webhook', 'pdf', 'wand', 'table',
];

// Icône image importée : `img:<identifiant>` (22 caractères base64url). L'adresse est construite avec l'identifiant validé seul.
const ICON_IMAGE = /^img:([A-Za-z0-9_-]{22})$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,90}$/;
let iconShareToken = null;

/** Vue publique d'un lien de partage : les icônes image se lisent par ce lien (sans compte). `null` en sortant de la vue. */
export function setIconShareToken(token) { iconShareToken = typeof token === 'string' && SHARE_TOKEN.test(token) ? token : null; }

/** Identifiant de l'image désignée par une icône, ou null (emoji, nom d'icône, vide). */
export const iconImageId = (name) => (typeof name === 'string' ? ICON_IMAGE.exec(name)?.[1] ?? null : null);

/** Adresse d'une icône image ; sur une page partagée, par le lien public. */
export const iconImageUrl = (id) => (iconShareToken
  ? `/api/v3/public/shares/${iconShareToken}/page-icons/${id}`
  : `/api/v3/page-icons/${id}`);

// Icône d'une page ou d'un espace : nom d'une icône de l'interface (« folder »), emoji, ou image importée (`img:<identifiant>`).
// Un emoji s'affiche en texte (jamais en HTML) ; une image est décorative (le titre de la page l'accompagne toujours).
export function pageIcon(name, size = 16) {
  if (!name) return icon('file', size);
  const imageId = iconImageId(name);
  if (imageId) {
    const img = h('img', {
      class: 'icon-img', src: iconImageUrl(imageId), alt: '', 'aria-hidden': 'true', draggable: 'false',
      width: String(size), height: String(size), loading: 'lazy', decoding: 'async',
      style: { width: `${size}px`, height: `${size}px` },
    });
    // Image retirée, illisible ou réseau coupé : repli sur l'icône vide.
    img.addEventListener('error', () => img.replaceWith(icon('file', size)), { once: true });
    return img;
  }
  if (name.startsWith('img:')) return icon('file', size); // valeur image mal formée
  // Le « N » de BeNote : pastille violette fixe (pas une icône au trait, elle garde ses couleurs).
  if (name === 'benote') return h('span', { class: 'brand-logo brand-glyph', style: { width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.29)}px` }, 'aria-hidden': 'true' });
  if (PAGE_ICONS.includes(name)) return icon(name, size);
  if (/^[a-z-]+$/i.test(name)) return icon('file', size); // nom inconnu
  return h('span', { class: 'emoji-glyph', style: { fontSize: `${Math.round(size * 0.95)}px` }, 'aria-hidden': 'true' }, name);
}

// ---- Modales --------------------------------------------------------------

let modalSeq = 0;
export function openModal({ title, body, actions = [], size = '' }) {
  const titleId = `modal-title-${++modalSeq}`;
  const dlg = h('dialog', { class: `modal ${size}`, 'aria-labelledby': titleId });
  const close = () => { if (dlg.open) { rememberDialog(dlg); dlg.close(); } };
  dlg.append(h('div', { class: 'modal-inner' },
    h('div', { class: 'modal-head' },
      h('h2', { id: titleId }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onClick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length > 0 && h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-ghost'}`,
      onClick: async () => { if ((await a.onClick?.()) !== false) close(); },
    }, a.label)))));
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  // Échap : la position est relevée avant la fermeture native, pour l'animation de sortie.
  dlg.addEventListener('cancel', () => rememberDialog(dlg));
  dlg.addEventListener('close', () => modalOut(dlg));
  document.body.append(dlg);
  dlg.showModal();
  modalIn(dlg);
  return { el: dlg, close };
}

export function confirmModal({ title, message, confirm = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title,
      body: h('p', { class: 'muted' }, message),
      actions: [{ label: 'Annuler' }, { label: confirm, danger, primary: !danger, onClick: () => { ok = true; } }],
    });
    m.el.addEventListener('close', () => resolve(ok));
  });
}
