// Blocs synchronisés. Une « source » (syncedSource) est un conteneur édité normalement dans sa page ; une « copie » (syncedCopy) placée
// ailleurs n'enregistre que l'identifiant du bloc et en affiche le contenu, demandé au serveur avec les droits de la personne qui lit.
// Règles tenues ici (le serveur les revérifie) :
// - jamais de source dans une source ou une copie, ni de copie dans une source ;
// - une source collée (ou dupliquée) reçoit un nouvel identifiant : deux sources ne partagent jamais le même ;
// - la copie est en lecture seule, ne révèle ni la page source ni son titre, et n'insère aucun HTML venu du serveur :
//   le contenu passe par le schéma ProseMirror (nœuds connus seulement) puis par un éditeur en lecture seule.
import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { api, ApiError } from '../api.js';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { session } from '../session.js';
import { openModal, toast } from '../ui.js';

/** Même format que le serveur (server/src/lib/content.ts, SYNCED_BLOCK_ID) : 16 octets en base64url canonique, sans remplissage. */
export const BLOCK_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const validId = (v) => (typeof v === 'string' && BLOCK_ID.test(v) ? v : null);

/** Identifiant aléatoire de 128 bits (crypto.getRandomValues), en base64url sans remplissage (22 caractères). */
export function newBlockId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SOURCE = 'syncedSource';
const COPY = 'syncedCopy';
const isSynced = (node) => node.type.name === SOURCE || node.type.name === COPY;

// Dernier bloc copié avec « Copier le lien du bloc » : proposé par « / Copie d'un bloc synchronisé ». Un identifiant seul, sans titre.
const LAST_KEY = 'notabene:synced-block';
const rememberId = (id) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* facultatif */ } };
const lastId = () => { try { return validId(localStorage.getItem(LAST_KEY)); } catch { return null; } };

const blockIdAttr = (tag) => ({
  blockId: {
    default: null,
    parseHTML: (el) => validId(el.getAttribute('data-block-id')),
    renderHTML: (attrs) => (validId(attrs.blockId) ? { [tag]: '', 'data-block-id': attrs.blockId } : { [tag]: '' }),
  },
});

// ---- Imbrication interdite ----------------------------------------------------

/** Vrai si le document contient un bloc synchronisé à l'intérieur d'une source (une copie n'a pas de contenu). */
const nestingCache = new WeakMap();
export function hasNesting(doc) {
  if (nestingCache.has(doc)) return nestingCache.get(doc);
  let found = false;
  doc.descendants((node) => {
    if (found || node.isTextblock) return false;
    if (node.type.name === SOURCE) {
      node.descendants((inner) => { if (isSynced(inner)) found = true; return !found && !inner.isTextblock; });
      return false;
    }
    return true;
  });
  nestingCache.set(doc, found);
  return found;
}

/** Vrai si la position est dans une source : on n'y insère pas de bloc synchronisé. */
export function insideSource(state, pos = state.selection.from) {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d -= 1) if ($pos.node(d).type.name === SOURCE) return true;
  return false;
}

// Plafond du serveur (MAX_SYNCED_BLOCKS) : au-delà, la page ne serait plus enregistrée.
export const MAX_SYNCED = 20;
const countCache = new WeakMap();
function syncedCount(doc) {
  if (countCache.has(doc)) return countCache.get(doc);
  let n = 0;
  doc.descendants((node) => { if (isSynced(node)) n += 1; return !node.isTextblock; });
  countCache.set(doc, n);
  return n;
}

let warnedAt = 0;
const warn = (text) => {
  if (Date.now() - warnedAt < 2000) return;
  warnedAt = Date.now();
  setTimeout(() => toast(text, { kind: 'error' }), 0);
};
const warnNesting = () => warn('Un bloc synchronisé ne peut pas contenir un autre bloc synchronisé.');
const warnLimit = () => warn(`Une page compte au plus ${MAX_SYNCED} blocs synchronisés.`);

// ---- Identifiants uniques des sources ------------------------------------------

// Mémorisé par document : le document d'avant une frappe est celui d'après la précédente, un seul parcours par transaction.
const idsCache = new WeakMap();
function sourceIds(doc) {
  if (idsCache.has(doc)) return idsCache.get(doc);
  const ids = new Map();
  doc.descendants((node) => {
    if (node.isTextblock) return false;
    if (node.type.name === SOURCE && node.attrs.blockId) ids.set(node.attrs.blockId, (ids.get(node.attrs.blockId) || 0) + 1);
    return true;
  });
  idsCache.set(doc, ids);
  return ids;
}

