// « Mes tâches » : lignes de bases où une colonne Personne contient la personne connectée, dans toutes les bases qu'elle peut
// lire. Le serveur choisit, filtre et trie (en retard, puis par échéance) ; ici on regroupe par échéance (en retard, aujourd'hui,
// cette semaine, plus tard, sans échéance, puis terminées) et chaque tâche renvoie à sa base.
// Le nombre de tâches en retard alimente la pastille de la barre latérale. Aucune valeur n'est insérée comme HTML.
import { api } from './api.js';
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { pagePath, spacePath } from './urls.js';
import { store } from './store.js';
import { beginView, setView, topbar } from './views.js';
import { dayNum, fmtDate, isoDay, todayNum } from './base-model.js';

const main = () => document.getElementById('main');
const listeners = new Set();
let lateCount = 0;
let filter = 'todo'; // « À faire » (par défaut) ou « Toutes »

/** Tâches en retard : échéance passée, non terminée. */
const isLate = (t, today) => !t.done && typeof t.due === 'string' && t.due < today;

/** Groupes d'échéance, dans l'ordre d'affichage. */
const BUCKETS = [
  { id: 'late', label: 'En retard' },
  { id: 'today', label: 'Aujourd’hui' },
  { id: 'week', label: 'Cette semaine' },
  { id: 'later', label: 'Plus tard' },
  { id: 'none', label: 'Sans échéance' },
  { id: 'done', label: 'Terminées' },
];
/**
 * Groupe d'une tâche. « Cette semaine » : après aujourd'hui, jusqu'au dimanche de la semaine en cours.
 * @param {any} t @param {string} today @param {string} weekEnd
 */
function bucketOf(t, today, weekEnd) {
  if (t.done) return 'done';
  if (typeof t.due !== 'string' || !t.due) return 'none';
  if (t.due < today) return 'late';
  if (t.due === today) return 'today';
  return t.due <= weekEnd ? 'week' : 'later';
}
/** Dimanche de la semaine en cours (AAAA-MM-JJ). Le numéro de jour 0 (1er janvier 1970) est un jeudi. */
function weekEndOf(today) {
  const n = dayNum(today) ?? todayNum();
  const weekday = ((n + 3) % 7) + 1; // 1 = lundi … 7 = dimanche
  return isoDay(n + 7 - weekday);
}

/** Nombre de tâches en retard (pastille de la barre latérale). */
export const lateTasks = () => lateCount;
/** @param {() => void} fn */
export const onTasksChange = (fn) => { listeners.add(fn); };
function setLate(n) {
  if (n === lateCount) return;
  lateCount = n;
  listeners.forEach((fn) => fn());
}

// Le nombre est gardé deux minutes dans l'onglet : recharger l'application ne relance pas la requête (limitée par le serveur).
const CACHE_KEY = 'notabene.lateTasks';
const CACHE_MS = 120_000;
function remember(n) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ user: session.user?.id, day: isoDay(todayNum()), at: Date.now(), n })); } catch { /* stockage indisponible */ }
}
function recalled() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
    const fresh = c && c.user === session.user?.id && c.day === isoDay(todayNum()) && Date.now() - c.at < CACHE_MS && Number.isInteger(c.n);
    return fresh ? c.n : null;
  } catch { return null; }
}

/** Relit le nombre de tâches en retard (`force` : sans tenir compte du cache) ; une erreur laisse la pastille telle quelle. */
export async function refreshLateTasks(force = false) {
  if (!session.user) return;
  const cached = force ? null : recalled();
  if (cached !== null) { setLate(cached); return; }
  try {
    const res = await api.get('/my-tasks?done=false');
    const today = isoDay(todayNum());
    const n = (res?.tasks ?? []).filter((t) => isLate(t, today)).length;
    remember(n);
    setLate(n);
  } catch { /* pastille inchangée */ }
}
/** Après une modification de base (flux temps réel), relecture groupée. */
export const refreshLateTasksSoon = debounce(() => refreshLateTasks(true), 5000);

