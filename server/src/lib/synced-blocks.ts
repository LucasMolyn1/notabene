// Blocs synchronisés : une source (`syncedSource`, contenu édité dans sa page) et des copies (`syncedCopy`, identifiant seul)
// placées dans d'autres pages, qui en affichent le contenu en lecture seule.
// Règles de sécurité :
// - un identifiant ne désigne jamais qu'une page : la table `synced_blocks` le réserve à la première page qui l'enregistre, et
//   le garde réservé même quand la source est retirée de la page ou que la page est supprimée (sinon une autre page pourrait
//   reprendre l'identifiant et faire afficher son contenu par toutes les copies). Une page ne peut donc pas s'approprier un
//   identifiant déjà connu : refus 409 (API) ou nouvel identifiant (co-édition, copies de pages, modèles, imports) ;
// - le contenu d'une copie n'est jamais enregistré dans la page qui la contient (ni texte indexé) : il est lu à l'affichage,
//   seulement si le lecteur peut lire la page source dans ce contexte (compte, jeton, visiteur d'un partage) ;
// - une copie illisible, inconnue ou dont la source est à la corbeille est rendue comme un bloc neutre, sans rien révéler.
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import {
  type DocNode, isDroppedBySanitize, MAX_SYNCED_BLOCKS, NOT_BLOCK, stripCommentAnchors, SYNCED_BLOCK_ID, SYNCED_CONTAINERS, SYNCED_PARENTS, UNWRAP_PARENTS,
} from './content.js';
import { HttpError } from './http.js';

export { MAX_SYNCED_BLOCKS, SYNCED_BLOCK_ID } from './content.js';

/** Nouvel identifiant de bloc : 128 bits aléatoires, en base64url (22 caractères). */
export const newBlockId = () => randomBytes(16).toString('base64url');

/**
 * Refus d'une source dont l'identifiant appartient déjà à une autre page (ou figure deux fois dans la page). Message générique.
 * Risque accepté : ce 409 révèle qu'un identifiant est réservé. Il faut déjà connaître l'identifiant (128 bits aléatoires, donc
 * seulement par une copie qu'on a sous les yeux) et la réponse ne dit rien de la page, de son titre ni de son espace.
 */
export class SyncedBlockConflict extends HttpError {
  constructor() { super(409, 'Ce bloc synchronisé existe déjà : insérez-en une copie, ou créez un nouveau bloc'); }
}

/** Identifiants des sources du document, dans l'ordre du document (doublons compris). */
export function sourceIds(doc: DocNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'syncedSource' && typeof n.attrs?.blockId === 'string') out.push(n.attrs.blockId);
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

/** Document dont la i-ème source (ordre du document) reçoit `next[i]` comme identifiant, si `next[i]` n'est pas null. */
function renameSources(doc: DocNode, next: (string | null)[]): DocNode {
  let i = 0;
  const walk = (n: DocNode): DocNode => {
    let out = n;
    if (n.type === 'syncedSource') {
      const to = next[i++];
      if (to) out = { ...n, attrs: { ...n.attrs, blockId: to } };
    }
    return n.content ? { ...out, content: n.content.map(walk) } : out;
  };
  return walk(doc);
}

/**
 * Toutes les sources reçoivent un nouvel identifiant : pour une page produite à partir d'un autre contenu (création, duplication,
 * copie vers un espace, modèle, import). Elles deviennent des sources indépendantes ; les copies gardent leur identifiant.
 */
export function freshSources(doc: DocNode): DocNode {
  const ids = sourceIds(doc);
  return ids.length ? renameSources(doc, ids.map(() => newBlockId())) : doc;
}

/** Pour chaque source (ordre du document) : son identifiant est-il déjà pris ailleurs, ou répété dans la page ? */
function conflicts(db: DB, pageId: string, ids: string[]): boolean[] {
  const owner = db.prepare('SELECT page_id FROM synced_blocks WHERE block_id = ?');
  const seen = new Set<string>();
  return ids.map((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    const row = owner.get(id) as { page_id: string | null } | undefined;
    // Ligne sans page (page supprimée définitivement) : l'identifiant reste réservé, personne ne le reprend.
    return !!row && row.page_id !== pageId;
  });
}

