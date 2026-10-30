import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { newId } from '../src/lib/http.js';
import { createPage } from '../src/lib/pages.js';
import { escapeHtml, injectSeo, renderHtml } from '../src/lib/render-html.js';
import { idFromSegment, segmentOf, slugOf } from '../src/lib/slug.js';

const INDEX = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Notabene</title>
  <meta name="description" content="Notabene : wiki collaboratif auto-hébergé, inspiré de Docmost.">
</head>
<body>
  <div id="app"><main id="main" class="main" tabindex="-1"></main></div>
</body>
</html>`;

const env = { NODE_ENV: 'test', PUBLIC_URL: 'https://wiki.example.com', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('adresses lisibles', () => {
  it('le titre devient un texte sans accents, minuscule, relié par des tirets, borné', () => {
    expect(slugOf('Déploiement d’un wiki : œuvre & été !')).toBe('deploiement-d-un-wiki-oeuvre-ete');
    expect(slugOf('   ')).toBe('');
    expect(slugOf('😀')).toBe('');
    expect(slugOf('a'.repeat(100)).length).toBe(60);
    expect(slugOf('Mot '.repeat(30)).endsWith('-')).toBe(false);
  });
  it('l’identifiant se lit dans les 12 derniers caractères, avec ou sans titre', () => {
    const id = '1t3o0UknH-6J';
    expect(segmentOf(id, 'Bienvenue')).toBe(`bienvenue-${id}`);
    expect(segmentOf(id, '')).toBe(id);
    expect(idFromSegment(`bienvenue-${id}`)).toBe(id);
    expect(idFromSegment(id)).toBe(id);
    expect(idFromSegment(`ancien-titre-${id}`)).toBe(id); // un titre périmé reste valable
    expect(idFromSegment('a/b')).toBeNull();
    expect(idFromSegment('..')).toBeNull();
    expect(idFromSegment('x'.repeat(65))).toBeNull();
  });
});

describe('rendu HTML des pages publiques', () => {
  it('échappe tout, filtre les liens et les images, descend les titres d’un niveau', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'Voir ', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'ici', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
          { type: 'text', text: 'là', marks: [{ type: 'link', attrs: { href: 'https://exemple.fr/a?b=1&c="2"' } }] },
        ] },
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'x' } },
        { type: 'image', attrs: { src: 'https://exemple.fr/i.png', alt: '" onerror="alert(1)' } },
        { type: 'codeBlock', content: [{ type: 'text', text: 'if (a < b) {}' }] },
        { type: 'inconnu', content: [para('ignoré')] },
      ],
    }, () => null);
    expect(html).not.toContain('<script');
    expect(html).toContain('<h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://exemple.fr/a?b=1&amp;c=&quot;2&quot;" rel="nofollow ugc noopener noreferrer"');
    expect(html).not.toContain('data:image');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).toContain('<code>if (a &lt; b) {}</code>');
    expect(html).not.toContain('ignoré');
    expect(escapeHtml(`<a href='x'>&`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;');
  });
});

describe('injection dans la page d’application', () => {
  it('un titre qui ressemble à un motif de remplacement ($&, $1) est recopié tel quel', () => {
    const out = injectSeo(INDEX, { title: 'Prix $& $1 $$ <b>', description: '', url: 'https://wiki.example.com/p/x', modifiedAt: 0, body: '' });
    expect(out).toContain('<title>Prix $&amp; $1 $$ &lt;b&gt; · Notabene</title>');
    expect(out).toContain('<h1>Prix $&amp; $1 $$ &lt;b&gt;</h1>');
    expect(out).not.toContain('<meta name="description"'); // sans description, l'ancienne (générique) est retirée
  });
});

describe('référencement des pages publiques', () => {
  let app: FastifyInstance;
  let db: DB;
  let pub: { id: string; title: string };
  let priv: { id: string };
  let restricted: { id: string };
  afterEach(async () => { await app.close(); db.close(); });

  async function boot(extra: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'nb-seo-'));
    writeFileSync(join(dir, 'index.html'), INDEX);
    db = openDb(':memory:');
    app = await buildApp({ config: loadConfig({ ...env, ...extra }), db, clientDir: dir });
    const space = (name: string, visibility: string) => {
      const id = newId();
      db.prepare('INSERT INTO spaces (id, name, icon, description, visibility, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, name, 'folder', '', visibility, 0, 1, 1);
      return id;
    };
    const publicSpace = space('Public', 'public');
    const privateSpace = space('Privé', 'private');
    pub = createPage(db, { spaceId: publicSpace, title: 'Bienvenue à la maison', content: { type: 'doc', content: [para('Un texte <b>public</b> & lisible.')] } }, null);
    priv = createPage(db, { spaceId: privateSpace, title: 'Secret interne', content: { type: 'doc', content: [para('mot de passe du pare-feu')] } }, null);
    restricted = createPage(db, { spaceId: publicSpace, title: 'Réservée aux admins', content: { type: 'doc', content: [para('confidentiel')] } }, null);
    db.prepare("INSERT INTO users (id, sub, email, name, role, created_at) VALUES ('u1','local:u1','u1@example.com','U1','editor',1)").run();
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, 'u1', 'read')").run(restricted.id);
  }
  const get = (url: string) => app.inject({ method: 'GET', url });

  it('une page publique est rendue en HTML avec titre, description et adresse canonique', async () => {
    await boot();
    const seg = segmentOf(pub.id, pub.title);
    const res = await get(`/p/${seg}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.body).toContain('<title>Bienvenue à la maison · Notabene</title>');
    expect(res.body).toContain(`<link rel="canonical" href="https://wiki.example.com/p/${seg}">`);
    expect(res.body).toContain('<meta name="robots" content="index, follow">');
    expect(res.body).toContain('<meta name="description" content="Un texte &lt;b&gt;public&lt;/b&gt; &amp; lisible.">');
    expect(res.body).toContain('<article class="prose seo"><h1>Bienvenue à la maison</h1><p>Un texte &lt;b&gt;public&lt;/b&gt; &amp; lisible.</p></article>');
    expect(res.body).not.toContain('<b>public</b>');
  });

  it('un titre périmé ou un identifiant seul redirige (301) vers l’adresse canonique', async () => {
    await boot();
    const seg = segmentOf(pub.id, pub.title);
    for (const url of [`/p/${pub.id}`, `/p/ancien-titre-${pub.id}`]) {
      const res = await get(url);
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe(`/p/${seg}`);
    }
  });

  it('une page privée, restreinte, inexistante ou à identifiant invalide ne montre que l’application, marquée noindex', async () => {
    await boot();
    for (const url of [`/p/${segmentOf(priv.id, 'Secret interne')}`, `/p/${restricted.id}`, '/p/nexiste-pas-0123456789ab', '/p/%2e%2e', '/s/quelconque-0123456789ab']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
      expect(res.body, url).not.toMatch(/Secret|pare-feu|confidentiel|Réservée/);
      expect(res.body, url).toContain('<main id="main" class="main" tabindex="-1"></main>');
    }
  });

  it('une page mise à la corbeille cesse d’être rendue', async () => {
    await boot();
    db.prepare('UPDATE pages SET deleted_at = 1 WHERE id = ?').run(pub.id);
    const res = await get(`/p/${segmentOf(pub.id, pub.title)}`);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body).not.toContain('Un texte');
  });

  it('sitemap.xml ne liste que les pages publiques non restreintes ; robots.txt le désigne', async () => {
    await boot();
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.headers['content-type']).toContain('application/xml');
    expect(sitemap.body).toContain(`<loc>https://wiki.example.com/p/${segmentOf(pub.id, pub.title)}</loc>`);
    expect(sitemap.body).not.toContain(priv.id);
    expect(sitemap.body).not.toContain(restricted.id);
    const robots = (await get('/robots.txt')).body;
    expect(robots).toContain('Sitemap: https://wiki.example.com/sitemap.xml');
    expect(robots).toContain('Disallow: /api/');
  });

  it('SEO_INDEX=false : tout est noindex, le sitemap est vide et robots.txt interdit tout', async () => {
    await boot({ SEO_INDEX: 'false' });
    const res = await get(`/p/${segmentOf(pub.id, pub.title)}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body).not.toContain('Un texte');
    expect((await get('/sitemap.xml')).body).not.toContain('<url>');
    expect((await get('/robots.txt')).body).toContain('Disallow: /');
  });

  it('l’application elle-même (racine, réglages) est servie en noindex', async () => {
    await boot();
    for (const url of ['/', '/settings/about']) expect((await get(url)).headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
