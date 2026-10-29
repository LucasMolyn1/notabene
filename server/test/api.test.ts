import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { safeReturnTo } from '../src/auth/oidc.js';
import { seedDemo } from '../src/seed.js';

const KEY = randomBytes(32).toString('base64');
const baseEnv = {
  NODE_ENV: 'test', API_LEGACY_VERSIONS: 'v1,v2',
  PUBLIC_URL: 'http://localhost:3000',
  ENCRYPTION_KEY: KEY,
  DEV_LOGIN: 'true',
  SEED_DEMO: 'false',
};

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(baseEnv), db, clientDir: '/nonexistent' });
});
afterEach(async () => {
  await app.close();
  db.close();
});

async function login(role: 'admin' | 'editor' | 'reader') {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!;
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { nb_session: cookie.value } });
  return { cookies: { nb_session: cookie.value }, csrf: me.json().csrf as string, headers: { 'x-csrf-token': me.json().csrf as string } };
}

const spaces = () => db.prepare('SELECT id, visibility FROM spaces ORDER BY position').all() as { id: string; visibility: string }[];
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe('configuration', () => {
  it('refuse DEV_LOGIN en production', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', PUBLIC_URL: 'https://wiki.example.com' })).toThrow(/DEV_LOGIN/);
  });
  it('exige https en production', () => {
    expect(() => loadConfig({
      ...baseEnv, NODE_ENV: 'production', DEV_LOGIN: 'false',
      OIDC_ISSUER: 'https://auth.example.com/application/o/notabene/', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b',
    })).toThrow(/https/);
  });
  it('exige une clé de chiffrement de 32 octets', () => {
    expect(() => loadConfig({ ...baseEnv, ENCRYPTION_KEY: 'court' })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('contrôle d’accès', () => {
  it('un visiteur anonyme ne voit que les espaces publics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/spaces' });
    expect(res.json().every((s: { visibility: string }) => s.visibility === 'public')).toBe(true);
    const priv = spaces().find((s) => s.visibility === 'private')!;
    const pageId = (db.prepare('SELECT id FROM pages WHERE space_id = ?').get(priv.id) as { id: string }).id;
    expect((await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}` })).statusCode).toBe(404);
  });

  it('un lecteur ne peut pas écrire', async () => {
    const s = await login('reader');
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', ...s, payload: { spaceId: spaces()[0].id } });
    expect(res.statusCode).toBe(403);
  });

  it('seul un admin supprime définitivement', async () => {
    const editor = await login('editor');
    const created = await app.inject({ method: 'POST', url: '/api/v1/pages', ...editor, payload: { spaceId: spaces()[0].id, title: 'À jeter' } });
    const id = created.json().id;
    await app.inject({ method: 'DELETE', url: `/api/v1/pages/${id}`, ...editor });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/pages/${id}/permanent`, ...editor })).statusCode).toBe(403);
    const admin = await login('admin');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/pages/${id}/permanent`, ...admin })).statusCode).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH '\"jeter\"'").get()).toEqual({ n: 0 });
  });
});

describe('CSRF et origine', () => {
  it('refuse une écriture par cookie sans jeton CSRF', async () => {
    const { cookies } = await login('editor');
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', cookies, payload: { spaceId: spaces()[0].id } });
    expect(res.statusCode).toBe(403);
  });
  it('refuse une origine tierce', async () => {
    const s = await login('editor');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/pages', cookies: s.cookies,
      headers: { ...s.headers, origin: 'https://evil.example' }, payload: { spaceId: spaces()[0].id },
    });
    expect(res.statusCode).toBe(403);
  });
  it('accepte une écriture avec le bon jeton CSRF', async () => {
    const s = await login('editor');
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', ...s, payload: { spaceId: spaces()[0].id, title: 'OK' } });
    expect(res.statusCode).toBe(201);
  });
});

describe('contenu', () => {
  it('retire les liens javascript: et les images non sûres', async () => {
    const s = await login('editor');
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'clic', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
        { type: 'image', attrs: { src: 'data:text/html;base64,PHNjcmlwdD4=' } },
        { type: 'paragraph', attrs: { onclick: 'x' }, content: [{ type: 'text', text: 'ok' }] },
      ],
    };
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', ...s, payload: { spaceId: spaces()[0].id, content } });
    const saved = res.json().content;
    expect(JSON.stringify(saved)).not.toMatch(/javascript|text\/html|onclick/);
  });
  it('refuse un type de nœud inconnu', async () => {
    const s = await login('editor');
    const content = { type: 'doc', content: [{ type: 'script', content: [] }] };
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', ...s, payload: { spaceId: spaces()[0].id, content } });
    expect(res.statusCode).toBe(400);
  });
  it('détecte les modifications concurrentes', async () => {
    const s = await login('editor');
    const { id, version } = (await app.inject({ method: 'POST', url: '/api/v1/pages', ...s, payload: { spaceId: spaces()[0].id } })).json();
    const first = await app.inject({ method: 'PATCH', url: `/api/v1/pages/${id}`, ...s, payload: { content: doc('a'), baseVersion: version } });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PATCH', url: `/api/v1/pages/${id}`, ...s, payload: { content: doc('b'), baseVersion: version } });
    expect(stale.statusCode).toBe(409);
  });
  it('recherche sans accents et résiste aux opérateurs FTS', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=editeur' });
    expect(res.json().length).toBeGreaterThan(0);
    const weird = await app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('"x" OR NEAR( * ^ -')}` });
    expect(weird.statusCode).toBe(200);
  });
});

