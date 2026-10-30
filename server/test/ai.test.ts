import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

let app: FastifyInstance;
let db: DB;
let provider: Server | undefined;
const seen: { path: string; auth: string | undefined }[] = [];

// Faux fournisseur compatible OpenAI : enregistre les en-têtes reçus.
async function fakeProvider(): Promise<string> {
  provider = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'llama3.1:8b' }, { id: 'gpt-4o' }, { id: 'mistral-large-latest' }, { id: 'mauvais nom !' }] }));
  });
  await new Promise<void>((ok) => provider!.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
}

async function boot(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  seen.length = 0;
  app = await buildApp({ config: loadConfig({ ...env, ...extra }), db, clientDir: '/nonexistent' });
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run('adm', 'local:a@example.com', 'a@example.com', 'Admin', 'admin', Date.now(), await hashPassword(PASS));
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'a@example.com', password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
const put = (s: Awaited<ReturnType<typeof boot>>, payload: object) =>
  app.inject({ method: 'PUT', url: '/api/v3/admin/ai', ...s, payload: { reauth: { password: PASS }, ...payload } });
const models = (s: Awaited<ReturnType<typeof boot>>, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v3/admin/ai/models', ...s, payload });

afterEach(async () => {
  await app.close();
  db.close();
  await new Promise<void>((ok) => (provider ? provider.close(() => ok()) : ok()));
  provider = undefined;
});

describe('fournisseur IA : protection de la clé d’API', () => {
  it('exige la ressaisie du mot de passe', async () => {
    const s = await boot();
    const res = await app.inject({ method: 'PUT', url: '/api/v3/admin/ai', ...s, payload: { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-0123456789' } });
    expect(res.statusCode).toBe(401);
    expect((await put(s, { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-0123456789' })).statusCode).toBe(200);
  });

  it('exige de ressaisir la clé quand le fournisseur ou l’adresse change', async () => {
    const s = await boot();
    expect((await put(s, { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-0123456789' })).statusCode).toBe(200);
    const moved = await put(s, { enabled: true, provider: 'openai', baseUrl: 'https://93.184.216.34/v1', model: 'gpt-4o-mini' });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().detail).toMatch(/ressaisissez/i);
    // Même destination : la clé reste.
    expect((await put(s, { enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5' })).statusCode).toBe(200);
  });

  it('refuse une adresse interne ou en clair sans AI_ALLOW_PRIVATE', async () => {
    const s = await boot();
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'https://127.0.0.1/v1', 'http://ollama:11434/v1']) {
      const res = await put(s, { enabled: true, provider: 'openai', baseUrl, model: 'llama3.1:8b' });
      expect(res.statusCode, baseUrl).toBe(400);
    }
    expect((await models(s, { provider: 'openai', baseUrl: 'https://127.0.0.1/v1' })).statusCode).toBe(400);
  });
});

describe('fournisseur IA : liste des modèles', () => {
  it('liste les modèles d’un serveur local quand AI_ALLOW_PRIVATE est actif', async () => {
    const base = await fakeProvider();
    const s = await boot({ AI_ALLOW_PRIVATE: 'true' });
    const res = await models(s, { provider: 'openai', baseUrl: base });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual(['gpt-4o', 'llama3.1:8b', 'mistral-large-latest']);
  });

  it('n’envoie la clé enregistrée qu’à l’adresse enregistrée', async () => {
    const base = await fakeProvider();
    const s = await boot({ AI_ALLOW_PRIVATE: 'true' });
    expect((await put(s, { enabled: true, provider: 'openai', baseUrl: base, model: 'gpt-4o', apiKey: 'cle-secrete-1234' })).statusCode).toBe(200);

    expect((await models(s, { provider: 'openai', baseUrl: base })).statusCode).toBe(200);
    expect(seen.at(-1)?.auth).toBe('Bearer cle-secrete-1234');

    // Autre adresse (ici le même hôte, autre chemin) sans clé saisie : la clé enregistrée ne part pas.
    expect((await models(s, { provider: 'openai', baseUrl: `${base}/autre` })).statusCode).toBe(200);
    expect(seen.at(-1)?.path).toContain('/autre/models');
    expect(seen.at(-1)?.auth).toBeUndefined();
  });

  it('réserve la liste aux administrateurs', async () => {
    const s = await boot();
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run('ed', 'local:e@example.com', 'e@example.com', 'Ed', 'editor', Date.now(), '-');
    const editor = await app.inject({ method: 'POST', url: '/api/v3/admin/ai/models', payload: { provider: 'anthropic' } });
    expect([401, 403]).toContain(editor.statusCode);
    expect(s.cookies.nb_session).toBeTruthy();
  });
});
