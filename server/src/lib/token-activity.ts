// Activité des jetons d'API, pour le journal d'audit sans le noyer :
//  - `api.access` : un évènement agrégé par jeton, par famille de routes et par fenêtre de 5 minutes, avec le nombre de
//    requêtes et la répartition des statuts HTTP ; aucun texte, aucun identifiant de page, aucune adresse demandée.
//  - `auth.denied` : refus d'un jeton (portée insuffisante, espace hors de son périmètre, autre 403). Le premier refus d'une
//    fenêtre (par jeton et par raison) est écrit tout de suite ; les suivants sont comptés et résumés en une ligne à la fin
//    de la fenêtre. Au plus deux lignes par jeton, par raison et par fenêtre.
//  - compteur de requêtes de chaque jeton (`api_tokens.request_count`), cumulé en mémoire et écrit au plus une fois par minute.
// Volume borné : familles en nombre fini (FAMILIES), au plus MAX_BUCKETS agrégats en mémoire (au-delà, écriture anticipée).
import type { FastifyRequest } from 'fastify';
import type { DenialReason } from '../auth/denials.js';
import type { DB } from '../db.js';

export const ACCESS_WINDOW_MS = 5 * 60_000;
const MAX_BUCKETS = 5_000;
const COUNT_FLUSH_MS = 60_000;

// Familles de routes : premier segment après /api/v3 (quelques sous-ressources de page ont la leur). Tout le reste : « autre ».
const FAMILIES = new Set([
  'pages', 'search', 'spaces', 'bases', 'templates', 'labels', 'notifications', 'attachments', 'ai', 'admin', 'tokens', 'events',
  'me', 'config', 'my-tasks', 'imports', 'verifications', 'synced-blocks', 'groups', 'users', 'shares', 'trash', 'presence',
  'sessions', 'about', 'public',
]);
const PAGE_FAMILIES: Record<string, string> = { comments: 'comments', export: 'export', attachments: 'attachments', versions: 'versions', labels: 'labels' };

export function routeFamily(url: string | undefined): string {
  if (!url) return 'inconnue';
  if (url === '/mcp') return 'mcp';
  const page = /^\/api\/v3\/pages\/:id\/([a-z-]+)/.exec(url)?.[1];
  if (page && PAGE_FAMILIES[page]) return PAGE_FAMILIES[page];
  if (/\/export(\/|$)/.test(url)) return 'export';
  const first = /^\/api\/v3\/([a-z-]+)/.exec(url)?.[1];
  return first && FAMILIES.has(first) ? first : 'autre';
}

interface Who { userId: string; tokenId: string; tokenName: string | null; ip: string | null }
interface Bucket extends Who { window: number; requests: number; statuses: Map<number, number>; routes: Set<string>; reason?: DenialReason }

export class TokenActivity {
  #access = new Map<string, Bucket>();
  #denied = new Map<string, Bucket>();
  #counts = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DB, private readonly now: () => number = Date.now) {}

  start() {
    this.#timer = setInterval(() => { this.flush(false); this.flushCounts(); }, COUNT_FLUSH_MS);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    // Base déjà fermée (arrêt sur erreur) : rien à écrire, l'arrêt ne doit pas échouer.
    try { this.flush(true); this.flushCounts(); } catch { /* base indisponible */ }
  }

  #who(req: FastifyRequest): Who | null {
    const a = req.auth;
    if (a?.via !== 'token' || !a.tokenId) return null;
    return { userId: a.user.id, tokenId: a.tokenId, tokenName: a.tokenName ?? null, ip: req.ip ?? null };
  }

  /** Requête terminée d'un jeton : compteur et agrégat `api.access`. */
  record(req: FastifyRequest, status: number) {
    const who = this.#who(req);
    if (!who) return;
    this.#counts.set(who.tokenId, (this.#counts.get(who.tokenId) ?? 0) + 1);
    const family = routeFamily(req.routeOptions?.url);
    const window = this.#window();
    const key = `${who.tokenId}|${family}|${window}`;
    let b = this.#access.get(key);
    if (!b) {
      if (this.#access.size >= MAX_BUCKETS) this.flush(true);
      b = { ...who, window, requests: 0, statuses: new Map(), routes: new Set([family]) };
      this.#access.set(key, b);
    }
    b.requests++;
    b.ip = who.ip;
    b.statuses.set(status, (b.statuses.get(status) ?? 0) + 1);
  }

  /** Refus d'un jeton : première occurrence de la fenêtre écrite aussitôt, les suivantes résumées à la fin de la fenêtre. */
  deny(req: FastifyRequest, reason: DenialReason, status: number) {
    const who = this.#who(req);
    if (!who) return;
    const family = routeFamily(req.routeOptions?.url);
    const window = this.#window();
    const key = `${who.tokenId}|${reason}|${window}`;
    const b = this.#denied.get(key);
    if (!b) {
      if (this.#denied.size >= MAX_BUCKETS) this.flush(true);
      // Ligne immédiate ; l'agrégat (vide pour l'instant) retient la fenêtre.
      this.#write(who, 'auth.denied', { reason, requests: 1, routes: [family], statuses: { [status]: 1 } });
      this.#denied.set(key, { ...who, window, requests: 0, statuses: new Map(), routes: new Set(), reason });
      return;
    }
    b.requests++;
    b.ip = who.ip;
    b.routes.add(family);
    b.statuses.set(status, (b.statuses.get(status) ?? 0) + 1);
  }

  /** Écrit les agrégats des fenêtres terminées (toutes si `all`). */
  flush(all: boolean) {
    const current = this.#window();
    const tx = this.db.transaction(() => {
      for (const [key, b] of this.#access) {
        if (!all && b.window >= current) continue;
        this.#access.delete(key);
        this.#write(b, 'api.access', this.#meta(b));
      }
      for (const [key, b] of this.#denied) {
        if (!all && b.window >= current) continue;
        this.#denied.delete(key);
        if (b.requests > 0) this.#write(b, 'auth.denied', { reason: b.reason, aggregated: true, ...this.#meta(b) });
      }
    });
    tx();
  }

  /** Compteurs de requêtes vers la base (au plus une écriture par jeton à chaque appel, soit une par minute). */
  flushCounts() {
    if (!this.#counts.size) return;
    const update = this.db.prepare('UPDATE api_tokens SET request_count = request_count + ? WHERE id = ?');
    const pending = [...this.#counts];
    this.#counts.clear();
    this.db.transaction(() => { for (const [id, n] of pending) update.run(n, id); })();
  }

  /** Requêtes comptées mais pas encore écrites (pour afficher un total à jour). */
  pendingCount = (tokenId: string) => this.#counts.get(tokenId) ?? 0;

  #window() { return Math.floor(this.now() / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS; }

  #meta(b: Bucket) {
    return {
      requests: b.requests,
      routes: [...b.routes].sort(),
      statuses: Object.fromEntries([...b.statuses].sort((x, y) => x[0] - y[0]).map(([s, n]) => [String(s), n])),
      windowStart: new Date(b.window).toISOString(),
      windowMinutes: ACCESS_WINDOW_MS / 60_000,
    };
  }

  #write(who: Who, action: string, meta: Record<string, unknown>) {
    this.db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta, token_id, token_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.now(), who.userId, action, who.tokenId, who.ip, JSON.stringify(meta), who.tokenId, who.tokenName);
  }
}
