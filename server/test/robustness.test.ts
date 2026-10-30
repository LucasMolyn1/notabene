import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

async function login(role: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = r.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, ...s });

describe('base de données', () => {
  it('refuse de démarrer sur une base plus récente que le serveur', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'nb-schema-'));
    try {
      const file = resolve(dir, 'future.db');
      const raw = new Database(file);
      raw.pragma('user_version = 999');
      raw.close();
      expect(() => openDb(file)).toThrow(/schéma v999/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('corbeille', () => {
  it('se vide même quand un parent et son enfant y sont tous les deux', async () => {
    const admin = await login('admin');
    const space = (db.prepare("SELECT id FROM spaces WHERE visibility = 'private' LIMIT 1").get() as { id: string } | undefined)?.id
      ?? (db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }).id;
    const parent = (await call(admin, 'POST', '/api/v3/pages', { spaceId: space, title: 'parent' })).json().id as string;
    const child = (await call(admin, 'POST', '/api/v3/pages', { spaceId: space, parentId: parent, title: 'enfant' })).json().id as string;
    expect((await call(admin, 'DELETE', `/api/v3/pages/${child}`)).statusCode).toBe(204);
    expect((await call(admin, 'DELETE', `/api/v3/pages/${parent}`)).statusCode).toBe(204);
    expect((await call(admin, 'DELETE', '/api/v3/trash')).statusCode).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pages WHERE id IN (?, ?)').get(parent, child)).toEqual({ n: 0 });
  });
});

describe('santé et arrêt', () => {
  it('répond aux sondes HEAD et OPTIONS sur la racine', async () => {
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
    const options = await app.inject({ method: 'OPTIONS', url: '/' });
    expect(options.statusCode).toBe(204);
    expect(options.headers.allow).toContain('GET');
  });

  it('signale une base inaccessible', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const broken = openDb(':memory:');
    const other = await buildApp({ config: loadConfig(env), db: broken, clientDir: '/nonexistent' });
    broken.close();
    // 503 de la route, ou 500 si une garde en amont a déjà échoué : dans les deux cas le contrôle Docker échoue.
    expect((await other.inject({ method: 'GET', url: '/healthz' })).statusCode).toBeGreaterThanOrEqual(500);
    await other.close();
  });

  it('s’arrête même avec un flux d’événements ouvert', async () => {
    const other = await buildApp({ config: loadConfig(env), db: openDb(':memory:'), clientDir: '/nonexistent' });
    const address = await other.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/api/v3/events`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    const closed = await Promise.race([other.close().then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), 4000))]);
    expect(closed).toBe(true);
  });
});

describe('sauvegarde téléchargée depuis l’interface', () => {
  it('refuse le clair en production sans choix explicite', async () => {
    const admin = await login('admin');
    const saved = { node: process.env.NODE_ENV, rec: process.env.BACKUP_AGE_RECIPIENT, plain: process.env.BACKUP_ALLOW_PLAINTEXT };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.BACKUP_AGE_RECIPIENT;
      delete process.env.BACKUP_ALLOW_PLAINTEXT;
      expect((await call(admin, 'GET', '/api/v3/admin/backup')).statusCode).toBe(409);
      process.env.BACKUP_ALLOW_PLAINTEXT = 'true';
      expect((await call(admin, 'GET', '/api/v3/admin/backup')).statusCode).toBe(200);
    } finally {
      for (const [k, v] of [['NODE_ENV', saved.node], ['BACKUP_AGE_RECIPIENT', saved.rec], ['BACKUP_ALLOW_PLAINTEXT', saved.plain]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
