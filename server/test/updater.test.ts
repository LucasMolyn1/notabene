import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { UpdateChecker } from '../src/lib/update-check.js';
import { readUpdater, requestUpdate } from '../src/lib/updater.js';

const PASS = 'Sup3r-secret-pass';
let dir: string;
let app: FastifyInstance;
let db: DB;

const status = (over: object = {}, heartbeat = Math.floor(Date.now() / 1000)) =>
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'idle', version: '', message: '', at: 0, heartbeat, ...over }));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nb-upd-')); });
afterEach(async () => { rmSync(dir, { recursive: true, force: true }); await app?.close(); db?.close(); });

describe('lecture du statut de l’hôte', () => {
  it('absent, illisible ou lien symbolique : service indisponible', () => {
    expect(readUpdater(undefined).available).toBe(false);
    expect(readUpdater(dir).available).toBe(false);
    writeFileSync(join(dir, 'status.json'), 'pas du json');
    expect(readUpdater(dir).available).toBe(false);
    rmSync(join(dir, 'status.json'));
    writeFileSync(join(dir, 'autre'), JSON.stringify({ state: 'idle', heartbeat: Math.floor(Date.now() / 1000) }));
    symlinkSync(join(dir, 'autre'), join(dir, 'status.json'));
    expect(readUpdater(dir).available).toBe(false);
  });

  it('signe de vie récent : disponible ; trop ancien : indisponible', () => {
    status({ state: 'success', version: '3.6.0', message: 'ok', at: 1_700_000_000 });
    expect(readUpdater(dir)).toMatchObject({ available: true, state: 'success', version: '3.6.0', message: 'ok', at: 1_700_000_000_000 });
    status({}, Math.floor(Date.now() / 1000) - 600);
    expect(readUpdater(dir).available).toBe(false);
  });

  it('écrit la demande atomiquement et refuse une version piégée', () => {
    requestUpdate(dir, '3.6.0', 'u1');
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))).toMatchObject({ version: '3.6.0', requestedBy: 'u1' });
    expect(() => requestUpdate(dir, '3.6.0; rm -rf /', 'u1')).toThrow();
  });
});

describe('POST /admin/update/apply', () => {
  const env = (extra: object = {}) => ({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', UPDATER_DIR: dir, ...extra });
  const release = { tag_name: 'v9.9.9', html_url: 'https://github.com/o/r/releases/tag/v9.9.9', published_at: null };

  async function boot(role: 'admin' | 'editor' = 'admin', checking = true) {
    db = openDb(':memory:');
    const updateChecker = new UpdateChecker(() => ({ enabled: checking, source: 'env', locked: true }), 'o/r', '3.5.0', async () => release);
    app = await buildApp({ config: loadConfig(env()), db, clientDir: '/nonexistent', updateChecker });
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run('u1', 'local:a@example.com', 'a@example.com', 'A', role, Date.now(), await hashPassword(PASS));
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'a@example.com', password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
  }
  const apply = (s: Awaited<ReturnType<typeof boot>>, payload: object) => app.inject({ method: 'POST', url: '/api/v3/admin/update/apply', ...s, payload });
  const ok = { version: '9.9.9', reauth: { password: PASS } };

  it('dépose la demande (mot de passe exigé, journalisée) quand tout est réuni', async () => {
    status();
    const s = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/update-check', ...s })).json().updater).toMatchObject({ available: true, state: 'idle' });
    expect((await apply(s, { version: '9.9.9', reauth: { password: 'faux' } })).statusCode).toBe(401);
    expect(existsSync(join(dir, 'request.json'))).toBe(false);
    expect((await apply(s, ok)).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).version).toBe('9.9.9');
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'update.request'").get()).toEqual({ n: 1 });
  });

  it('exige le mot de passe même dans la fenêtre de 10 minutes', async () => {
    status();
    const s = await boot();
    await app.inject({ method: 'PUT', url: '/api/v3/admin/update-check/settings', ...s, payload: { enabled: true, reauth: { password: PASS } } }).catch(() => null);
    expect((await apply(s, { version: '9.9.9', reauth: {} })).statusCode).toBe(401);
  });

  it('refuse sans service hôte, pendant une mise à jour, pour une autre version, hors administrateur, vérification coupée', async () => {
    const s = await boot();
    expect((await apply(s, ok)).statusCode).toBe(409); // pas de status.json
    status({ state: 'running' });
    expect((await apply(s, ok)).json().detail).toMatch(/déjà en cours/);
    status();
    expect((await apply(s, { ...ok, version: '9.9.8' })).json().detail).toMatch(/dernière version/);
    expect((await apply(s, { ...ok, version: '3.5.0; id' })).statusCode).toBe(400);
    expect(existsSync(join(dir, 'request.json'))).toBe(false);
    await app.close(); db.close();
    status();
    const ed = await boot('editor');
    expect((await apply(ed, ok)).statusCode).toBe(403);
    await app.close(); db.close();
    const off = await boot('admin', false);
    expect((await apply(off, ok)).statusCode).toBe(409);
    mkdirSync(join(dir, 'x'), { recursive: true });
  });
});
