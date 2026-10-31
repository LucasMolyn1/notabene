// Refus ou troncature signalés par le fournisseur : un avis à part, jamais un morceau du texte à insérer dans la page.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL_NOTICE, TRUNCATED_NOTICE } from '../src/ai/llm.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { seedDemo } from '../src/seed.js';

let chunks: string[] = [];
vi.mock('../src/ai/llm.js', async (original) => ({
  ...(await original<typeof import('../src/ai/llm.js')>()),
  streamCompletion: async function* () { for (const c of chunks) yield c; },
}));

const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', AI_ALLOW_PRIVATE: 'true' }), db, clientDir: '/nonexistent' });
  for (const [email, role] of [['admin@example.com', 'admin'], ['ed1@example.com', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(email.split('@')[0], `local:${email}`, email, email, role, Date.now(), await hashPassword(PASS));
  }
  const team = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('pagelibre001', ?, 'Page', ?, 't', 1, 1)").run(team, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }));
});
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}

describe('assistant de rédaction : avis du fournisseur', () => {
  for (const [name, notice] of [['troncature', TRUNCATED_NOTICE], ['refus', REFUSAL_NOTICE]] as const) {
    it(`${name} : événement « notice », pas dans le texte proposé`, async () => {
      const admin = await login('admin@example.com');
      const put = await app.inject({ method: 'PUT', url: '/api/v3/admin/ai', ...admin, payload: { enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k-0001', reauth: { password: PASS } } });
      expect(put.statusCode).toBe(200);
      chunks = ['Début de réponse', notice];
      const res = await app.inject({ method: 'POST', url: '/api/v3/ai/assist', ...(await login('ed1@example.com')), payload: { pageId: 'pagelibre001', action: 'improve', text: 'Bonjour.' } });
      expect(res.statusCode).toBe(200);
      const deltas = [...res.body.matchAll(/^event: delta\ndata: (.+)$/gm)].map((m) => (JSON.parse(m[1]!) as { text: string }).text).join('');
      expect(deltas).toBe('Début de réponse');
      expect(res.body).toMatch(/event: notice\ndata: \{"message":"[^"]+"\}/);
    });
  }
});
