// Diffusion du journal d'audit hors de l'application : sortie standard (AUDIT_STDOUT=true) et SIEM (webhook signé).
// La file d'envoi est le journal lui-même : un curseur (dernier identifiant traité) est conservé dans la table `settings`.
// Toute écriture dans `audit_log` est donc reprise, y compris celles de la ligne de commande et des purges. Un envoi en échec
// est retenté avec un délai croissant (10 minutes au plus), sans jamais abandonner : rien n'est sauté.
// Rien d'autre que les évènements au format stable (lib/audit-events.ts) ne sort : ni secret, ni contenu de page.
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { audit } from './audit.js';
import { AUDIT_SCHEMA, auditAfter, auditCountAfter, auditMaxId, type AuditEvent, eventJson, toAuditEvent } from './audit-events.js';
import { MAX_FAILURES, postSigned } from './webhooks.js';

const STATE_KEY = 'audit:siem:state';
const BATCH = 100;
// Lots envoyés au plus par passage (toutes les 2 s) : un retard se rattrape sans monopoliser le serveur.
const MAX_BATCHES_PER_PASS = 10;
// Corps d'une requête : environ 1 Mo au plus (le lot est coupé avant).
export const MAX_BODY_BYTES = 1_000_000;
const STDOUT_BATCH = 500;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

export interface SiemState {
  // Empreinte de la configuration (adresse, familles, date d'enregistrement).
  config: string;
  // Empreinte de l'adresse seule : tant qu'elle ne change pas, le curseur est conservé.
  url: string;
  cursor: number;
  failures: number;
  // Alerte « audit.siem.failing » déjà journalisée pour cette série d'échecs.
  alerted: boolean;
  lastStatus: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number | null;
}

export interface ForwarderOptions {
  allowPrivate: boolean;
  // Écriture d'une ligne sur la sortie standard ; null : sortie standard désactivée.
  stdout: ((line: string) => void) | null;
  intervalMs?: number;
}

type Kind = 'audit.events' | 'audit.test' | 'audit.stop';
const envelope = (type: Kind, events: string[]) =>
  `{"schema":${JSON.stringify(AUDIT_SCHEMA)},"type":${JSON.stringify(type)},"sentAt":${JSON.stringify(new Date().toISOString())},"events":[${events.join(',')}]}`;
export const siemBody = (events: AuditEvent[], type: Kind = 'audit.events') => envelope(type, events.map(eventJson));

