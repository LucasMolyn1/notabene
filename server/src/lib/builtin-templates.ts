// Modèles fournis avec Notabene : du code, pas des données. Ils ne dépendent d'aucun espace et ne sont pas modifiables.
import type { DocNode } from './content.js';

const text = (t: string): DocNode => ({ type: 'text', text: t });
const p = (t = ''): DocNode => (t ? { type: 'paragraph', content: [text(t)] } : { type: 'paragraph' });
const h2 = (t: string): DocNode => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
const bullets = (...items: string[]): DocNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const tasks = (...items: string[]): DocNode => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const callout = (type: 'info' | 'warning' | 'success' | 'danger', t: string): DocNode => ({ type: 'callout', attrs: { type }, content: [p(t)] });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

export interface BuiltinTemplate { id: string; name: string; icon: string; description: string; content: DocNode }

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'builtin-compte-rendu', name: 'Compte rendu de réunion', icon: 'users', description: 'Participants, ordre du jour, décisions et actions.',
    content: doc(
      p('Date : · Participants : '),
      h2('Ordre du jour'), bullets('Premier point', 'Deuxième point'),
      h2('Décisions'), bullets('Décision prise'),
      h2('Actions'), tasks('Action à mener (qui, pour quand)'),
      h2('Notes'), p(),
    ),
  },
  {
    id: 'builtin-procedure', name: 'Procédure', icon: 'file', description: 'Objectif, prérequis, étapes et vérification.',
    content: doc(
      callout('info', 'Dites en une phrase à quoi sert cette procédure et qui doit la suivre.'),
      h2('Prérequis'), bullets('Accès nécessaires', 'Outils à installer'),
      h2('Étapes'), { type: 'orderedList', content: ['Première étape', 'Deuxième étape'].map((i) => ({ type: 'listItem', content: [p(i)] })) },
      h2('Vérification'), p('Comment savoir que tout a fonctionné ?'),
      h2('En cas de problème'), callout('warning', 'Qui prévenir, et comment revenir en arrière.'),
    ),
  },
  {
    id: 'builtin-post-mortem', name: 'Post-mortem d’incident', icon: 'shield', description: 'Chronologie, cause, impact et actions correctives, sans chercher de coupable.',
    content: doc(
      callout('info', 'Un post-mortem décrit ce qui s’est passé et comment l’éviter, pas qui a tort.'),
      h2('Résumé'), p(),
      h2('Impact'), bullets('Ce qui a été touché', 'Durée'),
      h2('Chronologie'), bullets('hh:mm : détection', 'hh:mm : résolution'),
      h2('Cause'), p(),
      h2('Ce qui a bien fonctionné'), bullets(),
      h2('Actions correctives'), tasks('Action (responsable, échéance)'),
    ),
  },
];

export const builtinTemplate = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id);
