// Import Markdown (export « fichiers/Git » de Wiki.js, dossiers de notes…) vers des pages Notabene.
// Le Markdown est converti en document TipTap puis passe par sanitizeDoc comme tout contenu.
import { type Token, type Tokens, marked } from 'marked';
import type { DB } from '../db.js';
import { type DocNode, sanitizeDoc } from './content.js';
import { HttpError } from './http.js';
import { createPage, updatePage } from './pages.js';

export interface ImportFile { path: string; content: string }
export interface ImportResult { pages: number; folders: number; links: { resolved: number; unresolved: number }; images: number }

export const IMPORT_LIMITS = { files: 2000, fileBytes: 1_000_000, totalBytes: 25_000_000 };

// ---- En-tête YAML minimal (clé: valeur) ----------------------------------------------------

const FRONT_MATTER_KEYS = ['title', 'description', 'published', 'date', 'dateCreated', 'tags', 'editor'] as const;

export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  // Lecture dans une Map, puis recopie de clés CONSTANTES : un nom venant du fichier n'est jamais utilisé comme propriété.
  const raw = new Map<string, string>();
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) raw.set(kv[1]!, kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  const meta: Record<string, string> = {};
  for (const k of FRONT_MATTER_KEYS) {
    const v = raw.get(k);
    if (v !== undefined) meta[k] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---- Chemins ---------------------------------------------------------------------------------

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(md|markdown)$/i, '').replace(/\/+$/, '');
const key = (p: string) => normPath(p).toLowerCase();
const humanize = (segment: string) => {
  const t = segment.replace(/[-_]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Sans titre';
};
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

function validPath(p: string) {
  const parts = normPath(p).split('/');
  return parts.length > 0 && parts.every((s) => s && s !== '.' && s !== '..');
}

// ---- Markdown -> TipTap ----------------------------------------------------------------------

interface Ctx { resolveLink: (href: string, from: string) => string | null; from: string; stats: ImportResult }
type Mark = { type: string; attrs?: Record<string, unknown> };

const para = (content: DocNode[] = []): DocNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const text = (t: string, marks: Mark[] = []): DocNode => (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });

function inline(tokens: Token[] = [], ctx: Ctx, marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape': {
        const tk = t as Tokens.Text;
        if (tk.tokens?.length) out.push(...inline(tk.tokens, ctx, marks));
        else if (tk.text) out.push(text(tk.text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]!)), marks));
        break;
      }
      case 'strong': out.push(...inline((t as Tokens.Strong).tokens, ctx, [...marks, { type: 'bold' }])); break;
      case 'em': out.push(...inline((t as Tokens.Em).tokens, ctx, [...marks, { type: 'italic' }])); break;
      case 'del': out.push(...inline((t as Tokens.Del).tokens, ctx, [...marks, { type: 'strike' }])); break;
      case 'codespan': out.push(text((t as Tokens.Codespan).text, [...marks, { type: 'code' }])); break;
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'link': {
        const { href, tokens } = t as Tokens.Link;
        if (/^(https?:|mailto:)/i.test(href)) {
          out.push(...inline(tokens, ctx, [...marks, { type: 'link', attrs: { href } }]));
        } else if (href.startsWith('#')) {
          out.push(...inline(tokens, ctx, marks));
        } else {
          const id = ctx.resolveLink(href, ctx.from);
          if (id) { ctx.stats.links.resolved++; out.push({ type: 'pageLink', attrs: { id } }); }
          else { ctx.stats.links.unresolved++; out.push(...inline(tokens, ctx, marks)); }
        }
        break;
      }
      case 'image': {
        const { href, text: alt, title } = t as Tokens.Image;
        if (/^https:\/\//i.test(href) || /^data:image\//i.test(href)) out.push({ type: 'image', attrs: { src: href, alt: alt || null, title: title || null } });
        else { ctx.stats.images++; out.push(text(`[Image : ${alt || href.split('/').pop() || 'non importée'}]`, marks)); }
        break;
      }
      default: break; // html brut : ignoré
    }
  }
  return out;
}

