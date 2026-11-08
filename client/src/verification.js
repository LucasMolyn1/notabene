// Vérification de page : pastille de statut, boîte de dialogue (vérificateurs, échéance, marquer vérifiée) et liste des pages à revoir.
// Le serveur calcule le statut et décide des droits (canVerify, canConfigure) ; cet écran ne fait que les refléter.
// Titres de page et noms viennent du serveur et ne sont affichés que comme texte.
import { api } from './api.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { store } from './store.js';
import { confirmModal, openModal, pageIcon, toast } from './ui.js';
import { pagePath } from './urls.js';
import { debounce, fullDate, h } from './util.js';

export const MAX_VERIFIERS = 10;
const INTERVALS = [[30, '30 jours'], [90, '90 jours (3 mois)'], [180, '180 jours (6 mois)'], [365, '365 jours (1 an)']];
const STATUS_CLASS = { verified: 'ok', expiring: 'warn', expired: 'bad', pending: 'info' };

// JJ/MM, avec l'année quand elle diffère de l'année en cours.
export function shortDate(ts) {
  const d = new Date(ts);
  const opts = /** @type {Intl.DateTimeFormatOptions} */ ({ day: '2-digit', month: '2-digit' });
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('fr-FR', opts);
}

/** Libellé du statut, en texte (la couleur n'est qu'un appui). @param {{ status: string, expiresAt?: number | null }} s */
export function statusLabel(s) {
  switch (s.status) {
    case 'verified': return s.expiresAt ? `Vérifiée jusqu’au ${shortDate(s.expiresAt)}` : 'Vérifiée';
    case 'expiring': return s.expiresAt ? `Arrive à échéance le ${shortDate(s.expiresAt)}` : 'Arrive à échéance';
    case 'expired': return 'Vérification expirée';
    case 'pending': return 'En attente de vérification';
    default: return 'Aucune vérification';
  }
}

const statusIcon = (status) => ({ verified: 'verified', expiring: 'clock', expired: 'alert', pending: 'clock' }[status] || 'verified');

// Une action faite ici (ou reçue par le flux temps réel) prévient la pastille de la page ouverte.
const announce = (pageId, state) => window.dispatchEvent(new CustomEvent('notabene:verification', { detail: { pageId, state } }));

const errorText = (err, fallback) => err?.message || fallback;

/** @param {ParentNode} root @param {string} selector */
const focusIn = (root, selector) => /** @type {HTMLElement | null} */ (root.querySelector(selector))?.focus();

// ---- Pastille de la page ouverte ------------------------------------------------