export const backoffMs = (failures: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const synthetic = (action: string): AuditEvent => ({ schema: AUDIT_SCHEMA, id: 0, timestamp: new Date().toISOString(), action, outcome: 'success', actor: null, target: null, ip: null, meta: null });
const headers = () => ({ 'user-agent': 'Notabene-Audit/1', 'x-notabene-delivery': randomUUID() });

export class AuditForwarder {
  #timer: NodeJS.Timeout | null = null;
  // Exclusion mutuelle : passages, changements de configuration et lectures d'état ne se chevauchent pas.
  #queue: Promise<unknown> = Promise.resolve();
  #tick: Promise<void> | null = null;
  #stdoutCursor: number;

  constructor(private readonly db: DB, private readonly cfg: () => Config, private readonly opts: ForwarderOptions) {
    // La sortie standard ne reprend pas l'historique : seulement ce qui est écrit après le démarrage.
    this.#stdoutCursor = auditMaxId(db);
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs ?? 2_000);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.catch(() => {});
    return p;
  }

  // Un seul passage en file à la fois : un appel pendant un passage attend celui-ci.
  tick(): Promise<void> {
    if (!this.#tick) this.#tick = this.#exclusive(() => this.#run()).finally(() => { this.#tick = null; });
    return this.#tick;
  }

  async #run() {
    try { this.#toStdout(); } catch { /* la sortie standard ne doit jamais bloquer l'envoi au SIEM */ }
    try { await this.#toSiem(); } catch { /* erreur inattendue : nouvel essai au passage suivant */ }
  }

  #toStdout() {
    const write = this.opts.stdout;
    if (!write) return;
    if (auditMaxId(this.db) < this.#stdoutCursor) this.#stdoutCursor = 0; // journal vidé : les identifiants repartent de 1
    for (let i = 0; i < 20; i++) {
      const rows = auditAfter(this.db, this.#stdoutCursor, STDOUT_BATCH);
      if (!rows.length) return;
      for (const r of rows) write(eventJson(toAuditEvent(r)));
      this.#stdoutCursor = rows.at(-1)!.id;
    }
  }

  // ---- État ---------------------------------------------------------------------------------------
  // Empreinte non secrète : le secret n'y entre pas, la date d'enregistrement de la section change avec lui.
  #fingerprint(c: Config): string {
    const row = this.db.prepare("SELECT updated_at FROM settings WHERE key = 'cfg:siem'").get() as { updated_at: number } | undefined;
    return hash([c.SIEM_URL, c.SIEM_ACTIONS, row?.updated_at ?? 'env']);
  }

  #read(): SiemState | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as SiemState; } catch { return null; }
  }

  #write(s: SiemState): SiemState {
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(STATE_KEY, JSON.stringify(s), Date.now());
    return s;
  }

  // Nouvelle configuration. Même adresse : le curseur est conservé (rien de ce qui attend n'est sauté). Autre adresse :
  // départ juste avant l'entrée de configuration qui vient d'être écrite (`entryId`), ou plus tôt si l'ancien collecteur
  // n'a pas tout reçu (`handoff`). Sans entrée connue (configuration par l'environnement) : départ au dernier évènement.
  #transition(c: Config, entryId: number | null, handoff: number | null): SiemState {
    const prev = this.#read();
    const url = hash(c.SIEM_URL);
    let cursor: number;
    if (prev && prev.url === url) cursor = prev.cursor;
    else {
      const start = entryId !== null ? entryId - 1 : auditMaxId(this.db);
      cursor = handoff !== null ? Math.min(handoff, start) : start;
    }
    const same = prev?.url === url;
    return this.#write({
      config: this.#fingerprint(c), url, cursor, failures: 0, alerted: false,
      lastStatus: same ? prev!.lastStatus : null, lastAttemptAt: same ? prev!.lastAttemptAt : null, lastSuccessAt: same ? prev!.lastSuccessAt : null,
      nextAttemptAt: null,
    });
  }

  #state(c: Config): SiemState {
    const cur = this.#read();
    return cur && cur.config === this.#fingerprint(c) ? cur : this.#transition(c, null, null);
  }

  // ---- Envoi --------------------------------------------------------------------------------------
  // Un lot : familles filtrées en SQL, corps coupé vers MAX_BODY_BYTES. `more` : il reste des évènements à envoyer.
  async #sendBatch(c: Config, s: SiemState): Promise<{ state: SiemState; ok: boolean; status: number; more: boolean }> {
    const snap = auditMaxId(this.db);
    if (snap < s.cursor) s = { ...s, cursor: 0 }; // journal vidé : les identifiants repartent de 1
    const rows = auditAfter(this.db, s.cursor, BATCH, { families: c.SIEM_ACTIONS, upTo: snap });
    if (!rows.length) {
      // Rien à envoyer jusqu'à l'instantané : les entrées écartées par le filtre sont passées.
      if (snap !== s.cursor) s = this.#write({ ...s, cursor: snap });
      return { state: s, ok: true, status: 0, more: false };
    }
    const parts: string[] = [];
    let size = 200;
    let lastId = s.cursor;
    for (const r of rows) {
      const json = eventJson(toAuditEvent(r));
      const bytes = Buffer.byteLength(json) + 1;
      if (parts.length && size + bytes > MAX_BODY_BYTES) break;
      parts.push(json);
      size += bytes;
      lastId = r.id;
    }
    const complete = parts.length === rows.length && rows.length < BATCH;
    const now = Date.now();
    const status = await postSigned(c.SIEM_URL!, c.SIEM_SECRET!, 'audit.events', envelope('audit.events', parts), this.opts.allowPrivate, headers());
    if (status >= 200 && status < 300) {
      const state = this.#write({ ...s, cursor: complete ? snap : lastId, failures: 0, alerted: false, lastStatus: status, lastAttemptAt: now, lastSuccessAt: now, nextAttemptAt: null });
      return { state, ok: true, status, more: !complete };
    }
    const failures = s.failures + 1;
    const alert = failures >= MAX_FAILURES && !s.alerted;
    const state = this.#write({ ...s, failures, alerted: s.alerted || alert, lastStatus: status, lastAttemptAt: now, nextAttemptAt: now + backoffMs(failures) });
    // Alerte unique par série d'échecs ; l'envoi continue (l'adresse du collecteur n'y figure pas).
    if (alert) audit(this.db, null, 'audit.siem.failing', null, { failures, status });
    return { state, ok: false, status, more: false };
  }

  async #toSiem() {
    const c = this.cfg();
    if (!c.SIEM_URL || !c.SIEM_SECRET) return;
    let s = this.#state(c);
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      if (s.nextAttemptAt && Date.now() < s.nextAttemptAt) return;
      const r = await this.#sendBatch(c, s);
      if (!r.more) return;
      s = r.state;
    }
  }

  // Changement de configuration (enregistrement, désactivation, retour à l'environnement). `apply` enregistre la
  // configuration et écrit l'entrée d'audit correspondante, de façon synchrone. Si l'ancien collecteur cesse d'être la
  // destination, il reçoit d'abord ce qui attend encore (un passage) puis un évènement d'arrêt signé ; les échecs sont tolérés.
  reconfigure(nextUrl: string | undefined, apply: () => void): Promise<void> {
    return this.#exclusive(async () => {
      const old = this.cfg();
      let handoff: number | null = null;
      if (old.SIEM_URL && old.SIEM_SECRET && nextUrl !== old.SIEM_URL) {
        let s = this.#state(old);
        let reachable = true;
        try {
          for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
            const r = await this.#sendBatch(old, s);
            s = r.state;
            if (!r.ok && r.status === 0) reachable = false;
            if (!r.more) break;
          }
          if (reachable) await postSigned(old.SIEM_URL, old.SIEM_SECRET, 'audit.stop', siemBody([synthetic('audit.siem.stop')], 'audit.stop'), this.opts.allowPrivate, headers());
        } catch { /* l'ancien collecteur ne bloque jamais le changement */ }
        handoff = s.cursor;
      }
      apply();
      const next = this.cfg();
      if (next.SIEM_URL && next.SIEM_SECRET) this.#transition(next, auditMaxId(this.db), handoff);
    });
  }

  // Envoi d'un évènement de test avec une configuration candidate (non enregistrée). Renvoie le statut HTTP (0 : injoignable).
  async sendTest(c: Config): Promise<number> {
    if (!c.SIEM_URL || !c.SIEM_SECRET) return 0;
    return postSigned(c.SIEM_URL, c.SIEM_SECRET, 'audit.test', siemBody([synthetic('audit.siem.test')], 'audit.test'), this.opts.allowPrivate, headers());
  }

  // État lisible par un administrateur : ni secret, ni chemin de l'adresse (seulement son origine).
  // `disabled` reste à false (l'envoi n'est plus désactivé automatiquement) ; `maxFailures` est le seuil d'alerte.
  status() {
    return this.#exclusive(() => {
      const c = this.cfg();
      const configured = !!(c.SIEM_URL && c.SIEM_SECRET);
      const s = configured ? this.#state(c) : null;
      let origin: string | null;
      try { origin = c.SIEM_URL ? new URL(c.SIEM_URL).origin : null; } catch { origin = null; }
      return {
        configured,
        active: configured,
        origin,
        actions: configured ? c.SIEM_ACTIONS : [],
        disabled: false,
        failures: s?.failures ?? 0,
        maxFailures: MAX_FAILURES,
        lastStatus: s?.lastStatus ?? null,
        lastAttemptAt: s?.lastAttemptAt ?? null,
        lastSuccessAt: s?.lastSuccessAt ?? null,
        nextAttemptAt: s?.nextAttemptAt ?? null,
        pending: s ? auditCountAfter(this.db, s.cursor, c.SIEM_ACTIONS) : 0,
        stdout: !!this.opts.stdout,
      };
    });
  }
}
