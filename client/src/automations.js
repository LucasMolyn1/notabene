// Automatisations d'une base : liste et état, création et modification par formulaires à listes fermées, activation,
// suppression, journal d'exécution, secret de webhook montré une seule fois ; message du résultat d'un bouton de ligne.
// Droits, plafonds et coupe-circuits sont appliqués par le serveur : ici on affiche et on envoie. Aucun HTML n'est inséré.
import { api } from './api.js';
import { h, debounce } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { confirmModal, openModal, toast } from './ui.js';
import { DATE_FILTER_TYPES, OPERATORS, opKind } from './base-model.js';

/** Colonnes qu'une action peut écrire (celles d'un modèle de ligne : ni calcul, ni relation, ni colonne tenue par le serveur). */
const WRITABLE = new Set(['text', 'number', 'date', 'date_range', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'url', 'email', 'phone']);
const TRIGGERS = { row_added: 'Une ligne est ajoutée', property_changed: 'Une propriété est modifiée', recurrence: 'À intervalle régulier', button: 'Bouton sur chaque ligne' };
const ACTIONS = { set_property: 'Modifier une propriété', add_row: 'Ajouter une ligne', notify: 'Notifier des personnes', webhook: 'Appeler un webhook' };
const EVERY = { hour: 'Chaque heure', day: 'Chaque jour', week: 'Chaque semaine', month: 'Chaque mois' };
const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const STATUS = { active: ['Active', 'ok'], paused: ['En pause', 'warn'], suspended: ['Suspendue', 'warn'], broken: ['En panne', 'bad'] };
const REASONS = {
  errors: 'Mise en pause après plusieurs erreurs consécutives. Consultez le journal, corrigez puis réactivez.',
  frequency: 'Mise en pause : elle s’est exécutée trop souvent en peu de temps. Vérifiez ses filtres puis réactivez.',
  author: 'Suspendue : son auteur n’a plus de compte actif. Réactivez-la pour qu’elle agisse avec vos droits.',
  access: 'Suspendue : son auteur ne peut plus modifier cette base (ou la base cible). Réactivez-la pour qu’elle agisse avec vos droits.',
  config: 'En panne : une colonne, une option ou une base qu’elle cite n’existe plus. Modifiez-la puis enregistrez.',
};
const CODES = {
  ok: 'Réussie', truncated: 'Réussie, limitée au plafond de lignes', access: 'Droits insuffisants', author: 'Auteur indisponible',
  config: 'Configuration invalide', frequency: 'Trop d’exécutions, mise en pause', limit_base: 'Sautée : trop d’exécutions sur la base',
  limit_rows: 'Trop de lignes concernées', write_failed: 'Écriture refusée', webhook_failed: 'Échec du webhook',
  webhook_disabled: 'Webhooks désactivés par l’administrateur', trashed: 'Base dans la corbeille',
};
const RUN_STATUS = { ok: ['Réussie', 'ok'], error: ['Erreur', 'bad'], skipped: ['Sautée', 'warn'] };
const DEFAULT_LIMITS = { automations: 20, actions: 5, filters: 5, recipients: 20 };
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
// replaceChildren transforme null, false et les tableaux en texte : on aplatit et on écarte avant.
const put = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter(Boolean));
let seq = 0;

/** Fuseaux proposés (liste fermée) ; par défaut celui du navigateur. */
function timeZones() {
  let list = [];
  try { list = Intl.supportedValuesOf('timeZone'); } catch { /* navigateur ancien */ }
  return list.includes('UTC') ? list : [...list, 'UTC'];
}
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** Message lisible du résultat d'un bouton de ligne. */
export function runMessage(label, r) {
  if (r.status === 'ok') return `« ${label} » : ${r.code === 'truncated' ? CODES.truncated.toLowerCase() : 'fait'}${r.rows > 1 ? ` (${r.rows} lignes)` : ''}.`;
  return `« ${label} » : ${(CODES[r.code] ?? 'échec').toLowerCase()}.`;
}

/**
 * Panneau « Automatisations » d'une base (droit d'écriture requis, vérifié par le serveur).
 * @param {{ baseId: string, title: string, properties: any[], onChange: () => void }} o
 */
