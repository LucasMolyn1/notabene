import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test',  PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
});
afterEach(async () => { await app.close(); db.close(); });

async function token(role: 'admin' | 'editor' | 'reader', scopes: string[]) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  const t = await app.inject({ method: 'POST', url: '/api/v3/tokens', cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf }, payload: { name: 'mcp', scopes, expiresInDays: 7 } });
  return { Authorization: `Bearer ${t.json().token}` };
}

const call = (headers: Record<string, string>, body: unknown) => app.inject({ method: 'POST', url: '/mcp', headers, payload: body as object });
const rpc = (method: string, params?: object, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('serveur MCP', () => {
  it('exige un jeton Bearer', async () => {
    expect((await call({}, rpc('ping'))).statusCode).toBe(401);
  });

  it('refuse une session navigateur (cookie)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role: 'admin' } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    const r = await app.inject({ method: 'POST', url: '/mcp', cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf }, payload: rpc('ping') });
    expect(r.statusCode).toBe(401);
  });

  it('refuse une origine étrangère', async () => {
    const h = await token('reader', ['read']);
    expect((await call({ ...h, origin: 'https://evil.example' }, rpc('ping'))).statusCode).toBe(403);
  });

  it('initialize puis liste les outils selon les portées', async () => {
    const reader = await token('reader', ['read']);
    const init = (await call(reader, rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
    expect(init.result.serverInfo.name).toBe('notabene');
    const names = (await call(reader, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('search_pages');
    expect(names).not.toContain('create_page');
    const editor = await token('editor', ['read', 'write']);
    expect((await call(editor, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).toContain('create_page');
  });

  it('recherche, lit et crée une page avec les droits du jeton', async () => {
    const editor = await token('editor', ['read', 'write']);
    const spaces = JSON.parse((await call(editor, rpc('tools/call', { name: 'list_spaces', arguments: {} }))).json().result.content[0].text) as { id: string }[];
    const created = (await call(editor, rpc('tools/call', { name: 'create_page', arguments: { spaceId: spaces[0]!.id, title: 'Page MCP', text: '# Titre\n\nbonjour MCP zebre' } }))).json();
    expect(created.result.isError).toBeUndefined();
    const { id } = JSON.parse(created.result.content[0].text);
    const found = (await call(editor, rpc('tools/call', { name: 'search_pages', arguments: { query: 'zebre' } }))).json();
    expect(found.result.content[0].text).toContain(id);
    const page = (await call(editor, rpc('tools/call', { name: 'get_page', arguments: { id } }))).json();
    expect(page.result.content[0].text).toContain('bonjour MCP zebre');
  });

  it('un jeton en lecture ne peut pas écrire', async () => {
    const reader = await token('reader', ['read']);
    const r = (await call(reader, rpc('tools/call', { name: 'create_page', arguments: { spaceId: 'x', title: 't' } }))).json();
    expect(r.error.code).toBe(-32602);
  });

  it('valide les arguments et accepte les notifications', async () => {
    const reader = await token('reader', ['read']);
    const bad = (await call(reader, rpc('tools/call', { name: 'get_page', arguments: { id: '../etc' } }))).json();
    expect(bad.result.isError).toBe(true);
    expect((await call(reader, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await call(reader, [rpc('ping')])).json().error.code).toBe(-32600);
  });
});

describe('versions d’API', () => {
  it('liste les versions et leur état', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
    expect(res.current).toBe('v3');
    expect(res.versions.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([['v1', 'removed'], ['v2', 'removed'], ['v3', 'stable']]);
    for (const v of ['v1', 'v2']) expect((await app.inject({ method: 'GET', url: `/api/${v}/config` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).statusCode).toBe(200);
  });
});
