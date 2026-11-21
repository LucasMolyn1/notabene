// Automatisations d'une base vues en schéma : Déclencheur, puis Filtres, puis Actions dans l'ordre (chaîne linéaire, comme le
// moteur). Réutilise le canevas générique de workflow/canvas.js avec un autre registre de types. Le client n'affiche que ce que
// le serveur rend et n'envoie que par les routes existantes (zod strict, droits et plafonds restent côté serveur) ; les positions
// ne sont pas enregistrées (rangement automatique de gauche à droite). Aucun HTML n'est inséré : textContent partout.
import { h } from './util.js';
import { icon } from './icons.js';
import { createCanvas } from './workflow/canvas.js';
import * as M from './workflow/model.js';

const RANK = { trigger: 0, filter: 1, action: 2 };
const PORTS = { out: 'Suite' };

/** Registre des types (même forme que workflow/kinds.js). Les nœuds sont figés (rangement automatique) et leur texte est calculé. */
export const AUTO_KINDS = {
  trigger: {
    label: 'Déclencheur', in: false, out: ['out'], shape: 'pill', icon: 'bell', defaultLabel: 'Déclencheur', labelEditable: false, movable: false,
    describe: () => 'Ce qui met l’automatisation en marche : une ligne ajoutée, une propriété modifiée, un intervalle régulier ou un bouton sur chaque ligne. Il n’y en a qu’un par automatisation.',
  },
  filter: {
    label: 'Filtre', in: true, out: ['out'], shape: 'decision', icon: 'layers', defaultLabel: 'Filtre', labelEditable: false, movable: false,
    describe: () => 'Une condition sur la ligne concernée : l’automatisation ne continue que si tous les filtres (ET) sont vrais. Les filtres se placent avant les actions ; un bouton de ligne n’en a pas.',
  },
  action: {
    label: 'Action', in: true, out: ['out'], shape: 'rect', icon: 'wand', defaultLabel: 'Action', labelEditable: false, movable: false,
    describe: () => 'Ce que fait l’automatisation : modifier une propriété, ajouter une ligne, notifier des personnes ou appeler un webhook. Les actions s’exécutent dans l’ordre des liens.',
  },
};

