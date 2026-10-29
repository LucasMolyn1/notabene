import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const base = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;
const logs: string[] = [];

async function boot(legacy?: string) {
  db = openDb(':memory:');
  const config = loadConfig({ ...base, ...(legacy ? { API_LEGACY_VERSIONS: legacy } : {}) });
  app = await buildApp({ config, db, clientDir: '/nonexistent', logger: { level: 'warn', stream: { write: (m: string) => { logs.push(m); } } } as never });
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run('u1', 'local:a@example.com', 'a@example.com', 'A', 'admin', Date.now(), await hashPassword('Sup3r-secret-pass'));
}
afterEach(async () => { await app.close(); db.close(); logs.length = 0; });

describe('versions d’API héritées', () => {
  it('ne sert que la v3 par défaut', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).statusCode).toBe(200);
    for (const v of ['v1', 'v2']) {
      const res = await app.inject({ method: 'GET', url: `/api/${v}/config` });
      expect(res.statusCode, v).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/${v}/pages` })).statusCode).toBe(404);
    }
    const versions = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
    expect(versions.current).toBe('v3');
    expect(versions.versions.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([['v1', 'disabled'], ['v2', 'disabled'], ['v3', 'stable']]);
  });

  it('réactive une version héritée sur demande, avec en-têtes de dépréciation', async () => {
    await boot('v1');
    const v1 = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(v1.statusCode).toBe(200);
    expect(v1.headers.deprecation).toBe('true');
    expect(v1.headers.sunset).toMatch(/2027/);
    expect((await app.inject({ method: 'GET', url: '/api/v2/config' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/versions' })).json().versions[0].status).toBe('deprecated');
  });

  it('journalise l’appelant d’une version héritée, une fois par heure', async () => {
    await boot('v1,v2');
    const hit = () => app.inject({ method: 'GET', url: '/api/v1/config', headers: { 'user-agent': 'script-test/1.0' } });
    await hit(); await hit();
    await app.inject({ method: 'GET', url: '/api/v2/config' });
    const warned = logs.filter((l) => l.includes('version d’API dépréciée'));
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain('script-test/1.0');
    expect(warned[0]).toContain('"legacyApi":"v1"');
  });

  it('refuse une valeur inconnue', () => {
    expect(() => loadConfig({ ...base, API_LEGACY_VERSIONS: 'v4' })).toThrow();
  });

  it('livre toujours les webhooks même sans version héritée', async () => {
    await boot();
    expect(app.printRoutes()).toContain('webhooks');
  });
});
