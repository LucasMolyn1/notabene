// Panneau d'explication d'un nœud : à quoi sert son type, ses paramètres modifiables, ses connexions, suppression.
// Générique : le contenu vient du registre de types (`describe(node, graph)` et `fields(node, graph)`, voir kinds.js) ; le
// canevas fournit seulement les actions. Tout est écrit par textContent (aucun innerHTML).
import { h } from '../util.js';
import { icon } from '../icons.js';

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const short = (s, n = 40) => { const t = oneLine(s) || 'sans titre'; return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
let seq = 0;

/**
 * @param {{ kinds: any, portLabels: Record<string, string>, isEditable: () => boolean,
 *   onField: (id: string, name: string, value: string) => void, onGoto: (id: string) => void, onDelete: (id: string) => void,
 *   onClose: () => void, renderFields?: (node: any, def: any, host: HTMLElement) => void }} o
 */
export function createInspector({ kinds, portLabels, isEditable, onField, onGoto, onDelete, onClose, renderFields }) {
  const uid = ++seq;
  const title = h('h3', { class: 'wf-panel-title', tabindex: '-1', id: `wf-panel-title-${uid}` });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer le panneau', title: 'Fermer le panneau (Échap)', onClick: onClose }, icon('x', 14));
  const body = h('div', { class: 'wf-panel-body' });
  const el = h('aside', { class: 'wf-panel', 'aria-labelledby': `wf-panel-title-${uid}`, hidden: true }, h('div', { class: 'wf-panel-head' }, title, closeBtn), body);
  let current = null; // identifiant du nœud affiché
  let signature = '';

  const portName = (p) => portLabels[p] ?? p;

  /** Contrôle d'un champ ; la valeur est enregistrée à la validation (Entrée, changement de liste, sortie du champ). */
  function control(node, f) {
    const id = `wf-f-${uid}-${f.name}`;
    let ctl;
    if (f.type === 'select') {
      ctl = h('select', { class: 'input', id, 'data-field': f.name }, f.options.map(([v, l]) => h('option', { value: v }, l)));
      ctl.value = f.value ?? '';
      ctl.addEventListener('change', () => onField(node.id, f.name, ctl.value));
    } else {
      ctl = f.type === 'textarea'
        ? h('textarea', { class: 'input wf-panel-text', id, rows: '3', 'data-field': f.name, spellcheck: 'false' })
        : h('input', { class: 'input', id, type: 'text', 'data-field': f.name, spellcheck: 'false' });
      if (f.maxlength) ctl.setAttribute('maxlength', String(f.maxlength));
      ctl.value = f.value ?? '';
      let saved = ctl.value;
      const commit = () => { if (ctl.value !== saved) { saved = ctl.value; onField(node.id, f.name, ctl.value); } };
      ctl.addEventListener('change', commit);
      ctl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !(f.type === 'textarea' && e.shiftKey)) { e.preventDefault(); commit(); }
      });
    }
    const wrap = h('div', { class: 'field' }, h('label', { for: id }, f.label), ctl);
    if (f.hint) { const hint = h('small', { class: 'muted', id: `${id}-hint` }); hint.textContent = f.hint; ctl.setAttribute('aria-describedby', hint.id); wrap.append(hint); }
    return wrap;
  }

  function fieldsSection(node, def, g) {
    const host = h('div', { class: 'wf-panel-fields' });
    if (renderFields) { renderFields(node, def, host); return host; }
    const list = def.fields?.(node, g) ?? [];
    if (!list.length) return null;
    if (isEditable()) { host.append(...list.map((f) => control(node, f))); return host; }
    // Lecture seule : les valeurs sont affichées, sans contrôle de modification.
    const dl = h('dl', { class: 'wf-panel-values' });
    for (const f of list) {
      const dt = h('dt'); dt.textContent = f.label;
      const dd = h('dd');
      dd.textContent = f.type === 'select' ? (f.options.find(([v]) => v === (f.value ?? ''))?.[1] ?? '') : (f.value || 'Vide');
      dl.append(dt, dd);
    }
    host.append(dl);
    return host;
  }

  function link(label, id) {
    const b = h('button', { class: 'btn btn-ghost btn-sm wf-panel-link', type: 'button', 'data-goto': id, title: 'Aller à ce nœud' });
    b.textContent = label;
    b.addEventListener('click', () => onGoto(id));
    return h('li', null, b);
  }

  function connections(node, def, g) {
    if (!def.in && !def.out.length) return null;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const name = (n) => `${kinds[n.kind].label} : ${short(n.label)}`;
    const ins = g.edges.filter((e) => e.to === node.id && byId.has(e.from));
    const outs = g.edges.filter((e) => e.from === node.id && byId.has(e.to));
    const sec = h('section', { class: 'wf-panel-sec' }, h('h4', null, 'Connexions'));
    if (def.in) {
      sec.append(h('h5', null, 'Entrées'), ins.length ? h('ul', { class: 'wf-panel-list', 'aria-label': 'Entrées' }, ins.map((e) => {
        const from = byId.get(e.from);
        const multi = kinds[from.kind].out.length > 1;
        return link(`Depuis ${name(from)}${multi ? ` (${e.label ?? portName(e.port)})` : ''}`, from.id);
      })) : h('p', { class: 'muted' }, 'Aucune entrée reliée.'));
    }
    if (def.out.length) {
      sec.append(h('h5', null, 'Sorties'), outs.length ? h('ul', { class: 'wf-panel-list', 'aria-label': 'Sorties' }, outs.map((e) => {
        const to = byId.get(e.to);
        const text = e.label ?? (def.out.length > 1 ? portName(e.port) : '');
        return link(`${text ? `${text} vers ` : 'Vers '}${name(to)}`, to.id);
      })) : h('p', { class: 'muted' }, 'Aucune sortie reliée.'));
    }
    return sec;
  }

  const sigOf = (node, def, g) => JSON.stringify([
    node.id, node.kind, isEditable(),
    g.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => [e.id, e.from, e.to, e.port, e.label, g.nodes.find((n) => n.id === (e.from === node.id ? e.to : e.from))?.label]),
    renderFields ? null : (def.fields?.(node, g) ?? []).map((f) => [f.name, f.type, f.options?.length ?? 0]),
  ]);

  /** Champ de la zone actuellement actif (pour le retrouver après une reconstruction). */
  const activeField = () => { const a = document.activeElement; return a && body.contains(a) ? a.getAttribute('data-field') || a.getAttribute('data-goto') : null; };

  function build(node, g) {
    const def = kinds[node.kind];
    const focusKey = activeField();
    title.textContent = `${def.label} : ${short(node.label, 60)}`;
    const desc = h('p', { class: 'wf-panel-desc' });
    desc.textContent = def.describe?.(node, g) ?? '';
    const fields = fieldsSection(node, def, g);
    body.replaceChildren(
      h('p', { class: 'wf-panel-kind' }, icon(def.icon || 'file', 14), def.label),
      desc,
      fields && h('section', { class: 'wf-panel-sec' }, h('h4', null, 'Paramètres'), fields),
      connections(node, def, g),
      isEditable() && h('div', { class: 'wf-panel-foot' }, h('button', {
        class: 'btn btn-ghost btn-sm danger', type: 'button', 'data-field': 'delete', onClick: () => onDelete(node.id),
      }, icon('trash', 14), 'Supprimer ce nœud')));
    if (focusKey) { const t = body.querySelector(`[data-field="${CSS.escape(focusKey)}"], [data-goto="${CSS.escape(focusKey)}"]`); if (t instanceof HTMLElement) t.focus({ preventScroll: true }); }
  }

  /** Affiche le nœud ; renvoie vrai si le panneau vient d'apparaître. */
  function show(node, g) {
    const def = kinds[node.kind];
    const wasHidden = el.hidden;
    el.hidden = false;
    const sig = sigOf(node, def, g);
    if (sig !== signature || current !== node.id) {
      current = node.id;
      signature = sig;
      build(node, g);
    } else {
      // Même structure : seules les valeurs sont remises à jour (sauf le champ en cours de saisie).
      title.textContent = `${def.label} : ${short(node.label, 60)}`;
      if (!renderFields && isEditable()) {
        for (const f of def.fields?.(node, g) ?? []) {
          const ctl = body.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
          if (ctl instanceof HTMLInputElement || ctl instanceof HTMLTextAreaElement || ctl instanceof HTMLSelectElement) if (document.activeElement !== ctl) ctl.value = f.value ?? '';
        }
      }
    }
    return wasHidden;
  }

  function hide() { el.hidden = true; current = null; signature = ''; }

  return {
    el, show, hide,
    get nodeId() { return current; },
    contains: (n) => el.contains(n),
    /** Premier contrôle de modification (ou le titre en lecture seule) reçoit le focus. */
    focusFirst() { (body.querySelector('[data-field]:not([data-field="delete"])') ?? title).focus({ preventScroll: true }); },
    /** Annule une saisie non validée (Échap) : la valeur du nœud est remise dans le champ actif. */
    revertActive(node, g) {
      const a = document.activeElement;
      if (!a || !body.contains(a) || !(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) return;
      const f = (kinds[node.kind].fields?.(node, g) ?? []).find((x) => x.name === a.getAttribute('data-field'));
      if (f) a.value = f.value ?? '';
    },
  };
}
