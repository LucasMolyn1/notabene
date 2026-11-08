import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { csvCell, sanitizeMeta, toAuditEvent } from '../src/lib/audit-events.js';
import { backoffMs } from '../src/lib/audit-forwarder.js';
import { hashPassword } from '../src/lib/password.js';
import { sign } from '../src/lib/webhooks.js';

const baseEnv = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
const SECRET = 'siem-secret-0123456789abcdef';
const reauth = { password: PASS };

let app: FastifyInstance;
let db: DB;
let stdout: string[];
let servers: Server[] = [];

async function boot(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  stdout = [];
  app = await buildApp({ config: loadConfig({ ...baseEnv, ...extra }), db, clientDir: '/nonexistent', auditStdout: (l) => stdout.push(l) });
}
afterEach(async () => {
  await app?.close();
  db?.close();
  await Promise.all(servers.map((srv) => new Promise((r) => srv.close(r))));
  servers = [];
});

async function addUser(email: string, role: 'admin' | 'editor' | 'reader') {
  const id = `u-${email}`;
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  return id;
}
async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type Session = Awaited<ReturnType<typeof login>>;
const api = (s: Session, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url: `/api/v3${url}`, payload, ...s });

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
function row(action: string, opts: { at?: number; user?: string | null; target?: string | null; ip?: string | null; meta?: object | null } = {}) {
  return Number(db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (?, ?, ?, ?, ?, ?)').run(
    opts.at ?? Date.now(), opts.user ?? null, action, opts.target ?? null, opts.ip ?? null, opts.meta ? JSON.stringify(opts.meta) : null,
  ).lastInsertRowid);
}

