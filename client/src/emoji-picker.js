// Sélecteur d'icône de page ou d'espace : les icônes de l'interface et tous les emojis (noms et mots-clés en français).
// Les données (emojibase, ~600 Ko) ne se chargent qu'à la première ouverture. La valeur enregistrée est soit le nom
// d'une icône (« folder »), soit le caractère emoji lui-même. Pour une page, un panneau « Importer une image » envoie une image
// (PNG, JPEG, WebP ou GIF) ; la valeur devient alors `img:<identifiant>`, fixée par le serveur.
import { h, norm } from './util.js';
import { icon } from './icons.js';
import { closePopover, iconImageId, openPopover, pageIcon, PAGE_ICONS, ICON_LABELS, toast } from './ui.js';

const RECENT_KEY = 'notabene:recent-emojis';
const RECENT_MAX = 16;
const COLUMNS = 8;

// Groupes d'emojibase (0 à 9 ; 2 = composants, écartés), avec le libellé français et un emoji pour l'onglet.
const GROUPS = [
  { id: 0, label: 'Visages et émotions', tab: '😀' }, { id: 1, label: 'Personnes et corps', tab: '👋' }, { id: 3, label: 'Animaux et nature', tab: '🐻' },
  { id: 4, label: 'Nourriture et boissons', tab: '🍔' }, { id: 5, label: 'Voyages et lieux', tab: '🚗' }, { id: 6, label: 'Activités', tab: '⚽' },
  { id: 7, label: 'Objets', tab: '💡' }, { id: 8, label: 'Symboles', tab: '❤️' }, { id: 9, label: 'Drapeaux', tab: '🏁' },
];

const readRecents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string' && !x.startsWith('img:')).slice(0, RECENT_MAX); } catch { return []; } };
const pushRecent = (value) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([value, ...readRecents().filter((x) => x !== value)].slice(0, RECENT_MAX))); } catch { /* navigation privée */ } };

let dataset = null;
async function loadEmojis() {
  dataset ||= import('emojibase-data/fr/compact.json').then((m) => /** @type {any[]} */ (m.default ?? m)
    .filter((e) => e.group !== undefined && e.group !== 2 && e.unicode.length <= 16)
    .map((e) => ({ char: e.unicode, label: e.label, group: e.group, order: e.order ?? 0, search: norm(`${e.label} ${(e.tags ?? []).join(' ')}`) }))
    .sort((a, b) => a.order - b.order));
  return dataset;
}

