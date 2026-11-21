// Registre des types de nœuds du bloc « workflow » (copie de server/src/lib/workflow.ts, vérifiée par test/workflow.test.ts).
// `in` : le type a une prise d'entrée ; `out` : identifiants des prises de sortie. `shape`, `icon` et `defaultLabel` ne
// concernent que l'affichage. Le canevas (canvas.js) accepte un autre registre de même forme (automatisations, V2).

/** Couleurs nommées (server/src/lib/content.ts) : jamais une valeur CSS. */
export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

/** Plafonds communs avec le serveur. */
export const LIMITS = {
  nodes: 100, edges: 200, nodeLabel: 120, nodeLines: 3, edgeLabel: 60, graphChars: 100000, coord: 10000, grid: 20,
};

/** Noms français des couleurs (affichage seulement ; la valeur enregistrée reste le nom anglais de COLORS). */
export const COLOR_NAMES = { gray: 'Gris', red: 'Rouge', orange: 'Orange', yellow: 'Jaune', green: 'Vert', blue: 'Bleu', purple: 'Violet', pink: 'Rose' };

/** Champ « Libellé » commun (texte brut, 120 caractères au plus). */
/** @type {(node: any, opts?: { multiline?: boolean, hint?: string }) => any} */
export const labelField = (node, { multiline = true, hint = undefined } = {}) => ({
  name: 'label', label: 'Libellé', type: multiline ? 'textarea' : 'text', value: node.label ?? '', maxlength: LIMITS.nodeLabel, hint,
});
/** Champ « Couleur » commun : liste fermée de COLORS, jamais une valeur CSS. */
export const colorField = (node) => ({
  name: 'color', label: 'Couleur', type: 'select', value: node.color ?? '',
  options: [['', 'Aucune'], ...COLORS.map((c) => [c, COLOR_NAMES[c]])],
});

// `describe(node, graph)` : à quoi sert le type (texte français court) ; `fields(node, graph)` : paramètres modifiables du nœud,
// { name, label, type: 'text' | 'textarea' | 'select', value, options?, maxlength?, hint? }. Le canevas ne connaît que cette forme.
const HINT = 'Texte brut, 120 caractères et 3 lignes au plus.';
export const KINDS = {
  start: {
    label: 'Début', in: false, out: ['out'], shape: 'pill', icon: 'move', defaultLabel: 'Début',
    describe: () => 'Point de départ du processus : ce qui le met en route (une demande, un évènement). Il n’a pas d’entrée et une seule sortie, vers la première étape.',
    fields: (n) => [labelField(n, { hint: HINT }), colorField(n)],
  },
  step: {
    label: 'Étape', in: true, out: ['out'], shape: 'rect', icon: 'file', defaultLabel: 'Étape',
    describe: () => 'Une action à réaliser, par une personne ou un outil. Elle reçoit le flux d’un nœud précédent et le passe au suivant par sa sortie.',
    fields: (n) => [labelField(n, { hint: HINT }), colorField(n)],
  },
  decision: {
    label: 'Décision', in: true, out: ['yes', 'no'], shape: 'decision', icon: 'diamond', defaultLabel: 'Condition ?',
    describe: () => 'Une question dont la réponse oriente le processus : la sortie « Oui » et la sortie « Non » mènent chacune à une suite différente. Formulez le libellé comme une question.',
    fields: (n) => [labelField(n, { hint: `Une question, par exemple « Validée ? ». ${HINT}` }), colorField(n)],
  },
  end: {
    label: 'Fin', in: true, out: [], shape: 'pill', icon: 'check', defaultLabel: 'Fin',
    describe: () => 'Point d’arrivée du processus : le résultat obtenu. Il reçoit le flux et n’a pas de sortie. Un schéma peut avoir plusieurs fins.',
    fields: (n) => [labelField(n, { hint: HINT }), colorField(n)],
  },
  note: {
    label: 'Note', in: false, out: [], shape: 'note', icon: 'comment', defaultLabel: 'Note',
    describe: () => 'Un commentaire posé sur le schéma pour expliquer un point. Elle n’a ni entrée ni sortie et n’est jamais reliée aux autres nœuds.',
    fields: (n) => [labelField(n, { hint: HINT }), colorField(n)],
  },
};

/** Libellé par défaut d'un lien selon sa prise (quand le lien n'a pas de libellé propre). */
export const PORT_LABELS = { out: 'Suite', yes: 'Oui', no: 'Non' };
