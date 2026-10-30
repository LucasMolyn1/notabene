// Conversion minimale de HTML (pages « éditeur HTML » de Wiki.js, blocs HTML d'un Markdown) en blocs TipTap.
// Le HTML n'est jamais conservé : seuls le texte et la structure (titres, paragraphes, listes, code, diagrammes) le sont.
import type { DocNode } from './content.js';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', amp: '&' };
const decode = (s: string) => s.replace(/&(lt|gt|quot|apos|#39|nbsp|amp);/g, (_m, name: string) => ENTITIES[name]!);

const SKIPPED = new Set(['script', 'style', 'head', 'title', 'svg', 'noscript']);
const BLOCK_BREAKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'blockquote', 'br', 'hr', 'table', 'thead', 'tbody', 'figure', 'figcaption']);

/** Texte d'un fragment : chaque balise est retirée d'un seul passage, un « < » sans « > » est supprimé. */
function stripTags(fragment: string): string {
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf('<', i);
    if (lt === -1) { out += fragment.slice(i); break; }
    out += fragment.slice(i, lt);
    const gt = fragment.indexOf('>', lt);
    if (gt === -1) break;
    i = gt + 1;
  }
  return out;
}

const para = (t: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

/** Langue d'un bloc de code d'après ses classes (« language-mermaid », « mermaid », « lang-bash »). */
function langOf(classes: string): string | null {
  for (const c of classes.split(/\s+/)) {
    const m = /^(?:language-|lang-)?([a-z0-9+#-]{1,32})$/i.exec(c);
    if (m && (c.startsWith('language-') || c.startsWith('lang-') || /^(mermaid|plantuml)$/i.test(c))) return m[1]!.toLowerCase();
  }
  return null;
}

export function htmlToBlocks(html: string): DocNode[] {
  const out: DocNode[] = [];
  let buf = '';
  let items: DocNode[] = [];
  let listType: 'bulletList' | 'orderedList' | null = null;
  let code: { lang: string | null; text: string; end: string } | null = null;

  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (t) out.push(para(t));
  };
  const flushList = () => {
    flush();
    if (listType && items.length) out.push({ type: listType, content: items });
    items = [];
    listType = null;
  };
  const endCode = () => {
    if (!code) return;
    const body = code.text.replace(/^\n+|\s+$/g, '');
    if (code.lang === 'mermaid' || code.lang === 'plantuml') out.push({ type: code.lang, attrs: { code: body } });
    else out.push({ type: 'codeBlock', attrs: { language: code.lang }, content: body ? [{ type: 'text', text: body }] : [] });
    code = null;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) {
      const chunk = decode(html.slice(i, textEnd));
      if (code) code.text += chunk; else buf += chunk;
    }
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) { buf += decode(html.slice(lt)); break; }
    const tag = html.slice(lt + 1, gt);
    i = gt + 1;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    if (tag.startsWith('!') || tag.startsWith('?')) continue; // doctype, instructions de traitement
    if (!m) { if (code) code.text += `<${tag}>`; else buf += `<${tag}>`; continue; }
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    const attrs = tag.slice(m[0].length, 2000);
    const classes = /class\s*=\s*["']([^"']{0,200})["']/i.exec(attrs)?.[1] ?? '';

    if (code) {
      if (closing && name === code.end) endCode();
      else if (name === 'br') code.text += '\n';
      else if (!closing && name === 'code' && !code.lang) code.lang = langOf(classes);
      continue;
    }
    if (!closing && SKIPPED.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const close = end === -1 ? -1 : html.indexOf('>', end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!closing && (name === 'pre' || (name === 'div' && /\bmermaid\b/i.test(classes)))) {
      flushList();
      code = { lang: name === 'div' ? 'mermaid' : langOf(classes), text: '', end: name };
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      flush();
      if (closing) continue;
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const inner = stripTags(html.slice(i, close === -1 ? html.length : close));
      const t = decode(inner).replace(/\s+/g, ' ').trim();
      if (t) out.push({ type: 'heading', attrs: { level: Math.min(3, Number(name[1])) }, content: [{ type: 'text', text: t }] });
      const end = close === -1 ? -1 : html.indexOf('>', close);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      flushList();
      if (!closing) listType = name === 'ul' ? 'bulletList' : 'orderedList';
      continue;
    }
    if (name === 'li') {
      if (closing) {
        const t = buf.replace(/\s+/g, ' ').trim();
        buf = '';
        if (t) items.push({ type: 'listItem', content: [para(t)] });
      } else if (buf.trim()) {
        const t = buf.replace(/\s+/g, ' ').trim();
        buf = '';
        items.push({ type: 'listItem', content: [para(t)] });
      }
      if (!listType) listType = 'bulletList';
      continue;
    }
    if (name === 'td' || name === 'th') { if (closing) buf += ' | '; continue; }
    if (name === 'tr') { if (closing) buf = buf.replace(/\s*\|\s*$/, ''); flush(); continue; }
    if (BLOCK_BREAKS.has(name)) flush();
  }
  endCode();
  flushList();
  return out;
}
