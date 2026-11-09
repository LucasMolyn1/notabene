// Accusé de lecture : bandeau de la page ouverte (« J'ai lu »), fenêtre de gestion (demande, retrait, liste des lecteurs).
// Le serveur décide des droits (canRequest, canAck, canSeeReaders) ; cet écran ne fait que les refléter. Aucun accusé
// n'est diffusé en temps réel : la liste des lecteurs est relue à l'ouverture de la fenêtre et après chaque action.
// Noms et dates viennent du serveur et ne sont affichés que comme texte.
import { api } from './api.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { confirmModal, openModal, toast } from './ui.js';
import { fullDate, h } from './util.js';

const PAGE_SIZE = 50;
export const TRANSPARENCY = 'Votre accusé est visible du demandeur, de l’auteur de la page et des administrateurs.';

/** JJ/MM/AAAA. @param {number} ts */
export const dayDate = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const plural = (n, one, many) => (n > 1 ? many : one);
const errorText = (err, fallback) => err?.message || fallback;

/** @param {ParentNode} root @param {string} selector */
const focusIn = (root, selector) => /** @type {HTMLElement | null} */ (root.querySelector(selector))?.focus();

// Une action faite ici (ou reçue par le flux temps réel, sans état) prévient le bandeau de la page ouverte.
const announce = (pageId, state) => window.dispatchEvent(new CustomEvent('notabene:read-receipt', { detail: { pageId, state } }));

/** Texte de mon accusé. @param {{ myAck: { ackedAt: number, modifiedSinceAck: boolean } | null }} s */
function myAckText(s) {
  if (!s.myAck) return 'Vous n’avez pas encore confirmé la lecture.';
  return s.myAck.modifiedSinceAck ? 'Lu avant la dernière modification' : `Lu le ${dayDate(s.myAck.ackedAt)}`;
}

// Un nouvel accusé renouvelle l'ancien : même requête pour « J'ai lu » et « Confirmer à nouveau ».
const acknowledge = (pageId) => api.post(`/pages/${pageId}/read-receipt/ack`);
const ackLabel = (s) => (s.myAck ? 'Confirmer à nouveau' : 'J’ai lu');
// Bouton proposé : pas encore accusé, ou accusé antérieur à la dernière modification.
const showAck = (s) => s.requested && s.canAck && (!s.myAck || s.myAck.modifiedSinceAck);

// ---- Bandeau de la page ouverte ----------------------------------------------------