// ---- Icône image : contrôles côté client (le serveur refait tous les contrôles sur les octets) ----------------------------
const ICON_MAX_BYTES = 512 * 1024;
const ICON_MIN_SIDE = 8;
const ICON_MAX_SIDE = 1024;
const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Type reconnu sur les premiers octets (signature), ou null. */
async function sniffImage(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const at = (i, ...bytes) => bytes.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

const readDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const kilo = (n) => `${Math.max(1, Math.round(n / 1024))} Ko`;

/**
 * Contrôle un fichier choisi : type, poids, dimensions. Renvoie { dataUrl, base64, width, height } ou lève une Error au message
 * lisible. Le fichier n'est lu qu'après les contrôles de type et de poids.
 * @param {File} file
 */
async function checkIconFile(file) {
  if ((file.type && !ICON_TYPES.includes(file.type)) || !(await sniffImage(file))) {
    throw new Error('Format non pris en charge : choisissez une image PNG, JPEG, WebP ou GIF (pas de SVG).');
  }
  if (file.size > ICON_MAX_BYTES) throw new Error(`Image trop lourde (${kilo(file.size)}) : 512 Ko au plus.`);
  if (file.size === 0) throw new Error('Le fichier est vide.');
  const dataUrl = await readDataUrl(file);
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { throw new Error('Image illisible : le fichier est peut-être endommagé.'); }
  const { naturalWidth: width, naturalHeight: height } = img;
  if (width < ICON_MIN_SIDE || height < ICON_MIN_SIDE || width > ICON_MAX_SIDE || height > ICON_MAX_SIDE) {
    throw new Error(`Dimensions non acceptées (${width} × ${height} pixels) : entre ${ICON_MIN_SIDE} et ${ICON_MAX_SIDE} pixels de côté.`);
  }
  return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
}

/** Message d'une erreur d'envoi, selon le statut HTTP. */
function uploadError(err) {
  switch (err?.status) {
    case 400: return err.message && !/^Erreur \d+$/.test(err.message) ? `Image refusée : ${err.message}` : 'Image refusée par le serveur.';
    case 403: return 'Vous n’avez pas le droit de modifier cette page.';
    case 404: return 'Page introuvable : elle a peut-être été supprimée.';
    case 413: return 'Image trop lourde : 512 Ko au plus.';
    case 429: return 'Trop d’envois rapprochés : réessayez dans une minute.';
    default: return err?.message || 'Envoi impossible : vérifiez la connexion.';
  }
}

/**
 * Panneau « Importer une image » du sélecteur.
 * @param {{ current: () => string, upload: (base64: string) => Promise<unknown>, remove: () => Promise<unknown> }} image
 * @param {() => void} back retour aux emojis
 */
function imagePanel(image, back) {
  let chosen = null;
  let busy = false;
  const status = h('p', { class: 'icon-upload-status', role: 'status', 'aria-live': 'polite' });
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: ICON_ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' }));
  const preview = h('div', { class: 'icon-upload-preview', hidden: true });
  const chooseBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => input.click() }, icon('upload', 14), ' Choisir une image');
  const useBtn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true }, 'Utiliser cette image'));
  const hasImage = !!iconImageId(image.current());
  const removeBtn = !hasImage ? null : h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('trash', 14), ' Retirer l’image');
  const setBusy = (on) => {
    busy = on;
    useBtn.disabled = on || !chosen;
    chooseBtn.toggleAttribute('disabled', on);
    if (removeBtn) removeBtn.toggleAttribute('disabled', on);
  };

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = ''; // le même fichier pourra être choisi de nouveau
    if (!file || busy) return;
    chosen = null;
    useBtn.disabled = true;
    preview.hidden = true;
    preview.replaceChildren();
    try {
      const checked = await checkIconFile(file);
      chosen = checked;
      preview.replaceChildren(
        h('img', { src: checked.dataUrl, alt: 'Aperçu de la nouvelle icône', width: '48', height: '48' }),
        h('span', { class: 'icon-upload-meta' }, h('span', { class: 'icon-upload-name' }, file.name), h('span', { class: 'hint' }, `${checked.width} × ${checked.height} pixels, ${kilo(file.size)}`)));
      preview.hidden = false;
      useBtn.disabled = false;
      say('Image prête : vérifiez l’aperçu puis validez.');
      useBtn.focus();
    } catch (err) {
      say(err instanceof Error ? err.message : 'Image illisible.', true);
    }
  });

  useBtn.addEventListener('click', async () => {
    if (!chosen || busy) return;
    setBusy(true);
    say('Envoi de l’image…');
    try {
      await image.upload(chosen.base64);
      closePopover();
      toast('Icône de la page mise à jour');
    } catch (err) {
      setBusy(false);
      say(uploadError(err), true);
    }
  });

  removeBtn?.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    say('Retrait de l’image…');
    try {
      await image.remove();
      closePopover();
      toast('Image retirée de l’icône');
    } catch (err) {
      setBusy(false);
      say(uploadError(err), true);
    }
  });

  const el = h('div', { class: 'icon-upload', role: 'group', 'aria-label': 'Importer une image' },
    h('p', { class: 'hint' }, 'PNG, JPEG, WebP ou GIF, 512 Ko au plus, entre 8 et 1024 pixels de côté. Une image carrée rend mieux.'),
    input,
    h('div', { class: 'icon-upload-row' }, chooseBtn, removeBtn),
    preview,
    status,
    h('div', { class: 'icon-upload-row end' },
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: back }, 'Retour aux emojis'),
      useBtn));
  return { el, focus: () => chooseBtn.focus() };
}

/**
 * @param {HTMLElement} anchor
 * @param {(value: string) => void} onPick
 * @param {{ allowRemove?: boolean, image?: { current: () => string, upload: (base64: string) => Promise<unknown>, remove: () => Promise<unknown> } }} [options]
 *   `image` : icône de page, propose l'import d'une image (absent pour un espace).
 */
