// Remplissage borné d'une page de résultats filtrés après lecture (droits relus au moment de la requête).
// Une page devenue restreinte n'est connue qu'après lecture : on relit la source par lots jusqu'à avoir assez d'éléments
// lisibles, sans jamais dépasser un nombre de tours ni un nombre de lignes lues. Les lignes écartées ne sortent jamais
// de cette fonction : seule la position de lecture est rendue, pour reprendre plus loin.

export const FILL_MAX_ROUNDS = 10;
export const FILL_MAX_ROWS = 2000;

export interface FillOptions<R, S> {
  /** Nombre d'éléments lisibles voulus (la boucle s'arrête dès qu'il est atteint). */
  want: number;
  /** Taille d'un lot lu dans la source. */
  batch: number;
  /** Position de départ (null : début de la source). */
  start: S | null;
  /** Lecture d'un lot à partir d'une position, dans un ordre stable. */
  fetch: (from: S | null, n: number) => R[];
  /** Filtre des droits, appliqué à chaque lot. */
  keep: (rows: R[]) => R[];
  /** Position après un lot lu (curseur de clé ou décalage). */
  advance: (from: S | null, rows: R[]) => S;
  maxRounds?: number;
  maxRows?: number;
}

export interface FillResult<R, S> {
  /** Éléments lisibles, dans l'ordre de la source (au plus `want`). */
  items: R[];
  /** Position après la dernière ligne lue. */
  scanned: S | null;
  /**
   * La source peut contenir d'autres lignes après `scanned` : un lot complet a été lu et la boucle s'est arrêtée sur un
   * plafond (tours ou lignes), ou parce que `want` était atteint.
   */
  more: boolean;
}

export function fillReadable<R, S>(o: FillOptions<R, S>): FillResult<R, S> {
  const maxRounds = o.maxRounds ?? FILL_MAX_ROUNDS;
  const maxRows = o.maxRows ?? FILL_MAX_ROWS;
  const items: R[] = [];
  let pos = o.start;
  let read = 0;
  let more = false;
  for (let round = 0; round < maxRounds && read < maxRows; round++) {
    const n = Math.min(o.batch, maxRows - read);
    const rows = o.fetch(pos, n);
    read += rows.length;
    if (!rows.length) { more = false; break; }
    const kept = o.keep(rows);
    // Arrêt exact au besoin : la position reprend juste après le dernier élément gardé si la page est pleine.
    for (let i = 0; i < kept.length && items.length < o.want; i++) items.push(kept[i]!);
    pos = o.advance(pos, rows);
    more = rows.length === n;
    if (rows.length < n || items.length >= o.want) break;
  }
  return { items, scanned: pos, more };
}
