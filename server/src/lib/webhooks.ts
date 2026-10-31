// Webhooks sortants : signature HMAC-SHA256, protection SSRF, pas de redirection, délai court.
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DB } from '../db.js';
import type { SecretBox } from './crypto.js';
import type { AppEvent, EventBus } from './events.js';
import { isBlockedAddress, safeFetch } from './net-guard.js';

export const WEBHOOK_EVENTS = ['page.created', 'page.updated', 'page.trashed', 'page.restored', 'page.deleted', 'page.moved', 'space.changed', 'page.permissions', 'comment.created', 'comment.updated', 'comment.deleted'] as const;

const MAX_FAILURES = 10;

// Vérifie le schéma et refuse les adresses internes (sauf WEBHOOK_ALLOW_PRIVATE).
export async function assertSafeUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Error('URL https obligatoire');
  if (url.username || url.password) throw new Error('Identifiants dans l’URL interdits');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
    if (!addrs.length || addrs.some(isBlockedAddress)) throw new Error('Adresse interne refusée');
  }
  return url;
}

export const sign = (secret: string, timestamp: string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

interface Row { id: string; url: string; secret: string; events: string; failures: number }

export async function deliver(db: DB, box: SecretBox, allowPrivate: boolean, hook: Row, event: string, payload: unknown): Promise<number> {
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
  const ts = String(Math.floor(Date.now() / 1000));
  let status: number;
  try {
    const url = await assertSafeUrl(hook.url, allowPrivate);
    const secret = box.open(hook.secret, `webhook:${hook.id}`);
    // Connexion épinglée sur l'adresse vérifiée (net-guard) : pas de rebinding DNS entre le contrôle et l'envoi.
    const res = await safeFetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Notabene-Webhook/1',
        'x-notabene-event': event,
        'x-notabene-timestamp': ts,
        'x-notabene-signature': `sha256=${sign(secret, ts, body)}`,
      },
      body,
    }, allowPrivate);
    status = res.status;
  } catch {
    status = 0;
  }
  const ok = status >= 200 && status < 300;
  db.prepare('UPDATE webhooks SET last_status = ?, last_at = ?, failures = ?, enabled = CASE WHEN ? >= ? THEN 0 ELSE enabled END WHERE id = ?')
    .run(status, Date.now(), ok ? 0 : hook.failures + 1, ok ? 0 : hook.failures + 1, MAX_FAILURES, hook.id);
  return status;
}

// Ne transmet que des identifiants et titres : jamais le contenu des pages.
export function startWebhooks(db: DB, bus: EventBus, box: SecretBox, allowPrivate: boolean) {
  return bus.subscribe((e: AppEvent) => {
    if (e.type === 'presence') return;
    // Rien d'un espace personnel ne sort vers un service externe.
    const spaceId = e.spaceId ?? (e.pageId ? (db.prepare('SELECT space_id FROM pages WHERE id = ?').get(e.pageId) as { space_id: string } | undefined)?.space_id : undefined);
    if (spaceId && db.prepare("SELECT 1 FROM spaces WHERE id = ? AND kind = 'personal'").get(spaceId)) return;
    const hooks = db.prepare('SELECT id, url, secret, events, failures FROM webhooks WHERE enabled = 1').all() as Row[];
    const payload = { pageId: e.pageId, spaceId: e.spaceId, version: e.version, by: e.by };
    for (const hook of hooks) {
      if ((JSON.parse(hook.events) as string[]).includes(e.type)) void deliver(db, box, allowPrivate, hook, e.type, payload);
    }
  });
}
