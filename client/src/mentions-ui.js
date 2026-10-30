// Suggestions de personnes à mentionner : liste flottante partagée par l'éditeur et la zone de commentaire.
// Les noms viennent du serveur et ne sont affichés que comme texte.
import { api } from './api.js';
import { h } from './util.js';

export const searchMentionable = async (pageId, q) => (await api.get(`/pages/${pageId}/mentionable?q=${encodeURIComponent(q)}`)).items;

/**
 * `host` : élément qui reçoit la liste, lu à chaque affichage. Dans une fenêtre modale (`dialog`), elle doit en faire partie, sinon la fenêtre la recouvre.
 * @param {{ search: (query: string) => Promise<{ id: string, name: string }[]>, onPick: (user: { id: string, name: string }) => void, host?: () => HTMLElement }} options
 */
export function suggestList({ search, onPick, host = () => document.body }) {
  const el = h('div', { class: 'mention-list', role: 'listbox', 'aria-label': 'Personnes à mentionner', hidden: true });
  document.body.append(el);
  let items = [];
  let active = 0;
  let open = false;
  let seq = 0;

  const close = () => { seq++; open = false; el.hidden = true; items = []; };

  function render() {
    el.replaceChildren(...items.map((u, i) => h('button', {
      class: `mention-item${i === active ? ' active' : ''}`, type: 'button', role: 'option', 'aria-selected': String(i === active),
      onMouseDown: (e) => { e.preventDefault(); pick(i); },
      onMouseMove: () => { if (active !== i) { active = i; render(); } },
    }, u.name)));
  }

  function place(rect) {
    el.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
  }

  function pick(i) {
    const user = items[i];
    if (!user) return;
    close();
    onPick(user);
  }

  return {
    /** Affiche les suggestions pour `query`, sous le rectangle `rect` (coordonnées de la fenêtre). */
    async show(query, rect) {
      const mine = ++seq;
      let found;
      try { found = await search(query); } catch { found = []; }
      if (mine !== seq) return;
      if (!found.length) { close(); return; }
      const target = host();
      if (el.parentElement !== target) target.append(el);
      items = found;
      active = 0;
      open = true;
      el.hidden = false;
      render();
      place(rect);
    },
    close,
    isOpen: () => open,
    /** Touches de navigation ; renvoie true si la touche a été traitée. */
    onKeyDown(e) {
      if (!open) return false;
      if (e.key === 'ArrowDown') { active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' || e.key === 'Tab') pick(active);
      else if (e.key === 'Escape') close();
      else return false;
      e.preventDefault();
      return true;
    },
    destroy() { close(); el.remove(); },
  };
}

/**
 * Ajoute les mentions « @nom » à une zone de texte (commentaire). `ids()` renvoie les personnes dont « @Nom » figure encore dans le texte.
 * @param {HTMLTextAreaElement} textarea
 */
export function attachMentions(textarea, pageId) {
  const picked = new Map(); // identifiant -> nom (deux personnes de même nom restent distinctes)
  let range = null;
  const list = suggestList({
    host: () => textarea.closest('dialog') || document.body,
    search: (q) => searchMentionable(pageId, q),
    onPick: (user) => {
      if (!range) return;
      const text = `@${user.name} `;
      textarea.setRangeText(text, range.from, range.to, 'end');
      picked.set(user.id, user.name);
      textarea.focus();
      range = null;
    },
  });

  function update() {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    const query = at < 0 ? '' : before.slice(at + 1);
    // Le « @ » doit commencer un mot, et la saisie rester courte, sans retour à la ligne.
    if (at < 0 || (at > 0 && !/\s/u.test(before[at - 1])) || query.length > 40 || /[\n@]/u.test(query) || query.split(' ').length > 3) { list.close(); return; }
    range = { from: at, to: pos };
    list.show(query, textarea.getBoundingClientRect());
  }

  textarea.addEventListener('input', update);
  textarea.addEventListener('keydown', (e) => { if (list.onKeyDown(e)) e.stopPropagation(); });
  textarea.addEventListener('blur', () => setTimeout(list.close, 120));
  return {
    ids: () => [...picked].filter(([, name]) => textarea.value.includes(`@${name}`)).map(([id]) => id),
    destroy: list.destroy,
  };
}