/** Graphe (nœuds et liens) d'une automatisation, et la configuration de chaque nœud (identifiant du nœud -> objet de formulaire). */
export function graphOf({ trigger, filters, actions }) {
  const cfgs = new Map();
  const nodes = [];
  const add = (id, kind, cfg) => { cfgs.set(id, cfg); nodes.push({ id, kind, label: '', x: 0, y: 0, color: null }); };
  add('t1', 'trigger', trigger);
  filters.forEach((f, i) => add(`f${i + 1}`, 'filter', f));
  actions.forEach((a, i) => add(`a${i + 1}`, 'action', a));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i + 1}`, from: nodes[i].id, port: 'out', to: n.id, label: null }));
  return { cfgs, graph: M.autoLayout({ v: 1, nodes, edges }, AUTO_KINDS) };
}

/** Maillons dans l'ordre des liens à partir du déclencheur (s'arrête au premier cycle). */
export function chainIds(graph) {
  const trig = graph.nodes.find((n) => n.kind === 'trigger');
  const order = [];
  const seen = new Set();
  let cur = trig?.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    cur = graph.edges.find((e) => e.from === cur)?.to;
  }
  return order;
}

/** Lit le schéma : { trigger, filters, actions } dans l'ordre, ou { error } si le schéma n'est pas une chaîne valide. */
export function readChain(graph, cfgs) {
  const triggers = graph.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length !== 1) return { error: triggers.length ? 'Une automatisation n’a qu’un seul déclencheur.' : 'Ajoutez un déclencheur.' };
  const order = chainIds(graph);
  if (order.length < graph.nodes.length) return { error: 'Reliez tous les nœuds en une seule chaîne à partir du déclencheur.' };
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  let rank = 0;
  for (const id of order) {
    const r = RANK[kindOf.get(id)];
    if (r < rank) return { error: 'Les filtres se placent avant les actions.' };
    rank = r;
  }
  const part = (kind) => order.filter((id) => kindOf.get(id) === kind).map((id) => cfgs.get(id));
  const trigger = cfgs.get(order[0]);
  const filters = part('filter');
  if (trigger.type === 'button' && filters.length) return { error: 'Un bouton de ligne n’a pas de filtre : retirez les filtres.' };
  const actions = part('action');
  if (!actions.length) return { error: 'Ajoutez au moins une action.' };
  return { trigger, filters, actions };
}

/**
 * Contraintes imposées au canevas : un seul déclencheur, chaîne linéaire (une entrée et une sortie par nœud, pas de boucle), filtres
 * avant les actions, plafonds du serveur. `triggerType()` donne le type du déclencheur courant (un bouton n'a pas de filtre).
 */
function constraintsFor({ limits, triggerType, onNewNode }) {
  const count = (g, kind) => g.nodes.filter((n) => n.kind === kind).length;
  const insert = (g, node) => {
    const rank = RANK[node.kind];
    const link = (graph, from, to) => M.connect(graph, AUTO_KINDS, from, 'out', to).graph ?? graph;
    if (node.kind === 'trigger') {
      const heads = g.nodes.filter((n) => n.id !== node.id && n.kind !== 'trigger' && !g.edges.some((e) => e.to === n.id));
      return heads.length === 1 ? link(g, node.id, heads[0].id) : g;
    }
    const others = { ...g, nodes: g.nodes.filter((n) => n.id !== node.id) };
    const order = chainIds(others);
    if (!order.length) return g;
    const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
    let at = 0;
    order.forEach((id, i) => { if (RANK[kindOf.get(id)] <= rank) at = i; });
    const prev = order[at];
    const next = order[at + 1];
    let out = g;
    if (next) out = M.removeEdge(out, g.edges.find((e) => e.from === prev && e.to === next).id);
    out = link(out, prev, node.id);
    return next ? link(out, node.id, next) : out;
  };
  return {
    canAdd(g, kind) {
      if (kind === 'trigger' && count(g, 'trigger') >= 1) return 'Une automatisation n’a qu’un seul déclencheur.';
      if (kind === 'filter' && triggerType() === 'button') return 'Un bouton de ligne n’a pas de filtre.';
      if (kind === 'filter' && count(g, 'filter') >= limits.filters) return `${limits.filters} filtres au plus.`;
      if (kind === 'action' && count(g, 'action') >= limits.actions) return `${limits.actions} actions au plus.`;
      return null;
    },
    canConnect(g, from, port, to) {
      const a = g.nodes.find((n) => n.id === from);
      const b = g.nodes.find((n) => n.id === to);
      if (!a || !b) return 'Nœud introuvable.';
      if (g.edges.some((e) => e.from === from)) return 'Ce nœud a déjà une suite : supprimez d’abord son lien.';
      if (g.edges.some((e) => e.to === to)) return 'Ce nœud a déjà une entrée : une automatisation est une chaîne, sans branche.';
      if (RANK[a.kind] > RANK[b.kind]) return 'Les filtres se placent avant les actions.';
      for (let cur = to, i = 0; cur && i < 100; i++) { // pas de boucle : la suite de `to` ne doit pas revenir à `from`
        if (cur === from) return 'Un lien ne peut pas boucler.';
        cur = g.edges.find((e) => e.from === cur)?.to;
      }
      return null;
    },
    afterAdd(g, node) {
      onNewNode(node);
      return M.autoLayout(insert(g, node), AUTO_KINDS);
    },
    afterRemove(after, removed, before) {
      const into = before.edges.find((e) => e.to === removed.id);
      const out = before.edges.find((e) => e.from === removed.id);
      const bridged = into && out ? (M.connect(after, AUTO_KINDS, into.from, 'out', out.to).graph ?? after) : after;
      return M.autoLayout(bridged, AUTO_KINDS);
    },
  };
}

/**
 * Éditeur en schéma d'une automatisation (nouvelle ou existante).
 * `kit` vient d'automations.js : formulaires existants réutilisés dans le panneau de configuration, résumés, validation de la charge.
 * @param {{ draft: { name: string, trigger: any, actions: any[] }, existing: any, editable: boolean, kit: any,
 *   loadRuns: () => Promise<any[]>, onSave: (body: any) => Promise<void>, onCancel: () => void }} o
 */
export function mountSchema({ draft, existing, editable, kit, loadRuns, onSave, onCancel }) {
  let dirty = false;
  let name = draft.name;
  let panelHost = null;
  let panelId = null;
  let stateShort = '';
  const { cfgs, graph: first } = graphOf({ trigger: draft.trigger, filters: draft.trigger.filters ?? [], actions: draft.actions });
  const triggerCfg = () => cfgs.get(chainRoot());
  const chainRoot = () => canvas.getGraph().nodes.find((n) => n.kind === 'trigger')?.id;

  const labelOf = (n) => M.cleanLabel(kit.summary[n.kind](cfgs.get(n.id)) || AUTO_KINDS[n.kind].label).replace(/\n/g, ' ');
  const withLabels = (g) => ({ ...g, nodes: g.nodes.map((n) => { const label = labelOf(n); return label === n.label ? n : { ...n, label }; }) });
  const markDirty = () => { dirty = true; };

  const constraints = constraintsFor({
    limits: kit.limits,
    triggerType: () => triggerCfg()?.type,
    onNewNode: (node) => cfgs.set(node.id, kit.defaults[node.kind]()),
  });
  const base = constraints.afterAdd;
  constraints.afterAdd = (g, node) => withLabels(base(g, node));
  const baseRemove = constraints.afterRemove;
  constraints.afterRemove = (after, removed, before) => withLabels(baseRemove(after, removed, before));

  function renderBody(node, def, body) {
    const kind = h('span', { class: 'wf-node-kind' }, icon(def.icon, 12), def.label);
    const text = h('span', { class: 'wf-node-label' });
    text.textContent = node.label || 'Sans titre';
    const state = node.kind === 'trigger' && stateShort ? h('span', { class: 'au-node-state' }) : null;
    if (state) state.textContent = stateShort;
    body.replaceChildren(...[kind, text, state].filter(Boolean));
  }

  // Panneau de configuration d'un nœud : les formulaires de la liste, sur l'objet de configuration du nœud.
  function paintHost(focusKey, initial = false) {
    if (!panelHost || !(initial || panelHost.isConnected)) return; // à la construction, l'hôte n'est pas encore dans la page
    const node = canvas.getGraph().nodes.find((n) => n.id === panelId);
    if (!node) return;
    const cfg = cfgs.get(node.id);
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const key = focusKey ?? (active && panelHost.contains(active) ? active.getAttribute('data-k') : null);
    let parts;
    if (!editable) parts = [h('p', { class: 'muted' }, node.label)];
    else if (node.kind === 'trigger') parts = kit.triggerFields(cfg, (next) => { cfgs.set(node.id, next); kit.repaint(); });
    else if (node.kind === 'filter') parts = kit.filterFields(cfg, `f-${node.id}`);
    else parts = kit.actionFields(cfg, `a-${node.id}`, (next) => { cfgs.set(node.id, next); kit.repaint(); });
    panelHost.replaceChildren(...parts.flat(Infinity).filter(Boolean));
    const el = key && /** @type {HTMLElement | null} */ (panelHost.querySelector(`[data-k="${CSS.escape(key)}"]`));
    if (el && !(/** @type {any} */ (el).disabled)) el.focus();
  }
  function fields(node, _def, host) {
    panelHost = host;
    panelId = node.id;
    host.addEventListener('input', () => { markDirty(); canvasRelabel(); });
    host.addEventListener('change', () => { markDirty(); canvasRelabel(); });
    paintHost(undefined, true);
  }
  const canvasRelabel = () => { const g = canvas.getGraph(); const next = withLabels(g); if (next.nodes.some((n, i) => n !== g.nodes[i])) canvas.setGraph(next); };
  kit.setRepaint((focusKey) => { markDirty(); canvasRelabel(); paintHost(focusKey); });

  const initial = withLabels(first);
  let lastShape = `${initial.nodes.length}|${initial.edges.length}`;
  const canvas = createCanvas({
    kinds: AUTO_KINDS,
    graph: initial,
    editable,
    constraints,
    portLabels: PORTS,
    label: 'Schéma de l’automatisation',
    edgeLabels: false,
    renderNodeBody: renderBody,
    renderFields: fields,
    onChange: () => {
      markDirty();
      updateCounts();
      const g = canvas.getGraph();
      const shape = `${g.nodes.length}|${g.edges.length}`;
      if (shape !== lastShape) { lastShape = shape; canvas.fit(); }
    },
  });
  canvas.el.style.setProperty('--wf-h', '300px');

  // Couleur des nœuds : état de l'automatisation, sinon dernier résultat du journal (codes fermés existants).
  function colorize(runs) {
    const color = kit.statusColor(existing, runs);
    stateShort = kit.stateShort(existing, runs);
    const g = canvas.getGraph();
    canvas.setGraph({ ...g, nodes: g.nodes.map((n) => ({ ...n, color })) });
    stateLine.textContent = kit.stateLine(existing, runs);
  }
  const stateLine = h('p', { class: 'muted au-legend' });

  const errorEl = h('p', { class: 'notice error', role: 'alert', tabindex: '-1', hidden: true });
  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; errorEl.focus(); };
  const counts = h('p', { class: 'muted au-legend' });
  const updateCounts = () => {
    const g = canvas.getGraph();
    const n = (k) => g.nodes.filter((x) => x.kind === k).length;
    counts.textContent = `Filtres : ${n('filter')} sur ${kit.limits.filters}. Actions : ${n('action')} sur ${kit.limits.actions}.`;
  };
  updateCounts();

  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-k': 'save' }, existing ? 'Enregistrer' : 'Créer');
  const form = h('form', { class: 'stack au-form au-schema', novalidate: true, 'aria-label': existing ? `Schéma de ${existing.name}` : 'Schéma de la nouvelle automatisation' },
    editable
      ? kit.input('name', 'Nom', name, (v) => { name = v; markDirty(); }, { maxlength: '80', required: true })
      : h('h3', { class: 'au-title' }, existing?.name ?? ''),
    errorEl,
    canvas.el,
    stateLine,
    counts,
    h('p', { class: 'muted au-legend' }, 'Un déclencheur, puis des filtres (tous vrais, « et »), puis des actions exécutées dans l’ordre des liens. Les positions ne sont pas enregistrées : le schéma se range automatiquement. Cliquez sur un nœud pour le configurer.'),
    editable && existing && draft.trigger.type !== 'button' && h('p', { class: 'muted' }, 'En enregistrant, vous devenez l’auteur : l’automatisation agira avec vos droits.'),
    editable && h('div', { class: 'row wrap au-foot' }, save, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: onCancel }, 'Annuler')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const r = readChain(canvas.getGraph(), cfgs);
    if (r.error) { showError(r.error); return; }
    const p = kit.payload({ name, trigger: { ...r.trigger, filters: r.filters }, actions: r.actions });
    if (p.error) { showError(p.error); return; }
    save.disabled = true;
    try { await onSave(p.body); dirty = false; } catch (err) { save.disabled = false; showError(err?.message || 'Une erreur est survenue'); }
  });

  if (existing) loadRuns().then(colorize, () => colorize([]));
  else colorize([]);

  return { el: form, isDirty: () => dirty };
}