export function openAutomations({ baseId, title, properties, onChange }) {
  const host = h('div', { class: 'au-panel' });
  let state = null; // réponse de GET /automations
  let secret = null; // { name, value } : secret de webhook à montrer une seule fois
  let changed = false;
  const m = openModal({ title: `Automatisations de ${title || 'la base'}`, body: host, size: 'medium', actions: [{ label: 'Fermer' }] });
  m.el.addEventListener('close', () => { if (changed) onChange(); });
  const limits = () => ({ ...DEFAULT_LIMITS, ...(state?.limits ?? {}) });
  const propById = (pid) => properties.find((p) => p.id === pid);
  const fail = (err) => toast(err?.message || 'Une erreur est survenue', { kind: 'error' });

  async function refresh() {
    try { state = await api.get(`/bases/${baseId}/automations`); } catch (err) {
      put(host, h('p', { class: 'notice error', role: 'alert' }, err?.message || 'Impossible de charger les automatisations.'));
      return false;
    }
    return true;
  }

  // ---- Résumés ----
  function triggerText(t) {
    if (!t) return 'Déclencheur illisible';
    const f = t.filters?.length ? ` (${plural(t.filters.length, 'filtre', 'filtres')})` : '';
    if (t.type === 'row_added') return `Quand une ligne est ajoutée${f}`;
    if (t.type === 'property_changed') return `Quand « ${propById(t.propertyId)?.name ?? 'colonne supprimée'} » est modifiée${f}`;
    if (t.type === 'button') return `Bouton « ${t.label} » sur chaque ligne`;
    const at = `à ${t.hour} h`;
    const when = t.every === 'hour' ? 'Chaque heure' : t.every === 'day' ? `Chaque jour ${at}` : t.every === 'week' ? `Chaque ${WEEKDAYS[t.weekday] ?? 'semaine'} ${at}` : `Le ${t.day} de chaque mois ${at}`;
    return `${when} (${t.timeZone})${f}`;
  }
  const actionsText = (list) => list.map((a) => ACTIONS[a.type] ?? a.type).join(', ');

  // ---- Liste ----
  /** Secret en lecture seule : sélectionnable au clavier, nommé pour les lecteurs d'écran. */
  const secretField = (value) => {
    const el = h('input', { class: 'input token-value', readonly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Secret du webhook' });
    el.value = value;
    el.addEventListener('focus', () => el.select());
    return el;
  };
  function secretNotice(shown) {
    if (!shown) return null;
    const value = shown.value;
    const copy = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => navigator.clipboard.writeText(value).then(() => toast('Secret copié'), () => toast('Copie impossible : sélectionnez le secret', { kind: 'error' })) }, icon('copy', 14), 'Copier le secret');
    return h('div', { class: 'notice success stack au-secret' },
      h('strong', null, `Secret de signature du webhook de « ${shown.name} ». Copiez-le maintenant : il ne sera plus affiché.`),
      h('div', { class: 'row wrap' }, secretField(value), copy),
      h('small', { class: 'muted' }, 'Chaque envoi est signé (en-tête X-Notabene-Signature, HMAC-SHA256) et ne contient que des identifiants.'));
  }

  async function patch(a, body, okText) {
    try {
      const res = await api.patch(`/bases/${baseId}/automations/${a.id}`, body);
      changed = true;
      if (res?.webhookSecret) secret = { name: res.name, value: res.webhookSecret };
      toast(okText);
    } catch (err) { fail(err); }
    await refresh();
    showList(`au-item-${a.id}`);
  }

  function itemEl(a) {
    const [label, kind] = a.enabled ? STATUS[a.status] ?? [a.status, ''] : ['Désactivée', 'off'];
    const headId = `au-name-${++seq}`;
    const hasHook = a.actions.some((x) => x.type === 'webhook');
    const inactive = a.enabled && a.status !== 'active';
    const toggleLabel = !a.enabled ? 'Activer' : inactive ? 'Réactiver' : 'Désactiver';
    return h('li', { class: 'au-item', 'aria-labelledby': headId },
      h('div', { class: 'au-item-head' }, h('strong', { id: headId, class: 'au-name' }, a.name), h('span', { class: `pill ${kind}` }, label)),
      h('p', { class: 'au-summary' }, `${triggerText(a.trigger)} : ${actionsText(a.actions)}.`),
      inactive && a.statusReason && h('p', { class: 'notice warning' }, REASONS[a.statusReason] ?? 'Elle ne s’exécute plus.'),
      a.masked && h('p', { class: 'notice info' }, 'Une partie de cette automatisation vise une base ou des personnes que vous ne voyez pas : ses actions ne sont pas modifiables par vous.'),
      h('p', { class: 'muted au-meta' }, [
        a.trigger?.type === 'button' ? 'Agit avec les droits de la personne qui clique' : a.author ? `Agit avec les droits de ${a.author.name}` : 'Auteur inconnu',
        a.lastRunAt ? `dernière exécution le ${fmtWhen(a.lastRunAt)}` : 'jamais exécutée',
        a.nextRunAt && a.enabled && a.status === 'active' ? `prochaine le ${fmtWhen(a.nextRunAt)}` : null,
      ].filter(Boolean).join(' ; ')),
      h('div', { class: 'row wrap au-item-actions' },
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', 'data-focus': `au-item-${a.id}`, 'aria-label': `${toggleLabel} ${a.name}`,
          onClick: () => patch(a, { enabled: toggleLabel !== 'Désactiver' }, toggleLabel === 'Désactiver' ? 'Automatisation désactivée' : 'Automatisation activée'),
        }, toggleLabel),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: a.masked || !a.trigger, 'aria-label': `Modifier ${a.name}`, onClick: () => showEditor(a) }, icon('pencil', 14), 'Modifier'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Journal de ${a.name}`, onClick: () => showRuns(a) }, icon('clock', 14), 'Journal'),
        hasHook && h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Renouveler le secret du webhook de ${a.name}`,
          onClick: async () => {
            if (!await confirmModal({ title: 'Renouveler le secret', message: 'L’ancien secret cessera aussitôt de signer les envois. Le nouveau ne sera montré qu’une fois.', confirm: 'Renouveler' })) return;
            try { const r = await api.post(`/bases/${baseId}/automations/${a.id}/webhook-secret`); secret = { name: a.name, value: r.webhookSecret }; } catch (err) { fail(err); }
            showList();
          },
        }, icon('key', 14), 'Renouveler le secret'),
        h('button', {
          class: 'btn btn-ghost btn-sm danger', type: 'button', 'aria-label': `Supprimer ${a.name}`,
          onClick: async () => {
            if (!await confirmModal({ title: 'Supprimer l’automatisation', message: `« ${a.name} » et son journal seront supprimés.`, confirm: 'Supprimer', danger: true })) return;
            try { await api.del(`/bases/${baseId}/automations/${a.id}`); changed = true; toast('Automatisation supprimée'); } catch (err) { fail(err); }
            await refresh();
            showList();
          },
        }, icon('trash', 14), 'Supprimer')));
  }

  function showList(focus = null) {
    const items = state.items;
    const full = items.length >= limits().automations;
    // Le secret n'est montré qu'à l'affichage qui suit sa création : il est oublié aussitôt.
    const shown = secret;
    secret = null;
    put(host,
      secretNotice(shown),
      h('p', { class: 'muted' }, 'Une automatisation agit avec les droits de son auteur, la dernière personne qui a défini son déclencheur ou ses actions ; un bouton, avec ceux de la personne qui clique. Une automatisation n’en déclenche jamais une autre.'),
      items.length ? h('ul', { class: 'au-list', 'aria-label': 'Automatisations' }, items.map(itemEl)) : h('p', { class: 'muted' }, 'Aucune automatisation pour le moment.'),
      h('div', { class: 'row wrap au-foot' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: full, 'data-focus': 'au-new', onClick: () => showEditor(null) }, icon('plus', 14), 'Nouvelle automatisation'),
        h('span', { class: 'muted' }, `${items.length} sur ${limits().automations} au plus`)));
    const target = /** @type {HTMLElement | null} */ (shown ? host.querySelector('.au-secret button') : focus && host.querySelector(`[data-focus="${CSS.escape(focus)}"]`));
    (target ?? /** @type {HTMLElement | null} */ (host.querySelector('[data-focus="au-new"]:not(:disabled)')))?.focus();
  }

  // ---- Journal ----
  async function showRuns(a) {
    put(host, h('p', { class: 'muted' }, 'Chargement…'));
    let runs;
    try { runs = (await api.get(`/bases/${baseId}/automations/${a.id}/runs`)).items; } catch (err) { fail(err); showList(); return; }
    const back = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => showList(`au-item-${a.id}`) }, 'Retour à la liste');
    put(host,
      h('div', { class: 'row wrap au-head' }, back, h('h3', { class: 'au-title' }, `Journal de « ${a.name} »`)),
      h('p', { class: 'muted' }, 'Les 50 dernières exécutions : résultat et nombre de lignes, jamais leur contenu.'),
      runs.length ? h('div', { class: 'au-scroll' }, h('table', { class: 'au-runs' },
        h('caption', { class: 'sr-only' }, `Journal de ${a.name}`),
        h('thead', null, h('tr', null, ['Date', 'Résultat', 'Détail', 'Lignes', 'Par'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, runs.map((r) => {
          const [st, kind] = RUN_STATUS[r.status] ?? [r.status, ''];
          return h('tr', null,
            h('td', null, fmtWhen(r.at)), h('td', null, h('span', { class: `pill ${kind}` }, st)), h('td', null, CODES[r.code] ?? r.code),
            h('td', null, String(r.rows)), h('td', null, r.actor?.name ?? (a.trigger?.type === 'recurrence' ? 'Planification' : '—')));
        }))))
        : h('p', { class: 'muted' }, 'Aucune exécution pour le moment.'));
    back.focus();
  }

  // ---- Formulaire ----
  /** Recherche d'une personne qui lit la base, ou d'une page : champ de recherche et liste de résultats cliquables. */
  function searchPicker(label, search, onPick) {
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher', 'aria-label': label, maxlength: '60', autocomplete: 'off' });
    const results = h('ul', { class: 'au-results', 'aria-label': `Résultats : ${label}` });
    const run = debounce(async () => {
      try {
        const items = await search(q.value.trim());
        put(results, items.length ? items.slice(0, 8).map((it) => h('li', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => onPick(it) }, it.label)))
          : q.value.trim() && h('li', { class: 'muted' }, 'Aucun résultat.'));
      } catch (err) { fail(err); }
    }, 250);
    q.addEventListener('input', run);
    return h('div', { class: 'au-picker' }, q, results);
  }
  const searchPeople = async (q) => (await api.get(`/pages/${baseId}/mentionable?q=${encodeURIComponent(q)}`)).items.map((u) => ({ id: u.id, label: u.name }));
  const searchPages = async (q) => (q ? (await api.get(`/search?q=${encodeURIComponent(q)}&limit=8`)).items.map((x) => ({ id: x.id, label: x.title || 'Sans titre' })) : []);

  function showEditor(existing) {
    const L = limits();
    const writable = properties.filter((p) => WRITABLE.has(p.type));
    const watchable = properties.filter((p) => WRITABLE.has(p.type) || p.type === 'relation');
    const people = properties.filter((p) => p.type === 'person');
    const bases = store.spaces.flatMap((sp) => store.pagesIn(sp.id)).filter((pg) => pg.kind === 'base' && pg.id !== baseId)
      .sort((x, y) => (x.title || '').localeCompare(y.title || '', 'fr'));
    const targetProps = new Map([[baseId, properties]]); // colonnes des bases cibles, lues à la demande
    const names = new Map(); // noms des personnes choisies (identifiant -> nom)
    const webhookOk = !!state.webhooksAvailable;
    const keptOrigin = existing?.actions.find((x) => x.type === 'webhook')?.origin ?? null;
    const uid = ++seq;
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const draft = existing
      ? { name: existing.name, trigger: clone(existing.trigger), actions: clone(existing.actions).map((a) => (a.type === 'webhook' ? { type: 'webhook', url: '' } : a)) }
      : { name: '', trigger: { type: 'row_added', filters: [] }, actions: [defaultAction('set_property')] };
    for (const a of draft.actions) if (a.type === 'notify') for (const u of a.users ?? []) names.set(u.id, u.name);
    const form = h('form', { class: 'stack au-form', novalidate: true, 'aria-labelledby': `au-form-title-${uid}` });
    const errorEl = h('p', { class: 'notice error', role: 'alert', tabindex: '-1', hidden: true });

    function defaultValue(p) {
      if (!p) return null;
      if (p.type === 'checkbox') return true;
      if (p.type === 'select' || p.type === 'status') return p.options[0]?.id ?? null;
      if (p.type === 'date' || p.type === 'date_range') return { dynamic: 'today' };
      if (p.type === 'person') return { dynamic: 'actor' };
      return null;
    }
    function defaultAction(type) {
      if (type === 'set_property') { const p = properties.find((x) => WRITABLE.has(x.type)); return { type, propertyId: p?.id ?? '', value: defaultValue(p) }; }
      if (type === 'add_row') return { type, baseId, values: {} };
      if (type === 'notify') return { type, userIds: [], propertyId: undefined };
      return { type: 'webhook', url: '' };
    }
    function defaultTrigger(type) {
      if (type === 'property_changed') return { type, propertyId: watchable[0]?.id ?? '', filters: [] };
      if (type === 'recurrence') { const zone = browserZone(); return { type, every: 'day', hour: 8, weekday: 1, day: 1, timeZone: timeZones().includes(zone) ? zone : 'UTC', filters: [] }; }
      if (type === 'button') return { type, label: '' };
      return { type: 'row_added', filters: [] };
    }

    // Champs : identifiant stable (data-k) pour rendre le focus après un nouveau rendu du formulaire.
    const fid = (k) => `au-${uid}-${k}`;
    const select = (k, label, value, options, onChange, extra = {}) => {
      const sel = h('select', { class: 'input', id: fid(k), 'data-k': k, ...extra }, options.map(([v, l, dis]) => h('option', { value: v, disabled: !!dis }, l)));
      sel.value = value ?? '';
      sel.addEventListener('change', () => onChange(sel.value));
      return label ? h('div', { class: 'field' }, h('label', { for: sel.id }, label), sel) : sel;
    };
    const input = (k, label, value, onInput, extra = {}) => {
      const el = h('input', { class: 'input', id: fid(k), 'data-k': k, ...extra });
      el.value = value ?? '';
      el.addEventListener('input', () => onInput(el.value));
      return label ? h('div', { class: 'field' }, h('label', { for: el.id }, label), el) : el;
    };
    const iconBtn = (label, onClick, k) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, 'data-k': k, onClick }, icon('x', 14));

    /**
     * Valeur à écrire dans une colonne : contrôle adapté au type (listes fermées pour options, cases, dates et personnes).
     * @param {string} k @param {any} p @param {any} value @param {(v: any) => void} set
     */
    function valueEditor(k, p, value, set) {
      const name = `Valeur de ${p.name}`;
      const dyn = value && typeof value === 'object' && !Array.isArray(value) && 'dynamic' in value ? value.dynamic : null;
      switch (p.type) {
        case 'checkbox': return select(k, name, value === true ? 'true' : '', [['true', 'Cochée'], ['', 'Non cochée']], (v) => set(v === 'true' ? true : null));
        case 'select': case 'status': return select(k, name, value ?? '', [['', 'Vide'], ...p.options.map((o) => [o.id, o.name])], (v) => set(v || null));
        case 'multi_select': {
          const chosen = new Set(Array.isArray(value) ? value : []);
          return h('fieldset', { class: 'au-fieldset' }, h('legend', null, name), p.options.length ? p.options.map((o, i) => {
            const cb = h('input', { type: 'checkbox', id: fid(`${k}-${i}`), 'data-k': `${k}-${i}` });
            cb.checked = chosen.has(o.id);
            cb.addEventListener('change', () => { if (cb.checked) chosen.add(o.id); else chosen.delete(o.id); set(chosen.size ? [...chosen] : null); });
            return h('label', { class: 'au-check', for: cb.id }, cb, o.name);
          }) : h('p', { class: 'muted' }, 'Aucune option dans cette colonne.'));
        }
        case 'number': return input(k, name, value ?? '', (v) => set(v === '' || !Number.isFinite(Number(v)) ? null : Number(v)), { type: 'number', step: 'any' });
        case 'date': case 'date_range': {
          const mode = dyn === 'today' ? 'today' : value ? 'fixed' : 'empty';
          const range = p.type === 'date_range';
          const today = new Date().toISOString().slice(0, 10);
          // Plage : début et fin modifiés séparément, à partir de la valeur courante (pas de celle du dernier rendu).
          let cur = mode === 'fixed' ? value : null;
          const setRange = (start, end) => { cur = start ? { start, end: end || null } : null; set(cur); };
          return h('div', { class: 'au-inline' },
            select(`${k}-mode`, name, mode, [['today', 'Date du jour'], ['fixed', range ? 'Plage choisie' : 'Date choisie'], ['empty', 'Vide']],
              (v) => { set(v === 'today' ? { dynamic: 'today' } : v === 'fixed' ? (range ? { start: today, end: null } : today) : null); redraw(); }),
            mode === 'fixed' && !range && input(`${k}-d`, 'Date', cur, (v) => set(v || null), { type: 'date' }),
            mode === 'fixed' && range && [
              input(`${k}-s`, 'Début', cur?.start ?? '', (v) => setRange(v, cur?.end), { type: 'date' }),
              input(`${k}-e`, 'Fin (facultative)', cur?.end ?? '', (v) => { if (cur?.start) setRange(cur.start, v); }, { type: 'date' })]);
        }
        case 'person': {
          const mode = dyn === 'actor' ? 'actor' : typeof value === 'string' ? 'fixed' : 'empty';
          return h('div', { class: 'au-inline' },
            select(`${k}-mode`, name, mode, [['actor', 'Personne qui déclenche'], ['fixed', 'Personne choisie'], ['empty', 'Vide']], (v) => { set(v === 'actor' ? { dynamic: 'actor' } : v === 'fixed' ? '' : null); redraw(); }),
            mode === 'fixed' && (value
              ? h('p', { class: 'au-chosen' }, h('span', null, names.get(value) ?? 'Personne déjà choisie'), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': `${k}-chg`, onClick: () => { set(''); redraw(); } }, 'Changer'))
              : searchPicker(`Choisir la personne (${p.name})`, searchPeople, (it) => { names.set(it.id, it.label); set(it.id); redraw(`${k}-chg`); })));
        }
        case 'page_link': {
          const mode = typeof value === 'string' ? 'fixed' : 'empty';
          return h('div', { class: 'au-inline' },
            select(`${k}-mode`, name, mode, [['fixed', 'Page choisie'], ['empty', 'Vide']], (v) => { set(v === 'fixed' ? '' : null); redraw(); }),
            mode === 'fixed' && (value
              ? h('p', { class: 'au-chosen' }, h('span', null, store.page(value)?.title || 'Page déjà choisie'), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': `${k}-chg`, onClick: () => { set(''); redraw(); } }, 'Changer'))
              : searchPicker(`Choisir la page (${p.name})`, searchPages, (it) => { set(it.id); redraw(`${k}-chg`); })));
        }
        default: {
          const max = p.type === 'email' ? '254' : p.type === 'phone' ? '30' : '2000';
          return input(k, name, typeof value === 'string' ? value : '', (v) => set(v.trim() ? v.trim() : null), { maxlength: max, type: p.type === 'url' ? 'url' : p.type === 'email' ? 'email' : p.type === 'phone' ? 'tel' : 'text' });
        }
      }
    }

    /** Filtres du déclencheur (5 au plus) : colonne, condition, valeur ; « aujourd'hui » pour une date. */
    function filtersEl(t) {
      const list = t.filters;
      return h('fieldset', { class: 'au-fieldset' }, h('legend', null, 'Seulement si (facultatif)'),
        list.length ? null : h('p', { class: 'muted' }, 'Aucun filtre : toutes les lignes concernées.'),
        list.map((f, i) => {
          const p = propById(f.propertyId) ?? properties[0];
          const ops = OPERATORS[opKind(p.type)];
          const k = `f${i}`;
          let valueEl = null;
          if (f.op !== 'empty' && f.op !== 'notempty') {
            if (p.type === 'checkbox') valueEl = select(`${k}-v`, 'Valeur', String(f.value === true), [['true', 'cochée'], ['false', 'non cochée']], (v) => { f.value = v === 'true'; });
            else if (['select', 'status', 'multi_select'].includes(p.type)) valueEl = select(`${k}-v`, 'Valeur', f.value ?? '', p.options.map((o) => [o.id, o.name]), (v) => { f.value = v; });
            else if (DATE_FILTER_TYPES.has(p.type)) {
              const today = f.value && typeof f.value === 'object';
              valueEl = h('div', { class: 'au-inline' },
                select(`${k}-dm`, 'Comparer à', today ? 'today' : 'fixed', [['today', 'aujourd’hui'], ['fixed', 'une date']], (v) => { f.value = v === 'today' ? { dynamic: 'today' } : ''; redraw(); }),
                !today && input(`${k}-v`, 'Date', f.value ?? '', (v) => { f.value = v; }, { type: 'date' }));
            } else valueEl = input(`${k}-v`, 'Valeur', f.value ?? '', (v) => { f.value = p.type === 'number' || p.type === 'rollup' ? (v === '' ? null : Number(v)) : v; }, { type: p.type === 'number' || p.type === 'rollup' ? 'number' : 'text', maxlength: '200', step: p.type === 'number' ? 'any' : null });
          }
          return h('div', { class: 'au-row', role: 'group', 'aria-label': `Filtre ${i + 1}` },
            select(`${k}-p`, 'Colonne', p.id, properties.map((x) => [x.id, x.name]), (v) => { const np = propById(v); list[i] = { propertyId: v, op: OPERATORS[opKind(np.type)][0][0], value: initialFilterValue(np) }; redraw(); }),
            select(`${k}-o`, 'Condition', f.op, ops, (v) => { f.op = v; redraw(); }),
            valueEl,
            iconBtn(`Retirer le filtre ${i + 1}`, () => { list.splice(i, 1); redraw('f-add'); }, `${k}-x`));
        }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': 'f-add', disabled: list.length >= L.filters, onClick: () => { const p = properties[0]; list.push({ propertyId: p.id, op: OPERATORS[opKind(p.type)][0][0], value: initialFilterValue(p) }); redraw(`f${list.length - 1}-p`); } },
          icon('plus', 14), 'Ajouter un filtre'));
    }
    const initialFilterValue = (p) => (['select', 'status', 'multi_select'].includes(p.type) ? p.options[0]?.id ?? null : p.type === 'checkbox' ? true : DATE_FILTER_TYPES.has(p.type) ? { dynamic: 'today' } : '');

    function triggerEl() {
      const t = draft.trigger;
      const hours = Array.from({ length: 24 }, (_, i) => [String(i), `${i} h`]);
      return h('fieldset', { class: 'au-fieldset' }, h('legend', null, 'Déclencheur'),
        select('t-type', 'Quand', t.type, Object.entries(TRIGGERS), (v) => { draft.trigger = defaultTrigger(v); redraw(); }),
        t.type === 'property_changed' && (watchable.length
          ? select('t-prop', 'Colonne surveillée', t.propertyId, watchable.map((p) => [p.id, p.name]), (v) => { t.propertyId = v; })
          : h('p', { class: 'notice warning' }, 'Aucune colonne modifiable à surveiller.')),
        t.type === 'recurrence' && h('div', { class: 'au-row' },
          select('t-every', 'Fréquence', t.every, Object.entries(EVERY), (v) => { t.every = v; redraw(); }),
          t.every === 'week' && select('t-wd', 'Jour', String(t.weekday), WEEKDAYS.map((d, i) => [String(i), d]), (v) => { t.weekday = Number(v); }),
          t.every === 'month' && select('t-day', 'Jour du mois', String(t.day), Array.from({ length: 28 }, (_, i) => [String(i + 1), String(i + 1)]), (v) => { t.day = Number(v); }),
          t.every !== 'hour' && select('t-hour', 'Heure', String(t.hour), hours, (v) => { t.hour = Number(v); }),
          select('t-tz', 'Fuseau horaire', t.timeZone, timeZones().map((z) => [z, z]), (v) => { t.timeZone = v; })),
        t.type === 'button' && input('t-label', 'Libellé du bouton', t.label, (v) => { t.label = v; }, { maxlength: '40', required: true }),
        t.type === 'button' && h('p', { class: 'muted' }, 'Le bouton s’affiche sur chaque ligne pour les personnes qui peuvent modifier la base ; il agit avec leurs droits.'),
        t.type === 'recurrence' && h('p', { class: 'muted' }, 'À chaque échéance, « Modifier une propriété » s’applique aux lignes qui passent les filtres. Une échéance manquée (serveur arrêté) n’est pas rattrapée.'),
        t.type !== 'button' && filtersEl(t));
    }

    function addRowValues(a, k) {
      const target = a.baseId ?? baseId;
      const tprops = targetProps.get(target);
      if (!tprops) {
        api.get(`/bases/${target}`).then((d) => { targetProps.set(target, d.properties); redraw(); }, (err) => { fail(err); });
        return h('p', { class: 'muted' }, 'Chargement des colonnes…');
      }
      const cols = tprops.filter((p) => WRITABLE.has(p.type));
      const used = Object.keys(a.values);
      return h('fieldset', { class: 'au-fieldset' }, h('legend', null, 'Valeurs de la nouvelle ligne'),
        used.length ? null : h('p', { class: 'muted' }, 'Ligne vide.'),
        used.map((pid, j) => {
          const p = tprops.find((x) => x.id === pid);
          if (!p) return null;
          return h('div', { class: 'au-row', role: 'group', 'aria-label': `Valeur ${j + 1}` },
            select(`${k}-c${j}`, 'Colonne', pid, cols.filter((c) => c.id === pid || !used.includes(c.id)).map((c) => [c.id, c.name]), (v) => {
              const next = {};
              for (const [key, val] of Object.entries(a.values)) next[key === pid ? v : key] = key === pid ? defaultValue(tprops.find((x) => x.id === v)) : val;
              a.values = next;
              redraw();
            }),
            valueEditor(`${k}-v${j}`, p, a.values[pid], (v) => { a.values[pid] = v; }),
            iconBtn(`Retirer la valeur ${j + 1}`, () => { delete a.values[pid]; redraw(`${k}-add`); }, `${k}-x${j}`));
        }),
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': `${k}-add`, disabled: used.length >= cols.length,
          onClick: () => { const c = cols.find((x) => !used.includes(x.id)); if (c) { a.values[c.id] = defaultValue(c); redraw(`${k}-c${used.length}`); } },
        }, icon('plus', 14), 'Ajouter une valeur'));
    }

    function actionEl(a, i) {
      const k = `a${i}`;
      const types = Object.entries(ACTIONS).map(([v, l]) => [v, v === 'webhook' && !webhookOk && a.type !== 'webhook' ? `${l} (désactivé par l’administrateur)` : l, v === 'webhook' && !webhookOk && a.type !== 'webhook']);
      let bodyEl;
      if (a.type === 'set_property') {
        const p = propById(a.propertyId);
        bodyEl = writable.length
          ? [select(`${k}-p`, 'Colonne', a.propertyId, writable.map((x) => [x.id, x.name]), (v) => { a.propertyId = v; a.value = defaultValue(propById(v)); redraw(); }),
            p && valueEditor(`${k}-v`, p, a.value, (v) => { a.value = v; })]
          : h('p', { class: 'notice warning' }, 'Aucune colonne modifiable dans cette base.');
      } else if (a.type === 'add_row') {
        bodyEl = [
          select(`${k}-b`, 'Base', a.baseId ?? baseId, [[baseId, `${title || 'Sans titre'} (cette base)`], ...bases.map((b) => [b.id, b.title || 'Sans titre'])], (v) => { a.baseId = v; a.values = {}; redraw(); }),
          addRowValues(a, k)];
      } else if (a.type === 'notify') {
        const chosen = a.userIds;
        bodyEl = [
          h('fieldset', { class: 'au-fieldset' }, h('legend', null, 'Personnes'),
            chosen.length ? h('ul', { class: 'au-chips', 'aria-label': 'Personnes notifiées' }, chosen.map((u, j) => h('li', { class: 'au-chip' }, names.get(u) ?? 'Personne',
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Retirer ${names.get(u) ?? 'la personne'}`, 'data-k': `${k}-u${j}`, onClick: () => { chosen.splice(j, 1); redraw(`${k}-q`); } }, icon('x', 12)))))
              : h('p', { class: 'muted' }, 'Aucune personne choisie.'),
            chosen.length < L.recipients && searchPicker('Ajouter une personne', searchPeople, (it) => { if (!chosen.includes(it.id)) { names.set(it.id, it.label); chosen.push(it.id); } redraw(); })),
          people.length > 0 && select(`${k}-p`, 'Et les personnes de la colonne', a.propertyId ?? '', [['', 'Aucune'], ...people.map((p) => [p.id, p.name])], (v) => { a.propertyId = v || undefined; }),
          h('p', { class: 'muted' }, 'Seules les personnes qui peuvent lire la base reçoivent la notification ; elle ne contient pas le contenu de la ligne.')];
      } else {
        bodyEl = [
          input(`${k}-url`, 'Adresse du webhook', a.url, (v) => { a.url = v; }, { type: 'url', maxlength: '500', placeholder: 'https://…', inputmode: 'url', spellcheck: 'false', autocomplete: 'off' }),
          h('p', { class: 'muted' }, keptOrigin ? `Adresse enregistrée sur ${keptOrigin}. Laissez vide pour la garder.` : 'HTTPS conseillé ; les adresses internes sont refusées. L’envoi est signé et ne contient que des identifiants. Le secret de signature est montré une seule fois.'),
          !webhookOk && h('p', { class: 'notice warning' }, 'Les webhooks d’automatisation sont désactivés par l’administrateur, ou la base est dans un espace personnel : l’enregistrement sera refusé.')];
      }
      return h('fieldset', { class: 'au-fieldset au-action' }, h('legend', null, `Action ${i + 1}`),
        h('div', { class: 'au-row' },
          select(`${k}-t`, 'Type d’action', a.type, types, (v) => { draft.actions[i] = defaultAction(v); redraw(); }),
          draft.actions.length > 1 && h('button', { class: 'btn btn-ghost btn-sm danger', type: 'button', 'data-k': `${k}-rm`, onClick: () => { draft.actions.splice(i, 1); redraw('a-add'); } }, icon('trash', 14), `Retirer l’action ${i + 1}`)),
        bodyEl);
    }

    function redraw(focusKey) {
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      const key = focusKey ?? (active && form.contains(active) ? active.getAttribute('data-k') : null);
      put(form,
        h('div', { class: 'row wrap au-head' },
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': 'back', onClick: () => showList(existing ? `au-item-${existing.id}` : null) }, 'Retour à la liste'),
          h('h3', { class: 'au-title', id: `au-form-title-${uid}` }, existing ? `Modifier « ${existing.name} »` : 'Nouvelle automatisation')),
        errorEl,
        input('name', 'Nom', draft.name, (v) => { draft.name = v; }, { maxlength: '80', required: true }),
        triggerEl(),
        draft.actions.map(actionEl),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': 'a-add', disabled: draft.actions.length >= L.actions, onClick: () => { draft.actions.push(defaultAction('set_property')); redraw(`a${draft.actions.length - 1}-t`); } },
          icon('plus', 14), `Ajouter une action (${draft.actions.length} sur ${L.actions})`),
        existing && draft.trigger.type !== 'button' && h('p', { class: 'muted' }, 'En enregistrant, vous devenez l’auteur : l’automatisation agira avec vos droits.'),
        h('div', { class: 'row wrap au-foot' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-k': 'save' }, existing ? 'Enregistrer' : 'Créer'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => showList(existing ? `au-item-${existing.id}` : null) }, 'Annuler')));
      const el = key && /** @type {HTMLElement | null} */ (form.querySelector(`[data-k="${CSS.escape(key)}"]`));
      if (el && !(/** @type {any} */ (el).disabled)) el.focus();
      else if (key) /** @type {HTMLElement | null} */ (form.querySelector('[data-k="name"]'))?.focus();
    }

    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; errorEl.focus(); };

    /** Charge utile au format de l'API ; null et un message si un champ manque. */
    function payload() {
      const t = draft.trigger;
      const name = draft.name.trim();
      if (!name) return { error: 'Donnez un nom à l’automatisation.' };
      const filters = (list) => list.map((f) => (f.op === 'empty' || f.op === 'notempty' ? { propertyId: f.propertyId, op: f.op } : { propertyId: f.propertyId, op: f.op, value: f.value === '' ? null : f.value ?? null }));
      let trigger;
      if (t.type === 'button') {
        if (!t.label.trim()) return { error: 'Donnez un libellé au bouton.' };
        trigger = { type: 'button', label: t.label.trim() };
      } else if (t.type === 'property_changed') {
        if (!t.propertyId) return { error: 'Choisissez la colonne surveillée.' };
        trigger = { type: t.type, propertyId: t.propertyId, filters: filters(t.filters) };
      } else if (t.type === 'recurrence') trigger = { type: t.type, every: t.every, hour: t.hour, weekday: t.weekday, day: t.day, timeZone: t.timeZone, filters: filters(t.filters) };
      else trigger = { type: 'row_added', filters: filters(t.filters) };
      const actions = [];
      for (const [i, a] of draft.actions.entries()) {
        const at = `Action ${i + 1} : `;
        if (a.type === 'set_property') {
          if (!a.propertyId) return { error: `${at}choisissez une colonne.` };
          if (a.value === '') return { error: `${at}choisissez une valeur.` };
          actions.push({ type: a.type, propertyId: a.propertyId, value: a.value ?? null });
        } else if (a.type === 'add_row') {
          const values = {};
          for (const [key, v] of Object.entries(a.values)) { if (v === '') return { error: `${at}choisissez chaque valeur.` }; values[key] = v ?? null; }
          actions.push({ type: a.type, ...(a.baseId && a.baseId !== baseId ? { baseId: a.baseId } : {}), values });
        } else if (a.type === 'notify') {
          if (!a.userIds.length && !a.propertyId) return { error: `${at}choisissez au moins une personne ou une colonne Personne.` };
          actions.push({ type: a.type, userIds: [...a.userIds], ...(a.propertyId ? { propertyId: a.propertyId } : {}) });
        } else {
          const url = (a.url ?? '').trim();
          if (!url && !keptOrigin) return { error: `${at}indiquez l’adresse du webhook.` };
          actions.push(url ? { type: 'webhook', url } : { type: 'webhook' });
        }
      }
      return { body: { name, trigger, actions } };
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = payload();
      if (r.error) { showError(r.error); return; }
      const save = /** @type {HTMLButtonElement} */ (form.querySelector('[data-k="save"]'));
      save.disabled = true;
      try {
        const res = existing ? await api.patch(`/bases/${baseId}/automations/${existing.id}`, r.body) : await api.post(`/bases/${baseId}/automations`, r.body);
        changed = true;
        if (res?.webhookSecret) secret = { name: res.name, value: res.webhookSecret };
        toast(existing ? 'Automatisation enregistrée' : 'Automatisation créée');
        await refresh();
        showList(`au-item-${res.id}`);
      } catch (err) {
        save.disabled = false;
        showError(err?.message || 'Une erreur est survenue');
      }
    });
    redraw('name');
    put(host, form);
    /** @type {HTMLElement | null} */ (form.querySelector('[data-k="name"]'))?.focus();
  }

  put(host, h('p', { class: 'muted' }, 'Chargement…'));
  refresh().then((ok) => { if (ok) showList(); });
}