const CALLOUT_CLASS: Record<string, string> = { 'is-info': 'info', 'is-warning': 'warning', 'is-success': 'success', 'is-danger': 'danger' };
const CALLOUT_ALERT: Record<string, string> = { NOTE: 'info', TIP: 'success', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger' };

function blocks(tokens: Token[] = [], ctx: Ctx): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({ type: 'heading', attrs: { level: Math.min(3, h.depth) }, content: inline(h.tokens, ctx) });
        break;
      }
      case 'paragraph': out.push(para(inline((t as Tokens.Paragraph).tokens, ctx))); break;
      case 'text': out.push(para(inline([t], ctx))); break;
      case 'hr': out.push({ type: 'horizontalRule' }); break;
      case 'code': {
        const c = t as Tokens.Code;
        const lang = (c.lang ?? '').trim().split(/\s+/)[0]!.toLowerCase();
        if (lang === 'mermaid' || lang === 'plantuml') out.push({ type: lang, attrs: { code: c.text } });
        else out.push({ type: 'codeBlock', attrs: { language: lang || null }, content: c.text ? [text(c.text)] : [] });
        break;
      }
      case 'blockquote': out.push(blockquote(t as Tokens.Blockquote, ctx)); break;
      case 'list': out.push(list(t as Tokens.List, ctx)); break;
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, type: string): DocNode => ({ type, content: [para(inline(c.tokens, ctx))] });
        out.push({ type: 'table', content: [
          { type: 'tableRow', content: tb.header.map((c) => cell(c, 'tableHeader')) },
          ...tb.rows.map((r): DocNode => ({ type: 'tableRow', content: r.map((c) => cell(c, 'tableCell')) })),
        ] });
        break;
      }
      default: break; // space, html…
    }
  }
  return out;
}

function blockquote(t: Tokens.Blockquote, ctx: Ctx): DocNode {
  const inner = blocks(t.tokens, ctx);
  const first = inner[0];
  const firstText = first?.type === 'paragraph' ? (first.content ?? []).map((n) => n.text ?? '').join('') : '';
  const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(firstText);
  if (alert && first) {
    const rest = (first.content ?? []).filter((n, i) => !(i === 0 && n.type === 'text'));
    const firstNode = first.content?.[0];
    const stripped = firstNode?.text ? [text(firstNode.text.replace(/^\[!\w+\]\s*/, ''), (firstNode.marks as Mark[]) ?? [])].filter((n) => n.text) : [];
    const body = [para([...stripped, ...rest]), ...inner.slice(1)];
    return { type: 'callout', attrs: { type: CALLOUT_ALERT[alert[1]!] }, content: body };
  }
  const last = inner[inner.length - 1];
  const lastNode = last?.type === 'paragraph' ? last.content?.[last.content.length - 1] : undefined;
  const cls = lastNode?.type === 'text' ? /\s*\{\.(is-info|is-warning|is-success|is-danger)\}\s*$/.exec(lastNode.text ?? '') : null;
  if (last && lastNode && cls) {
    const remaining = (lastNode.text ?? '').slice(0, cls.index);
    const content = [...(last.content ?? []).slice(0, -1), ...(remaining ? [{ ...lastNode, text: remaining }] : [])];
    const body = [...inner.slice(0, -1), ...(content.length ? [para(content)] : [])];
    return { type: 'callout', attrs: { type: CALLOUT_CLASS[cls[1]!] }, content: body.length ? body : [para()] };
  }
  return { type: 'blockquote', content: inner.length ? inner : [para()] };
}

function list(t: Tokens.List, ctx: Ctx): DocNode {
  const isTask = t.items.some((i) => i.task);
  const items = t.items.map((item): DocNode => {
    const content = blocks(item.tokens, ctx);
    const body = content.length ? content : [para()];
    return isTask ? { type: 'taskItem', attrs: { checked: !!item.checked }, content: body } : { type: 'listItem', content: body };
  });
  if (isTask) return { type: 'taskList', content: items };
  return t.ordered ? { type: 'orderedList', attrs: { start: typeof t.start === 'number' ? t.start : 1 }, content: items } : { type: 'bulletList', content: items };
}