export function iconPicker(anchor, onPick, { allowRemove = true, image } = {}) {
  const pick = (value) => { if (value) pushRecent(value); closePopover(); onPick(value); };
  const search = h('input', { class: 'input emoji-search', type: 'search', placeholder: 'Rechercher un emoji…', 'aria-label': 'Rechercher un emoji', autocomplete: 'off' });
  const body = h('div', { class: 'emoji-body', tabindex: '-1' });
  const tabs = h('div', { class: 'emoji-tabs', role: 'group', 'aria-label': 'Catégories' });
  let all = [];

  const button = (value, label, content) => h('button', { class: 'emoji-btn', type: 'button', tabindex: '-1', 'aria-label': label, title: label, onClick: () => pick(value) }, content);
  const emojiBtn = (e) => button(e.char, e.label, e.char);
  const section = (id, title, buttons) => h('section', { class: 'emoji-section', 'data-group': id },
    h('h3', { class: 'emoji-title' }, title), h('div', { class: 'emoji-grid', role: 'group', 'aria-label': title }, buttons));

  const paint = () => {
    const q = norm(search.value.trim());
    body.replaceChildren();
    if (q) {
      const words = q.split(/\s+/);
      const iconHits = PAGE_ICONS.filter((n) => words.every((w) => norm(`${n} ${ICON_LABELS[n] ?? ''}`).includes(w)));
      const hits = all.filter((e) => words.every((w) => e.search.includes(w))).slice(0, 160);
      if (iconHits.length) body.append(section('icons', 'Icônes', iconHits.map((n) => button(n, ICON_LABELS[n] || n, pageIcon(n, 20)))));
      if (hits.length) body.append(section('found', 'Emojis', hits.map(emojiBtn)));
      if (!iconHits.length && !hits.length) body.append(h('p', { class: 'muted emoji-empty' }, `Aucun résultat pour « ${search.value.trim()} »`));
    } else {
      const recents = readRecents();
      if (recents.length) {
        body.append(section('recent', 'Récents', recents.map((v) => (PAGE_ICONS.includes(v) ? button(v, ICON_LABELS[v] || v, pageIcon(v, 20)) : button(v, all.find((e) => e.char === v)?.label || v, v)))));
      }
      body.append(section('icons', 'Icônes', PAGE_ICONS.map((n) => button(n, ICON_LABELS[n] || n, pageIcon(n, 20)))));
      if (!all.length) body.append(h('p', { class: 'muted emoji-empty' }, 'Chargement des emojis…'));
      for (const g of GROUPS) {
        const list = all.filter((e) => e.group === g.id);
        if (list.length) body.append(section(g.id, g.label, list.map(emojiBtn)));
      }
    }
    // Un seul arrêt de tabulation dans la grille, les flèches font le reste.
    body.querySelector('.emoji-btn')?.setAttribute('tabindex', '0');
  };

  const tab = (id, label, content) => h('button', { class: 'emoji-tab', type: 'button', 'aria-label': label, title: label, onClick: () => {
    search.value = '';
    paint();
    body.querySelector(`[data-group="${id}"]`)?.scrollIntoView({ block: 'start' });
  } }, content);
  tabs.append(tab('icons', 'Icônes', icon('layers', 16)), ...GROUPS.map((g) => tab(g.id, g.label, g.tab)));

  const random = () => {
    const pool = all.length ? all.map((e) => e.char) : PAGE_ICONS;
    pick(pool[Math.floor(Math.random() * pool.length)]);
  };
  // Panneau image : remplace la recherche, les onglets et la grille ; « Retour aux emojis » les rétablit.
  let panel = null;
  const showImage = (on) => {
    for (const part of [search, tabs, body, foot]) part.hidden = on;
    panel?.el.remove();
    panel = null;
    if (on && image) {
      panel = imagePanel(image, () => showImage(false));
      root.append(panel.el);
      panel.focus();
    } else search.focus();
  };
  const foot = h('div', { class: 'emoji-foot' },
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: random }, icon('wand', 14), ' Au hasard'),
    image && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => showImage(true) }, icon('upload', 14), ' Importer une image'),
    allowRemove && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => pick('') }, 'Retirer'));

  const root = h('div', { class: 'emoji-picker' }, search, tabs, body, foot);
  const el = openPopover(anchor, root);
  paint();
  search.focus();
  search.addEventListener('input', paint);

  // Flèches dans la grille (par ligne de COLUMNS), depuis le champ de recherche (flèche bas) ou un bouton.
  el.addEventListener('keydown', (e) => {
    const buttons = [...body.querySelectorAll('.emoji-btn')];
    const i = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
    if (!move) return;
    if (i < 0) { if (e.key === 'ArrowDown' && document.activeElement === search) { e.preventDefault(); buttons[0]?.focus(); } return; }
    e.preventDefault();
    const next = buttons[i + move];
    if (next) { buttons.forEach((b) => b.setAttribute('tabindex', '-1')); next.setAttribute('tabindex', '0'); next.focus(); }
    else if (move < 0) search.focus();
  });

  loadEmojis().then((list) => { all = list; if (el.isConnected) paint(); }).catch(() => { body.append(h('p', { class: 'muted emoji-empty' }, 'Liste des emojis indisponible.')); });
}
