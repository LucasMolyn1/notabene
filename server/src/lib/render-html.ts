// Rendu HTML en lecture seule d'un document TipTap, pour les moteurs de recherche et les lecteurs sans JavaScript (pages publiques).
// Tout est échappé ; seuls les nœuds, marques et liens connus sont rendus (liste blanche, comme lib/content.ts).
import { type DocNode, isSafeHref, isSafeImageSrc } from './content.js';

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type TitleOf = (id: string) => string | null;
type MentionName = (id: string) => string | null;

const MARK: Record<string, string> = { bold: 'strong', italic: 'em', strike: 's', code: 'code', underline: 'u', highlight: 'mark' };

export function renderHtml(doc: DocNode, titleOf: TitleOf, mentionName: MentionName = () => null): string {
  const inline = (nodes: DocNode[] = []): string => nodes.map((n) => {
    if (n.type === 'hardBreak') return '<br>';
    if (n.type === 'mention') return `<span>@${escapeHtml(mentionName(String(n.attrs?.id)) ?? 'utilisateur')}</span>`;
    if (n.type === 'pageLink') return `<a href="/p/${escapeHtml(String(n.attrs?.id ?? ''))}">${escapeHtml(titleOf(String(n.attrs?.id)) ?? 'Sans titre')}</a>`;
    if (n.type !== 'text') return '';
    let html = escapeHtml(n.text ?? '');
    for (const m of n.marks ?? []) {
      const tag = MARK[m.type];
      if (tag) html = `<${tag}>${html}</${tag}>`;
      else if (m.type === 'link' && isSafeHref(m.attrs?.href) && !String(m.attrs?.href).startsWith('#')) html = `<a href="${escapeHtml(String(m.attrs?.href))}" rel="nofollow ugc noopener noreferrer">${html}</a>`;
    }
    return html;
  }).join('');

  const text = (node: DocNode) => escapeHtml((node.content ?? []).map((t) => t.text ?? '').join(''));
  const children = (node: DocNode) => (node.content ?? []).map(block).join('');

  const block = (node: DocNode): string => {
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'paragraph': return `<p>${inline(node.content)}</p>`;
      // Le titre de la page est le h1 : les titres du contenu descendent d'un niveau.
      case 'heading': { const level = Math.min(4, (Number(a.level) || 1) + 1); return `<h${level}>${inline(node.content)}</h${level}>`; }
      case 'blockquote': return `<blockquote>${children(node)}</blockquote>`;
      case 'callout': return `<aside>${children(node)}</aside>`;
      case 'codeBlock': return `<pre><code>${text(node)}</code></pre>`;
      case 'mermaid': case 'plantuml': return `<pre><code>${escapeHtml(String(a.code ?? ''))}</code></pre>`;
      case 'horizontalRule': return '<hr>';
      case 'image': return isSafeImageSrc(a.src) && !String(a.src).startsWith('data:') ? `<img src="${escapeHtml(String(a.src))}" alt="${escapeHtml(String(a.alt ?? ''))}" loading="lazy">` : '';
      case 'bulletList': return `<ul>${children(node)}</ul>`;
      case 'orderedList': return `<ol>${children(node)}</ol>`;
      case 'taskList': return `<ul>${children(node)}</ul>`;
      case 'listItem': return `<li>${children(node)}</li>`;
      case 'taskItem': return `<li>${a.checked ? '[x] ' : '[ ] '}${children(node)}</li>`;
      case 'table': return `<table>${children(node)}</table>`;
      case 'tableRow': return `<tr>${children(node)}</tr>`;
      case 'tableHeader': return `<th>${children(node)}</th>`;
      case 'tableCell': return `<td>${children(node)}</td>`;
      default: return '';
    }
  };

  return children(doc);
}

// Page d'application (index.html) enrichie pour les moteurs de recherche : titre, description, adresse canonique, Open Graph, contenu.
// Le contenu est remplacé dès que l'application affiche la page. Fonction pure : tout ce qui vient de la base passe par escapeHtml.
export function injectSeo(indexHtml: string, page: { title: string; description: string; url: string; modifiedAt: number; body: string }): string {
  const { title, description, url } = page;
  const head = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    '<meta name="robots" content="index, follow">',
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    '<meta property="og:site_name" content="Notabene">',
    ...(description ? [`<meta property="og:description" content="${escapeHtml(description)}">`] : []),
    `<meta property="article:modified_time" content="${new Date(page.modifiedAt).toISOString()}">`,
  ].join('\n  ');
  return indexHtml
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)} · Notabene</title>`)
    .replace(/<meta name="description"[^>]*>/, () => (description ? `<meta name="description" content="${escapeHtml(description)}">` : ''))
    .replace('</head>', () => `  ${head}\n</head>`)
    .replace(/(<main id="main"[^>]*>)(<\/main>)/, (_m, open: string, close: string) => `${open}<article class="prose seo"><h1>${escapeHtml(title)}</h1>${page.body}</article>${close}`);
}