/** @param {string} pageId @returns {{ el: HTMLElement, destroy: () => void }} */
export function verificationBadge(pageId) {
  const el = h('div', { class: 'verif-bar', hidden: true });
  if (!session.user) return { el, destroy: () => undefined };
  let state = null;

  function paint() {
    if (!state || state.status === 'none') { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    el.replaceChildren(h('button', {
      class: `verif-badge ${state.status}`, type: 'button', 'aria-haspopup': 'dialog', title: 'Ouvrir la vérification de la page',
      onClick: () => openVerification(pageId),
    }, icon(statusIcon(state.status), 14), h('span', null, statusLabel(state)),
    state.modifiedSinceVerification && h('span', { class: 'verif-mod' }, '· modifiée depuis la vérification')));
  }

  async function load() {
    try { state = await api.get(`/pages/${pageId}/verification`); } catch { state = null; }
    paint();
  }

  function onChange(e) {
    if (e.detail?.pageId !== pageId) return;
    if (e.detail.state) { state = e.detail.state; paint(); } else load();
  }
  window.addEventListener('notabene:verification', onChange);
  load();
  return { el, destroy: () => window.removeEventListener('notabene:verification', onChange) };
}

// ---- Boîte de dialogue « Vérification » ------------------------------------------

let formSeq = 0;

/** @param {string} pageId */
export function openVerification(pageId) {
  const body = h('div', { class: 'stack verif', 'aria-busy': 'true' }, h('p', { class: 'muted', role: 'status' }, 'Chargement…'));
  const m = openModal({ title: 'Vérification de la page', size: 'medium', body, actions: [{ label: 'Fermer' }] });
  const ids = ++formSeq;
  let state = null;
  // Brouillon de configuration (vérificateurs choisis, intervalle), gardé entre deux affichages.
  let chosen = [];
  let interval = 'none';
  let customDays = '';
  let refused = new Set();
  let error = '';
  let busy = false;

  const resetDraft = () => {
    chosen = state.verifiers.map((u) => ({ id: u.id, name: u.name }));
    const d = state.intervalDays;
    interval = d == null ? 'none' : INTERVALS.some(([n]) => n === d) ? String(d) : 'custom';
    customDays = d != null && interval === 'custom' ? String(d) : '';
    refused = new Set();
    error = '';
  };

  async function load() {
    try {
      state = await api.get(`/pages/${pageId}/verification`);
      resetDraft();
      paint();
    } catch (err) {
      body.removeAttribute('aria-busy');
      body.replaceChildren(h('div', { class: 'notice error', role: 'alert' }, errorText(err, 'Impossible de charger la vérification.')),
        h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: load }, 'Réessayer')));
    }
  }

  // Rendu après une action : le focus revient sur le statut (sinon il tomberait hors de la fenêtre).
  function settle(next, message) {
    state = next;
    resetDraft();
    announce(pageId, state);
    paint();
    toast(message);
    focusIn(body, '.verif-status');
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  }

  const verify = () => run(async () => {
    try { settle(await api.post(`/pages/${pageId}/verification/verify`), 'Page marquée comme vérifiée'); } catch (err) { toast(errorText(err, 'Impossible de marquer la page vérifiée.'), { kind: 'error' }); }
  });

  const save = () => run(async () => {
    error = '';
    refused = new Set();
    let intervalDays = null;
    if (interval === 'custom') {
      intervalDays = Number(customDays);
      if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650) { error = 'L’intervalle doit être un nombre entier de jours, de 1 à 3650.'; paint(); focusIn(body, 'input[type=number]'); return; }
    } else if (interval !== 'none') intervalDays = Number(interval);
    if (!chosen.length) { error = 'Choisissez au moins un vérificateur.'; paint(); focusIn(body, 'input[type=search]'); return; }
    try {
      settle(await api.put(`/pages/${pageId}/verification`, { verifierIds: chosen.map((u) => u.id), intervalDays }), 'Vérification enregistrée');
    } catch (err) {
      const list = Array.isArray(err?.data?.refused) ? err.data.refused : [];
      if (err?.status === 422 && list.length) {
        refused = new Set(list);
        const names = chosen.filter((u) => refused.has(u.id)).map((u) => u.name);
        error = `${names.length > 1 ? 'Ces personnes ne peuvent' : 'Cette personne ne peut'} pas être vérificateur : ${names.join(', ') || 'compte inconnu'}. Un vérificateur doit être un compte actif qui lit la page. Retirez-${names.length > 1 ? 'les' : 'la'}, puis enregistrez.`;
      } else error = errorText(err, 'Impossible d’enregistrer la vérification.');
      paint();
      body.querySelector('.notice.error')?.scrollIntoView({ block: 'nearest' });
    }
  });

  const remove = () => run(async () => {
    if (!(await confirmModal({ title: 'Retirer la vérification ?', message: 'Les vérificateurs, l’échéance et la dernière vérification de cette page seront effacés.', confirm: 'Retirer', danger: true }))) return;
    try {
      await api.del(`/pages/${pageId}/verification`);
      settle(await api.get(`/pages/${pageId}/verification`), 'Vérification retirée');
    } catch (err) { toast(errorText(err, 'Impossible de retirer la vérification.'), { kind: 'error' }); }
  });

  function summary() {
    const s = state;
    const row = (label, value) => [h('dt', null, label), h('dd', null, value)];
    return h('dl', { class: 'verif-dl' },
      row('Statut', h('span', { class: `pill ${STATUS_CLASS[s.status] || ''}` }, statusLabel(s))),
      row('Vérificateurs', s.verifiers.length ? s.verifiers.map((u) => u.name).join(', ') : 'Aucun'),
      row('Dernière vérification', s.verifiedAt
        ? h('span', { title: fullDate(s.verifiedAt) }, `Le ${shortDate(s.verifiedAt)}${s.verifiedBy ? ` par ${s.verifiedBy.name}` : ''}`)
        : 'Jamais'),
      row('Échéance', s.expiresAt ? h('span', { title: fullDate(s.expiresAt) }, `Le ${shortDate(s.expiresAt)}`) : s.intervalDays ? 'Après la première vérification' : 'Aucune'));
  }

  function verifierPicker() {
    const searchId = `verif-search-${ids}`;
    const full = chosen.length >= MAX_VERIFIERS;
    const results = h('ul', { class: 'verif-results', 'aria-label': 'Personnes trouvées' });
    const input = h('input', {
      class: 'input', type: 'search', id: searchId, maxlength: '40', autocomplete: 'off', spellcheck: 'false',
      placeholder: full ? `${MAX_VERIFIERS} vérificateurs au plus` : 'Rechercher une personne', disabled: full,
    });
    let seq = 0;
    const search = debounce(async () => {
      const mine = ++seq;
      let items;
      try { items = (await api.get(`/pages/${pageId}/mentionable?q=${encodeURIComponent(input.value.trim())}`)).items; } catch { items = []; }
      if (mine !== seq || !input.isConnected) return;
      const free = items.filter((u) => !chosen.some((c) => c.id === u.id));
      results.replaceChildren(...(free.length
        ? free.map((u) => h('li', null, h('button', {
          type: 'button', 'aria-label': `Ajouter ${u.name}`,
          onClick: () => { if (chosen.length >= MAX_VERIFIERS) return; chosen.push({ id: u.id, name: u.name }); error = ''; paint(); focusIn(body, `#${searchId}`); },
        }, icon('plus', 14), h('span', null, u.name))))
        : input.value.trim() ? [h('li', { class: 'hint' }, 'Personne ne correspond (seuls les comptes actifs qui lisent la page sont proposés).')] : []));
    }, 200);
    input.addEventListener('input', search);
    if (!full) search();
    return h('div', { class: 'field' },
      h('label', { for: searchId }, 'Vérificateurs'),
      chosen.length > 0 && h('ul', { class: 'verif-chips', 'aria-label': 'Vérificateurs choisis' }, chosen.map((u) => h('li', { class: `verif-chip${refused.has(u.id) ? ' refused' : ''}` },
        h('span', null, u.name, refused.has(u.id) ? ' (refusé)' : ''),
        h('button', {
          class: 'label-x', type: 'button', 'aria-label': `Retirer ${u.name}`,
          onClick: () => { chosen = chosen.filter((c) => c.id !== u.id); refused.delete(u.id); paint(); focusIn(body, `#${searchId}`); },
        }, icon('x', 12))))),
      input,
      h('small', { class: 'hint' }, full ? `Nombre maximal atteint (${MAX_VERIFIERS}).` : `${chosen.length} sur ${MAX_VERIFIERS}. Un lecteur peut être vérificateur.`),
      results);
  }

  function intervalField() {
    const selectId = `verif-interval-${ids}`;
    const daysId = `verif-days-${ids}`;
    const select = h('select', { class: 'input', id: selectId },
      h('option', { value: 'none', selected: interval === 'none' }, 'Sans échéance'),
      INTERVALS.map(([n, label]) => h('option', { value: String(n), selected: interval === String(n) }, label)),
      h('option', { value: 'custom', selected: interval === 'custom' }, 'Autre durée'));
    select.addEventListener('change', () => { interval = select.value; paint(); focusIn(body, `#${interval === 'custom' ? daysId : selectId}`); });
    const days = interval === 'custom' && h('input', { class: 'input', type: 'number', id: daysId, min: '1', max: '3650', step: '1', inputmode: 'numeric', value: customDays });
    if (days) days.addEventListener('input', () => { customDays = days.value; });
    return h('div', { class: 'field' },
      h('label', { for: selectId }, 'Échéance après chaque vérification'),
      select,
      days && h('label', { for: daysId, class: 'hint' }, 'Nombre de jours (1 à 3650)'),
      days);
  }

  function paint() {
    const s = state;
    body.removeAttribute('aria-busy');
    const configure = s.canConfigure;
    body.replaceChildren(...[
      h('p', { class: 'verif-status', tabindex: '-1' }, s.configured
        ? 'Les vérificateurs confirment que cette page est à jour. Une échéance invite à la revoir régulièrement.'
        : 'Aucune vérification n’est configurée sur cette page.'),
      s.configured && summary(),
      s.modifiedSinceVerification && h('div', { class: 'notice warning' }, 'La page a été modifiée depuis la dernière vérification.'),
      s.canVerify && h('div', null, h('button', { class: 'btn btn-primary', type: 'button', onClick: verify }, icon('verified', 15), 'Marquer comme vérifiée')),
      !configure && !s.configured && h('p', { class: 'hint' }, 'Seules les personnes qui peuvent modifier la page peuvent désigner des vérificateurs.'),
      configure && h('section', { class: 'verif-section', 'aria-labelledby': `verif-conf-${ids}` },
        h('h3', { id: `verif-conf-${ids}` }, s.configured ? 'Modifier la vérification' : 'Configurer la vérification'),
        verifierPicker(),
        intervalField(),
        error && h('div', { class: 'notice error', role: 'alert' }, error),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: save }, 'Enregistrer'),
          s.configured && h('button', { class: 'btn btn-ghost btn-sm danger', type: 'button', onClick: remove }, 'Retirer la vérification'))),
    ].filter(Boolean));
  }

  load();
  return m;
}

