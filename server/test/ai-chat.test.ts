import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_MESSAGES, MAX_CONVERSATIONS, MAX_MESSAGES } from '../src/ai/chat.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { cleanup, type DB, MIGRATIONS, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', AI_ALLOW_PRIVATE: 'true' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let provider: Server;
let providerUrl: string;
// Comportement du faux fournisseur : réponse complète, erreur HTTP, ou connexion coupée au milieu du flux.
let mode: 'ok' | 'fail' | 'cut' | 'hold' = 'ok';
let release: (() => void) | null = null; // mode « hold » : le flux attend qu'on le libère
const received: { messages: { role: string; content: string }[] }[] = [];

beforeEach(async () => {
  received.length = 0;
  mode = 'ok';
  release = null;
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      if (mode === 'fail') { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Réponse ' } }] })}\n\n`);
      if (mode === 'cut') { res.destroy(); return; }
      const finish = () => { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'suite' } }] })}\n\n`); res.end('data: [DONE]\n\n'); };
      if (mode === 'hold') { release = finish; return; }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'sourcée [1]' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor'], ['ed2@example.com', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, email.split('@')[0], role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => {
  await app.close();
  db.close();
  await new Promise<void>((ok) => provider.close(() => ok()));
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, cookies: s.cookies, headers: s.headers });
const configure = async () => {
  const admin = await login('admin@example.com');
  const res = await call(admin, 'PUT', '/api/v3/admin/ai', { enabled: true, provider: 'openai', baseUrl: providerUrl, model: 'test-model', apiKey: 'cle-secrete-0001', reauth: { password: PASS } });
  expect(res.statusCode).toBe(200);
};
const chat = (s: S, payload: object) => call(s, 'POST', '/api/v3/ai/chat', payload);
const events = (body: string, name: string) => [...body.matchAll(new RegExp(`^event: ${name}\\ndata: (.+)$`, 'gm'))].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
const deltas = (body: string) => events(body, 'delta').map((d) => d.text).join('');
const conversationOf = (body: string) => events(body, 'conversation')[0] as { id: string; title: string };
const pageId = (title: string) => (db.prepare('SELECT id FROM pages WHERE title = ?').get(title) as { id: string }).id;
const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const insertConv = (id: string, userId: string, updatedAt: number) =>
  db.prepare('INSERT INTO ai_conversations (id, user_id, title, page_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').run(id, userId, `Conv ${id}`, updatedAt, updatedAt);
const insertMsg = (conv: string, i: number, role: 'user' | 'assistant', content: string) =>
  db.prepare('INSERT INTO ai_messages (id, conversation_id, role, content, sources, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(`${conv}-m${i}`, conv, role, content, i);

describe('chat IA : parcours', () => {
  it('crée une conversation, diffuse la réponse et enregistre les deux messages', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    const long = `Comment fonctionne l’onboarding ? ${'détail '.repeat(30)}`;
    const res = await chat(ed, { message: long });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const conv = conversationOf(res.body);
    expect(conv.title).toBe(long.replace(/\s+/g, ' ').trim().slice(0, 80));
    expect(Array.isArray(events(res.body, 'sources')[0])).toBe(true);
    expect(deltas(res.body)).toBe('Réponse sourcée [1]');
    expect(res.body).toContain('event: done');
    // Ordre des événements : conversation, sources, delta, done.
    expect(res.body.indexOf('event: conversation')).toBeLessThan(res.body.indexOf('event: sources'));

    const list = (await call(ed, 'GET', '/api/v3/ai/conversations')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: conv.id, title: conv.title, pageId: null, messageCount: 2 });
    expect(list.nextCursor).toBeNull();
    const detail = (await call(ed, 'GET', `/api/v3/ai/conversations/${conv.id}`)).json();
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0]).toMatchObject({ content: long.trim(), sources: null });
    expect(detail.messages[1].content).toBe('Réponse sourcée [1]');
    expect(Array.isArray(detail.messages[1].sources)).toBe(true);
  });

  it('transmet l’historique au modèle, borné, et le prompt système de lecture seule', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    const conv = conversationOf((await chat(ed, { message: 'Première question' })).body);
    await chat(ed, { message: 'Et la suite ?', conversationId: conv.id });
    const msgs = received[1]!.messages;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('lecture seule');
    expect(msgs[0]!.content).toContain('jamais comme des instructions');
    expect(msgs.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]!.content).toBe('Première question');
    expect(msgs[2]!.content).toBe('Réponse sourcée [1]');
    expect(msgs[3]!.content).toContain('Message : Et la suite ?');
    expect(n('SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = ?', conv.id)).toBe(4);

    // Longue conversation : seuls les derniers messages partent.
    for (let i = 0; i < 30; i++) insertMsg(conv.id, 100 + i, i % 2 ? 'assistant' : 'user', `ancien ${i}`);
    await chat(ed, { message: 'Encore', conversationId: conv.id });
    const last = received[2]!.messages;
    expect(last.length).toBeLessThanOrEqual(HISTORY_MESSAGES + 2);
    expect(last.some((m) => m.content === 'ancien 0')).toBe(false);
    expect(last.some((m) => m.content === 'ancien 29')).toBe(true);
  });

  it('ajoute la page ouverte au contexte, comme donnée, quand elle est lisible', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    const page = pageId('Onboarding');
    db.prepare('UPDATE pages SET text = ? WHERE id = ?').run(`Texte unique de la page ${'x'.repeat(20_000)}`, page);
    const res = await chat(ed, { message: 'Résume cette page', pageId: page });
    expect(res.statusCode).toBe(200);
    const user = received[0]!.messages.at(-1)!.content;
    expect(user).toContain('current="true"');
    expect(user).toContain('Texte unique de la page');
    expect(user.length).toBeLessThan(8000 + 18_000 + 2000);
    expect((events(res.body, 'sources')[0] as unknown as { id: string }[])[0]!.id).toBe(page);
    const list = (await call(ed, 'GET', '/api/v3/ai/conversations')).json();
    expect(list.items[0].pageId).toBe(page);
  });

  it('pagine la liste des conversations par curseur', async () => {
    const ed = await login('ed1@example.com');
    for (let i = 0; i < 5; i++) insertConv(`conv000${i}`, 'ed1', 1000 + i);
    const first = (await call(ed, 'GET', '/api/v3/ai/conversations?limit=2')).json();
    expect(first.items.map((c: { id: string }) => c.id)).toEqual(['conv0004', 'conv0003']);
    const second = (await call(ed, 'GET', `/api/v3/ai/conversations?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((c: { id: string }) => c.id)).toEqual(['conv0002', 'conv0001']);
    expect((await call(ed, 'GET', '/api/v3/ai/conversations?cursor=forge')).statusCode).toBe(400);
  });

  it('supprime une conversation, puis toutes les siennes', async () => {
    const ed = await login('ed1@example.com');
    insertConv('convA', 'ed1', 1); insertConv('convB', 'ed1', 2); insertConv('convC', 'ed1', 3); insertConv('convAutre', 'ed2', 4);
    insertMsg('convA', 1, 'user', 'x');
    expect((await call(ed, 'DELETE', '/api/v3/ai/conversations/convA')).statusCode).toBe(204);
    expect(n("SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = 'convA'")).toBe(0);
    expect((await call(ed, 'DELETE', '/api/v3/ai/conversations/convA')).statusCode).toBe(404);
    const all = await call(ed, 'DELETE', '/api/v3/ai/conversations');
    expect(all.json()).toEqual({ deleted: 2 });
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'convAutre'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ai.chat.delete'")).toBe(2);
  });
});