describe('journal d’audit : droits', () => {
  it('réserve les routes aux administrateurs', async () => {
    await boot();
    await addUser('ed@example.com', 'editor');
    const ed = await login('ed@example.com');
    for (const url of ['/admin/audit/events', '/admin/audit/export', '/admin/audit/siem', '/admin/retention', '/admin/audit']) {
      expect((await api(ed, 'GET', url)).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/v3${url}` })).statusCode).toBe(401);
    }
  });
});

describe('journal d’audit : filtres et curseur', () => {
  it('filtre par action, famille, utilisateur, cible, issue et dates', async () => {
    await boot();
    const admin = await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    row('auth.local.failed', { at: T0, target: 'x' });
    row('auth.login', { at: T0 + DAY, user: admin, target: 'cible-1' });
    row('authx.other', { at: T0 + 2 * DAY });
    row('space.create', { at: T0 + 3 * DAY, user: admin, target: 'cible-1' });
    row('auth.denied', { at: T0 + 4 * DAY });
    const actions = async (qs: string) => (await api(s, 'GET', `/admin/audit/events?${qs}`)).json().items.map((e: { action: string }) => e.action);
    expect(await actions('action=auth.login')).toEqual(['auth.login', 'auth.login']); // la connexion du test compte aussi
    expect(await actions('action=auth.&to=2026-10-31')).toEqual(['auth.denied', 'auth.login', 'auth.local.failed']);
    expect(await actions(`userId=${admin}&to=2026-10-31`)).toEqual(['space.create', 'auth.login']);
    expect(await actions('target=cible-1')).toEqual(['space.create', 'auth.login']);
    expect(await actions('outcome=failure')).toEqual(['auth.denied', 'auth.local.failed']);
    expect(await actions('from=2026-10-02&to=2026-10-03')).toEqual(['authx.other', 'auth.login']);
    expect(await actions('from=2026-10-02T12:00:00Z&to=2026-10-03T12:00:00Z')).toEqual(['auth.login']);
    expect((await api(s, 'GET', '/admin/audit/events?from=2026-10-05&to=2026-10-01')).statusCode).toBe(400);
    expect((await api(s, 'GET', '/admin/audit/events?action=auth%27%20OR%201=1')).statusCode).toBe(400);
    expect((await api(s, 'GET', '/admin/audit/events?from=hier')).statusCode).toBe(400);
  });

  it('pagine par curseur et refuse un curseur forgé', async () => {
    await boot();
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    for (let i = 0; i < 7; i++) row('space.create', { target: `s${i}` });
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(s, 'GET', `/admin/audit/events?action=space.create&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: number }[]; nextCursor: string | null };
      seen.push(...body.items.map((e) => e.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    const forged = [
      'pas-du-base64-json',
      Buffer.from(JSON.stringify({ i: 'x' })).toString('base64url'),
      Buffer.from(JSON.stringify({ i: -1 })).toString('base64url'),
      Buffer.from(JSON.stringify({ i: 1, extra: "1 OR 1=1" })).toString('base64url'),
    ];
    for (const c of forged) expect((await api(s, 'GET', `/admin/audit/events?cursor=${c}`)).statusCode).toBe(400);
  });

  it('renvoie le format stable et garde la forme historique', async () => {
    await boot();
    const admin = await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    row('page.destroy', { user: admin, target: 'p1', ip: '203.0.113.9', meta: { title: 'Plan secret', count: 2 } });
    const e = (await api(s, 'GET', '/admin/audit/events?action=page.destroy')).json().items[0];
    expect(e).toMatchObject({ schema: 'notabene.audit/1', action: 'page.destroy', outcome: 'success', actor: { id: admin, name: 'a' }, target: 'p1', ip: '203.0.113.9', meta: { count: 2 } });
    expect(e.meta.title).toBeUndefined();
    expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
    const legacy = (await api(s, 'GET', '/admin/audit?limit=200')).json();
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy[0]).toMatchObject({ action: 'page.destroy', user: 'a', target: 'p1' });
    expect(typeof legacy[0].meta).toBe('string');
    expect((await api(s, 'GET', '/admin/audit?action=auth.')).json().every((r: { action: string }) => r.action.startsWith('auth.'))).toBe(true);
  });
});

describe('journal d’audit : contenu transmis', () => {
  it('retire secrets et textes de `meta`, garde booléens et nombres', () => {
    expect(sanitizeMeta(JSON.stringify({ password: 'p', apiKey: 'k', token: 't', clientSecret: 's', title: 'T', content: 'c', message: 'm', keyChanged: true, password2: 1, count: 3, role: 'admin' })))
      .toEqual({ keyChanged: true, password2: 1, count: 3, role: 'admin' });
    expect(sanitizeMeta(JSON.stringify({ user: { password: true, token: 'x', name: 'n' } }))).toEqual({ user: { password: true, name: 'n' } });
    expect(sanitizeMeta(JSON.stringify({ long: 'x'.repeat(500) }))!.long).toHaveLength(201);
    // Sans ancre de fin : pluriels et composés, empreintes, codes, clés, chemins, noms de fichier et d'utilisateur.
    expect(sanitizeMeta(JSON.stringify({ tokens: ['a'], secretsChanged: ['password'], passwordHash: 'h', otpCode: '123456', sshKey: 'k', keys: 'k', filePaths: ['/a'], path: '/etc', filename: 'x.md', username: 'bob', titles: 't', skipped: 2 })))
      .toEqual({ skipped: 2 });
    expect(sanitizeMeta('pas du json')).toBeNull();
    expect(sanitizeMeta('[1,2]')).toBeNull();
  });

  it('classe les échecs', () => {
    const base = { id: 1, at: 0, user_id: null, user_name: null, target: null, ip: null, meta: null };
    expect(toAuditEvent({ ...base, action: 'auth.reauth.failed' }).outcome).toBe('failure');
    expect(toAuditEvent({ ...base, action: 'auth.denied' }).outcome).toBe('failure');
    expect(toAuditEvent({ ...base, action: 'auth.login' }).outcome).toBe('success');
  });

  it('neutralise les formules dans les cellules CSV', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(bad)).toBe(`"'${bad}"`);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
  });
});

