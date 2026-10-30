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
import { sanitizeDoc } from './content.js';
import type { EventBus } from './events.js';
import { randomToken } from './crypto.js';
import { jsonToYFragment, yFragmentToJson } from './yjs-json.js';
import { getPageRow, updatePage } from './pages.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const MSG_EPOCH = 100; // extension : identifiant de génération de l'état (hors numéros réservés par y-websocket)
const FIELD = 'default';
const SAVE_DELAY = 2000;
const IDLE_CLOSE = 15_000;
const MAX_CONNS_PER_ROOM = 50;

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
  dirty = false;
  saveTimer: NodeJS.Timeout | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  constructor(readonly pageId: string) {
    this.awareness.setLocalState(null);
  }
}

export class CollabHub {
  readonly #rooms = new Map<string, Room>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeMoves: () => void;

  constructor(private readonly db: DB, private readonly bus: EventBus, private readonly authorize: Authorize = () => true) {
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
    this.#close(room, CLOSE.RELOAD, true);
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
      if (typeof origin === 'object' && origin && room.conns.has(origin as WebSocket)) room.lastUser = room.conns.get(origin as WebSocket)!.userId;
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
    room.dirty = true;
    if (!room.saveTimer) room.saveTimer = setTimeout(() => this.#save(room), SAVE_DELAY);
  }

  #storeState(room: Room) {
    this.db.prepare(
      `INSERT INTO page_ydocs (page_id, state, epoch, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, epoch = excluded.epoch, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
    ).run(room.pageId, Buffer.from(Y.encodeStateAsUpdate(room.doc)), room.epoch, room.contentHash, Date.now());
  }

  // Écrit l'état Yjs et le contenu JSON assaini dans la page.
  #save(room: Room) {
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    if (!room.dirty) return;
    room.dirty = false;
    try {
      const page = getPageRow(this.db, room.pageId);
      if (!page || page.deleted_at) { this.#close(room, CLOSE.GONE, false); return; }
      const clean = sanitizeDoc(yFragmentToJson(room.doc.getXmlFragment(FIELD)));
      if (JSON.stringify(clean) !== page.content) {
        const row = updatePage(this.db, room.pageId, { content: clean }, room.lastUser);
        room.contentHash = sha(row.content);
        this.bus.publish({ type: 'page.updated', spaceId: row.space_id, pageId: row.id, version: row.version, by: undefined });
      }
      this.#storeState(room);
    } catch (err) {
      room.dirty = true; // nouvelle tentative au prochain changement
      console.error('collab : échec de la sauvegarde', (err as Error).message);
    }
  }

  #close(room: Room, code: number, dropState: boolean) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (dropState) this.db.prepare('DELETE FROM page_ydocs WHERE page_id = ?').run(room.pageId);
    else this.#save(room);
    this.#rooms.delete(room.pageId);
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
    for (const room of [...this.#rooms.values()]) this.#close(room, CLOSE.RELOAD, true);
  }

  shutdown() {
    this.#unsubscribe();
    this.#unsubscribeMoves();
    for (const room of [...this.#rooms.values()]) this.#close(room, 1001, false);
  }
}