function renewSources(fragment, keep) {
  const out = [];
  fragment.forEach((node) => {
    let next = node;
    if (node.type.name === SOURCE) {
      const id = keep(node.attrs.blockId) ? node.attrs.blockId : newBlockId();
      next = node.type.create({ ...node.attrs, blockId: id }, node.content, node.marks);
    } else if (node.content.size && !node.isTextblock) {
      next = node.copy(renewSources(node.content, keep));
    }
    out.push(next);
  });
  return Fragment.from(out);
}

export const SyncedGuard = Extension.create({
  name: 'syncedGuard',
  addProseMirrorPlugins() {
    // Sources retirées par « couper » dans cet éditeur : les recoller dans la même page garde leur identifiant (déplacement).
    const cut = new Set();
    return [new Plugin({
      key: new PluginKey('syncedGuard'),
      props: {
        // Collage ou dépôt : toute source reçoit un nouvel identifiant, sauf un déplacement dans la même page (glisser, ou couper puis coller).
        transformPasted: (slice, view) => {
          let has = false;
          slice.content.descendants((n) => { if (n.type.name === SOURCE) has = true; return !has && !n.isTextblock; });
          if (!has || view.dragging?.move) return slice;
          const present = sourceIds(view.state.doc);
          const keep = (id) => !!id && cut.has(id) && !present.has(id) && cut.delete(id);
          return new Slice(renewSources(slice.content, keep), slice.openStart, slice.openEnd);
        },
      },
      // Les changements reçus par co-édition ne sont jamais filtrés (sinon le document divergerait) : le serveur tranche.
      filterTransaction: (tr, state) => {
        if (!tr.docChanged || isChangeOrigin(tr)) return true;
        const count = syncedCount(tr.doc);
        if (count > MAX_SYNCED && count > syncedCount(state.doc)) { warnLimit(); return false; }
        if (!hasNesting(tr.doc) || hasNesting(state.doc)) return true;
        warnNesting();
        return false;
      },
      appendTransaction: (trs, oldState, newState) => {
        const local = trs.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
        if (!local.length) return null;
        const old = sourceIds(oldState.doc);
        const ids = sourceIds(newState.doc);
        if (local.some((tr) => tr.getMeta('uiEvent') === 'cut')) for (const id of old.keys()) if (!ids.has(id)) cut.add(id);
        // Dernier filet : une source dupliquée dans la page (par n'importe quel chemin) reçoit un nouvel identifiant.
        if (![...ids.values()].some((n) => n > 1)) return null;
        const seen = new Set();
        let tr = null;
        newState.doc.descendants((node, pos) => {
          if (node.isTextblock) return false;
          if (node.type.name !== SOURCE || !node.attrs.blockId) return true;
          const id = node.attrs.blockId;
          if (seen.has(id) && (old.get(id) || 0) < 2) tr = (tr || newState.tr).setNodeAttribute(pos, 'blockId', newBlockId());
          seen.add(id);
          return true;
        });
        return tr;
      },
    })];
  },
});

// ---- Source ------------------------------------------------------------------------

async function copyBlockLink(blockId) {
  rememberId(blockId);
  // Presse-papiers : une copie prête à coller (HTML reconnu par l'éditeur) et l'identifiant en texte brut. Rien d'autre.
  const html = `<div data-synced-copy="" data-block-id="${blockId}"></div>`;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([blockId], { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(blockId);
    }
    toast('Lien du bloc copié : collez-le dans une autre page, ou utilisez « / Copie d’un bloc synchronisé ».');
  } catch {
    toast('Bloc retenu : dans une autre page, utilisez « / Copie d’un bloc synchronisé ».');
  }
}