describe('journal d’audit : export', () => {
  it('exporte en CSV sûr, en flux, et journalise l’export sans contenu', async () => {
    await boot();
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    row('space.create', { target: '=HYPERLINK("https://evil.example","x")', meta: { visibility: '@cmd' } });
    row('space.create', { target: 'normal' });
    const res = await api(s, 'GET', '/admin/audit/export?format=csv&action=space.create');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="journal-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['x-export-rows']).toBe('2');
    expect(res.headers['x-export-truncated']).toBe('false');
    const lines = res.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('id,timestamp,action,outcome,actor_id,actor_name,target,ip,meta');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(lines.slice(1).every((l) => !/(^|,)"[=+\-@]/.test(l))).toBe(true);
    const logged = db.prepare("SELECT meta FROM audit_log WHERE action = 'audit.export'").get() as { meta: string };
    expect(JSON.parse(logged.meta)).toEqual({ format: 'csv', rows: 2, truncated: false, filters: ['action'] });
  });

  it('exporte en JSON au format stable', async () => {
    await boot();
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    for (let i = 0; i < 5; i++) row('page.label.add', { target: `p${i}`, meta: { name: 'x' } });
    const res = await api(s, 'GET', '/admin/audit/export?format=json&action=page.label.add');
    expect(res.headers['content-type']).toContain('application/json');
    const items = JSON.parse(res.body) as { schema: string; target: string }[];
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ schema: 'notabene.audit/1', target: 'p4' });
    expect((await api(s, 'GET', '/admin/audit/export?format=xml')).statusCode).toBe(400);
    // L'export n'est pas dans son propre résultat.
    const all = JSON.parse((await api(s, 'GET', '/admin/audit/export?format=json')).body) as { action: string }[];
    expect(all.filter((e) => e.action === 'audit.export')).toHaveLength(1);
  });
});

describe('durées de conservation', () => {
  it('renvoie les durées effectives avec une description', async () => {
    await boot({ AUDIT_RETENTION_DAYS: '10', AUDIT_IP_RETENTION_DAYS: '0', TRASH_RETENTION_DAYS: '7' });
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const body = (await api(s, 'GET', '/admin/retention')).json() as { items: { key: string; days: number; purged: boolean; description: string }[]; fixed: unknown[] };
    const by = Object.fromEntries(body.items.map((i) => [i.key, i]));
    expect(by.AUDIT_RETENTION_DAYS).toMatchObject({ days: 10, purged: true });
    expect(by.AUDIT_IP_RETENTION_DAYS).toMatchObject({ days: 0, purged: false });
    expect(by.TRASH_RETENTION_DAYS!.days).toBe(7);
    expect(by.NOTIFICATION_RETENTION_DAYS!.days).toBe(90);
    expect(by.AI_CHAT_RETENTION_DAYS!.days).toBe(90);
    expect(body.items.every((i) => i.description.length > 10)).toBe(true);
    expect(body.fixed.length).toBeGreaterThan(0);
  });
});

describe('sortie standard', () => {
  it('écrit une ligne JSON par évènement quand AUDIT_STDOUT=true', async () => {
    await boot({ AUDIT_STDOUT: 'true' });
    row('space.create', { target: 's1', meta: { title: 'Ne pas sortir' } });
    await app.auditForwarder.tick();
    const events = stdout.map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ schema: 'notabene.audit/1', action: 'space.create', target: 's1', meta: {} });
    await app.auditForwarder.tick();
    expect(stdout).toHaveLength(1);
  });

  it('reste muette par défaut', async () => {
    await boot();
    row('space.create');
    await app.auditForwarder.tick();
    expect(stdout).toHaveLength(0);
  });
});

interface Received { headers: IncomingHttpHeaders; body: string }
async function collector(status: () => number = () => 204) {
  const received: Received[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = status(); res.end('ok'); });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, received };
}
const eventsOf = (rs: Received[], type = 'audit.events') =>
  rs.map((r) => JSON.parse(r.body) as { type: string; events: { action: string; target: string | null; meta: Record<string, unknown> | null }[] })
    .filter((b) => b.type === type).flatMap((b) => b.events);