/** Source renommée : la `nth`-ième occurrence (à partir de 0, ordre du document) de l'identifiant `from` reçoit `to`. */
export interface SourceRename { from: string; nth: number; to: string }

/**
 * Traitement d'un bloc synchronisé en co-édition : gardé (null), renommé, sorti de son enveloppe (source), retiré, ou vidé (copie
 * gardée qui porte un contenu dans l'état Yjs : le JSON l'ignore, l'état Yjs est aligné).
 */
export type CollabAction = null | { kind: 'rename'; to: string } | { kind: 'unwrap' } | { kind: 'remove' } | { kind: 'strip' };

/**
 * Co-édition : rend enregistrable, sans jamais échouer pour un bloc synchronisé, le document brut de l'état Yjs (yFragmentToJson,
 * AVANT assainissement : même arbre que l'état Yjs, donc même ordre de parcours). Déterministe, en lecture seule.
 * - Source en conflit (collée depuis une autre page, ou en double) : nouvel identifiant (`reuse` propose celui déjà donné à cette
 *   occurrence dans la salle ; il n'est repris que s'il est libre ou à cette page, et absent du document).
 * - Bloc mal placé (chaîne d'ancêtres hors SYNCED_CONTAINERS, dans une source ou une copie), identifiant invalide, source vide ou
 *   mal formée, au-delà de MAX_SYNCED_BLOCKS, au-delà de MAX_SYNCED_IDS_PER_PAGE identifiants, ou renommage au-delà de
 *   `renameBudget` : une source est sortie de son enveloppe (son contenu devient du contenu ordinaire), une copie est retirée.
 * `actions[k]` : traitement du k-ième bloc synchronisé dans l'ordre préfixe des éléments (le même dans l'état Yjs) ; `fresh` :
 * renommages nouveaux (non repris), à compter dans le plafond de la salle une fois l'enregistrement réussi.
 */