/** @param {string} pageId @returns {{ el: HTMLElement, state: () => any, destroy: () => void }} */
export function readReceiptBar(pageId) {
  const content = h('div', { class: 'rr-content' });
  // Région d'annonce gardée d'un rendu à l'autre (sinon le lecteur d'écran ne lit pas le changement).
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const el = h('section', { class: 'rr-bar', 'aria-label': 'Accusé de lecture', hidden: true }, content, live);
  if (!session.user) return { el, state: () => null, destroy: () => undefined };
  let state = null;
  let busy = false;

  function paint() {
    if (!state?.requested) { el.hidden = true; content.replaceChildren(); return; }
    el.hidden = false;
    const s = state;
    const kind = !s.myAck ? 'asked' : s.myAck.modifiedSinceAck ? 'stale' : 'done';
    el.dataset.state = kind;
    const text = kind === 'asked' ? 'Accusé de lecture demandé' : kind === 'stale' ? 'Lu avant la dernière modification' : `Lu le ${dayDate(s.myAck.ackedAt)}`;
    content.replaceChildren(
      h('span', { class: 'rr-ico', 'aria-hidden': 'true' }, icon(kind === 'done' ? 'check' : kind === 'stale' ? 'alert' : 'eye', 15)),
      h('span', { class: 'rr-text', tabindex: '-1', title: s.myAck ? fullDate(s.myAck.ackedAt) : null }, text,
        kind === 'asked' && s.requestedBy ? h('span', { class: 'rr-by' }, ` par ${s.requestedBy.name}`) : null),
      showAck(s) && h('button', { class: 'btn btn-primary btn-sm rr-ack', type: 'button', disabled: busy, onClick: ack }, icon('check', 14), ackLabel(s)),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Détails de l’accusé de lecture', onClick: () => openReadReceipt(pageId) }, 'Détails'),
      // Transparence : écrite avant le clic sur « J'ai lu ».
      showAck(s) && h('small', { class: 'rr-hint' }, TRANSPARENCY));
  }

  async function ack() {
    if (busy) return;
    busy = true;
    const renew = !!state?.myAck;
    try {
      state = await acknowledge(pageId);
      busy = false;
      announce(pageId, state);
      live.textContent = renew ? 'Lecture confirmée à nouveau.' : 'Accusé de lecture enregistré.';
      // Le bouton disparaît : le focus passe au statut (sinon il tomberait hors de la page).
      focusIn(content, '.rr-text');
    } catch (err) {
      busy = false;
      toast(errorText(err, 'Impossible d’enregistrer l’accusé de lecture.'), { kind: 'error' });
      if (err?.status === 409) load();
      else paint();
    }
  }

  async function load() {
    try { state = await api.get(`/pages/${pageId}/read-receipt`); } catch { state = null; }
    paint();
  }

  function onChange(e) {
    if (e.detail?.pageId !== pageId) return;
    if (e.detail.state) { state = e.detail.state; paint(); } else load();
  }
  window.addEventListener('notabene:read-receipt', onChange);
  load();
  return { el, state: () => state, destroy: () => window.removeEventListener('notabene:read-receipt', onChange) };
}

// ---- Fenêtre « Accusé de lecture » -----------------------------------------------

let formSeq = 0;

