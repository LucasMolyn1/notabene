// Composants communs aux sections des paramètres.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { toast } from '../ui.js';

export const card = (title, desc, ...body) => h('section', { class: 'set-card' },
  (title || desc) && h('header', { class: 'set-card-head' }, title && h('h3', null, title), desc && h('p', { class: 'muted' }, desc)),
  ...body);

export const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));

export const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);

export const status = (ok, onText = 'Actif', offText = 'Inactif') => pill(ok ? onText : offText, ok ? 'ok' : 'off');

export function copyable(value) {
  return h('span', { class: 'copyable' }, h('code', null, value),
    h('button', { class: 'mini-btn', title: 'Copier', onClick: () => navigator.clipboard.writeText(value).then(() => toast('Copié')) }, icon('copy', 14)));
}

export function toggle(label, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch-input' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('strong', null, label), desc && h('small', null, desc)), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
}

export const loadingEl = () => h('p', { class: 'muted' }, 'Chargement…');