export function planCollabSynced(
  db: DB, pageId: string, raw: DocNode,
  opts: { reuse?: (from: string, nth: number) => string | undefined; renameBudget?: number } = {},
): { doc: DocNode; actions: CollabAction[]; renames: SourceRename[]; fresh: SourceRename[] } {
  const owner = db.prepare('SELECT page_id FROM synced_blocks WHERE block_id = ?');
  const known = new Set((db.prepare('SELECT block_id FROM synced_blocks WHERE page_id = ?').all(pageId) as { block_id: string }[]).map((r) => r.block_id));
  const ownedElsewhere = (id: string) => { const row = owner.get(id) as { page_id: string | null } | undefined; return !!row && row.page_id !== pageId; };
  const allIds = new Set<string>();
  const collect = (n: DocNode) => {
    if (n.type === 'syncedSource' && typeof n.attrs?.blockId === 'string') allIds.add(n.attrs.blockId);
    for (const c of n.content ?? []) collect(c);
  };
  collect(raw);
  const actions: CollabAction[] = [];
  const renames: SourceRename[] = [];
  const fresh: SourceRename[] = [];
  const keptIds = new Set<string>();
  const rank = new Map<string, number>();
  let kept = 0;
  let added = 0;
  let budget = opts.renameBudget ?? Infinity;
  // Nœuds que l'assainissement retirera (prédicat partagé, content.ts) : une source dont aucun bloc ne survit est sortie de son
  // enveloppe. `visible` : nœud que l'assainissement lira (ni dans un nœud retiré, ni dans une copie), pour compter comme lui.
  const dropped = new WeakSet<DocNode>();
  const dropState = { baseBlocks: 0 };

  // Renvoie les nœuds qui remplacent `n` dans son parent (lui-même, ses enfants s'il est sorti de son enveloppe, ou rien).
  const walk = (n: DocNode, parent: string, chain: boolean, visible: boolean): DocNode[] => {
    if (n.type === 'text') { if (isDroppedBySanitize(n, dropState)) dropped.add(n); return [n]; }
    const gone = visible && isDroppedBySanitize(n, dropState);
    const synced = n.type === 'syncedSource' || n.type === 'syncedCopy';
    const k = synced ? actions.push(null) - 1 : -1;
    const id = typeof n.attrs?.blockId === 'string' ? n.attrs.blockId : '';
    const nth = n.type === 'syncedSource' ? (rank.get(id) ?? 0) : 0;
    if (n.type === 'syncedSource') rank.set(id, nth + 1);
    const childChain = chain && (n.type === 'doc' || SYNCED_CONTAINERS.has(n.type));
    // Enfants que l'assainissement ne lira pas : dans un nœud retiré, une copie, ou une source qui sera retirée avec son contenu.
    const removedSource = n.type === 'syncedSource' && !UNWRAP_PARENTS.has(parent);
    const kids = (n.content ?? []).flatMap((c) => walk(c, n.type, childChain, visible && !gone && n.type !== 'syncedCopy' && !removedSource));
    // Comme yFragmentToJson : pas de clé `content` pour un élément vide (sinon le JSON différerait de l'état Yjs relu).
    const { content: _content, ...bare } = n;
    const self: DocNode = !n.content ? n : kids.length ? { ...n, content: kids } : bare;
    if (gone) dropped.add(self);
    if (!synced) return [self];
    const placed = chain && SYNCED_PARENTS.has(parent) && SYNCED_BLOCK_ID.test(id);
    if (n.type === 'syncedCopy') {
      if (!placed || kept >= MAX_SYNCED_BLOCKS) { actions[k] = { kind: 'remove' }; return []; }
      kept++;
      if (!n.content?.length) return [self];
      actions[k] = { kind: 'strip' };
      return [bare];
    }
    // Sortie de l'enveloppe seulement sous un parent qui accepte des blocs ; sous un parent à structure imposée (dépliable,
    // colonnes, titre de dépliable…) ou dans une copie, la source est retirée avec son contenu (comme sanitizeDoc en co-édition).
    const unwrap = () => {
      if (!UNWRAP_PARENTS.has(parent)) { actions[k] = { kind: 'remove' }; return []; }
      actions[k] = { kind: 'unwrap' };
      return kids;
    };
    const survivors = kids.filter((c) => !dropped.has(c));
    if (!placed || !survivors.length || survivors.some((c) => NOT_BLOCK.has(c.type)) || kept >= MAX_SYNCED_BLOCKS) return unwrap();
    let blockId = id;
    let freshRename = false;
    if (keptIds.has(id) || ownedElsewhere(id)) {
      const proposed = opts.reuse?.(id, nth);
      const reusable = !!proposed && SYNCED_BLOCK_ID.test(proposed) && !allIds.has(proposed) && !keptIds.has(proposed) && !ownedElsewhere(proposed);
      if (!reusable && budget <= 0) return unwrap();
      blockId = reusable ? proposed : newBlockId();
      freshRename = !reusable;
    }
    const isNew = !known.has(blockId);
    if (isNew && known.size + added + 1 > MAX_SYNCED_IDS_PER_PAGE) return unwrap();
    if (blockId !== id) {
      const r = { from: id, nth, to: blockId };
      renames.push(r);
      if (freshRename) { fresh.push(r); budget--; }
      actions[k] = { kind: 'rename', to: blockId };
    }
    if (isNew) added++;
    keptIds.add(blockId);
    allIds.add(blockId);
    kept++;
    return [blockId === id ? self : { ...self, attrs: { ...self.attrs, blockId } }];
  };
  const doc = walk(raw, '', true, true)[0] ?? { type: 'doc', content: [] };
  return { doc, actions, renames, fresh };
}