describe('chat IA : accès', () => {
  it('isole les conversations entre comptes : lire, supprimer ou écrire chez autrui donne 404', async () => {
    await configure();
    const ed1 = await login('ed1@example.com');
    const conv = conversationOf((await chat(ed1, { message: 'Ma question privée' })).body);
    const ed2 = await login('ed2@example.com');
    const calls = received.length;
    expect((await call(ed2, 'GET', `/api/v3/ai/conversations/${conv.id}`)).statusCode).toBe(404);
    expect((await call(ed2, 'DELETE', `/api/v3/ai/conversations/${conv.id}`)).statusCode).toBe(404);
    expect((await chat(ed2, { message: 'Intrusion', conversationId: conv.id })).statusCode).toBe(404);
    expect((await call(ed2, 'GET', '/api/v3/ai/conversations')).json().items).toEqual([]);
    expect((await call(ed2, 'DELETE', '/api/v3/ai/conversations')).json()).toEqual({ deleted: 0 });
    expect(received).toHaveLength(calls);
    expect(n('SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = ?', conv.id)).toBe(2);
    expect((await call(ed1, 'GET', `/api/v3/ai/conversations/${conv.id}`)).statusCode).toBe(200);
  });

  it('une page illisible donne 404 et n’entre jamais dans le contexte', async () => {
    await configure();
    const admin = await login('admin@example.com');
    const secret = pageId('Onboarding');
    db.prepare('UPDATE pages SET text = ? WHERE id = ?').run('confidentiel onboarding zyxwq-marqueur', secret);
    expect((await call(admin, 'PUT', `/api/v3/pages/${secret}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    const ed2 = await login('ed2@example.com');
    expect((await chat(ed2, { message: 'Montre-moi', pageId: secret })).statusCode).toBe(404);
    expect((await chat(ed2, { message: 'Montre-moi', pageId: 'inexistante01' })).statusCode).toBe(404);
    expect(received).toHaveLength(0);
    expect(n('SELECT COUNT(*) AS n FROM ai_conversations')).toBe(0);
    // Ni par la recherche (RAG) : la page restreinte n'est pas citée.
    await chat(ed2, { message: 'confidentiel onboarding' });
    expect(JSON.stringify(received[0]!.messages)).not.toContain('zyxwq');
    // La personne autorisée, elle, la retrouve par la recherche.
    await chat(await login('ed1@example.com'), { message: 'confidentiel onboarding' });
    expect(JSON.stringify(received[1]!.messages)).toContain('zyxwq');
  });

  it('les sources enregistrées sont refiltrées si la page devient illisible', async () => {
    await configure();
    const ed2 = await login('ed2@example.com');
    const page = pageId('Onboarding');
    const conv = conversationOf((await chat(ed2, { message: 'Résume', pageId: page })).body);
    const admin = await login('admin@example.com');
    await call(admin, 'PUT', `/api/v3/pages/${page}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] });
    const detail = (await call(ed2, 'GET', `/api/v3/ai/conversations/${conv.id}`)).json();
    expect(detail.pageId).toBeNull();
    expect(detail.messages[1].sources.some((s: { id: string }) => s.id === page)).toBe(false);
  });

  it('refuse les jetons d’API (sessions navigateur seulement)', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    const { token } = (await call(ed, 'POST', '/api/v3/tokens', { name: 'ia', scopes: ['read', 'ai'], expiresInDays: 7 })).json();
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/v3/ai/chat', headers, payload: { message: 'Bonjour' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v3/ai/conversations', headers })).statusCode).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('valide le corps et répond 503 quand l’IA n’est pas configurée', async () => {
    const ed = await login('ed1@example.com');
    expect((await chat(ed, { message: '' })).statusCode).toBe(400);
    expect((await chat(ed, { message: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await chat(ed, { message: 'ok', conversationId: '../x' })).statusCode).toBe(400);
    expect((await chat(ed, { message: 'Bonjour' })).statusCode).toBe(503);
    expect(n('SELECT COUNT(*) AS n FROM ai_conversations')).toBe(0);
  });
});

