// Co-édition temps réel : une « salle » Yjs par page ouverte, protocole y-websocket (sync + awareness).
// L'état Yjs est persisté (page_ydocs) puis resynchronisé vers pages.content : recherche, export,
// versions et API REST continuent de fonctionner sur le JSON habituel (toujours assaini).
import { createHash } from 'node:crypto';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import type { DB } from '../db.js';
import type { AttachmentCloner } from './attachments.js';
import { sanitizeDoc } from './content.js';
import type { EventBus } from './events.js';
import { randomToken } from './crypto.js';
import { jsonToYFragment, jsonToYNodes, yChildrenToJson, yFragmentToJson } from './yjs-json.js';
import { getPageRow, type PageRow, recordSnapshotVersion, updatePage } from './pages.js';
import { type CollabAction, planCollabSynced } from './synced-blocks.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const MSG_EPOCH = 100; // extension : identifiant de génération de l'état (hors numéros réservés par y-websocket)
const FIELD = 'default';
const SAVE_DELAY = 2000;
const IDLE_CLOSE = 15_000;
const MAX_CONNS_PER_ROOM = 50;
// Garde-fou : au plus 20 sources synchronisées renommées par salle et par minute. Au-delà, les sources en conflit sont sorties de
// leur enveloppe (contenu ordinaire), avec un avertissement : un état forgé ne peut pas faire réserver des identifiants en boucle,
// et l'enregistrement de la page n'échoue jamais pour autant.
const MAX_SYNCED_RENAMES_PER_MINUTE = 20;
// Nouvel essai d'un enregistrement qui a échoué (l'état Yjs, lui, est toujours stocké).
// Délai doublé à chaque échec (30 s, 60 s, 120 s… jusqu'à 10 min), remis au départ après un succès.
const SAVE_RETRY_DELAY = 30_000;
const SAVE_RETRY_MAX = 10 * 60_000;

// Codes 4400-4499 : y-websocket ne se reconnecte pas (décision délibérée du serveur).
export const CLOSE = { RELOAD: 4409, GONE: 4404, FULL: 4429, DENIED: 4403 } as const;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Conn { userId: string; name: string; sessionHash: string | null; awarenessIds: Set<number> }

// Décide si une connexion déjà ouverte garde le droit d'écrire sur la page (session valide, compte actif, permissions).
export type Authorize = (conn: { userId: string; sessionHash: string | null }, pageId: string) => boolean;

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Conn>();
  epoch = '';
  contentHash = '';
  lastUser: string | null = null;
  /** Personnes ayant modifié le document depuis le dernier enregistrement. */
  editors = new Set<string>();
  dirty = false;
  /** Salle en cours de fermeture : aucun nouvel essai programmé, aucune modification ne la marque à enregistrer. */
  closing = false;
  /** État modifié depuis le dernier stockage dans page_ydocs. */
  unstored = false;
  /** Délai du prochain nouvel essai après un échec. */
  retryDelay = SAVE_RETRY_DELAY;
  /** La minuterie en cours est un nouvel essai (espacé) : une modification la remplace par l'enregistrement habituel. */
  retryPending = false;
  /** Identifiant déjà donné à une source renommée (« ancien#rang ») : un même renommage n'en tire jamais un second. */
  readonly syncedRenames = new Map<string, string>();
  /** Dates des renommages de la dernière minute (plafond MAX_SYNCED_RENAMES_PER_MINUTE). */
  renameTimes: number[] = [];
  saveTimer: NodeJS.Timeout | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  constructor(readonly pageId: string) {
    this.awareness.setLocalState(null);
  }
}

const REF_NODES = new Set(['attachment', 'video', 'audio']);
const IMAGE_SRC = /^\/api\/v3\/attachments\/([A-Za-z0-9_-]{22})$/;

/**
 * Applique à l'état Yjs le plan calculé sur son JSON brut (planCollabSynced) : `actions[k]` vise le k-ième bloc synchronisé dans
 * l'ordre préfixe des éléments, le même que celui du JSON brut (yFragmentToJson garde chaque élément). Renommage (attribut
 * réécrit seulement s'il change), source sortie de son enveloppe (ses enfants prennent sa place), copie retirée. Les retraits se
 * font du dernier au premier : un descendant passe avant son ancêtre, un frère suivant avant le précédent, aucune position ne
 * glisse. Renvoie false (et ne touche à rien) si l'état ne correspond plus au plan.
 */
