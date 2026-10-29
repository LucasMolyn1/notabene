// Bus d'événements en mémoire (instance unique) : diffusé aux clients via SSE.
import { EventEmitter } from 'node:events';

export interface AppEvent {
  type: 'page.created' | 'page.updated' | 'page.moved' | 'page.trashed' | 'page.restored' | 'page.deleted' | 'space.changed' | 'presence' | 'page.permissions' | 'comment.created' | 'comment.updated' | 'comment.deleted' | 'notification';
  spaceId?: string;
  pageId?: string;
  version?: number;
  by?: { id: string; name: string };
  data?: unknown;
}

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(event: AppEvent) {
    this.emit('event', event);
  }

  subscribe(fn: (event: AppEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

// Présence : qui consulte ou modifie quelle page (purgée après 30 s sans signal).
export class Presence {
  #entries = new Map<string, { userId: string; name: string; pageId: string | null; editingAt: number; seen: number }>();

  constructor(private readonly bus: EventBus) {
    setInterval(() => this.#prune(), 10_000).unref();
  }

  update(key: string, user: { id: string; name: string }, pageId: string | null, editing: boolean) {
    const prev = this.#entries.get(key);
    const now = Date.now();
    this.#entries.set(key, {
      userId: user.id,
      name: user.name,
      pageId,
      editingAt: editing ? now : prev?.editingAt ?? 0,
      seen: now,
    });
    if (!prev || prev.pageId !== pageId || editing) this.#broadcast();
  }

  list() {
    return [...this.#entries.entries()].map(([key, e]) => ({ key, userId: e.userId, name: e.name, pageId: e.pageId, editingAt: e.editingAt }));
  }

  #prune() {
    const before = this.#entries.size;
    for (const [k, e] of this.#entries) if (Date.now() - e.seen > 30_000) this.#entries.delete(k);
    if (this.#entries.size !== before) this.#broadcast();
  }

  #broadcast() {
    this.bus.publish({ type: 'presence', data: this.list() });
  }
}
