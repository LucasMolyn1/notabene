// Administration : conversion des images base64 des pages en pièces jointes (estimation, conversion, suivi, retour arrière).
// Tout le texte venu du serveur (titres de pages, libellés, erreurs) est inséré en texte, jamais en HTML.
import { h, fullDate, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { confirmModal, toast } from '../ui.js';
import { pagePathById } from '../urls.js';
import { formatSize } from '../editor/attachments.js';
import * as A from '../actions.js';
import { REPO_URL } from './account.js';
import { card, loadingEl, pill } from './ui.js';

const POLL_MS = 3000;
const BACKUP_DOC = `${REPO_URL}/blob/main/docs/BACKUP.md`;

const STATUS = {
  running: ['En cours', 'accent'],
  done: ['Terminée', 'ok'],
  interrupted: ['Interrompue', 'warn'],
  failed: ['Échec', 'warn'],
};
const PAGE_STATUS = { converted: 'Convertie', reverted: 'Rétablie', skipped: 'Ignorée' };
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Libellé d'un motif renvoyé par le serveur (repli sur le code brut, en texte). */
const reasonLabel = (labels, code) => (labels && typeof labels[code] === 'string' ? labels[code] : code);

function statsLine(run) {
  const s = run.stats || {};
  const parts = [plural(s.pages || 0, 'page traitée', 'pages traitées')];
  if (run.kind === 'convert') parts.push(plural(s.converted || 0, 'convertie'));
  else parts.push(plural(s.reverted || 0, 'rétablie'));
  if (s.skipped) parts.push(plural(s.skipped, 'ignorée'));
  parts.push(plural(s.images || 0, 'image'));
  if (run.kind === 'convert' && s.bytes) parts.push(formatSize(s.bytes));
  return parts.join(' · ');
}

// Page de l'espace personnel d'un autre compte : le serveur ne donne ni titre ni lien à afficher.
const pageRef = (p, fallback) => (p.hidden
  ? h('span', { class: 'muted' }, 'Page d’un espace personnel (masquée)')
  : h('a', { href: pagePathById(p.pageId) }, p.title || fallback));

function reasonsList(labels, reasons) {
  const entries = Object.entries(reasons || {}).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  return h('ul', { class: 'perm-list img-reasons' }, entries.map(([code, n]) => h('li', null, h('strong', null, String(n)), ` : ${reasonLabel(labels, code)}`)));
}

export async function renderImages(el) {
  let timer = null;
  let state = null;
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const announce = (text) => { live.textContent = text; };
  // Le suivi s'arrête de lui-même quand la section est quittée (l'élément n'est plus dans la page).
  const alive = () => el.isConnected;

  const statusBox = h('div', { class: 'stack' });
  const simBox = h('div', { class: 'stack' });
  const progressBox = h('div', { class: 'stack' });
  const historyBox = h('div', { class: 'stack' });
  const progressCard = card('Exécution en cours', null, progressBox);
  const simulateBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, icon('eye', 15), 'Simuler');
  const convertBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('wand', 15), 'Convertir');

  async function load() {
    const next = await api.get('/admin/images/migration');
    const wasRunning = state?.current;
    state = next;
    paint();
    if (wasRunning && !state.current) {
      const last = state.runs.find((r) => r.id === wasRunning.id);
      announce(last ? `${last.kind === 'convert' ? 'Conversion' : 'Annulation'} ${STATUS[last.status]?.[0].toLowerCase() || 'terminée'} : ${statsLine(last)}.` : 'Exécution terminée.');
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (state?.current && alive()) timer = setTimeout(() => { if (alive()) load().catch(() => schedule()); }, POLL_MS);
  }

  function paint() {
    const { pendingPages, current } = state;
    statusBox.replaceChildren(
      h('p', null, pendingPages
        ? `${plural(pendingPages, 'page contient', 'pages contiennent')} encore des images intégrées dans le texte (base64).`
        : 'Aucune page ne contient d’image intégrée en base64.'));
    simulateBtn.disabled = !!current;
    convertBtn.disabled = !!current || !pendingPages;

    progressCard.hidden = !current;
    if (current) {
      progressBox.replaceChildren(
        h('div', { class: 'row wrap' }, pill(current.kind === 'convert' ? 'Conversion en cours' : 'Annulation en cours', 'accent'),
          h('span', { class: 'muted' }, `démarrée ${timeAgo(current.startedAt)}`)),
        h('progress', { class: 'img-progress', 'aria-label': 'Exécution en cours' }),
        h('p', null, statsLine(current)),
        h('p', { class: 'hint' }, 'Le suivi se met à jour toutes les 3 secondes. Vous pouvez quitter cette page : l’exécution continue sur le serveur.'));
    }
    paintHistory();
  }

  function paintHistory() {
    const { runs, labels } = state;
    if (!runs.length) { historyBox.replaceChildren(h('p', { class: 'muted' }, 'Aucune exécution pour le moment.')); return; }
    historyBox.replaceChildren(h('div', { class: 'table' }, runs.map((run) => {
      const [statusText, statusKind] = STATUS[run.status] || [run.status, ''];
      const revertedBy = runs.find((r) => r.kind === 'revert' && r.reverts === run.id);
      const detail = h('div', { class: 'img-detail', hidden: true });
      const detailBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-expanded': 'false' }, 'Détail par page');
      detailBtn.addEventListener('click', async () => {
        const open = detail.hidden;
        detail.hidden = !open;
        detailBtn.setAttribute('aria-expanded', String(open));
        if (open && !detail.childElementCount) {
          detail.replaceChildren(loadingEl());
          const d = await A.attempt(() => api.get(`/admin/images/migration/runs/${encodeURIComponent(run.id)}`));
          detail.replaceChildren(d ? pagesTable(d.pages, labels) : h('p', { class: 'muted' }, 'Détail indisponible.'));
        }
      });
      const canRevert = run.kind === 'convert' && run.status !== 'running' && !state.current && (run.stats?.converted || 0) > 0;
      const revertBtn = canRevert && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => revert(run, !!revertedBy) },
        icon('restore', 14), revertedBy ? 'Relancer l’annulation' : 'Annuler cette conversion');
      return h('div', { class: 'table-row wrap img-run' },
        h('span', { class: 'grow' },
          h('strong', null, run.kind === 'convert' ? 'Conversion' : 'Annulation d’une conversion', ' ', pill(statusText, statusKind)),
          h('small', null, [`${fullDate(run.startedAt)}`, run.source === 'cli' ? 'commande en ligne' : 'interface web', statsLine(run)].join(' · ')),
          revertedBy && h('small', null, `Annulée le ${fullDate(revertedBy.startedAt)}`),
          run.error && h('small', { class: 'img-error' }, `Erreur : ${run.error}`),
          reasonsList(labels, run.stats?.reasons)),
        h('span', { class: 'row wrap' }, detailBtn, revertBtn),
        detail);
    })));
  }

  function pagesTable(pages, labels) {
    if (!pages.length) return h('p', { class: 'muted' }, 'Aucune page traitée.');
    return h('ul', { class: 'perm-list img-pages', 'aria-label': 'Pages traitées' }, pages.map((p) => h('li', null,
      pageRef(p, 'Page supprimée'),
      ` : ${PAGE_STATUS[p.status] || p.status}`,
      p.images ? ` · ${plural(p.images, 'image')}` : '',
      p.bytes ? ` · ${formatSize(p.bytes)}` : '',
      p.reasons.length ? h('small', { class: 'hint' }, p.reasons.map((r) => reasonLabel(labels, r)).join(' ; ')) : null)));
  }

  async function simulate() {
    simulateBtn.disabled = true;
    simBox.replaceChildren(loadingEl());
    announce('Simulation en cours…');
    try {
      const r = await api.post('/admin/images/migration', { action: 'dry-run' });
      const summary = `${plural(r.pages, 'page serait convertie', 'pages seraient converties')}, ${plural(r.images, 'image')}, ${formatSize(r.bytes)}.`;
      simBox.replaceChildren(h('div', { class: 'notice info stack' },
        h('strong', null, 'Résultat de la simulation (rien n’a été modifié)'),
        h('p', null, summary),
        Object.keys(r.reasons || {}).length ? h('div', null, h('p', null, 'Images ou pages laissées telles quelles :'), reasonsList(state.labels, r.reasons)) : null,
        r.skipped?.length ? h('details', null, h('summary', null, `${plural(r.skipped.length, 'page concernée', 'pages concernées')} par une exclusion`),
          h('ul', { class: 'perm-list img-pages' }, r.skipped.map((s) => h('li', null,
            pageRef(s, 'Sans titre'),
            h('small', { class: 'hint' }, s.reasons.map((code) => reasonLabel(state.labels, code)).join(' ; ')))))) : null));
      announce(`Simulation terminée : ${summary}`);
    } catch (err) {
      simBox.replaceChildren(h('p', { class: 'notice warning', role: 'alert' }, err.message || 'Simulation impossible.'));
      announce('');
    } finally {
      simulateBtn.disabled = !!state?.current;
    }
  }

  async function start(body, okText) {
    try {
      await api.post('/admin/images/migration', body);
      toast(okText);
      announce(okText);
    } catch (err) {
      toast(err.status === 409 ? 'Une exécution est déjà en cours.' : err.message || 'Lancement impossible.', { kind: 'error' });
    }
    await load().catch(() => {});
  }

  async function convert() {
    const ok = await confirmModal({
      title: 'Convertir les images des pages ?',
      message: `Les images intégrées en base64 de ${plural(state.pendingPages, 'page')} deviendront des pièces jointes. Une version de chaque page est conservée dans l’historique et la conversion peut être annulée ensuite. Avez-vous fait une sauvegarde (base et pièces jointes) ?`,
      confirm: 'Convertir',
    });
    if (ok) await start({ action: 'convert' }, 'Conversion lancée.');
  }

  async function revert(run, again) {
    const ok = await confirmModal({
      title: again ? 'Relancer l’annulation ?' : 'Annuler cette conversion ?',
      message: `Les images converties le ${fullDate(run.startedAt)} seront remises dans les pages telles qu’à l’origine. Une page modifiée depuis garde ses modifications : seules ses images sont rétablies.`,
      confirm: 'Annuler la conversion',
      danger: true,
    });
    if (ok) await start({ action: 'revert', runId: run.id }, 'Annulation lancée.');
  }

  simulateBtn.addEventListener('click', simulate);
  convertBtn.addEventListener('click', convert);

  el.replaceChildren(loadingEl());
  try {
    state = await api.get('/admin/images/migration');
  } catch (err) {
    el.replaceChildren(h('p', { class: 'notice warning', role: 'alert' }, err.message || 'Chargement impossible.'));
    return;
  }
  el.replaceChildren(
    live,
    card('Images intégrées dans les pages', 'Les images collées dans une page sont parfois enregistrées dans son texte (base64), ce qui alourdit la base, la recherche et l’historique. La conversion les range en pièces jointes, sans changer leur affichage. Les images SVG et les contenus non reconnus restent dans la page.',
      h('div', { class: 'stack' },
        statusBox,
        h('div', { class: 'notice warning' },
          h('strong', null, 'Faites une sauvegarde d’abord. '),
          'Sauvegardez la base et le dossier des pièces jointes avant de convertir (voir ',
          h('a', { href: BACKUP_DOC, target: '_blank', rel: 'noopener' }, 'docs/BACKUP.md'),
          ').'),
        h('div', { class: 'row wrap' }, simulateBtn, convertBtn),
        simBox)),
    progressCard,
    card('Historique', 'Les 20 dernières exécutions (interface web ou commande en ligne).', historyBox));
  paint();
  schedule();
}
