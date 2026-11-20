// Registre des types de nœuds du bloc « workflow » (copie de server/src/lib/workflow.ts, vérifiée par test/workflow.test.ts).
// `in` : le type a une prise d'entrée ; `out` : identifiants des prises de sortie. `shape`, `icon` et `defaultLabel` ne
// concernent que l'affichage. Le canevas (canvas.js) accepte un autre registre de même forme (automatisations, V2).

/** Couleurs nommées (server/src/lib/content.ts) : jamais une valeur CSS. */
export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

/** Plafonds communs avec le serveur. */
export const LIMITS = {
  nodes: 100, edges: 200, nodeLabel: 120, nodeLines: 3, edgeLabel: 60, graphChars: 100000, coord: 10000, grid: 20,
};

export const KINDS = {
  start: { label: 'Début', in: false, out: ['out'], shape: 'pill', icon: 'move', defaultLabel: 'Début' },
  step: { label: 'Étape', in: true, out: ['out'], shape: 'rect', icon: 'file', defaultLabel: 'Étape' },
  decision: { label: 'Décision', in: true, out: ['yes', 'no'], shape: 'decision', icon: 'diamond', defaultLabel: 'Condition ?' },
  end: { label: 'Fin', in: true, out: [], shape: 'pill', icon: 'check', defaultLabel: 'Fin' },
  note: { label: 'Note', in: false, out: [], shape: 'note', icon: 'comment', defaultLabel: 'Note' },
};

/** Libellé par défaut d'un lien selon sa prise (quand le lien n'a pas de libellé propre). */
export const PORT_LABELS = { out: 'Suite', yes: 'Oui', no: 'Non' };
