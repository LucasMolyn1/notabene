import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { compareVersions, loadChangelog, parseChangelog } from '../src/lib/changelog.js';
import { hashPassword } from '../src/lib/password.js';
import { UpdateChecker } from '../src/lib/update-check.js';
import { VERSION } from '../src/version.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

describe('changelog', () => {
  it('structure les versions, sections et éléments, sans mise en forme Markdown', () => {
    const r = parseChangelog('# Journal\n\n## [Non publié]\n\n### Ajouté\n- caché\n\n## [1.2.0] - 2026-01-02\n\nRésumé **court**.\n\n### Ajouté\n- Un [lien](https://x.y) et `code`\n- **Gras**\n\n### Corrigé\n- Bug\n\n## [1.1.0] - 2025-12-01\n\n### Corrigé\n- Ancien\n');
    expect(r.map((x) => x.version)).toEqual(['1.2.0', '1.1.0']);
    expect(r[0]).toMatchObject({ date: '2026-01-02', summary: 'Résumé court.' });
    expect(r[0]!.sections).toEqual([{ title: 'Ajouté', items: ['Un lien et code', 'Gras'] }, { title: 'Corrigé', items: ['Bug'] }]);
  });

  it('le vrai CHANGELOG.md commence par la version courante', () => {
    expect(loadChangelog()[0]?.version).toBe(VERSION);
  });

  it('compare des versions', () => {
    expect(compareVersions('3.1.0', '3.0.0')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '3.0.0')).toBe(0);
    expect(compareVersions('2.9.9', '3.0.0')).toBeLessThan(0);
    expect(compareVersions('3.10.0', '3.9.0')).toBeGreaterThan(0);
  });
});

describe('vérification de mise à jour', () => {
  const release = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, published_at: '2026-11-01T00:00:00Z', ...extra });

  it('désactivée : ne contacte personne', async () => {
    let calls = 0;
    const c = new UpdateChecker(false, 'o/r', '3.0.0', async () => { calls++; return release('v9.9.9'); });
    expect(await c.status()).toMatchObject({ enabled: false, latest: null, updateAvailable: false });
    expect(calls).toBe(0);
  });

  it('signale une version plus récente, la garde en mémoire, ignore brouillons et préversions', async () => {
    let calls = 0;
    const c = new UpdateChecker(true, 'o/r', '3.0.0', async () => { calls++; return release('v3.1.0'); });
    const s = await c.status();
    expect(s).toMatchObject({ enabled: true, updateAvailable: true, latest: { version: '3.1.0' }, error: null });
    await c.status();
    expect(calls).toBe(1);
    for (const bad of [release('v9.0.0', { prerelease: true }), release('v9.0.0', { draft: true }), release('nightly'), release('v9.0.0', { html_url: 'https://evil.example/x' })]) {
      expect(await new UpdateChecker(true, 'o/r', '3.0.0', async () => bad).status()).toMatchObject({ latest: null, updateAvailable: false });
    }
  });

  it('joint les notes de version de la release, au format du CHANGELOG', async () => {
    const body = '## [3.1.0] - 2026-11-01\n\nRésumé.\n\n### Attention à la mise à jour\n- Sauvegardez avant.\n\n### Ajouté\n- Une chose\n';
    const s = await new UpdateChecker(true, 'o/r', '3.0.0', async () => release('v3.1.0', { body })).status();
    expect(s.latest?.notes).toMatchObject({ version: '3.1.0', summary: 'Résumé.', sections: [{ title: 'Attention à la mise à jour' }, { title: 'Ajouté' }] });
    expect((await new UpdateChecker(true, 'o/r', '3.0.0', async () => release('v3.1.0')).status()).latest?.notes).toBeNull();
  });

  it('à jour, sans release, ou en erreur', async () => {
    expect(await new UpdateChecker(true, 'o/r', '3.0.0', async () => release('v3.0.0')).status()).toMatchObject({ updateAvailable: false });
    expect(await new UpdateChecker(true, 'o/r', '3.0.0', async () => null).status()).toMatchObject({ latest: null, updateAvailable: false, error: null });
    const failing = await new UpdateChecker(true, 'o/r', '3.0.0', async () => { throw new Error('secret interne'); }).status();
    expect(failing.error).toMatch(/impossible/);
    expect(JSON.stringify(failing)).not.toContain('secret interne');
  });
});

describe('routes À propos', () => {
  let app: FastifyInstance;
  let db: DB;
  afterEach(async () => { await app.close(); db.close(); });

  async function boot(checker?: UpdateChecker) {
    db = openDb(':memory:');
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent', updateChecker: checker });
    for (const [id, role] of [['adm', 'admin'], ['ed', 'editor']] as const) {
      db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, id, role, Date.now(), await hashPassword(PASS));
    }
  }
  async function login(id: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookies = { nb_session: res.cookies.find((c) => c.name === 'nb_session')!.value };
    return { cookies, me: (await app.inject({ method: 'GET', url: '/api/v3/me', cookies })).json() };
  }

  it('version et nouveautés pour tout utilisateur connecté, jamais pour un anonyme', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v3/about' })).statusCode).toBe(401);
    const ed = await login('ed');
    expect(ed.me.version).toBe(VERSION);
    const about = (await app.inject({ method: 'GET', url: '/api/v3/about', cookies: ed.cookies })).json();
    expect(about.version).toBe(VERSION);
    expect(about.releases[0].version).toBe(VERSION);
    expect(about.releases[0].sections.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/v3/me' })).json().version).toBeNull();
  });

  it('la mise à jour disponible est réservée aux administrateurs, désactivée par défaut', async () => {
    await boot();
    const ed = await login('ed');
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/update-check', cookies: ed.cookies })).statusCode).toBe(403);
    const adm = await login('adm');
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/update-check', cookies: adm.cookies })).json()).toMatchObject({ enabled: false, updateAvailable: false });
  });

  it('activée : annonce la version plus récente', async () => {
    await boot(new UpdateChecker(true, 'o/r', VERSION, async () => ({ tag_name: 'v99.0.0', html_url: 'https://github.com/o/r/releases/tag/v99.0.0' })));
    const adm = await login('adm');
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/update-check', cookies: adm.cookies })).json()).toMatchObject({ enabled: true, updateAvailable: true, latest: { version: '99.0.0' } });
  });
});