async function configure(s: Session, url: string, actions: string[] = [], secret: string | undefined = SECRET) {
  const body = { config: { enabled: true, url, actions }, secrets: secret === undefined ? {} : { secret }, reauth };
  const test = (await api(s, 'POST', '/admin/settings/siem/test', body)).json();
  expect(test.ok).toBe(true);
  const put = await api(s, 'PUT', '/admin/settings/siem', { ...body, testId: test.testId });
  expect(put.statusCode).toBe(200);
  return put;
}
const disable = async (s: Session) => {
  const body = { config: { enabled: false }, reauth };
  const { testId } = (await api(s, 'POST', '/admin/settings/siem/test', body)).json();
  const off = await api(s, 'PUT', '/admin/settings/siem', { ...body, testId });
  expect(off.statusCode).toBe(200);
};
const unblock = () => {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'audit:siem:state'").get() as { value: string };
  db.prepare("UPDATE settings SET value = ? WHERE key = 'audit:siem:state'").run(JSON.stringify({ ...JSON.parse(r.value), nextAttemptAt: null }));
};
const siemStatus = async (s: Session) => (await api(s, 'GET', '/admin/audit/siem')).json();

async function adminSession(extra: Record<string, string> = {}) {
  await boot({ WEBHOOK_ALLOW_PRIVATE: 'true', ...extra });
  await addUser('a@example.com', 'admin');
  return login('a@example.com');
}