export function markdownToDoc(md: string, ctx: Ctx): DocNode {
  const content = blocks(marked.lexer(md, { gfm: true }), ctx);
  return { type: 'doc', content: content.length ? content : [para()] };
}

// ---- Import ----------------------------------------------------------------------------------

export function importMarkdown(db: DB, input: { spaceId: string; files: ImportFile[]; userId: string | null }): ImportResult {
  const { files } = input;
  if (!files.length) throw new HttpError(400, 'Aucun fichier à importer');
  if (files.length > IMPORT_LIMITS.files) throw new HttpError(413, `Trop de fichiers (maximum ${IMPORT_LIMITS.files})`);
  let total = 0;
  for (const f of files) {
    if (!validPath(f.path)) throw new HttpError(400, `Chemin invalide : ${f.path.slice(0, 120)}`);
    if (f.content.length > IMPORT_LIMITS.fileBytes) throw new HttpError(413, `Fichier trop volumineux : ${f.path.slice(0, 120)}`);
    total += f.content.length;
  }
  if (total > IMPORT_LIMITS.totalBytes) throw new HttpError(413, 'Volume total trop important');
  if (!db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(input.spaceId)) throw new HttpError(404, 'Espace introuvable');

  // Préfixe de langue de Wiki.js (« en/… ») retiré s'il est commun à tous les fichiers.
  let prefix = '';
  const firsts = new Set(files.map((f) => normPath(f.path).split('/')[0]!));
  if (firsts.size === 1 && files.every((f) => normPath(f.path).includes('/')) && LOCALE.test([...firsts][0]!)) prefix = `${[...firsts][0]}/`;
  const rel = (p: string) => normPath(p).slice(prefix.length);

  const parsed = files.map((f) => ({ path: rel(f.path), ...parseFrontMatter(f.content) }));
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(key(p.path))) throw new HttpError(400, `Chemin en double : ${p.path}`);
    seen.add(key(p.path));
  }

  const stats: ImportResult = { pages: 0, folders: 0, links: { resolved: 0, unresolved: 0 }, images: 0 };
  const ids = new Map<string, string>(); // chemin normalisé (minuscules) -> id de page
  const ensure = (path: string, title: string, parentId: string | null, folder: boolean) => {
    const row = createPage(db, { spaceId: input.spaceId, parentId, title: title.slice(0, 300) }, input.userId);
    ids.set(key(path), row.id);
    if (folder) stats.folders++; else stats.pages++;
    return row.id;
  };

  db.transaction(() => {
    // Les parents d'abord : tri par profondeur puis par nom.
    const order = [...parsed].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    for (const p of order) {
      const segs = p.path.split('/');
      let parent: string | null = null;
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        parent = ids.get(key(dir)) ?? ensure(dir, humanize(segs[i - 1]!), parent, true);
      }
      const existing = ids.get(key(p.path));
      if (existing) continue; // dossier créé avant que sa page ne soit rencontrée : traité plus bas
      ensure(p.path, p.meta.title || humanize(segs[segs.length - 1]!), parent, false);
    }

    const resolveLink = (href: string, from: string) => {
      let target = href.split('#')[0]!.split('?')[0]!;
      try { target = decodeURIComponent(target); } catch { /* inchangé */ }
      if (!target) return null;
      const abs = target.startsWith('/') ? normPath(target) : normPath(`${from.split('/').slice(0, -1).join('/')}/${target}`);
      const candidates = [abs, abs.startsWith(prefix) ? abs.slice(prefix.length) : abs, abs.replace(/^[a-z]{2}(?:-[A-Za-z]{2})?\//, '')];
      for (const c of candidates) { const id = ids.get(key(c)); if (id) return id; }
      return null;
    };

    for (const p of parsed) {
      const id = ids.get(key(p.path))!;
      const doc = sanitizeDoc(markdownToDoc(p.body, { resolveLink, from: p.path, stats }));
      updatePage(db, id, { content: doc, title: p.meta.title || undefined }, input.userId);
    }
  })();
  return stats;
}