describe('jetons d’API', () => {
  it('respecte les portées, ne crée pas de jeton et peut être révoqué', async () => {
    const s = await login('editor');
    const created = await app.inject({ method: 'POST', url: '/api/v1/tokens', ...s, payload: { name: 'ci', scopes: ['read'], expiresInDays: 7 } });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: auth })).json()).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/v1/pages', headers: auth, payload: { spaceId: spaces()[0].id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tokens', headers: auth, payload: { name: 'x', scopes: ['read'] } })).statusCode).toBe(403);
    expect(JSON.stringify(db.prepare('SELECT * FROM api_tokens').all())).not.toContain(token);
    await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}`, ...s });
    expect((await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: auth })).statusCode).toBe(401);
  });
  it('n’accorde pas de portée au-delà du rôle', async () => {
    const s = await login('editor');
    const res = await app.inject({ method: 'POST', url: '/api/v1/tokens', ...s, payload: { name: 'x', scopes: ['admin'] } });
    expect(res.statusCode).toBe(403);
  });
  it('rejette un jeton mal formé', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('réglages IA', () => {
  it('chiffre la clé et ne la renvoie jamais', async () => {
    const s = await login('admin');
    const secret = 'sk-ant-test-0123456789abcdef';
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/ai', ...s,
      payload: { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: secret },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(secret);
    expect(res.json().keyHint).toBe('…cdef');
    expect(JSON.stringify(db.prepare('SELECT value FROM settings').all())).not.toContain(secret);
    const editor = await login('editor');
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/ai', ...editor })).statusCode).toBe(403);
  });
});

describe('redirections', () => {
  it('n’accepte que des chemins locaux', () => {
    expect(safeReturnTo('/p/abc')).toBe('/p/abc');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
  });
});

describe('paramètres', () => {
  it('vue d’ensemble réservée aux admins et sans secret', async () => {
    const editor = await login('editor');
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/instance', ...editor })).statusCode).toBe(403);
    const admin = await login('admin');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/instance', ...admin });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(KEY);
    expect(res.json().stats.spaces).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/users', ...admin })).json().length).toBeGreaterThan(0);
  });

  it('ferme les autres sessions sans fermer la session courante', async () => {
    const first = await login('editor');
    const second = await login('editor');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/sessions', ...second })).json();
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/sessions/others', ...second });
    expect(res.json().closed).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies: first.cookies })).json().user).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', cookies: second.cookies })).json().user).not.toBeNull();
  });
});
