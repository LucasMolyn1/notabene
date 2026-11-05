// Import d'un export Notion (ZIP « Markdown & CSV ») dans un espace : simulation, puis import, avec rapport fichier par fichier.
// Tout le texte du rapport (chemins, titres, motifs) vient de l'archive : il est inséré en texte, jamais en HTML.
import { h, fullDate } from './util.js';
import { icon } from './icons.js';
import { api, uploadRaw } from './api.js';
import { store } from './store.js';
import { pagePathById } from './urls.js';
import { openModal, toast } from './ui.js';

const KIND_LABELS = { page: 'Page', base: 'Base', table: 'Tableau', folder: 'Dossier', attachment: 'Pièce jointe', file: 'Fichier' };
// Types qui correspondent à une page créée (une pièce jointe renvoie à la page qui la porte).
const PAGE_KINDS = new Set(['page', 'base', 'table', 'folder']);
// Au-delà, le tableau n'affiche que les premières lignes du filtre (le rapport complet reste consultable par l'API).
const MAX_ROWS = 1000;

/** Message d'erreur lisible pour un refus du serveur lors de l'envoi de l'archive. */
function errorMessage(err) {
  const detail = typeof err?.message === 'string' ? err.message : '';
  switch (err?.status) {
    case 0: return err?.data?.aborted ? 'Envoi annulé.' : 'Connexion interrompue pendant l’envoi. L’archive dépasse peut-être la taille admise par le serveur.';
    case 413: return /body is too large/i.test(detail) || !detail
      ? 'Archive trop volumineuse pour cette instance (réglage IMPORT_ZIP_MAX_MB).'
      : `Archive refusée : ${detail}`;
    case 415: return 'Le fichier choisi n’est pas une archive ZIP.';
    case 422: return detail || 'Aucune page Notion trouvée dans l’archive (format attendu : « Markdown & CSV »).';
    case 429: return 'Trop d’imports en peu de temps : réessayez dans une heure.';
    case 503: return detail || 'Un import est déjà en cours sur cette instance : réessayez dans quelques minutes.';
    default: return detail || 'Import impossible.';
  }
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** Récapitulatif chiffré d'un rapport. */
function summaryEl(summary) {
  const s = summary || {};
  const stat = (n, label) => h('div', { class: 'ni-stat' }, h('strong', null, String(n ?? 0)), h('span', null, label));
  return h('div', { class: 'ni-stats' },
    stat(s.pages, 'pages'), stat(s.bases, 'bases'), stat(s.tables, 'tableaux'), stat(s.folders, 'dossiers'),
    stat(s.attachments, 'pièces jointes'), stat(s.skipped, 'fichiers ignorés'),
    stat(s.links?.resolved, 'liens résolus'), stat(s.links?.unresolved, 'liens introuvables'));
}

/**
 * Rapport complet : récapitulatif, liens vers les pages créées, tableau filtrable par fichier.
 * @param {any} report
 * @param {() => void} close ferme la fenêtre (avant de suivre un lien vers une page)
 */
function reportEl(report, close) {
  const items = Array.isArray(report.items) ? report.items : [];
  const imported = items.filter((it) => it.status === 'imported').length;
  const skipped = items.length - imported;
  const link = (pageId, text) => h('a', { href: pagePathById(pageId), onClick: () => close() }, text);

  const head = report.dryRun
    ? h('div', { class: 'notice info stack' },
      h('strong', null, 'Simulation terminée : rien n’a été créé.'),
      h('p', null, 'Voici ce que l’import ferait. Relisez les fichiers ignorés, puis lancez l’import.'))
    : h('div', { class: 'notice success stack' },
      h('strong', null, 'Import terminé.'),
      h('p', null, 'Les pages ci-dessous ont été créées dans l’espace.'));

  // Pages créées (import réel) : une entrée par page, dans l'ordre du rapport.
  const created = [];
  const seen = new Set();
  if (!report.dryRun) {
    for (const it of items) {
      if (it.status !== 'imported' || !it.pageId || !PAGE_KINDS.has(it.kind) || seen.has(it.pageId)) continue;
      seen.add(it.pageId);
      created.push(it);
    }
  }
  const createdEl = created.length > 0 && h('div', { class: 'stack ni-created' },
    h('h4', null, plural(created.length, 'page créée', 'pages créées')),
    h('ul', { class: 'perm-list' }, created.slice(0, 50).map((it) => h('li', null, link(it.pageId, it.title || it.path)))),
    created.length > 50 && h('p', { class: 'hint' }, `Et ${created.length - 50} autres, visibles dans l’arborescence de l’espace.`));

  // Filtre du tableau : tous, importés, ignorés.
  const filterName = `ni-filter-${Math.random().toString(36).slice(2, 8)}`;
  let filter = 'all';
  const tbody = h('tbody');
  const countEl = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const radio = (value, label) => {
    const input = h('input', { type: 'radio', name: filterName, value });
    input.checked = value === filter;
    input.addEventListener('change', () => { filter = value; renderRows(); });
    return h('label', { class: 'ni-filter' }, input, h('span', null, label));
  };
  const filters = h('fieldset', { class: 'ni-filters' },
    h('legend', null, 'Afficher'),
    radio('all', `Tous (${items.length})`), radio('imported', `Importés (${imported})`), radio('skipped', `Ignorés (${skipped})`));

  function renderRows() {
    const rows = items.filter((it) => filter === 'all' || it.status === filter);
    tbody.replaceChildren(...rows.slice(0, MAX_ROWS).map((it) => {
      const ok = it.status === 'imported';
      const detail = ok
        ? [it.title && it.title !== it.path ? h('div', null, it.title) : null,
          ...(Array.isArray(it.notes) ? it.notes.map((n) => h('div', { class: 'ni-note' }, n)) : []),
          it.pageId && PAGE_KINDS.has(it.kind) ? link(it.pageId, 'Ouvrir la page') : null]
        : h('div', null, it.reason || 'Ignoré');
      return h('tr', { class: ok ? '' : 'ni-skipped' },
        h('td', { class: 'ni-path' }, it.path),
        h('td', null, KIND_LABELS[it.kind] || it.kind || ''),
        h('td', null, h('span', { class: `pill ${ok ? 'ok' : 'warn'}` }, ok ? 'Importé' : 'Ignoré')),
        h('td', null, detail));
    }));
    countEl.textContent = rows.length > MAX_ROWS
      ? `${MAX_ROWS} lignes affichées sur ${rows.length}.`
      : plural(rows.length, 'fichier affiché', 'fichiers affichés') + '.';
  }
  renderRows();

  return h('div', { class: 'stack ni-report' },
    head,
    summaryEl(report.summary),
    createdEl,
    report.truncated > 0 && h('p', { class: 'notice warning' }, `Rapport tronqué : ${report.truncated} fichier(s) non listé(s).`),
    items.length > 0
      ? [filters, countEl,
        h('div', { class: 'ni-scroll' }, h('table', { class: 'ni-table' },
          h('caption', { class: 'sr-only' }, 'Fichiers de l’archive'),
          h('thead', null, h('tr', null, ['Fichier', 'Type', 'État', 'Détail'].map((c) => h('th', { scope: 'col' }, c)))),
          tbody))]
      : h('p', { class: 'muted' }, 'Aucun fichier listé dans ce rapport.'));
}

/**
 * Fenêtre d'import Notion pour un espace où la personne peut écrire.
 * @param {string} spaceId
 */
export function openNotionImport(spaceId) {
  const space = store.space(spaceId);
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', class: 'input', id: 'ni-file' });
  const parentSel = h('select', { class: 'input', id: 'ni-parent' },
    h('option', { value: '' }, 'À la racine de l’espace'),
    store.pagesIn(spaceId)
      .slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', 'fr'))
      .map((p) => h('option', { value: p.id }, p.title || 'Sans titre')));
  const simulateBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Simuler');
  const importBtn = h('button', { class: 'btn btn-ghost', type: 'button', disabled: true }, icon('upload', 15), 'Importer');
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, 'Annuler l’envoi');
  const progress = h('progress', { class: 'ni-progress', max: '100', value: '0', 'aria-label': 'Progression de l’envoi', hidden: true });
  const live = h('p', { class: 'ni-status', role: 'status', 'aria-live': 'polite' });
  const error = h('p', { class: 'notice warning', role: 'alert', hidden: true });
  const reportBox = h('div', { class: 'ni-report-box', tabindex: '-1' });
  const historyBox = h('div', { class: 'stack' });

  // Fichier simulé avec succès : l'import n'est proposé qu'après une simulation du même fichier et de la même destination.
  let simulated = null;
  let controller = null;
  const key = () => { const f = fileInput.files?.[0]; return f ? `${f.name}|${f.size}|${f.lastModified}|${parentSel.value}` : null; };
  const refreshButtons = () => { importBtn.disabled = !!controller || !simulated || simulated !== key(); simulateBtn.disabled = !!controller; };
  fileInput.addEventListener('change', () => { simulated = null; error.hidden = true; refreshButtons(); });
  parentSel.addEventListener('change', () => { refreshButtons(); });
  cancelBtn.addEventListener('click', () => controller?.abort());

  let modal = null;
  const close = () => modal?.close();

  async function run(dryRun) {
    const file = fileInput.files?.[0];
    error.hidden = true;
    if (!file) {
      error.textContent = 'Choisissez d’abord l’archive ZIP exportée depuis Notion.';
      error.hidden = false;
      fileInput.focus();
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      error.textContent = 'Le fichier choisi n’est pas une archive .zip.';
      error.hidden = false;
      return;
    }
    const fileKey = key();
    controller = new AbortController();
    refreshButtons();
    progress.value = 0;
    progress.hidden = false;
    cancelBtn.hidden = false;
    live.textContent = dryRun ? 'Envoi de l’archive pour simulation…' : 'Envoi de l’archive pour import…';
    const params = new URLSearchParams({ dryRun: String(dryRun) });
    if (parentSel.value) params.set('parentId', parentSel.value);
    let lastPct = -1;
    try {
      const report = await uploadRaw(`/spaces/${encodeURIComponent(spaceId)}/import/notion?${params}`, file, {
        contentType: 'application/zip',
        signal: controller.signal,
        onProgress: (ratio) => {
          const pct = Math.round(ratio * 100);
          progress.value = pct;
          // Annonce par paliers de 25 % pour ne pas saturer les lecteurs d'écran.
          if (Math.floor(pct / 25) !== Math.floor(lastPct / 25)) live.textContent = `Envoi : ${pct} %`;
          lastPct = pct;
        },
        onSent: () => { cancelBtn.hidden = true; live.textContent = dryRun ? 'Archive reçue, simulation en cours…' : 'Archive reçue, import en cours…'; },
      });
      simulated = dryRun ? fileKey : null;
      live.textContent = dryRun ? 'Simulation terminée.' : 'Import terminé.';
      reportBox.replaceChildren(reportEl(report, close));
      reportBox.focus();
      if (!dryRun) {
        fileInput.value = '';
        toast('Import Notion terminé.');
        store.load().catch(() => { /* l'arborescence se rafraîchira au prochain événement */ });
      }
      loadHistory();
    } catch (err) {
      live.textContent = '';
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      controller = null;
      progress.hidden = true;
      cancelBtn.hidden = true;
      refreshButtons();
    }
  }
  simulateBtn.addEventListener('click', () => run(true));
  importBtn.addEventListener('click', () => run(false));

  async function showReport(id) {
    try {
      const report = await api.get(`/imports/${encodeURIComponent(id)}`);
      reportBox.replaceChildren(h('p', { class: 'hint' }, `Rapport du ${fullDate(report.createdAt)}`), reportEl(report, close));
      reportBox.focus();
    } catch (err) {
      toast(err?.message || 'Rapport introuvable', { kind: 'error' });
    }
  }

  async function loadHistory() {
    let list;
    try { list = (await api.get('/imports')).items || []; } catch { historyBox.replaceChildren(h('p', { class: 'muted' }, 'Historique indisponible.')); return; }
    const mine = list.filter((r) => r.spaceId === spaceId);
    historyBox.replaceChildren(mine.length === 0
      ? h('p', { class: 'muted' }, 'Aucun import récent dans cet espace.')
      : h('ul', { class: 'ni-history' }, mine.map((r) => h('li', null,
        h('span', { class: `pill ${r.dryRun ? '' : 'ok'}` }, r.dryRun ? 'Simulation' : 'Import'),
        h('span', null, fullDate(r.createdAt)),
        h('span', { class: 'muted' }, `${plural(r.summary?.pages ?? 0, 'page', 'pages')}, ${plural(r.summary?.skipped ?? 0, 'fichier ignoré', 'fichiers ignorés')}`),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Voir le rapport du ${fullDate(r.createdAt)}`, onClick: () => showReport(r.id) }, 'Voir le rapport')))));
  }

  modal = openModal({
    title: `Importer depuis Notion dans « ${space?.name || 'cet espace'} »`,
    size: 'wide',
    body: h('div', { class: 'stack ni' },
      h('p', { class: 'muted' }, 'Dans Notion : menu de la page ou de l’espace de travail, « Exporter », format « Markdown & CSV », avec les sous-pages. Choisissez ensuite l’archive obtenue.'),
      h('p', { class: 'notice info' }, 'La simulation lit et convertit l’archive sans rien écrire dans l’espace : seul son rapport est conservé. L’import n’est proposé qu’après une simulation du même fichier.'),
      h('div', { class: 'field' }, h('label', { for: 'ni-file' }, 'Archive ZIP Notion'), fileInput),
      h('div', { class: 'field' }, h('label', { for: 'ni-parent' }, 'Emplacement des pages importées'), parentSel),
      h('div', { class: 'row wrap' }, simulateBtn, importBtn, cancelBtn),
      progress, live, error,
      reportBox,
      h('section', { class: 'stack', 'aria-labelledby': 'ni-history-title' },
        h('h3', { id: 'ni-history-title', class: 'ni-h' }, 'Imports récents'),
        historyBox)),
    actions: [{ label: 'Fermer' }],
  });
  modal.el.addEventListener('close', () => controller?.abort());
  historyBox.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
  loadHistory();
  setTimeout(() => fileInput.focus(), 30);
}