export const SyncedSource = Node.create({
  name: SOURCE,
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  draggable: false,

  addAttributes() { return blockIdAttr('data-synced-source'); },
  parseHTML() { return [{ tag: 'div[data-synced-source]', getAttrs: (el) => (validId(el.getAttribute('data-block-id')) ? null : false) }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { class: 'synced-source' }), 0]; },

  addCommands() {
    return {
      insertSyncedSource: () => ({ chain, state }) => {
        if (insideSource(state)) { warnNesting(); return false; }
        const from = state.selection.from;
        return chain().insertContent({ type: SOURCE, attrs: { blockId: newBlockId() }, content: [{ type: 'paragraph' }] })
          .command(({ tr }) => {
            let at = null;
            tr.doc.descendants((node, pos) => { if (at === null && node.type.name === SOURCE && pos >= from - 1) at = pos; return at === null; });
            if (at !== null) tr.setSelection(TextSelection.create(tr.doc, at + 2));
            return true;
          }).run();
      },
    };
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const label = h('span', { class: 'synced-label' }, icon('layers', 14), ' Bloc synchronisé');
      const copyBtn = h('button', {
        class: 'synced-action', type: 'button', 'aria-label': 'Copier le lien du bloc synchronisé, pour l’afficher dans une autre page',
        onClick: () => { const id = validId(current.attrs.blockId); if (id) copyBlockLink(id); },
      }, icon('copy', 14), ' Copier le lien');
      copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
      const head = h('div', { class: 'synced-head', contenteditable: 'false' }, label, session.user && session.can('write') ? copyBtn : null);
      const body = h('div', { class: 'synced-body' });
      const dom = h('div', { class: 'synced-source', 'data-synced-source': '', role: 'group', 'aria-label': 'Bloc synchronisé' }, head, body);
      return {
        dom,
        contentDOM: body,
        // Un clic sur l'en-tête (hors bouton) sélectionne tout le bloc, qu'on peut alors supprimer ou déplacer.
        stopEvent: (e) => copyBtn.contains(/** @type {any} */ (e.target)),
        ignoreMutation: (m) => head.contains(m.target) || (m.type === 'attributes' && m.target === dom),
        update: (updated) => { if (updated.type.name !== SOURCE) return false; current = updated; return true; },
      };
    };
  },
});

// ---- Copie ---------------------------------------------------------------------------

// Un seul chargement par bloc, partagé par les copies affichées (réutilisé quelques secondes).
const FRESH_MS = 3000;
// Rafraîchissement automatique (retour sur l'onglet, page modifiée ailleurs) : au plus un toutes les 30 s par copie.
const MIN_INTERVAL_MS = 30_000;
const loads = new Map();
function fetchBlock(id) {
  const hit = loads.get(id);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = api.get(`/synced-blocks/${id}`);
  const entry = { at: Date.now(), promise };
  loads.set(id, entry);
  promise.catch(() => { if (loads.get(id) === entry) loads.delete(id); });
  return promise;
}

// Un statut 4xx (hors limite de débit) : bloc inexistant, supprimé ou illisible, indiscernables à dessein.
const unavailable = (err) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

// Contenu affichable : uniquement des blocs ; une source imbriquée est dépliée, une copie imbriquée retirée (le serveur les refuse déjà).
function displayable(content) {
  if (!Array.isArray(content)) return null;
  const walk = (nodes) => nodes.flatMap((n) => {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return [];
    if (n.type === COPY) return [];
    if (n.type === SOURCE) return walk(Array.isArray(n.content) ? n.content : []);
    return [Array.isArray(n.content) ? { ...n, content: walk(n.content) } : n];
  });
  const out = walk(content);
  return out.length ? out : null;
}

