// Primitives d'interface : toasts, menus contextuels, modales, sélecteur d'emoji.
import { h } from './util.js';
import { icon } from './icons.js';

// ---- Toasts ---------------------------------------------------------------

export function toast(message, { action, timeout = 3800, kind = '' } = {}) {
  const host = document.querySelector('.toasts') || document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  const el = h('div', { class: `toast ${kind}` },
    h('span', null, message),
    action && h('button', { class: 'toast-action', onClick: () => { action.onClick(); dismiss(); } }, action.label));
  host.append(el);
  setTimeout(dismiss, timeout);
}

// ---- Popovers & menus -----------------------------------------------------

let activePopover = null;

export function closePopover() {
  if (!activePopover) return;
  activePopover.el.remove();
  document.removeEventListener('mousedown', activePopover.outside, true);
  document.removeEventListener('keydown', activePopover.esc, true);
  activePopover = null;
}

export function openPopover(anchor, content, { align = 'left', className = '' } = {}) {
  closePopover();
  const el = h('div', { class: `popover ${className}` }, content);
  document.body.append(el);
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
  openPopover(anchor, list, opts);
}

const EMOJIS = '📄 📝 📘 📚 📓 🗂️ 📌 📎 🚀 ✨ 💡 🧠 🎯 🧭 🗺️ 🧱 ⚙️ 🛠️ 🔧 🧪 🐛 🔒 🔑 📊 📈 🗓️ ⏱️ ✅ ❗ ⚠️ 💬 📣 👋 🙌 🤝 👥 🏠 🌍 🌱 🔥 ⭐ 💎 🎨 🎬 🎵 📷 💻 📱 ☕ 🍕 ⚡ 🌙 ☀️ 🧩 🏆 💼 🔍 🚢 📐 🎓'.split(' ');

export function emojiPicker(anchor, onPick, { allowRemove = true } = {}) {
  const grid = h('div', { class: 'emoji-grid' }, EMOJIS.map((e) =>
    h('button', { class: 'emoji-btn', type: 'button', onClick: () => { closePopover(); onPick(e); } }, e)));
  const foot = h('div', { class: 'emoji-foot' },
    h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { closePopover(); onPick(EMOJIS[Math.floor(Math.random() * EMOJIS.length)]); } }, '🎲 Au hasard'),
    allowRemove && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { closePopover(); onPick(''); } }, 'Retirer'));
  openPopover(anchor, h('div', { class: 'emoji-picker' }, grid, foot));
}

// ---- Modales --------------------------------------------------------------

export function openModal({ title, body, actions = [], size = '' }) {
  const dlg = h('dialog', { class: `modal ${size}` });
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.append(h('div', { class: 'modal-inner' },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onClick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length > 0 && h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-ghost'}`,
      onClick: async () => { if ((await a.onClick?.()) !== false) close(); },
    }, a.label)))));
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
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
