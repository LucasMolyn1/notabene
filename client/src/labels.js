// Libellés d'une page : pastilles cliquables, ajout avec suggestions, retrait.
// Les noms viennent du serveur et ne sont affichés que comme texte (jamais interprétés comme du HTML).
import { api } from './api.js';
import { icon } from './icons.js';
import { toast } from './ui.js';
import { debounce, h } from './util.js';

export const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

/** Même règle que server/src/lib/labels.ts : minuscules, espaces remplacés par des tirets. */
export const normalizeLabel = (raw) => String(raw).normalize('NFC').trim().toLocaleLowerCase('fr').replace(/\s+/gu, '-');

export const labelPath = (name) => `/labels/${encodeURIComponent(name)}`;

let counter = 0;

/**
 * @param {string} pageId
 * @param {{ initial?: string[], canWrite: boolean }} options
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function labelBar(pageId, { initial = [], canWrite }) {
  let labels = [...initial];
  let adding = false;
  const listId = `label-suggest-${++counter}`;
  const el = h('div', { class: 'labels', role: 'group', 'aria-label': 'Libellés de la page' });

  async function change(request) {
    try {
      labels = (await request()).items;
    } catch (err) {
      toast(err?.message || 'Impossible de modifier les libellés.', { kind: 'error' });
    }
    paint();
  }

  function remove(name) { return change(() => api.del(`/pages/${pageId}/labels/${encodeURIComponent(name)}`)); }

  function submit(input) {
    const name = normalizeLabel(input.value);
    if (!name) { adding = false; paint(); return; }
    if (!LABEL_PATTERN.test(name)) {
      toast('Libellé invalide : 40 caractères au plus, lettres, chiffres, tirets et soulignés.', { kind: 'error' });
      input.focus();
      return;
    }
    adding = false;
    change(() => api.post(`/pages/${pageId}/labels`, { name })).then(() => el.querySelector('.label-add')?.focus());
  }

  function adder() {
    const suggestions = h('datalist', { id: listId });
    const input = h('input', {
      class: 'input input-sm label-input', type: 'text', maxlength: '40', list: listId, autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Nouveau libellé', placeholder: 'Nouveau libellé',
    });
    const suggest = debounce(async () => {
      try {
        const q = normalizeLabel(input.value);
        const found = (await api.get(`/labels?q=${encodeURIComponent(q)}`)).items;
        suggestions.replaceChildren(...found.filter((l) => !labels.includes(l.name)).slice(0, 8).map((l) => h('option', { value: l.name })));
      } catch { /* suggestions facultatives */ }
    }, 150);
    input.addEventListener('input', suggest);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(input); }
      else if (e.key === 'Escape') { e.preventDefault(); adding = false; paint(); el.querySelector('.label-add')?.focus(); }
    });
    input.addEventListener('blur', () => { if (!input.value.trim()) { adding = false; paint(); } });
    queueMicrotask(() => input.focus());
    suggest();
    return [input, suggestions];
  }

  function paint() {
    el.hidden = !canWrite && !labels.length;
    const nodes = labels.map((name) => h('span', { class: 'label-chip' },
      h('a', { class: 'label-link', href: labelPath(name), title: `Toutes les pages portant « ${name} »` }, name),
      canWrite && h('button', { class: 'label-x', type: 'button', 'aria-label': `Retirer le libellé ${name}`, onClick: () => remove(name) }, icon('x', 12))));
    if (canWrite) {
      if (adding) nodes.push(...adder());
      else nodes.push(h('button', { class: 'label-add', type: 'button', onClick: () => { adding = true; paint(); } }, icon('plus', 13), labels.length ? 'Libellé' : 'Ajouter un libellé'));
    }
    el.replaceChildren(...nodes);
  }

  // Modification faite ailleurs (autre onglet, autre personne, API) : on relit la liste.
  async function onRemote(e) {
    if (e.detail?.pageId !== pageId || adding) return;
    try { labels = (await api.get(`/pages/${pageId}/labels`)).items; paint(); } catch { /* page devenue inaccessible */ }
  }
  window.addEventListener('notabene:labels', onRemote);

  paint();
  return { el, destroy: () => window.removeEventListener('notabene:labels', onRemote) };
}