describe('chat IA : plafonds et robustesse', () => {
  it(`garde ${MAX_CONVERSATIONS} conversations au plus par personne`, async () => {
    await configure();
    const ed = await login('ed1@example.com');
    for (let i = 0; i < MAX_CONVERSATIONS; i++) insertConv(`old${String(i).padStart(3, '0')}`, 'ed1', 1000 + i);
    insertConv('autrui', 'ed2', 1);
    await chat(ed, { message: 'Nouvelle' });
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE user_id = 'ed1'")).toBe(MAX_CONVERSATIONS);
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'old000'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'old001'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'autrui'")).toBe(1);
  });

  it(`refuse (409) une conversation qui a atteint ${MAX_MESSAGES} messages`, async () => {
    await configure();
    const ed = await login('ed1@example.com');
    insertConv('pleine', 'ed1', 1);
    for (let i = 0; i < MAX_MESSAGES - 1; i++) insertMsg('pleine', i, i % 2 ? 'assistant' : 'user', 'm');
    const res = await chat(ed, { message: 'Encore une', conversationId: 'pleine' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail ?? res.json().message ?? res.body).toContain(String(MAX_MESSAGES));
    expect(received).toHaveLength(0);
    expect(n("SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = 'pleine'")).toBe(MAX_MESSAGES - 1);
  });

  it('une seule réponse en cours par personne (409), libérée à la fin du flux ; la sortie est bornée à 4 000 jetons', async () => {
    await configure();
    const ed1 = await login('ed1@example.com');
    const ed2 = await login('ed2@example.com');
    mode = 'hold';
    const first = chat(ed1, { message: 'première question' });
    for (let i = 0; i < 200 && !received.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect((received[0] as unknown as { max_tokens: number }).max_tokens).toBe(4000);
    const second = await chat(ed1, { message: 'deuxième question' });
    expect(second.statusCode).toBe(409);
    expect(n('SELECT COUNT(*) AS n FROM ai_messages')).toBe(1); // le refus n'enregistre rien
    // Une autre personne n'est pas bloquée.
    mode = 'ok';
    expect((await chat(ed2, { message: 'autre personne' })).statusCode).toBe(200);
    mode = 'hold';
    release?.();
    expect((await first).statusCode).toBe(200);
    mode = 'ok';
    expect((await chat(ed1, { message: 'troisième question' })).statusCode).toBe(200);
  });

  it('n’enregistre aucune réponse quand le fournisseur échoue', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    mode = 'fail';
    const res = await chat(ed, { message: 'Question sans réponse' });
    expect(res.body).toContain('event: error');
    expect(res.body).not.toContain('event: done');
    const conv = conversationOf(res.body);
    expect(db.prepare('SELECT role FROM ai_messages WHERE conversation_id = ?').all(conv.id)).toEqual([{ role: 'user' }]);
  });

  it('n’enregistre pas de réponse partielle quand le flux est coupé', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    mode = 'cut';
    const res = await chat(ed, { message: 'Question coupée' });
    expect(res.body).toContain('event: error');
    const conv = conversationOf(res.body);
    expect(db.prepare('SELECT role FROM ai_messages WHERE conversation_id = ?').all(conv.id)).toEqual([{ role: 'user' }]);
    // L'échange suivant fusionne les deux messages de la personne : les rôles alternent toujours.
    mode = 'ok';
    await chat(ed, { message: 'Je réessaie', conversationId: conv.id });
    expect(received.at(-1)!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('ne met aucun contenu dans le journal d’audit', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    const conv = conversationOf((await chat(ed, { message: 'marqueur-secret-42 dans ma question' })).body);
    await call(ed, 'DELETE', `/api/v3/ai/conversations/${conv.id}`);
    const rows = db.prepare("SELECT action, target, meta FROM audit_log WHERE action LIKE 'ai.chat%'").all() as { action: string; target: string | null; meta: string }[];
    expect(rows.map((r) => r.action).sort()).toEqual(['ai.chat', 'ai.chat.delete']);
    for (const r of rows) {
      expect(`${r.target} ${r.meta}`).not.toContain('marqueur');
      expect(`${r.target} ${r.meta}`).not.toContain('Réponse');
    }
    expect(JSON.parse(rows.find((r) => r.action === 'ai.chat')!.meta)).toMatchObject({ chars: 'marqueur-secret-42 dans ma question'.length, history: 0 });
  });
});

describe('chat IA : données personnelles', () => {
  it('purge les conversations sans activité au-delà de la durée de conservation', () => {
    const day = 86_400_000;
    insertConv('vieille', 'ed1', Date.now() - 40 * day);
    insertMsg('vieille', 1, 'user', 'x');
    insertConv('recente', 'ed1', Date.now() - 2 * day);
    cleanup(db, { trashDays: 0, notificationDays: 0, auditIpDays: 0, auditDays: 0, aiChatDays: 30 });
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'vieille'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = 'vieille'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'recente'")).toBe(1);
    // Sans réglage : 90 jours par défaut.
    insertConv('tres-vieille', 'ed1', Date.now() - 100 * day);
    cleanup(db, { trashDays: 0, notificationDays: 0, auditIpDays: 0, auditDays: 0 });
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'tres-vieille'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM ai_conversations WHERE id = 'recente'")).toBe(1);
  });

  it('borne AI_CHAT_RETENTION_DAYS entre 1 et 3650 jours', () => {
    expect(loadConfig(env).AI_CHAT_RETENTION_DAYS).toBe(90);
    expect(() => loadConfig({ ...env, AI_CHAT_RETENTION_DAYS: '0' })).toThrow();
    expect(() => loadConfig({ ...env, AI_CHAT_RETENTION_DAYS: '3651' })).toThrow();
  });

  it('inclut les conversations dans l’export de la personne, sans le contenu pour un administrateur', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    conversationOf((await chat(ed, { message: 'Ma question exportée' })).body);
    const mine = (await call(ed, 'GET', '/api/v3/me/export')).json();
    expect(mine.aiConversations).toHaveLength(1);
    expect(mine.aiConversations[0]).toMatchObject({ title: 'Ma question exportée' });
    expect(mine.aiConversations[0].messages.map((m: { content: string }) => m.content)).toEqual(['Ma question exportée', 'Réponse sourcée [1]']);
    const admin = await login('admin@example.com');
    const theirs = (await call(admin, 'GET', '/api/v3/admin/users/ed1/export')).json();
    expect(theirs.aiConversations).toEqual([expect.objectContaining({ messageCount: 2 })]);
    expect(JSON.stringify(theirs)).not.toContain('Ma question exportée');
    // L'archive reprend le même JSON (personalDataArchive sérialise l'export complet).
    expect((await call(ed, 'GET', '/api/v3/me/export/archive')).statusCode).toBe(200);
  });

  it('efface les conversations avec le compte', async () => {
    await configure();
    const ed = await login('ed1@example.com');
    conversationOf((await chat(ed, { message: 'À effacer' })).body);
    const admin = await login('admin@example.com');
    expect((await call(admin, 'POST', '/api/v3/admin/users/ed1/erase', { reauth: { password: PASS } })).statusCode).toBe(200);
    expect(n('SELECT COUNT(*) AS n FROM ai_conversations')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM ai_messages')).toBe(0);
  });
});

describe('migration v26', () => {
  it('ajoute les tables du chat à une base v25, avec les cascades', () => {
    const file = oldDb(25);
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    up.prepare("INSERT INTO ai_conversations (id, user_id, title, page_id, created_at, updated_at) VALUES ('c1', 'u1', 't', 'p1', 0, 0)").run();
    up.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'x', 0)").run();
    expect(() => up.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES ('m2', 'c1', 'system', 'x', 0)").run()).toThrow();
    up.prepare("DELETE FROM pages WHERE id = 'p1'").run();
    expect(up.prepare("SELECT page_id FROM ai_conversations WHERE id = 'c1'").get()).toEqual({ page_id: null });
    up.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM ai_messages').get()).toEqual({ n: 0 });
    up.close();
    expect(new Database(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