export async function showTasks() {
  beginView();
  document.title = 'Mes tâches · BeNote';
  let destroyed = false;
  const body = h('div', { class: 'tasks' });
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  main().replaceChildren(
    topbar(h('nav', { class: 'crumbs', 'aria-label': 'Fil d’Ariane' }, h('span', { class: 'crumb current' }, 'Mes tâches'))),
    h('div', { class: 'scroller' }, h('div', { class: 'page-wrap tasks-wrap' }, h('h1', { class: 'tasks-title' }, 'Mes tâches'), body, live)));
  setView({ kind: 'tasks', id: 'tasks', destroy() { destroyed = true; window.removeEventListener('notabene:base', onRemote); } });

  if (!session.user) {
    body.replaceChildren(h('p', { class: 'muted' }, 'Connectez-vous pour voir les tâches qui vous sont attribuées.'));
    return;
  }

  async function load(focusFilter = false) {
    let res;
    try {
      res = await api.get(`/my-tasks${filter === 'todo' ? '?done=false' : ''}`);
    } catch (err) {
      if (!destroyed) body.replaceChildren(h('p', { class: 'notice error', role: 'alert' }, err?.status === 429 ? 'Trop de demandes en peu de temps : réessayez dans une minute.' : err?.message || 'Impossible de charger vos tâches.'));
      return;
    }
    if (destroyed) return;
    render(res?.tasks ?? [], !!res?.truncated);
    if (focusFilter) /** @type {HTMLElement | null} */ (body.querySelector('.tasks-filter [aria-pressed="true"]'))?.focus();
  }

  function render(tasks, truncated) {
    const today = isoDay(todayNum());
    const weekEnd = weekEndOf(today);
    const late = tasks.filter((t) => isLate(t, today)).length;
    remember(late);
    setLate(late);
    // Regroupement par échéance ; dans chaque groupe, l'ordre du serveur (échéance croissante).
    const groups = new Map(BUCKETS.map((b) => [b.id, []]));
    for (const t of tasks) groups.get(bucketOf(t, today, weekEnd)).push(t);
    const pick = (value, label) => h('button', {
      class: `btn btn-ghost btn-sm${filter === value ? ' active' : ''}`, 'aria-pressed': String(filter === value),
      onClick: () => { if (filter === value) return; filter = value; load(true); },
    }, label);
    const taskEl = (t) => {
      const lateNow = isLate(t, today);
      return h('li', { class: `task${lateNow ? ' late' : ''}${t.done ? ' done' : ''}` },
        h('span', { class: 'task-state', 'aria-hidden': 'true' }, icon(t.done ? 'check' : lateNow ? 'alert' : 'clock', 15)),
        h('span', { class: 'task-main' },
          h('span', { class: 'task-name' }, t.title || 'Sans titre'),
          h('span', { class: 'task-meta' },
            lateNow && h('strong', { class: 'task-late' }, 'En retard'),
            h('span', null, t.due ? `Échéance : ${fmtDate(t.due)}` : 'Sans échéance'),
            t.status && h('span', { class: `bt-badge c-${t.status.color}` }, t.status.name),
            !t.status && t.done && h('span', null, 'Terminée'),
            h('a', { class: 'task-base', href: pagePath({ id: t.baseId, title: t.baseTitle }), 'aria-label': `Ouvrir le tableau ${t.baseTitle || 'Sans titre'}` },
              icon('table', 13), h('span', null, t.baseTitle || 'Sans titre')))));
    };
    // Liste vide : une phrase qui dit pourquoi, et où aller.
    const spaces = store.spaces.slice(0, 6);
    const emptyEl = () => h('div', { class: 'empty tasks-empty' },
      h('p', { class: 'tasks-empty-title' }, filter === 'todo' ? 'Aucune tâche à faire pour le moment.' : 'Aucune tâche ne vous est attribuée.'),
      h('p', { class: 'muted' }, filter === 'todo'
        ? 'Une tâche apparaît ici quand quelqu’un vous désigne dans la colonne « Responsable » d’un tableau, et disparaît quand elle est terminée.'
        : 'Une tâche apparaît ici quand quelqu’un vous désigne dans la colonne « Responsable » d’un tableau.'),
      spaces.length > 0 && h('nav', { class: 'tasks-spaces', 'aria-label': 'Espaces' },
        h('span', { class: 'muted' }, 'Voir les tableaux de vos espaces :'),
        spaces.map((sp) => h('a', { href: spacePath(sp) }, sp.name || 'Sans nom'))));
    body.replaceChildren(...[
      h('div', { class: 'tasks-head' },
        h('div', { class: 'tl-modes tasks-filter', role: 'group', 'aria-label': 'Tâches affichées' }, pick('todo', 'À faire'), pick('all', 'Toutes')),
        h('p', { class: 'muted tasks-count' }, `${tasks.length} tâche${tasks.length > 1 ? 's' : ''}${late ? `, dont ${late} en retard` : ''}`)),
      truncated && h('p', { class: 'notice info' }, 'Seules les premières tâches sont affichées : la liste a été tronquée.'),
      tasks.length === 0 && emptyEl(),
      ...BUCKETS.filter((b) => groups.get(b.id).length).map((b) => {
        const list = groups.get(b.id);
        return h('section', { class: `tasks-group tasks-${b.id}`, 'aria-labelledby': `tg-${b.id}` },
          h('h2', { id: `tg-${b.id}`, class: 'tasks-bucket' },
            b.id === 'late' && h('span', { class: 'task-state', 'aria-hidden': 'true' }, icon('alert', 15)),
            h('span', null, b.label),
            h('span', { class: 'tasks-n' }, h('span', { class: 'sr-only' }, ' : '), `${list.length}`, h('span', { class: 'sr-only' }, list.length > 1 ? ' tâches' : ' tâche'))),
          h('ul', { class: 'tasks-list' }, list.map(taskEl)));
      }),
    ].filter(Boolean));
  }

  const reload = debounce(() => { if (!destroyed) load(); }, 1000);
  const onRemote = () => reload();
  window.addEventListener('notabene:base', onRemote);
  await load();
}