export function applyCollabSynced(fragment: Y.XmlFragment, actions: CollabAction[]): boolean {
  if (!actions.some(Boolean)) return true;
  const els: Y.XmlElement[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'syncedSource' || child.nodeName === 'syncedCopy') els.push(child);
      // Un élément nommé « text » est une feuille pour le plan (planCollabSynced) : on n'y descend pas non plus.
      if (child.nodeName !== 'text') walk(child);
    }
  };
  walk(fragment);
  if (els.length !== actions.length) return false;
  actions.forEach((a, k) => { if (a?.kind === 'rename' && els[k]!.getAttribute('blockId') !== a.to) els[k]!.setAttribute('blockId', a.to); });
  for (let k = els.length - 1; k >= 0; k--) {
    const a = actions[k];
    if (a?.kind === 'strip') { const el = els[k]!; if (el.length) el.delete(0, el.length); continue; }
    if (a?.kind !== 'unwrap' && a?.kind !== 'remove') continue;
    const el = els[k]!;
    const parent = el.parent as Y.XmlElement | Y.XmlFragment | null;
    if (!parent) continue;
    const index = parent.toArray().indexOf(el);
    if (index < 0) continue;
    // Sortie d'enveloppe = suppression puis réinsertion des enfants : une frappe concurrente dans ce sous-arbre est perdue (risque
    // accepté : seulement pour un bloc hors règles, au-delà des plafonds ou forgé).
    const kids = a.kind === 'unwrap' ? yChildrenToJson(el) : [];
    parent.delete(index, 1);
    if (kids.length) parent.insert(index, jsonToYNodes(kids));
  }
  return true;
}

/** Remplace dans l'état Yjs les citations de pièces jointes résolues (`''` : inchangée, `null` : bloc retiré, sinon la copie). */
export function rewriteAttachmentRefs(parent: Y.XmlFragment | Y.XmlElement, resolved: Map<string, string | null>) {
  const children = parent.toArray();
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!(child instanceof Y.XmlElement)) continue;
    const isImage = child.nodeName === 'image';
    const ref = REF_NODES.has(child.nodeName) ? child.getAttribute('id') : isImage ? IMAGE_SRC.exec(String(child.getAttribute('src') ?? ''))?.[1] : undefined;
    if (typeof ref === 'string' && resolved.has(ref)) {
      const next = resolved.get(ref);
      if (next === null) { parent.delete(i, 1); continue; }
      if (next) child.setAttribute(isImage ? 'src' : 'id', isImage ? `/api/v3/attachments/${next}` : next);
    }
    rewriteAttachmentRefs(child, resolved);
  }
}

export class CollabHub {
  readonly #rooms = new Map<string, Room>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeMoves: () => void;