export const SyncedCopy = Node.create({
  name: COPY,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    // `createViewer(element, doc)` : éditeur en lecture seule fourni par editor.js (évite une dépendance circulaire).
    // `shareToken` : lien public ; le serveur y remplace déjà les copies par leur contenu lisible, rien n'est demandé ici.
    return { createViewer: null, shareToken: null };
  },

  addAttributes() { return blockIdAttr('data-synced-copy'); },
  parseHTML() { return [{ tag: 'div[data-synced-copy]', getAttrs: (el) => (validId(el.getAttribute('data-block-id')) ? null : false) }]; },
  // Copie, export et historique : un repère sans contenu (le contenu d'un bloc ne quitte pas l'application avec le presse-papiers).
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { class: 'synced-copy' }), 'Copie d’un bloc synchronisé']; },
  renderText() { return ''; },

  addCommands() {
    return {
      insertSyncedCopy: (blockId) => ({ commands, state }) => {
        if (!validId(blockId)) return false;
        if (insideSource(state)) { warnNesting(); return false; }
        return commands.insertContent({ type: COPY, attrs: { blockId } });
      },
    };
  },

  addNodeView() {
    const { createViewer, shareToken } = this.options;
    return ({ node }) => {
      const blockId = validId(node.attrs.blockId);
      const status = h('span', { class: 'synced-label' }, icon('layers', 14), ' Copie synchronisée, lecture seule');
      const body = h('div', { class: 'synced-body' });
      const dom = h('div', { class: 'synced-copy', 'data-synced-copy': '', contenteditable: 'false', role: 'group', 'aria-label': 'Copie d’un bloc synchronisé, lecture seule' },
        h('div', { class: 'synced-head' }, status), body);
      let alive = true;
      let viewer = null;
      let shown = null; // contenu affiché (JSON), pour ne pas reconstruire à l'identique
      let last = 0;
      let timer = null;

      const dropViewer = () => { viewer?.destroy(); viewer = null; shown = null; };
      const message = (text, retry = false) => {
        dropViewer();
        dom.removeAttribute('aria-busy');
        body.replaceChildren(h('div', { class: 'synced-note' }, h('p', { class: 'muted' }, text),
          retry && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => load() }, 'Réessayer')));
      };
      const neutral = () => message('Contenu indisponible');

      async function load() {
        if (!alive) return;
        clearTimeout(timer);
        timer = null;
        last = Date.now();
        if (!blockId || shareToken || !session.user) { neutral(); return; }
        if (!viewer) { dom.setAttribute('aria-busy', 'true'); body.replaceChildren(h('p', { class: 'muted synced-note' }, 'Chargement du bloc synchronisé…')); }
        try {
          const data = await fetchBlock(blockId);
          if (!alive) return;
          const content = displayable(data?.content);
          if (!content) { neutral(); return; }
          const json = JSON.stringify(content);
          if (json === shown && viewer) { dom.removeAttribute('aria-busy'); return; }
          const host = h('div', { class: 'synced-content' });
          const next = createViewer?.(host, { type: 'doc', content });
          if (!next) { neutral(); return; }
          dropViewer();
          viewer = next;
          shown = json;
          dom.removeAttribute('aria-busy');
          body.replaceChildren(host);
        } catch (err) {
          if (!alive) return;
          if (unavailable(err)) neutral();
          else if (viewer) dom.removeAttribute('aria-busy'); // panne passagère : on garde le contenu déjà affiché
          else message('Impossible de charger le bloc synchronisé.', true);
        }
      }

      // Rafraîchissement différé, borné à un toutes les 30 s ; jamais pendant que l'onglet est caché.
      const soon = () => {
        if (!alive || timer) return;
        timer = setTimeout(() => {
          timer = null;
          if (document.visibilityState === 'hidden') return;
          load();
        }, Math.max(0, last + MIN_INTERVAL_MS - Date.now()));
      };
      const onVisible = () => { if (document.visibilityState === 'visible') soon(); };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', soon);
      window.addEventListener('notabene:page-updated', soon);

      // Liens du contenu : les liens internes suivent la navigation de l'éditeur, les autres s'ouvrent dans un nouvel onglet.
      body.addEventListener('click', (e) => {
        const a = /** @type {Element} */ (e.target).closest?.('a[href]');
        if (!a || /^\/(?:p|s)\//.test(a.getAttribute('href') || '')) return;
        e.preventDefault();
        e.stopPropagation();
        window.open(a.getAttribute('href'), '_blank', 'noopener');
      });

      load();
      return {
        dom,
        // Les événements du contenu (sélection de texte, clics) restent dans la copie ; l'en-tête sert à sélectionner le bloc.
        stopEvent: (e) => body.contains(/** @type {any} */ (e.target)),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy() {
          alive = false;
          clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('focus', soon);
          window.removeEventListener('notabene:page-updated', soon);
          dropViewer();
        },
      };
    };
  },
});

// ---- Choix d'une copie depuis le menu « / » ----

/** Demande l'identifiant du bloc à afficher (prérempli avec le dernier bloc copié), vérifie qu'il est lisible, puis `onPick(id)`. */
export function askSyncedCopy(onPick) {
  const input = h('input', {
    class: 'input', type: 'text', id: 'synced-copy-id', autocomplete: 'off', spellcheck: 'false', maxlength: '64', value: lastId() || '',
    'aria-describedby': 'synced-copy-help',
  });
  const error = h('p', { class: 'notice warning', role: 'alert', hidden: true });
  const fail = (text) => { error.hidden = false; error.textContent = text; input.setAttribute('aria-invalid', 'true'); input.focus(); return false; };
  const submit = async () => {
    const id = input.value.trim();
    if (!validId(id)) return fail('Lien de bloc invalide.');
    try {
      await fetchBlock(id);
    } catch (err) {
      return fail(unavailable(err) ? 'Contenu indisponible : ce bloc n’existe pas ou vous n’y avez pas accès.' : 'Impossible de vérifier ce bloc. Réessayez.');
    }
    onPick(id);
    return undefined;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.closest('dialog')?.querySelector('.btn-primary')?.click(); } });
  openModal({
    title: 'Copie d’un bloc synchronisé',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field', for: 'synced-copy-id' }, h('span', null, 'Lien du bloc'), input),
      h('p', { class: 'muted', id: 'synced-copy-help' }, 'Dans la page source, utilisez « Copier le lien » sur le bloc synchronisé, puis collez-le ici. Vous pouvez aussi coller directement dans la page.'),
      error),
    actions: [{ label: 'Annuler' }, { label: 'Insérer', primary: true, onClick: submit }],
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
}
