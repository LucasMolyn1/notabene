// Fenêtre « Déplacer vers… » : choisir au clavier ou à la souris la page (ou l'espace) qui accueillera une page.
// Liste déroulante ARIA (combobox + listbox) : flèches, Début/Fin, Entrée ; Échap ferme la fenêtre (dialog natif).
// La page elle-même et ses descendantes sont exclues (le serveur refuserait une boucle).
import { h, norm } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs } from './prefs.js';
import { openModal, pageIcon, toast } from './ui.js';

const MAX_SHOWN = 60;
let seq = 0;

/** Chemin lisible d'une page : « Espace / Parent / … ». */
const pathOf = (p) => [store.space(p.spaceId)?.name, ...store.ancestors(p.id).map((a) => a.title || 'Sans titre')].filter(Boolean).join(' / ');

/** Espaces où la page peut aller : ceux où l'on écrit, sans les espaces personnels d'autrui (le serveur y refuse un déplacement). */
function targetSpaces(page) {
  return store.spaces.filter((s) => store.canWriteIn(s.id) && (s.kind !== 'personal' || s.id === page.spaceId));
}

/** @param {string} id identifiant de la page à déplacer */
export function openMoveDialog(id) {
  const page = store.page(id);
  if (!page || !session.can('write')) return;
  const excluded = new Set([id, ...store.descendants(id).map((d) => d.id)]);
  const spaces = targetSpaces(page);
  const spaceIds = new Set(spaces.map((s) => s.id));
  const here = { spaceId: page.spaceId, parentId: page.parentId || null };

  // Destinations possibles, calculées une fois : racines d'espaces puis pages (titre et chemin normalisés pour le filtre).
  const current = store.space(page.spaceId);
  const all = [
    ...[current, ...spaces.filter((s) => s.id !== page.spaceId)].filter(Boolean).map((s) => ({
      key: `space:${s.id}`, spaceId: s.id, parentId: null,
      label: s.id === page.spaceId ? 'À la racine de l’espace' : `Espace ${s.name}`,
      detail: s.id === page.spaceId ? s.name : 'à la racine',
      ico: pageIcon(s.icon || 'folder', 16),
      text: norm(`${s.name} racine espace`),
    })),
    ...store.spaces.filter((s) => spaceIds.has(s.id)).flatMap((s) => store.pagesIn(s.id))
      .filter((p) => !excluded.has(p.id) && p.kind !== 'base')
      // Pages de l'espace courant d'abord, puis les autres ; ordre alphabétique dans chaque groupe.
      .sort((a, b) => (Number(a.spaceId !== page.spaceId) - Number(b.spaceId !== page.spaceId)) || (a.title || '').localeCompare(b.title || '', 'fr'))
      .map((p) => ({
        key: `page:${p.id}`, spaceId: p.spaceId, parentId: p.id,
        label: p.title || 'Sans titre', detail: pathOf(p),
        ico: pageIcon(p.icon, 16),
        text: norm(`${p.title} ${pathOf(p)}`),
      })),
  ].map((d) => ({ ...d, current: d.spaceId === here.spaceId && d.parentId === here.parentId }));

  const n = ++seq;
  const listId = `move-list-${n}`;
  const inputId = `move-input-${n}`;
  const input = h('input', {
    id: inputId, class: 'input', type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false', maxlength: '200',
    'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', placeholder: 'Titre d’une page ou nom d’un espace',
  });
  const list = h('ul', { id: listId, class: 'move-list', role: 'listbox', 'aria-label': 'Destinations' });
  const status = h('p', { class: 'hint move-status', role: 'status' });
  let shown = [];
  let active = -1;

  const optionId = (i) => `move-opt-${n}-${i}`;
  function setActive(i) {
    const selectable = shown.map((d, k) => (d.current ? -1 : k)).filter((k) => k >= 0);
    if (!selectable.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = selectable.includes(i) ? i : selectable[0];
    list.querySelectorAll('[aria-selected="true"]').forEach((o) => o.setAttribute('aria-selected', 'false'));
    const el = document.getElementById(optionId(active));
    if (el) { el.setAttribute('aria-selected', 'true'); el.scrollIntoView({ block: 'nearest' }); }
    input.setAttribute('aria-activedescendant', optionId(active));
  }
  function step(delta) {
    const selectable = shown.map((d, k) => (d.current ? -1 : k)).filter((k) => k >= 0);
    if (!selectable.length) return;
    const at = selectable.indexOf(active);
    setActive(selectable[Math.min(Math.max(at + delta, 0), selectable.length - 1)]);
  }

  function paint() {
    const q = norm(input.value.trim());
    const matches = q ? all.filter((d) => d.text.includes(q)) : all;
    shown = matches.slice(0, MAX_SHOWN);
    list.replaceChildren(...shown.map((d, i) => h('li', {
      id: optionId(i), class: `move-opt${d.current ? ' current' : ''}`, role: 'option', 'aria-selected': 'false',
      'aria-disabled': d.current ? 'true' : null,
      onMousedown: (e) => e.preventDefault(), // le focus reste dans le champ
      onClick: () => { if (!d.current) choose(d); },
    }, h('span', { class: 'move-ico' }, d.ico),
    h('span', { class: 'move-text' }, h('strong', null, d.label), h('small', null, d.current ? `${d.detail} (emplacement actuel)` : d.detail)))));
    status.textContent = !matches.length ? 'Aucune destination ne correspond.'
      : matches.length > MAX_SHOWN ? `${matches.length} destinations : les ${MAX_SHOWN} premières sont affichées, précisez la recherche.`
        : `${matches.length} destination${matches.length > 1 ? 's' : ''}.`;
    setActive(-1);
  }

  async function choose(d) {
    modal.close();
    const target = d.spaceId !== page.spaceId ? d.spaceId : undefined;
    const index = store.children(d.spaceId, d.parentId).filter((p) => p.id !== id).length;
    try {
      await store.movePage(id, d.parentId, index, target);
    } catch (err) {
      toast(err?.message || 'Déplacement impossible', { kind: 'error' });
      return;
    }
    if (d.parentId) prefs.expanded[d.parentId] = true;
    for (const a of store.ancestors(id)) prefs.expanded[a.id] = true;
    if (target) prefs.space = target;
    savePrefs();
    const parent = d.parentId ? store.page(d.parentId) : null;
    toast(parent ? `Page déplacée sous « ${parent.title || 'Sans titre'} ».` : `Page déplacée à la racine de l’espace ${store.space(d.spaceId)?.name ?? ''}.`);
  }

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home' && e.ctrlKey) step(-Infinity);
    else if (e.key === 'End' && e.ctrlKey) step(Infinity);
    else if (e.key === 'PageDown') step(10);
    else if (e.key === 'PageUp') step(-10);
    else if (e.key === 'Enter') { if (active >= 0 && shown[active]) choose(shown[active]); }
    else return;
    e.preventDefault();
  });

  const modal = openModal({
    title: `Déplacer « ${page.title || 'Sans titre'} »`,
    size: 'medium',
    body: h('div', { class: 'stack move-dialog' },
      h('label', { for: inputId, class: 'field-label' }, 'Rechercher une page ou un espace de destination'),
      input,
      h('p', { class: 'hint', id: `move-help-${n}` }, icon('move', 13), ' Flèches pour choisir, Entrée pour déplacer. La page garde ses sous-pages.'),
      list,
      status),
    actions: [{ label: 'Annuler' }],
  });
  input.setAttribute('aria-describedby', `move-help-${n}`);
  modal.el.classList.add('move-modal');
  paint();
  input.focus();
}