// ---- Liste « Pages à revoir » ----------------------------------------------------

const FILTERS = [['', 'Tous'], ['pending', 'En attente'], ['expiring', 'Arrive à échéance'], ['expired', 'Expirée']];
const PAGE_SIZE = 30;

export function openReviewList() {
  const isAdmin = session.can('admin');
  const ids = ++formSeq;
  let scope = 'mine';
  let status = '';
  let items = [];
  let cursor = null;
  let loading = false;
  let error = '';
  let seq = 0;

  const panel = h('div', { class: 'verif-panel' });
  const tabs = !isAdmin ? null : h('div', { class: 'verif-tabs', role: 'tablist', 'aria-label': 'Pages concernées' },
    [['mine', 'À revoir'], ['all', 'Toutes']].map(([key, label]) => h('button', {
      class: 'verif-tab', type: 'button', role: 'tab', id: `verif-tab-${key}-${ids}`, 'aria-controls': `verif-panel-${ids}`, 'data-scope': key,
      onClick: () => select(key),
    }, label)));
  if (tabs) {
    panel.id = `verif-panel-${ids}`;
    panel.setAttribute('role', 'tabpanel');
    // Clavier : flèches gauche et droite, Début, Fin (motif des onglets de l'ARIA APG).
    tabs.addEventListener('keydown', (e) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 'mine' : e.key === 'End' ? 'all' : scope === 'mine' ? 'all' : 'mine';
      select(next);
      focusIn(tabs, `[data-scope="${next}"]`);
    });
  }
  const filters = h('div', { class: 'verif-filters', role: 'group', 'aria-label': 'Filtrer par statut' },
    FILTERS.map(([key, label]) => h('button', { class: 'chip', type: 'button', 'data-status': key, onClick: () => { if (status !== key) { status = key; reload(); } } }, label)));

  const m = openModal({ title: 'Pages à revoir', size: 'medium', body: h('div', { class: 'verif-review' }, tabs, filters, panel), actions: [{ label: 'Fermer' }] });

  function select(key) {
    if (scope === key) return;
    scope = key;
    reload();
  }

  function chrome() {
    tabs?.querySelectorAll('[role=tab]').forEach((t) => {
      const on = t.getAttribute('data-scope') === scope;
      t.setAttribute('aria-selected', String(on));
      t.setAttribute('tabindex', on ? '0' : '-1');
      if (on) panel.setAttribute('aria-labelledby', t.id);
    });
    filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-status') === status)));
  }

  function rowFor(it) {
    const space = store.space(it.page.spaceId);
    const detail = it.status === 'pending' ? 'Jamais vérifiée' : it.expiresAt ? `Échéance le ${shortDate(it.expiresAt)}` : '';
    return h('li', null, h('a', {
      class: 'table-row verif-row', href: pagePath(it.page), onClick: () => m.close(),
    },
    h('span', { class: 'verif-row-icon' }, pageIcon(it.page.icon)),
    h('span', { class: 'grow' },
      h('strong', null, it.page.title || 'Sans titre'),
      h('small', null, [space?.name, detail, it.modifiedSinceVerification && 'modifiée depuis la vérification'].filter(Boolean).join(' · '))),
    h('span', { class: `pill ${STATUS_CLASS[it.status] || ''}` }, statusLabel({ status: it.status, expiresAt: it.expiresAt }))));
  }

  function paint() {
    chrome();
    panel.setAttribute('aria-busy', String(loading));
    const nodes = [];
    if (items.length) nodes.push(h('ul', { class: 'table verif-list', 'aria-label': 'Pages' }, items.map(rowFor)));
    if (loading && !items.length) nodes.push(h('p', { class: 'muted', role: 'status' }, 'Chargement…'));
    if (error) {
      nodes.push(h('div', { class: 'notice error', role: 'alert' }, h('p', null, error),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => fetchMore() }, 'Réessayer')));
    }
    if (!loading && !error && !items.length) {
      nodes.push(h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, icon('verified', 32)),
        h('p', null, scope === 'all'
          ? status ? 'Aucune page de ce statut sur l’instance.' : 'Aucune page à revoir sur l’instance.'
          : status ? 'Aucune de vos pages n’a ce statut.' : 'Rien à revoir : les pages dont vous êtes vérificateur sont à jour.')));
    }
    if (cursor && items.length) {
      nodes.push(h('div', { class: 'verif-more' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: loading, onClick: () => fetchMore(true) }, loading ? 'Chargement…' : 'Voir plus')));
    }
    panel.replaceChildren(...nodes);
  }

  // `more` : « Voir plus » ; le focus passe ensuite à la première ligne ajoutée (le bouton disparaît du rendu).
  async function fetchMore(more = false) {
    const mine = ++seq;
    const before = items.length;
    loading = true;
    error = '';
    paint();
    const q = new URLSearchParams({ scope, limit: String(PAGE_SIZE) });
    if (status) q.set('status', status);
    if (cursor) q.set('cursor', cursor);
    try {
      const res = await api.get(`/verifications?${q}`);
      if (mine !== seq) return;
      items = [...items, ...res.items];
      cursor = res.nextCursor;
    } catch (err) {
      if (mine !== seq) return;
      error = errorText(err, 'Impossible de charger les pages à revoir.');
    }
    loading = false;
    paint();
    if (more) /** @type {HTMLElement | undefined} */ (panel.querySelectorAll('.verif-row')[before] ?? panel.querySelector('.verif-more button, .notice.error button'))?.focus();
  }

  function reload() {
    items = [];
    cursor = null;
    fetchMore();
  }

  reload();
  return m;
}