// Au plus 200 identifiants indexés par page (sources présentes et retirées). Les lignes retirées ne sont jamais purgées : purger
// rouvrirait le détournement d'un identifiant encore cité par une copie (dans une page, une version, un modèle), et savoir qu'aucune
// copie ne le cite demanderait de parcourir tout le contenu. Le plafond borne donc ce qu'une page peut réserver ; au-delà, une
// nouvelle source est refusée (400) jusqu'à ce qu'on réutilise une source existante.
export const MAX_SYNCED_IDS_PER_PAGE = 200;

/**
 * Tient l'index à jour pour le contenu enregistré de `pageId` (à appeler dans la transaction d'écriture de la page) : refus si une
 * source reprend un identifiant d'une autre page ; sources présentes inscrites ; sources retirées marquées (identifiant réservé).
 */
export function syncIndex(db: DB, pageId: string, spaceId: string, doc: DocNode): void {
  const ids = sourceIds(doc);
  if (conflicts(db, pageId, ids).some(Boolean)) throw new SyncedBlockConflict();
  const known = new Set((db.prepare('SELECT block_id FROM synced_blocks WHERE page_id = ?').all(pageId) as { block_id: string }[]).map((r) => r.block_id));
  const added = ids.filter((id) => !known.has(id)).length;
  if (added && known.size + added > MAX_SYNCED_IDS_PER_PAGE) {
    throw new HttpError(400, `Trop de blocs synchronisés créés sur cette page (${MAX_SYNCED_IDS_PER_PAGE} au plus, retirés compris)`);
  }
  const now = Date.now();
  // Le WHERE de la mise à jour interdit, en plus du contrôle ci-dessus, de déplacer un identifiant d'une page à une autre.
  const upsert = db.prepare(
    `INSERT INTO synced_blocks (block_id, page_id, space_id, created_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(block_id) DO UPDATE SET space_id = excluded.space_id, updated_at = excluded.updated_at, removed_at = NULL
     WHERE synced_blocks.page_id = excluded.page_id AND (synced_blocks.removed_at IS NOT NULL OR synced_blocks.space_id IS NOT excluded.space_id)`,
  );
  for (const id of ids) upsert.run(id, pageId, spaceId, now, now);
  db.prepare(
    `UPDATE synced_blocks SET removed_at = ?, updated_at = ? WHERE page_id = ? AND removed_at IS NULL
       AND block_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(now, now, pageId, JSON.stringify(ids));
}

/** Source `blockId` dans un document : la première trouvée. */
function findSource(n: DocNode, blockId: string): DocNode | null {
  if (n.type === 'syncedSource' && n.attrs?.blockId === blockId) return n;
  for (const c of n.content ?? []) { const r = findSource(c, blockId); if (r) return r; }
  return null;
}

/**
 * Lectures d'une même vue (rendu public, export) : pages déjà lues (une page n'est lue et analysée qu'une fois) et, pour les vues
 * anonymes, plafond du volume de contenu source lu (`budget`, en caractères JSON) ; au-delà, les copies restent neutres.
 */
export interface ReadContext { pages: Map<string, DocNode | null>; budget?: { left: number } }

/**
 * Contenu (blocs) de la source `blockId`, ou null : identifiant mal formé ou inconnu, source retirée, page à la corbeille ou
 * supprimée, ou page illisible selon `canRead`. La réponse est la même dans tous ces cas, et le contrôle de lecture est toujours
 * évalué (sur un identifiant qui ne désigne aucune page quand le bloc est inconnu). La durée n'est pas pour autant identique : une
 * page existante demande plus de requêtes (espace, restrictions héritées) qu'un bloc inconnu, et une source lisible est lue et
 * analysée. Écart de l'ordre de la milliseconde, qui n'apprend au mieux qu'un identifiant de 128 bits est indexé (comme le 409).
 * Sans ancre de commentaire.
 */
export function readSyncedSource(db: DB, blockId: string, canRead: (pageId: string) => boolean, ctx?: ReadContext): DocNode[] | null {
  const row = SYNCED_BLOCK_ID.test(blockId)
    ? db.prepare('SELECT page_id FROM synced_blocks WHERE block_id = ? AND removed_at IS NULL').get(blockId) as { page_id: string | null } | undefined
    : undefined;
  const pageId = row?.page_id ?? null;
  const allowed = canRead(pageId ?? blockId);
  if (!pageId || !allowed) return null;
  let doc = ctx?.pages.get(pageId);
  if (doc === undefined) {
    // Budget vérifié dans la requête : une page trop grosse n'est pas lue du tout.
    const max = ctx?.budget ? ctx.budget.left : Number.MAX_SAFE_INTEGER;
    const page = db.prepare("SELECT content, length(content) AS n FROM pages WHERE id = ? AND deleted_at IS NULL AND kind = 'doc' AND length(content) <= ?")
      .get(pageId, max) as { content: string; n: number } | undefined;
    doc = null;
    if (page) {
      if (ctx?.budget) ctx.budget.left -= page.n;
      try { doc = JSON.parse(page.content) as DocNode; } catch { doc = null; }
    }
    // Page absente, illisible ou hors budget : retenue comme telle pour le reste de la vue (aucune nouvelle lecture).
    ctx?.pages.set(pageId, doc);
  }
  if (!doc) return null;
  const source = findSource(doc, blockId);
  if (!source?.content?.length) return null;
  return source.content.map(stripCommentAnchors);
}

/**
 * Document où chaque copie porte le contenu de sa source quand `canRead` permet de lire la page source dans ce contexte (export,
 * rendu public), et reste sans contenu sinon (les rendus en font un bloc neutre). Le résultat n'est jamais enregistré.
 */
export function expandSyncedCopies(db: DB, doc: DocNode, canRead: (pageId: string) => boolean, opts: { maxSourceChars?: number } = {}): DocNode {
  const cache = new Map<string, DocNode[] | null>();
  const ctx: ReadContext = { pages: new Map(), ...(opts.maxSourceChars !== undefined ? { budget: { left: opts.maxSourceChars } } : {}) };
  const walk = (n: DocNode): DocNode => {
    if (n.type === 'syncedCopy') {
      const id = String(n.attrs?.blockId ?? '');
      if (!cache.has(id)) cache.set(id, readSyncedSource(db, id, canRead, ctx));
      const content = cache.get(id);
      return content ? { type: 'syncedCopy', attrs: { blockId: id }, content } : { type: 'syncedCopy', attrs: { blockId: id } };
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return walk(doc);
}

/**
 * Sources devenues vides (leurs seuls blocs retirés après l'assainissement, par exemple une pièce jointe illisible ou au quota
 * dépassé, retirée par le copieur) : retirées du document, pour qu'aucune source vide ne soit indexée ni enregistrée.
 */
export function dropEmptySources(doc: DocNode): DocNode {
  const walk = (n: DocNode): DocNode[] => {
    if (n.type === 'syncedSource' && !n.content?.length) return [];
    return n.content ? [{ ...n, content: n.content.flatMap(walk) }] : [n];
  };
  return walk(doc)[0] ?? doc;
}

/** L'index suit des pages déplacées vers un autre espace (une page et son sous-arbre). */
/**
 * Plafond du contenu source lu pour une vue anonyme (page partagée, rendu pour les moteurs de recherche) : au plus 20 copies par
 * page, mais chacune peut désigner une grosse page ; au-delà de ce volume, les copies restantes sont neutres. Pas de cache entre
 * requêtes : rien n'est partagé entre appelants qui n'ont pas les mêmes droits.
 */
export const MAX_ANONYMOUS_SOURCE_CHARS = 5_000_000;

export function moveIndexToSpace(db: DB, pageIds: string[], spaceId: string): void {
  db.prepare('UPDATE synced_blocks SET space_id = ? WHERE page_id IN (SELECT value FROM json_each(?))').run(spaceId, JSON.stringify(pageIds));
}
