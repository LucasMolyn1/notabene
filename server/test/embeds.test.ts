import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { sanitizeDoc } from '../src/lib/content.js';
import { embedUrl, normalizeEmbedHost } from '../src/lib/embed.js';
import { toMarkdown } from '../src/lib/markdown.js';
import { hashPassword } from '../src/lib/password.js';
import { renderHtml } from '../src/lib/render-html.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
const reauth = { password: PASS };
let app: FastifyInstance;
let db: DB;

async function boot(extra: Record<string, string> = {}) {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({ ...env, ...extra }), db, clientDir: '/nonexistent' });
}
beforeEach(() => boot());
afterEach(async () => { await app.close(); db.close(); });

async function login(email: string, role: 'admin' | 'editor') {
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(`u-${email}`, `local:${email}`, email, email, role, Date.now(), await hashPassword(PASS));
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const api = (s: S, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url: `/api/v3${url}`, payload, ...s });
const csp = async () => String((await app.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy']);
const frameSrc = async () => /frame-src ([^;]*)/.exec(await csp())?.[1];

describe('nom d’hôte autorisé', () => {
  it('accepte un nom de domaine exact en minuscules', () => {
    expect(normalizeEmbedHost('www.youtube-nocookie.com')).toBe('www.youtube-nocookie.com');
    expect(normalizeEmbedHost('  Player.Vimeo.com ')).toBe('player.vimeo.com');
  });

  it('refuse tout ce qui n’est pas un nom de domaine : joker, chemin, port, protocole, adresse IP, nom interne, espace, directive CSP', () => {
    for (const bad of ['*', '*.example.com', 'example.com/chemin', 'example.com:8443', 'https://example.com', '127.0.0.1', '10.0.0.5', '[::1]', 'localhost', 'intranet', 'a.b', "example.com; script-src *", "example.com 'unsafe-inline'", 'ex ample.com', 'exämple.fr', '-a.example.com', '', 'a'.repeat(260) + '.com']) {
      expect(normalizeEmbedHost(bad), bad).toBeNull();
    }
  });
});

describe('adresse d’un contenu intégré', () => {
  it('normalise une adresse https sur un nom de domaine', () => {
    expect(embedUrl('https://www.youtube-nocookie.com/embed/abc?start=3')).toBe('https://www.youtube-nocookie.com/embed/abc?start=3');
    expect(embedUrl('HTTPS://Player.Vimeo.com/video/1')).toBe('https://player.vimeo.com/video/1');
  });

  it('refuse http, javascript, data, identifiants, port, adresse IP, nom interne, espaces et caractères de contrôle', () => {
    for (const bad of ['http://player.vimeo.com/x', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://user:pass@player.vimeo.com/x', 'https://player.vimeo.com:8443/x',
      'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://intranet/x', 'https://exa mple.com/x', 'https://example.com/\u0000', '//example.com/x', 'ftp://example.com/x', '', 12, null, undefined, 'https://example.com/' + 'a'.repeat(2100)]) {
      expect(embedUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('contenu de page', () => {
  const doc = (url: unknown) => ({ type: 'doc', content: [{ type: 'embed', attrs: { url } }, { type: 'paragraph' }] });

  it('garde une adresse valide et retire le bloc si l’adresse est refusée', () => {
    expect(sanitizeDoc(doc('https://player.vimeo.com/video/1')).content![0]).toEqual({ type: 'embed', attrs: { url: 'https://player.vimeo.com/video/1' } });
    for (const bad of ['javascript:alert(1)', 'http://player.vimeo.com/x', 'https://127.0.0.1/x', 7, null]) {
      expect(sanitizeDoc(doc(bad)).content!.map((n) => n.type), String(bad)).toEqual(['paragraph']);
    }
  });

  it('les exports affichent un lien, jamais une iframe', () => {
    const d = sanitizeDoc(doc('https://player.vimeo.com/video/1?a=1&b=<x>'));
    const md = toMarkdown('P', '', d, () => null);
    expect(md).toContain('https://player.vimeo.com/video/1');
    const html = renderHtml(d, () => null);
    expect(html).toContain('<a href="https://player.vimeo.com/video/1?a=1&amp;b=%3Cx%3E"');
    expect(html).not.toContain('<iframe');
  });
});

describe('réglage de l’administrateur', () => {
  it('par défaut : aucune iframe autorisée', async () => {
    expect(await frameSrc()).toBe("'none'");
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).json().embedHosts).toEqual([]);
  });

  it('autorise des hôtes sans redémarrage (CSP frame-src), puis les retire', async () => {
    const admin = await login('a@example.com', 'admin');
    const res = await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['Player.Vimeo.com', 'player.vimeo.com', 'www.youtube-nocookie.com'] }, reauth });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.hosts).toEqual(['player.vimeo.com', 'www.youtube-nocookie.com']);
    expect(await frameSrc()).toBe('https://player.vimeo.com https://www.youtube-nocookie.com');
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).json().embedHosts).toEqual(['player.vimeo.com', 'www.youtube-nocookie.com']);
    expect((await api(admin, 'POST', '/admin/settings/embeds/reset', { reauth })).statusCode).toBe(200);
    expect(await frameSrc()).toBe("'none'");
  });

  it('désactiver la section retire tous les hôtes', async () => {
    const admin = await login('a@example.com', 'admin');
    await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['player.vimeo.com'] }, reauth });
    expect((await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: false }, reauth })).statusCode).toBe(200);
    expect(await frameSrc()).toBe("'none'");
  });

  it('refuse les hôtes dangereux, y compris injection dans la politique de sécurité, et l’hôte de Notabene', async () => {
    const admin = await login('a@example.com', 'admin');
    for (const bad of ['*', '*.example.com', 'https://example.com', 'example.com/x', '127.0.0.1', 'localhost', "a.com; script-src *", "a.com 'unsafe-inline'", 'a.com\nscript-src *', '']) {
      const res = await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: [bad] }, reauth });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    await app.close(); db.close();
    await boot({ PUBLIC_URL: 'http://wiki.example.org:3000' });
    const a2 = await login('b@example.com', 'admin');
    expect((await api(a2, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['wiki.example.org'] }, reauth })).statusCode).toBe(400);
    expect(await frameSrc()).toBe("'none'");
  });

  it('exige un administrateur, une session et la ressaisie du mot de passe', async () => {
    const editor = await login('e@example.com', 'editor');
    expect((await api(editor, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['player.vimeo.com'] }, reauth })).statusCode).toBe(403);
    const admin = await login('a@example.com', 'admin');
    expect((await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['player.vimeo.com'] }, reauth: { password: 'mauvais' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v3/admin/settings/embeds', payload: { config: { enabled: true, hosts: ['player.vimeo.com'] }, reauth } })).statusCode).toBe(401);
    expect(await frameSrc()).toBe("'none'");
  });

  it('journalise la modification', async () => {
    const admin = await login('a@example.com', 'admin');
    await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['player.vimeo.com'] }, reauth });
    expect((db.prepare("SELECT action FROM audit_log WHERE action LIKE 'settings.%' ORDER BY id").all() as { action: string }[]).length).toBeGreaterThan(0);
  });

  it('CONFIG_LOCKED fige la liste de l’environnement', async () => {
    await app.close(); db.close();
    await boot({ CONFIG_LOCKED: 'true', CONTENT_EMBED_HOSTS: 'player.vimeo.com' });
    expect(await frameSrc()).toBe('https://player.vimeo.com');
    const admin = await login('a@example.com', 'admin');
    expect((await api(admin, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['www.youtube-nocookie.com'] }, reauth })).statusCode).toBe(409);
    expect(await frameSrc()).toBe('https://player.vimeo.com');
  });

  it('l’environnement valide la liste au démarrage', () => {
    expect(() => loadConfig({ ...env, CONTENT_EMBED_HOSTS: 'player.vimeo.com,www.youtube-nocookie.com' })).not.toThrow();
    for (const bad of ['*', 'https://a.com', 'a.com/x', 'localhost', '10.0.0.1', 'A.COM', 'localhost']) {
      expect(() => loadConfig({ ...env, CONTENT_EMBED_HOSTS: bad }), bad).toThrow();
    }
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'https://wiki.example.org', CONTENT_EMBED_HOSTS: 'wiki.example.org' })).toThrow(/s'intégrer lui-même/);
  });
});