describe('envoi au SIEM', () => {
  it('signe les évènements, filtre par famille et ne renvoie jamais le secret', async () => {
    const s = await adminSession();
    const { url, received } = await collector();
    const put = await configure(s, url, ['space', 'auth.local']);
    expect(received).toHaveLength(1); // évènement de test
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: 'audit.test', events: [{ action: 'audit.siem.test' }] });
    expect(put.body).not.toContain(SECRET);
    expect((await api(s, 'GET', '/admin/settings')).body).not.toContain(SECRET);
    await app.auditForwarder.tick(); // l'entrée settings.siem est écartée par le filtre ; pas d'historique antérieur
    expect(received).toHaveLength(1);

    row('space.create', { target: 's1', meta: { secret: 'fuite', visibility: 'public' } });
    row('page.destroy', { target: 'p1' });
    row('auth.local.failed', { meta: { reason: 'password' } });
    await app.auditForwarder.tick();
    expect(received).toHaveLength(2);
    const { headers, body } = received[1]!;
    expect(headers['x-notabene-event']).toBe('audit.events');
    expect(headers['user-agent']).toBe('Notabene-Audit/1');
    expect(headers['x-notabene-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['x-notabene-signature']).toBe(`sha256=${sign(SECRET, String(headers['x-notabene-timestamp']), body)}`);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ schema: 'notabene.audit/1', type: 'audit.events' });
    expect(payload.events.map((e: { action: string }) => e.action)).toEqual(['space.create', 'auth.local.failed']);
    expect(payload.events[0].meta).toEqual({ visibility: 'public' });
    expect(payload.events[1].outcome).toBe('failure');
    expect(body).not.toContain(SECRET);

    await app.auditForwarder.tick(); // rien de nouveau : rien n'est renvoyé
    expect(received).toHaveLength(2);
    const status = await siemStatus(s);
    expect(status).toMatchObject({ configured: true, active: true, origin: new URL(url).origin, actions: ['space', 'auth.local'], failures: 0, lastStatus: 204, pending: 0, disabled: false });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const auditDump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    expect(auditDump).not.toContain(SECRET);
    expect(auditDump).not.toContain('/hook');
  });

  it('retente sans jamais abandonner et alerte une seule fois après 10 échecs', async () => {
    const s = await adminSession();
    let code = 204;
    const { url, received } = await collector(() => code);
    await configure(s, url, ['space']);
    await app.auditForwarder.tick();
    row('space.create', { target: 'en-attente' });
    code = 500;
    await app.auditForwarder.tick();
    let st = await siemStatus(s);
    expect(st).toMatchObject({ failures: 1, lastStatus: 500, active: true, pending: 1 });
    expect(st.nextAttemptAt).toBeGreaterThan(Date.now());
    const before = received.length;
    await app.auditForwarder.tick(); // délai d'attente : pas de nouvel essai
    expect(received.length).toBe(before);
    for (let i = 0; i < 11; i++) { unblock(); await app.auditForwarder.tick(); }
    st = await siemStatus(s);
    expect(st).toMatchObject({ failures: 12, active: true, disabled: false, pending: 1 });
    expect(st.nextAttemptAt - st.lastAttemptAt).toBeLessThanOrEqual(600_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.siem.failing'").get()).toEqual({ n: 1 });
    code = 204;
    unblock();
    await app.auditForwarder.tick();
    expect(eventsOf(received.slice(before)).map((e) => e.target)).toContain('en-attente');
    expect(await siemStatus(s)).toMatchObject({ failures: 0, pending: 0 });
  });

  it('garde ce qui attend quand la configuration change sans changer d’adresse', async () => {
    const s = await adminSession();
    let code = 204;
    const { url, received } = await collector(() => code);
    await configure(s, url, ['space']);
    await app.auditForwarder.tick();
    code = 500;
    row('space.create', { target: 'avant-changement' });
    await app.auditForwarder.tick();
    code = 204;
    await configure(s, url, [], undefined); // même adresse : secret conservé, familles élargies
    await app.auditForwarder.tick();
    const actions = eventsOf(received).map((e) => e.target ?? e.action);
    expect(actions).toContain('avant-changement');
    expect(eventsOf(received).map((e) => e.action)).toContain('settings.siem'); // l'entrée de configuration est envoyée
  });

  it('change de collecteur sans trou : reste et arrêt à l’ancien, départ avant l’entrée de configuration pour le nouveau', async () => {
    const s = await adminSession();
    const a = await collector();
    const b = await collector();
    await configure(s, a.url);
    await app.auditForwarder.tick();
    row('space.create', { target: 'pour-a' });
    await configure(s, b.url);
    expect(eventsOf(a.received).map((e) => e.target)).toContain('pour-a');
    expect(eventsOf(a.received, 'audit.stop').map((e) => e.action)).toEqual(['audit.siem.stop']);
    await app.auditForwarder.tick();
    const toB = eventsOf(b.received);
    expect(toB[0]!.action).toBe('settings.siem');
    expect(toB.map((e) => e.target)).not.toContain('pour-a');
  });

  it('envoie un arrêt à la désactivation et reprend sans trou à la réactivation', async () => {
    const s = await adminSession();
    const { url, received } = await collector();
    await configure(s, url);
    await app.auditForwarder.tick();
    await disable(s);
    expect(eventsOf(received, 'audit.stop')).toHaveLength(1);
    row('space.create', { target: 'pendant-arret' });
    expect(await siemStatus(s)).toMatchObject({ configured: false, active: false });
    await configure(s, url);
    await app.auditForwarder.tick();
    const after = eventsOf(received).map((e) => e.target ?? e.action);
    expect(after).toContain('pendant-arret');
    expect(eventsOf(received).filter((e) => e.action === 'settings.siem')).toHaveLength(3); // activation, arrêt, réactivation
  });

  it('enchaîne les lots et coupe un corps trop gros sans jamais bloquer', async () => {
    const s = await adminSession();
    const { url, received } = await collector();
    await configure(s, url, ['space']);
    await app.auditForwarder.tick();
    received.length = 0;
    for (let i = 0; i < 250; i++) row('space.create', { target: `t${i}` });
    row('space.create', { target: 'x'.repeat(200_000) }); // évènement géant : tronqué, jamais bloquant
    for (let i = 0; i < 40; i++) row('space.create', { target: `${i}-${'y'.repeat(30_000)}` });
    await app.auditForwarder.tick();
    const evs = eventsOf(received);
    expect(evs).toHaveLength(291);
    expect(received.length).toBeGreaterThanOrEqual(4);
    expect(received.every((r) => Buffer.byteLength(r.body) <= 1_000_000)).toBe(true);
    const giant = evs[250]!;
    expect(giant.meta).toEqual({ truncated: true });
    expect(giant.target!.length).toBeLessThan(400);
    expect(await siemStatus(s)).toMatchObject({ pending: 0 });
  });

  it('rogne le secret au test comme à l’enregistrement et exige 16 caractères utiles', async () => {
    const s = await adminSession();
    const { url, received } = await collector();
    await configure(s, url, [], `  ${SECRET}  `);
    const h = received[0]!.headers;
    expect(h['x-notabene-signature']).toBe(`sha256=${sign(SECRET, String(h['x-notabene-timestamp']), received[0]!.body)}`);
    row('space.create');
    await app.auditForwarder.tick();
    const last = received.at(-1)!;
    expect(last.headers['x-notabene-signature']).toBe(`sha256=${sign(SECRET, String(last.headers['x-notabene-timestamp']), last.body)}`);
    const padded = await api(s, 'POST', '/admin/settings/siem/test', { config: { enabled: true, url }, secrets: { secret: `   court${' '.repeat(20)}` }, reauth });
    expect(padded.statusCode).toBe(400);
  });

  it('exige la ressaisie et refuse les adresses internes et les familles invalides', async () => {
    await boot();
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const http = await api(s, 'POST', '/admin/settings/siem/test', { config: { enabled: true, url: 'http://siem.example.com/h' }, secrets: { secret: SECRET }, reauth });
    expect(http.statusCode).toBe(400);
    const internal = (await api(s, 'POST', '/admin/settings/siem/test', { config: { enabled: true, url: 'https://127.0.0.1/h' }, secrets: { secret: SECRET }, reauth })).json();
    expect(internal.ok).toBe(false);
    expect((await api(s, 'POST', '/admin/settings/siem/test', { config: { enabled: true, url: 'https://siem.example.com/h' }, secrets: { secret: 'court' }, reauth })).statusCode).toBe(400);
    const noReauth = await api(s, 'PUT', '/admin/settings/siem', { config: { enabled: true, url: 'https://siem.example.com/h' }, secrets: { secret: SECRET }, reauth: { password: 'faux' } });
    expect(noReauth.statusCode).toBe(401);
    const badFamily = await api(s, 'POST', '/admin/settings/siem/test', { config: { enabled: true, url: 'https://siem.example.com/h', actions: ['auth%'] }, secrets: { secret: SECRET }, reauth });
    expect(badFamily.statusCode).toBe(400);
    expect(await siemStatus(s)).toMatchObject({ configured: false, active: false });
  });

  it('valide et met en minuscules SIEM_ACTIONS de l’environnement', () => {
    const cfg = loadConfig({ ...baseEnv, SIEM_ACTIONS: 'Auth, Settings.,space' });
    expect(cfg.SIEM_ACTIONS).toEqual(['auth', 'settings', 'space']);
    expect(() => loadConfig({ ...baseEnv, SIEM_ACTIONS: 'auth,a..b' })).toThrow(/SIEM_ACTIONS/);
    expect(() => loadConfig({ ...baseEnv, SIEM_ACTIONS: 'auth%' })).toThrow(/SIEM_ACTIONS/);
  });

  it('borne le délai entre deux essais', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(20)).toBe(600_000);
  });
});

describe('journal d’audit : imports', () => {
  it('ne journalise que des compteurs pour un import Markdown', async () => {
    await boot();
    await addUser('a@example.com', 'admin');
    const s = await login('a@example.com');
    const space = (await api(s, 'POST', '/spaces', { name: 'Commun' })).json() as { id: string };
    const res = await api(s, 'POST', '/admin/import/markdown', { spaceId: space.id, files: [{ path: 'dossier/confidentiel-rh.md', content: '# Salut' }] });
    expect(res.statusCode).toBe(200);
    const meta = (db.prepare("SELECT meta FROM audit_log WHERE action = 'import.markdown'").get() as { meta: string }).meta;
    expect(meta).not.toContain('confidentiel');
    expect(Object.values(JSON.parse(meta)).every((v) => typeof v === 'number' || (typeof v === 'object' && v !== null))).toBe(true);
  });
});