  // `clonerFor` : copieur des pièces jointes citées par une autre page, avec les droits de toutes les personnes qui ont modifié
  // depuis le dernier enregistrement (voir access.ts, collabClonerFor).
  constructor(private readonly db: DB, private readonly bus: EventBus, private readonly authorize: Authorize = () => true, private readonly clonerFor?: (editors: string[], author: string | null) => AttachmentCloner) {
    // Une modification de contenu venue d'ailleurs (API, restauration d'une version…) invalide la salle.
    this.#unsubscribe = bus.subscribe((e) => {
      if (!e.pageId) return;
      const room = this.#rooms.get(e.pageId);
      if (!room) return;
      if (e.type === 'page.trashed' || e.type === 'page.deleted') this.#close(room, CLOSE.GONE, true);
      else if (e.type === 'page.updated' || e.type === 'page.restored') this.#onPageEvent(room);
    });
    // Page déplacée sous un parent restreint : ses sous-pages aussi changent de zone, on revérifie toutes les salles.
    this.#unsubscribeMoves = bus.subscribe((e) => { if (e.type === 'page.moved') this.recheckAll(); });
  }

  get roomCount() { return this.#rooms.size; }

  /** Page ouverte en co-édition (salle chargée, avec ou sans connexion en cours) : un traitement de fond ne doit pas y toucher. */
  isOpen(pageId: string): boolean { return this.#rooms.has(pageId); }

  // Referme les connexions qui n'ont plus le droit d'écrire (compte désactivé, session fermée, page déplacée…).
  recheckAll() {
    for (const room of this.#rooms.values()) {
      for (const [ws, conn] of [...room.conns]) if (!this.authorize(conn, room.pageId)) ws.close(CLOSE.DENIED);
    }
  }

  #onPageEvent(room: Room) {
    const row = getPageRow(this.db, room.pageId);
    if (!row || row.deleted_at) { this.#close(room, CLOSE.GONE, true); return; }
    // Titre, icône… : le contenu est inchangé, la salle reste valable.
    if (sha(row.content) === room.contentHash) return;
    this.#snapshotUnsaved(room);
    this.#close(room, CLOSE.RELOAD, true);
  }

  // Contenu modifié ailleurs alors que la salle a des modifications non enregistrées : elles sont gardées dans l'historique de la
  // page (version restaurable) avant que l'état ne soit abandonné. Chaque bloc de premier niveau est assaini à part, un bloc
  // invalide (cause d'un échec d'enregistrement) est laissé de côté. À défaut, avertissement avec la taille de l'état perdu.
  #snapshotUnsaved(room: Room) {
    if (!room.dirty) return;
    try {
      const raw = yFragmentToJson(room.doc.getXmlFragment(FIELD));
      const blocks = (raw.content ?? []).flatMap((b) => {
        try {
          const out = sanitizeDoc({ type: 'doc', content: [b] }, { lenientSynced: true }).content ?? [];
          // Bloc retiré entièrement : sanitizeDoc rend un paragraphe vide par défaut, qu'on ne garde pas.
          return out.length === 1 && out[0]!.type === 'paragraph' && !out[0]!.content && b.type !== 'paragraph' ? [] : out;
        } catch { return []; }
      });
      const doc = sanitizeDoc({ type: 'doc', content: blocks }, { lenientSynced: true });
      if (recordSnapshotVersion(this.db, room.pageId, doc, room.lastUser)) {
        console.warn(`collab : modifications non enregistrées de la page ${room.pageId} gardées dans l'historique avant rechargement`);
      }
    } catch {
      console.warn(`collab : modifications non enregistrées de la page ${room.pageId} perdues au rechargement (${Y.encodeStateAsUpdate(room.doc).length} octets)`);
    }
  }

  #load(pageId: string): Room | null {
    const page = getPageRow(this.db, pageId);
    if (!page || page.deleted_at) return null;
    const room = new Room(pageId);
    const saved = this.db.prepare('SELECT state, epoch, content_hash FROM page_ydocs WHERE page_id = ?').get(pageId) as { state: Buffer; epoch: string; content_hash: string } | undefined;
    if (saved && saved.content_hash === sha(page.content)) {
      Y.applyUpdate(room.doc, new Uint8Array(saved.state));
      room.epoch = saved.epoch;
      room.contentHash = saved.content_hash;
    } else {
      // Première ouverture, ou contenu modifié hors co-édition : on repart du JSON de la page.
      room.doc.transact(() => jsonToYFragment(JSON.parse(page.content), room.doc.getXmlFragment(FIELD)));
      room.epoch = randomToken(9);
      room.contentHash = sha(page.content);
      this.#storeState(room);
    }
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);
      for (const ws of room.conns.keys()) if (ws !== origin) this.#send(ws, msg);
      if (typeof origin === 'object' && origin && room.conns.has(origin as WebSocket)) { room.lastUser = room.conns.get(origin as WebSocket)!.userId; room.editors.add(room.lastUser); }
      this.#markDirty(room);
    });
    room.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const conn = origin && typeof origin === 'object' ? room.conns.get(origin as WebSocket) : undefined;
      if (conn) {
        added.forEach((id) => conn.awarenessIds.add(id));
        removed.forEach((id) => conn.awarenessIds.delete(id));
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
      const msg = encoding.toUint8Array(encoder);
      for (const ws of room.conns.keys()) this.#send(ws, msg);
    });
    this.#rooms.set(pageId, room);
    return room;
  }

  #send(ws: WebSocket, msg: Uint8Array) {
    if (ws.readyState === 1) ws.send(msg, (err) => { if (err) ws.close(); });
  }

  #markDirty(room: Room) {
    room.unstored = true;
    if (room.closing) return;
    room.dirty = true;
    if (room.saveTimer && room.retryPending) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    room.retryPending = false;
    if (!room.saveTimer) room.saveTimer = setTimeout(() => this.#save(room), SAVE_DELAY);
  }

  #storeState(room: Room) {
    room.unstored = false;
    this.db.prepare(
      `INSERT INTO page_ydocs (page_id, state, epoch, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, epoch = excluded.epoch, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
    ).run(room.pageId, Buffer.from(Y.encodeStateAsUpdate(room.doc)), room.epoch, room.contentHash, Date.now());
  }

  // Écrit l'état Yjs et le contenu JSON assaini dans la page. Renvoie true si tout est enregistré. Un échec ne perd jamais
  // l'état Yjs : il est stocké quand même (page_ydocs), et un nouvel essai est programmé.
  #save(room: Room): boolean {
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    room.retryPending = false;
    // Salle fermée et remplacée (ou retirée) : son état est périmé, rien n'est écrit.
    if (room.closing && this.#rooms.get(room.pageId) !== room) return true;
    if (!room.dirty) return true;
    room.dirty = false;
    try {
      const page = getPageRow(this.db, room.pageId);
      if (!page || page.deleted_at) { this.#close(room, CLOSE.GONE, false); return true; }
      const now = Date.now();
      room.renameTimes = room.renameTimes.filter((t) => now - t < 60_000);
      // Blocs synchronisés : plan calculé sur le JSON brut, jamais d'échec ; rien n'est écrit dans l'état Yjs avant l'index.
      const plan = planCollabSynced(this.db, room.pageId, yFragmentToJson(room.doc.getXmlFragment(FIELD)), {
        reuse: (from, nth) => room.syncedRenames.get(`${from}#${nth}`),
        renameBudget: MAX_SYNCED_RENAMES_PER_MINUTE - room.renameTimes.length,
      });
      if (plan.actions.some((a) => a?.kind === 'unwrap' || a?.kind === 'remove')) {
        console.warn(`collab : blocs synchronisés hors règles sortis de leur enveloppe dans la page ${room.pageId}`);
      }
      const clean = sanitizeDoc(plan.doc, { lenientSynced: true });
      let cloner: AttachmentCloner | undefined;
      let row: PageRow | undefined;
      if (JSON.stringify(clean) !== page.content) {
        cloner = this.clonerFor?.([...room.editors], room.lastUser);
        try { row = updatePage(this.db, room.pageId, { content: clean }, room.lastUser, cloner); } catch (err) { cloner?.rollback(); throw err; }
        room.contentHash = sha(row.content);
      }
      // Index et page enregistrés : l'état Yjs reçoit maintenant le même traitement, diffusé à tous les participants.
      room.renameTimes.push(...plan.fresh.map(() => now));
      for (const r of plan.renames) room.syncedRenames.set(`${r.from}#${r.nth}`, r.to);
      if (plan.actions.some(Boolean)) {
        room.doc.transact(() => {
          if (!applyCollabSynced(room.doc.getXmlFragment(FIELD), plan.actions)) console.warn(`collab : état modifié pendant l'enregistrement de ${room.pageId}`);
        }, 'server');
      }
      // Le document de co-édition reçoit le même nettoyage : aucun identifiant de fichier inaccessible n'y reste.
      if (cloner?.resolved.size) room.doc.transact(() => rewriteAttachmentRefs(room.doc.getXmlFragment(FIELD), cloner.resolved), 'server');
      if (row) {
        const author = room.lastUser ? this.db.prepare('SELECT id, name FROM users WHERE id = ?').get(room.lastUser) as { id: string; name: string } | undefined : undefined;
        this.bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: row.id, version: row.version, by: author, shared: room.editors.size > 1 });
      }
      room.editors.clear();
      this.#storeState(room);
      room.retryDelay = SAVE_RETRY_DELAY;
      return true;
    } catch (err) {
      room.dirty = true;
      console.error('collab : échec de la sauvegarde', (err as Error).message);
      // L'état Yjs est gardé quoi qu'il arrive (le contenu JSON reste le dernier enregistré) : à la réouverture, la salle repart de
      // cet état tant que la page n'a pas été modifiée ailleurs.
      if (room.unstored) try { this.#storeState(room); } catch (e) { console.error('collab : état non stocké', (e as Error).message); }
      if (!room.closing && !room.saveTimer) {
        room.saveTimer = setTimeout(() => this.#save(room), room.retryDelay);
        room.retryPending = true;
        room.retryDelay = Math.min(room.retryDelay * 2, SAVE_RETRY_MAX);
      }
      return false;
    }
  }

  // `dropState` : l'état Yjs est abandonné (page à la corbeille ou supprimée, contenu modifié ailleurs, ou état déjà enregistré).
  // Sinon il est enregistré, ou au moins stocké si l'enregistrement échoue (#save) : la salle n'est jamais détruite avant.
  #close(room: Room, code: number, dropState: boolean) {
    room.closing = true;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (dropState) this.db.prepare('DELETE FROM page_ydocs WHERE page_id = ?').run(room.pageId);
    else this.#save(room);
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    if (this.#rooms.get(room.pageId) === room) this.#rooms.delete(room.pageId);
    for (const ws of room.conns.keys()) ws.close(code);
    room.awareness.destroy();
    room.doc.destroy();
  }

  // Branche une WebSocket déjà authentifiée et autorisée (écriture) sur la salle de la page.
  connect(ws: WebSocket, pageId: string, user: { id: string; name: string; sessionHash?: string | null }): boolean {
    const room = this.#rooms.get(pageId) ?? this.#load(pageId);
    if (!room) { ws.close(CLOSE.GONE); return false; }
    if (room.conns.size >= MAX_CONNS_PER_ROOM) { ws.close(CLOSE.FULL); return false; }
    if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
    const conn: Conn = { userId: user.id, name: user.name, sessionHash: user.sessionHash ?? null, awarenessIds: new Set() };
    room.conns.set(ws, conn);

    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, MSG_EPOCH);
    encoding.writeVarString(hello, room.epoch);
    this.#send(ws, encoding.toUint8Array(hello));

    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MSG_SYNC);
    syncProtocol.writeSyncStep1(step1, room.doc);
    this.#send(ws, encoding.toUint8Array(step1));
    const states = room.awareness.getStates();
    if (states.size) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      this.#send(ws, encoding.toUint8Array(aw));
    }

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      // Les droits ne sont pas figés à la connexion : session expirée ou fermée, compte désactivé, page restreinte ou déplacée.
      if (!this.authorize(conn, pageId)) { ws.close(CLOSE.DENIED); return; }
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on('message', (data: Buffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
          if (encoding.length(encoder) > 1) this.#send(ws, encoding.toUint8Array(encoder));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        } else if (type === MSG_QUERY_AWARENESS) {
          const aw = encoding.createEncoder();
          encoding.writeVarUint(aw, MSG_AWARENESS);
          encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
          this.#send(ws, encoding.toUint8Array(aw));
        }
      } catch {
        ws.close(1003);
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      room.conns.delete(ws);
      awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.awarenessIds], null);
      if (!room.conns.size && this.#rooms.get(pageId) === room) {
        this.#save(room);
        room.idleTimer = setTimeout(() => { if (!room.conns.size) this.#close(room, 1000, false); }, IDLE_CLOSE);
      }
    });
    return true;
  }

  // Arrêt du serveur : sauvegarde toutes les salles.
  // Ferme toutes les salles (code RELOAD) : les clients se reconnectent et repassent le contrôle d'accès
  // (changement de permissions d'une page).
  evictAll() {
    for (const room of [...this.#rooms.values()]) {
      // Les frappes en attente ne sont pas perdues : l'état n'est abandonné que s'il a été enregistré, sinon il est stocké.
      const saved = this.#save(room);
      if (this.#rooms.get(room.pageId) === room) this.#close(room, CLOSE.RELOAD, saved);
    }
  }

  shutdown() {
    this.#unsubscribe();
    this.#unsubscribeMoves();
    for (const room of [...this.#rooms.values()]) this.#close(room, 1001, false);
  }
}
