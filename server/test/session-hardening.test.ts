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

async function boot(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({ ...base, ...extra }), db, clientDir: '/nonexistent' });
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run('u1', 'local:a@example.com', 'a@example.com', 'A', 'admin', Date.now(), await hashPassword('Sup3r-secret-pass'));
}
afterEach(async () => { await app.close(); db.close(); });

const login = (cookies?: Record<string, string>, headers?: Record<string, string>) => app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'a@example.com', password: 'Sup3r-secret-pass' }, cookies, headers });
const cookieOf = (res: Awaited<ReturnType<typeof login>>) => res.cookies.find((c) => c.name === 'nb_session')!.value;

describe('expiration d’inactivité', () => {
  it('ferme une session restée inactive plus que SESSION_IDLE_MINUTES', async () => {
    await boot({ SESSION_IDLE_MINUTES: '30' });
    const cookie = cookieOf(await login());
    const me = () => app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } });
    expect((await me()).json().user).toMatchObject({ id: 'u1' });
    // 29 minutes d'inactivité : encore valide (et l'activité repousse l'échéance).
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 29 * 60_000);
    expect((await me()).json().user).toBeTruthy();
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 31 * 60_000);
    expect((await me()).json().user).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('refuse une valeur trop basse', () => {
    expect(() => loadConfig({ ...base, SESSION_IDLE_MINUTES: '1' })).toThrow();
  });
});

describe('connexion locale', () => {
  it('remplace la session précédente du navigateur', async () => {
    await boot();
    const first = cookieOf(await login());
    const csrf = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: first } })).json().csrf as string;
    const second = cookieOf(await login({ nb_session: first }, { 'x-csrf-token': csrf }));
    expect(second).not.toBe(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});

describe('documentation de l’API', () => {
  it('est réservée aux connectés par défaut', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/docs/json' })).statusCode).toBe(401);
    const cookie = cookieOf(await login());
    expect((await app.inject({ method: 'GET', url: '/api/docs/json', cookies: { nb_session: cookie } })).statusCode).toBe(200);
  });
  it('peut être publique ou désactivée', async () => {
    await boot({ API_DOCS: 'public' });
    expect((await app.inject({ method: 'GET', url: '/api/docs/json' })).statusCode).toBe(200);
    await app.close(); db.close();
    await boot({ API_DOCS: 'off' });
    expect((await app.inject({ method: 'GET', url: '/api/docs/json' })).statusCode).toBe(404);
  });
});