/** @param {string} pageId */
export function openReadReceipt(pageId) {
  const ids = ++formSeq;
  const top = h('div', { class: 'stack rr-top' });
  const readersPanel = h('section', { class: 'rr-readers', 'aria-labelledby': `rr-readers-${ids}`, hidden: true });
  const body = h('div', { class: 'stack rr', 'aria-busy': 'true' }, h('p', { class: 'muted', role: 'status' }, 'Chargement…'));
  const m = openModal({ title: 'Accusé de lecture', size: 'medium', body, actions: [{ label: 'Fermer' }] });
  let state = null;
  let busy = false;
  // Liste des lecteurs (seulement si canSeeReaders).
  let readers = [];
  let cursor = null;
  let loadingReaders = false;
  let readersError = '';
  let readersSeq = 0;

  async function load() {
    body.setAttribute('aria-busy', 'true');
    try {
      state = await api.get(`/pages/${pageId}/read-receipt`);
      paint();
      reloadReaders();
    } catch (err) {
      body.removeAttribute('aria-busy');
      body.replaceChildren(h('div', { class: 'notice error', role: 'alert' }, errorText(err, 'Impossible de charger l’accusé de lecture.')),
        h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: load }, 'Réessayer')));
    }
  }

  // Rendu après une action : le focus revient sur le statut (le bouton cliqué a pu disparaître).
  function settle(next, message) {
    state = next;
    announce(pageId, state);
    paint();
    reloadReaders();
    toast(message);
    focusIn(body, '.rr-status');
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  }

  const request = () => run(async () => {
    try { settle(await api.put(`/pages/${pageId}/read-receipt`), 'Accusé de lecture demandé'); } catch (err) { toast(errorText(err, 'Impossible de demander l’accusé de lecture.'), { kind: 'error' }); }
  });

  const withdraw = () => run(async () => {
    const n = state.readersCount;
    const count = typeof n === 'number' ? ` (${n} ${plural(n, 'accusé enregistré', 'accusés enregistrés')})` : '';
    const ok = await confirmModal({
      title: 'Retirer la demande ?',
      message: `Retirer la demande efface les accusés déjà enregistrés${count}. Cette action est définitive.`,
      confirm: 'Retirer la demande', danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.del(`/pages/${pageId}/read-receipt`);
      const deleted = typeof res?.receiptsDeleted === 'number' ? ` ${res.receiptsDeleted} ${plural(res.receiptsDeleted, 'accusé effacé', 'accusés effacés')}.` : '';
      settle(await api.get(`/pages/${pageId}/read-receipt`), `Demande retirée.${deleted}`);
    } catch (err) {
      toast(err?.status === 403
        ? 'Seuls la personne qui a demandé l’accusé, l’auteur de la page et les administrateurs peuvent retirer cette demande.'
        : errorText(err, 'Impossible de retirer la demande.'), { kind: 'error' });
    }
  });

  const ack = () => run(async () => {
    const renew = !!state.myAck;
    try { settle(await acknowledge(pageId), renew ? 'Lecture confirmée à nouveau' : 'Accusé de lecture enregistré'); } catch (err) {
      toast(errorText(err, 'Impossible d’enregistrer l’accusé de lecture.'), { kind: 'error' });
      if (err?.status === 409) load();
    }
  });

  const unack = () => run(async () => {
    try {
      await api.del(`/pages/${pageId}/read-receipt/ack`);
      settle(await api.get(`/pages/${pageId}/read-receipt`), 'Votre accusé de lecture est retiré');
    } catch (err) { toast(errorText(err, 'Impossible de retirer votre accusé.'), { kind: 'error' }); }
  });

  function paint() {
    const s = state;
    body.removeAttribute('aria-busy');
    const by = s.requestedBy ? ` par ${s.requestedBy.name}` : '';
    const since = s.requestedAt ? ` le ${dayDate(s.requestedAt)}` : '';
    top.replaceChildren(...[
      h('p', { class: 'rr-status', tabindex: '-1' }, s.requested
        ? `Un accusé de lecture est demandé sur cette page${by}${since}. Chaque personne qui lit la page peut confirmer « J’ai lu ».`
        : 'Aucun accusé de lecture n’est demandé sur cette page.'),
      s.requested && h('section', { class: 'rr-section', 'aria-labelledby': `rr-mine-${ids}` },
        h('h3', { id: `rr-mine-${ids}` }, 'Votre accusé'),
        h('p', { class: 'rr-mine' }, s.myAck ? h('span', { title: fullDate(s.myAck.ackedAt) }, myAckText(s)) : myAckText(s)),
        h('p', { class: 'hint' }, TRANSPARENCY, s.canSeeReaders ? '' : ' Seules ces personnes voient la liste des lecteurs.'),
        (showAck(s) || s.myAck) && h('div', { class: 'row wrap' },
          showAck(s) && h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: ack }, icon('check', 14), ackLabel(s)),
          s.myAck && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: unack }, 'Retirer mon accusé'))),
      s.canRequest && h('section', { class: 'rr-section', 'aria-labelledby': `rr-req-${ids}` },
        h('h3', { id: `rr-req-${ids}` }, 'Demande'),
        s.requested
          ? s.canSeeReaders
            ? h('div', { class: 'row wrap' }, h('button', { class: 'btn btn-ghost btn-sm danger', type: 'button', onClick: withdraw }, 'Retirer la demande'))
            : h('p', { class: 'hint' }, 'Seuls la personne qui a demandé l’accusé, l’auteur de la page et les administrateurs peuvent retirer cette demande.')
          : [
            h('p', { class: 'hint' }, 'Les personnes qui lisent la page pourront confirmer « J’ai lu ». Rien n’est enregistré à la simple ouverture de la page.'),
            h('div', { class: 'row wrap' }, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: request }, 'Demander un accusé de lecture')),
          ]),
      !s.canRequest && !s.requested && h('p', { class: 'hint' }, 'Seules les personnes qui peuvent modifier la page peuvent demander un accusé de lecture.'),
    ].filter(Boolean));
    readersPanel.hidden = !(s.requested && s.canSeeReaders);
    body.replaceChildren(top, readersPanel);
  }

  function readerRow(it) {
    return h('li', { class: 'rr-reader' },
      h('strong', null, it.user.name),
      h('small', null, h('span', { title: fullDate(it.ackedAt) }, `Lu le ${dayDate(it.ackedAt)}`),
        it.modifiedSinceAck && h('span', { class: 'rr-stale' }, ' · lu avant la dernière modification')));
  }

  function paintReaders() {
    const s = state;
    if (readersPanel.hidden) { readersPanel.replaceChildren(); return; }
    const n = s.readersCount ?? 0;
    const nodes = [
      h('h3', { id: `rr-readers-${ids}` }, 'Lecteurs'),
      h('p', { class: 'hint' }, n ? `${n} ${plural(n, 'personne a confirmé', 'personnes ont confirmé')} la lecture.` : 'Personne n’a encore confirmé la lecture.'),
    ];
    readersPanel.setAttribute('aria-busy', String(loadingReaders));
    if (readers.length) nodes.push(h('ul', { class: 'rr-list', 'aria-label': 'Personnes qui ont confirmé la lecture' }, readers.map(readerRow)));
    if (loadingReaders && !readers.length) nodes.push(h('p', { class: 'muted', role: 'status' }, 'Chargement…'));
    if (readersError) {
      nodes.push(h('div', { class: 'notice error', role: 'alert' }, h('p', null, readersError),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => fetchReaders() }, 'Réessayer')));
    }
    if (!loadingReaders && !readersError && !readers.length && n) nodes.push(h('p', { class: 'muted' }, 'Aucun lecteur à afficher.'));
    if (cursor && readers.length) {
      nodes.push(h('div', { class: 'rr-more' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-disabled': loadingReaders ? 'true' : null, onClick: () => { if (!loadingReaders) fetchReaders(true); } },
        loadingReaders ? 'Chargement…' : 'Voir plus')));
    }
    readersPanel.replaceChildren(...nodes);
  }

  // `more` : « Voir plus » ; le focus reste sur le bouton s'il en reste, sinon passe à la première ligne ajoutée.
  async function fetchReaders(more = false) {
    if (readersPanel.hidden) return;
    const mine = ++readersSeq;
    const before = readers.length;
    loadingReaders = true;
    readersError = '';
    paintReaders();
    if (more) focusIn(readersPanel, '.rr-more button');
    const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) q.set('cursor', cursor);
    try {
      const res = await api.get(`/pages/${pageId}/read-receipt/readers?${q}`);
      if (mine !== readersSeq) return;
      readers = [...readers, ...res.items];
      cursor = res.nextCursor;
    } catch (err) {
      if (mine !== readersSeq) return;
      readersError = errorText(err, 'Impossible de charger la liste des lecteurs.');
    }
    loadingReaders = false;
    paintReaders();
    if (!more) return;
    const row = /** @type {HTMLElement | undefined} */ (readersPanel.querySelectorAll('.rr-reader')[before]);
    if (cursor || !row) { focusIn(readersPanel, '.rr-more button, .notice.error button'); return; }
    row.tabIndex = -1;
    row.focus();
  }

  function reloadReaders() {
    readers = [];
    cursor = null;
    readersError = '';
    loadingReaders = false;
    ++readersSeq;
    paintReaders();
    fetchReaders();
  }

  // Demande posée ou retirée par quelqu'un d'autre pendant que la fenêtre est ouverte.
  function onChange(e) {
    if (e.detail?.pageId !== pageId || e.detail.state || busy || !state) return;
    load();
  }
  window.addEventListener('notabene:read-receipt', onChange);
  m.el.addEventListener('close', () => window.removeEventListener('notabene:read-receipt', onChange));

  load();
  return m;
}
