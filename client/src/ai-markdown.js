// Markdown minimal et sûr pour les réponses de l'IA (palette et panneau de l'assistant).
// Tout le texte est échappé avant la pose des quelques balises autorisées : le modèle ne peut injecter aucun HTML.
import { esc } from './util.js';
import { pagePath } from './urls.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} text réponse du modèle (texte brut)
 * @param {{ n: number, id: string, title?: string }[]} sources pages citées, numérotées
 * @returns {string} HTML échappé
 */
export function renderAnswer(text, sources) {
  const byN = new Map(sources.filter((s) => SAFE_ID.test(String(s.id))).map((s) => [s.n, s]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2})\]/g, (m, n) => {
      const src = byN.get(Number(n));
      return src ? `<a class="cite" href="${esc(pagePath(src))}" title="${esc(src.title || 'Sans titre')}">${n}</a>` : m;
    });
  const out = [];
  let list = null;
  for (const line of String(text).split('\n')) {
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      if (!list) { list = []; out.push(list); }
      list.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    list = null;
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) out.push(`<p><strong>${inline(head[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.map((b) => (Array.isArray(b) ? `<ul>${b.join('')}</ul>` : b)).join('');
}
