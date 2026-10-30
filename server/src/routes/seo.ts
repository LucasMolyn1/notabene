// Référencement des pages d'espaces publics : robots.txt, sitemap.xml et /p/<titre>-<id> rendu côté serveur
// (titre, description, contenu en HTML) pour les moteurs de recherche, avant que l'application ne prenne la main.
// Rien de ce qui n'est pas lisible par un visiteur anonyme n'est jamais rendu ici : même contrôle d'accès que l'API.
import type { FastifyInstance } from 'fastify';
import { canReadPage, filterReadable } from '../lib/page-acl.js';
import { getPageRow } from '../lib/pages.js';
import { escapeHtml, renderHtml } from '../lib/render-html.js';
import { idFromSegment, segmentOf } from '../lib/slug.js';
import type { DocNode } from '../lib/content.js';

const SITEMAP_LIMIT = 5000;

export default async function seoRoutes(app: FastifyInstance, { indexHtml }: { indexHtml: string | null }) {
  const { db, config } = app;
  const base = config.PUBLIC_URL;

  app.get('/robots.txt', async (_req, reply) => reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send(
    config.SEO_INDEX
      ? `User-agent: *\nAllow: /p/\nDisallow: /api/\nDisallow: /auth/\nDisallow: /mcp\nDisallow: /settings\n\nSitemap: ${base}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n'));

  app.get('/sitemap.xml', async (_req, reply) => {
    const rows = config.SEO_INDEX
      ? filterReadable(db, null, db.prepare(
        `SELECT p.id, p.title, p.updated_at FROM pages p JOIN spaces s ON s.id = p.space_id
         WHERE s.visibility = 'public' AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT ?`).all(SITEMAP_LIMIT) as { id: string; title: string; updated_at: number }[])
      : [];
    const urls = rows.map((r) => `<url><loc>${escapeHtml(`${base}/p/${segmentOf(r.id, r.title)}`)}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod></url>`).join('');
    return reply.header('content-type', 'application/xml; charset=utf-8').header('cache-control', 'public, max-age=600')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`);
  });

  if (!indexHtml) return;

  const titleOf = (id: string) => (db.prepare('SELECT title FROM pages WHERE id = ? AND deleted_at IS NULL').get(id) as { title: string } | undefined)?.title ?? null;

  app.get('/p/:seg', async (req, reply) => {
    const seg = (req.params as { seg: string }).seg;
    const id = idFromSegment(seg);
    const row = id ? getPageRow(db, id) : undefined;
    // Lisible par un anonyme (espace public, page non restreinte, hors corbeille) ? Sinon : l'application seule, que les moteurs ne doivent pas garder.
    const open = !!row && !row.deleted_at && !!db.prepare("SELECT 1 FROM spaces WHERE id = ? AND visibility = 'public'").get(row.space_id) && canReadPage(db, null, row.id);
    if (!open || !row || !config.SEO_INDEX) return reply.header('x-robots-tag', 'noindex, nofollow').header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(indexHtml);

    const canonical = segmentOf(row.id, row.title);
    if (seg !== canonical) return reply.redirect(`/p/${canonical}`, 301);

    let body = '';
    try { body = renderHtml(JSON.parse(row.content) as DocNode, titleOf); } catch { /* contenu illisible : le titre seul est rendu */ }
    const description = row.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const title = row.title || 'Sans titre';
    const url = `${base}/p/${canonical}`;
    const head = [
      `<link rel="canonical" href="${escapeHtml(url)}">`,
      '<meta name="robots" content="index, follow">',
      '<meta property="og:type" content="article">',
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:url" content="${escapeHtml(url)}">`,
      '<meta property="og:site_name" content="Notabene">',
      ...(description ? [`<meta property="og:description" content="${escapeHtml(description)}">`] : []),
      `<meta property="article:modified_time" content="${new Date(row.updated_at).toISOString()}">`,
    ].join('\n  ');
    const html = indexHtml
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} · Notabene</title>`)
      .replace(/<meta name="description"[^>]*>/, description ? `<meta name="description" content="${escapeHtml(description)}">` : '')
      .replace('</head>', () => `  ${head}\n</head>`)
      // Remplacé dès que l'application affiche la page.
      .replace(/(<main id="main"[^>]*>)(<\/main>)/, (_m, open_: string, close: string) => `${open_}<article class="prose seo"><h1>${escapeHtml(title)}</h1>${body}</article>${close}`);
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(html);
  });
}
