// Bandeau « Lecture seule » d'une page ou d'une base : dit en mots simples ce que la personne peut faire et à qui demander.
// Affiché seulement quand la personne n'a pas le droit de modifier (pas en mode Lecture choisi, pas dans une intégration).
// Le nom de la dernière personne à avoir modifié vient des données déjà chargées : aucune requête de plus. Texte seulement.
import { h } from './util.js';
import { icon } from './icons.js';
import { session } from './session.js';

/**
 * @param {{ kind: 'page' | 'base', lastEditor?: string | null }} o
 * @returns {HTMLElement}
 */
export function readOnlyNotice({ kind, lastEditor }) {
  const name = typeof lastEditor === 'string' && lastEditor.trim() && lastEditor !== session.user?.name ? lastEditor.trim() : null;
  const what = kind === 'base'
    ? 'Vous pouvez consulter ce tableau, le trier et le filtrer pour vous, mais pas le modifier.'
    : 'Vous pouvez lire cette page et y chercher, mais pas la modifier.';
  const who = name
    ? `Pour ${kind === 'base' ? 'le' : 'la'} modifier, demandez à ${name}, qui ${kind === 'base' ? 'l’a modifié' : 'l’a modifiée'} en dernier, ou à un administrateur.`
    : `Pour ${kind === 'base' ? 'le' : 'la'} modifier, demandez à son auteur ou à un administrateur.`;
  return h('div', { class: 'ro-notice', role: 'note' },
    h('span', { class: 'ro-badge' }, icon('lock', 13), 'Lecture seule'),
    h('p', { class: 'ro-text' }, `${what} ${who}`));
}
