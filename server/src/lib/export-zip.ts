// Export ZIP d'une page (avec ou sans ses sous-pages) ou d'un espace : une arborescence de dossiers en Markdown ou en HTML,
// les bases en CSV, et les fichiers cités dans un dossier `attachments/` à la racine, avec des liens relatifs réécrits.
// N'entre dans l'archive que ce que la personne peut lire : pages de la corbeille exclues, page illisible (restreinte) exclue
// avec toutes ses sous-pages, pièce jointe seulement si sa page (ou son modèle) est lisible. Les noms viennent des titres,
// assainis (aucun « .. », séparateur ni caractère de contrôle) et rendus uniques dans chaque dossier.
// Tout est calculé avant le premier octet : un plafond dépassé donne une vraie réponse 413 ; les fichiers sont lus en flux.
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { canReadAttachment, loadReadablePage, readableSpaceIds } from './access.js';
import { ATTACHMENT_ID, attachmentPath, INLINE_MIMES, sanitizeFilename, sniffMime, type AttachmentMime } from './attachments.js';
import { presentRows, propertiesOf, readBudget, toCsv } from './bases.js';
import { type DocNode, mentionIds } from './content.js';
import { HttpError } from './http.js';
import { type ExportLinks, toMarkdown } from './markdown.js';
import { readersAmong } from './mentions.js';
import { canReadPage, filterReadable } from './page-acl.js';
import { escapeHtml, renderHtml } from './render-html.js';
import { expandSyncedCopies } from './synced-blocks.js';
import { zipEntryName, zipStream, type ZipEntry } from './zip.js';

export type ExportFormat = 'md' | 'html';
export interface ExportLimits { maxPages: number; maxBytes: number; inlineBytes: number }
export interface ExportSummary { pages: number; files: number; images: number; missing: number; bytes: number }

interface Meta { id: string; parent_id: string | null; title: string; icon: string; kind: 'doc' | 'base'; updated_at: number }
interface Node extends Meta { children: Node[]; file: string; dir: string }

const MB = 1024 * 1024;
// Images base64 encore dans les pages : décodées une à une au moment de l'écriture, plafonnées à part.
export const INLINE_IMAGES_MAX_BYTES = 64 * MB;
const FILES_DIR = 'attachments';
const IMAGE_SRC = /^\/api\/v3\/attachments\/([A-Za-z0-9_-]{22})$/;
const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const STORED = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/zip', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg']);
// Extension d'un fichier de l'archive, d'après le type reconnu sur ses octets.
const FILE_EXT: Record<AttachmentMime, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'application/zip': '.zip',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'application/octet-stream': '.bin',
};
const PREPARE_BATCH = 50;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Noms réservés par Windows : un dossier « CON » ne se crée pas.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const SEGMENT_MAX = 120;

const key = (n: string) => n.toLocaleLowerCase('fr');

/** Segment de chemin tiré d'un titre : jamais vide, sans séparateur, « .. », caractère de contrôle ni nom réservé ; borné. */
export function pathSegment(raw: string, fallback = 'Sans titre'): string {
  // Segment témoin « a/ » : zipEntryName ne renvoie jamais une chaîne vide, ce qui masquerait un titre fait de points ou d'espaces.
  const named = zipEntryName(`a/${(raw || '').replace(/[/\\]/g, '-')}`);
  let s = named === 'a' ? '' : [...named.slice(2)].slice(0, SEGMENT_MAX).join('').replace(/[\s.]+$/, '');
  if (!s) s = fallback;
  if (s && RESERVED.test(s.split('.')[0]!)) s = `_${s}`;
  return s;
}

/** Réserve dans un dossier un nom de fichier (`base` + `ext`) et, si `withDir`, le dossier `base` : « Titre (2) » en cas de doublon. */
function reserve(used: Set<string>, base: string, ext: string, withDir: boolean): string {
  const free = (b: string) => !used.has(key(b + ext)) && (!withDir || !used.has(key(b)));
  let b = base;
  for (let i = 2; !free(b); i++) b = `${base} (${i})`;
  used.add(key(b + ext));
  if (withDir) used.add(key(b));
  return b;
}

// Chemin relatif d'un fichier de l'archive vu depuis un autre (segments encodés pour une adresse).
function relative(from: string, to: string): string {
  const depth = from.split('/').length - 1;
  return '../'.repeat(depth) + to.split('/').map(encodeURIComponent).join('/');
}

const htmlPage = (title: string, body: string) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>body{max-width:48rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6}img{max-width:100%}pre{overflow:auto;background:#f4f4f5;padding:.75rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}aside{border-left:4px solid #888;padding-left:1rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;

/**
 * Prépare l'archive. `rootIds` : pages de départ (déjà contrôlées par l'appelant), toutes dans `spaceId` ; `subpages` : descendre
 * dans les sous-pages lisibles. Lève 413 si un plafond est dépassé, avant toute écriture.
 */
export async function buildExport(db: DB, req: FastifyRequest, opts: {
  spaceId: string; rootIds: string[]; subpages: boolean; format: ExportFormat; filesDir: string; limits: ExportLimits;
}): Promise<{ stream: AsyncGenerator<Buffer>; summary: ExportSummary }> {
  const metas = db.prepare(
    `SELECT id, parent_id, title, icon, kind, updated_at FROM pages WHERE space_id = ? AND deleted_at IS NULL ORDER BY position, created_at`,
  ).all(opts.spaceId) as Meta[];
  // Une seule passe de contrôle d'accès pour tout l'espace (espace, restrictions de page, bases sans compte).
  const readable = new Set(filterReadable(db, req.auth, metas).map((m) => m.id));
  const byParent = new Map<string | null, Meta[]>();
  for (const m of metas) {
    const list = byParent.get(m.parent_id);
    if (list) list.push(m); else byParent.set(m.parent_id, [m]);
  }
  const byId = new Map(metas.map((m) => [m.id, m]));

  // Arborescence : une page illisible n'entre pas, ses sous-pages non plus (on ne révèle rien de ce qui est sous elle).
  let count = 0;
  const grow = (m: Meta, depth: number): Node => {
    if (++count > opts.limits.maxPages) throw new HttpError(413, `Trop de pages à exporter (${opts.limits.maxPages} au plus) : exportez une partie de l’arborescence`);
    const kids = opts.subpages && depth < 100 ? (byParent.get(m.id) ?? []).filter((c) => readable.has(c.id)).map((c) => grow(c, depth + 1)) : [];
    return { ...m, children: kids, file: '', dir: '' };
  };
  const roots = opts.rootIds.map((id) => byId.get(id)).filter((m): m is Meta => !!m && readable.has(m.id)).map((m) => grow(m, 0));

  // Noms : un fichier par page, un dossier du même nom pour ses sous-pages ; « attachments » est réservé à la racine.
  const ext = opts.format === 'html' ? '.html' : '.md';
  const place = (nodes: Node[], dir: string, used: Set<string>) => {
    for (const n of nodes) {
      const fileExt = n.kind === 'base' ? '.csv' : ext;
      const base = reserve(used, pathSegment(n.title), fileExt, true);
      n.file = `${dir}${base}${fileExt}`;
      n.dir = `${dir}${base}/`;
      place(n.children, n.dir, new Set());
    }
  };
  place(roots, '', new Set([key(FILES_DIR)]));
  const all: Node[] = [];
  const flatten = (nodes: Node[]) => { for (const n of nodes) { all.push(n); flatten(n.children); } };
  flatten(roots);
  const fileOfPage = new Map(all.map((n) => [n.id, n.file]));

  // Fichiers cités : pièces jointes lisibles présentes sur le disque, images base64 raster (type reconnu sur les octets).
  // Ils sont inscrits pendant la préparation ; ensuite (`frozen`), plus rien ne s'ajoute : une page modifiée pendant le flux ne
  // peut pas citer un fichier absent de l'archive (son lien reste alors celui du wiki).
  let frozen = false;
  const usedFiles = new Set<string>();
  const attachmentRow = db.prepare('SELECT id, page_id, template_id, name, mime, size, created_at FROM attachments WHERE id = ?');
  const files = new Map<string, { path: string; entry: ZipEntry } | null>();
  // Images base64 : indexées par l'empreinte de la chaîne, jamais gardées en mémoire ; seuls la page et la taille sont retenues.
  const images = new Map<string, { path: string; entry: ZipEntry } | null>();
  let inlineBytes = 0;
  let inlineCount = 0;
  let missing = 0;
  const content = db.prepare('SELECT content FROM pages WHERE id = ?');
  const fileFor = (id: string) => {
    if (files.has(id) || frozen) return files.get(id) ?? null;
    const row = attachmentRow.get(id) as { id: string; page_id: string | null; template_id: string | null; name: string; mime: AttachmentMime; size: number; created_at: number } | undefined;
    let out: { path: string; entry: ZipEntry } | null = null;
    if (row && ((row.page_id && fileOfPage.has(row.page_id)) || canReadAttachment(db, req, row))) {
      const disk = attachmentPath(opts.filesDir, row.id);
      let ok = false;
      try { ok = statSync(disk).size === row.size; } catch { /* absent du disque */ }
      if (ok) {
        // Extension déduite du type reconnu sur les octets, jamais du nom d'origine (« facture.pdf.html » ne s'ouvre pas en HTML).
        const name = sanitizeFilename(row.name);
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 && name.length - dot <= 12 ? name.slice(0, dot) : name;
        const ext = FILE_EXT[row.mime] ?? '.bin';
        const path = `${FILES_DIR}/${reserve(usedFiles, pathSegment(stem, 'fichier'), ext, false)}${ext}`;
        out = { path, entry: { name: path, size: row.size, mtime: row.created_at, store: STORED.has(row.mime), body: () => createReadStream(disk) } };
      } else missing++;
    }
    files.set(id, out);
    return out;
  };
  const imageFor = (src: string, pageId: string) => {
    const m = DATA_IMAGE.exec(src);
    if (!m) { const id = IMAGE_SRC.exec(src)?.[1]; return id ? fileFor(id) : null; }
    const key = sha(src);
    if (images.has(key) || frozen) return images.get(key) ?? null;
    let out: { path: string; entry: ZipEntry } | null = null;
    const bytes = Buffer.from(m[2]!, 'base64');
    const mime = sniffMime(bytes.subarray(0, 64));
    // Un SVG (ou tout ce qui n'est pas une image raster reconnue) n'est jamais copié dans l'archive.
    if (INLINE_MIMES.has(mime) && bytes.length > 0) {
      inlineBytes += bytes.length;
      if (inlineBytes > opts.limits.inlineBytes) {
        throw new HttpError(413, `Trop d’images intégrées aux pages (${Math.round(opts.limits.inlineBytes / MB)} Mo au plus) : convertissez-les d’abord en pièces jointes`);
      }
      const path = `${FILES_DIR}/${reserve(usedFiles, `image-${++inlineCount}`, FILE_EXT[mime]!, false)}${FILE_EXT[mime]!}`;
      // Redécodée au moment de l'écriture, depuis la page relue : une seule image en mémoire à la fois.
      const body = () => {
        const found = findDataImage(imageDocOf(pageId), key);
        if (!found) throw new Error('image modifiée pendant l’export');
        return Buffer.from(found, 'base64');
      };
      out = { path, entry: { name: path, size: bytes.length, mtime: Date.now(), store: true, body } };
    }
    images.set(key, out);
    return out;
  };

  // Contenu d'une page tel qu'exporté : copies synchronisées résolues seulement si la personne peut lire la page source.
  const canReadSource = (pid: string) => { try { loadReadablePage(db, req, pid); return true; } catch { return false; } };
  const docOf = (pageId: string) => expandSyncedCopies(db,
    JSON.parse((content.get(pageId) as { content: string } | undefined)?.content ?? '{"type":"doc","content":[]}') as DocNode, canReadSource);
  // Images intégrées : écrites à la suite pour une même page, d'où un cache d'une seule page développée (la dernière) plutôt que
  // de garder toutes les pages en mémoire pendant l'export.
  let lastImageDoc: { pageId: string; doc: DocNode } | null = null;
  const imageDocOf = (pageId: string) => {
    if (lastImageDoc?.pageId !== pageId) lastImageDoc = { pageId, doc: docOf(pageId) };
    return lastImageDoc.doc;
  };

  // Titres des pages liées : celles de l'archive, ou une page lisible ailleurs (lien absolu vers le wiki).
  const visible = new Set(readableSpaceIds(db, req));
  const titleCache = new Map<string, string | null>();
  const titleOf = (id: string) => {
    if (titleCache.has(id)) return titleCache.get(id)!;
    const local = byId.get(id);
    let t: string | null = null;
    if (local && fileOfPage.has(id)) t = local.title || 'Sans titre';
    else {
      const p = db.prepare('SELECT space_id, title, deleted_at FROM pages WHERE id = ?').get(id) as { space_id: string; title: string; deleted_at: number | null } | undefined;
      if (p && visible.has(p.space_id) && !p.deleted_at && canReadPage(db, req.auth, id)) t = p.title || 'Sans titre';
    }
    titleCache.set(id, t);
    return t;
  };

  // Budget de calcul des bases (formules, cumuls, expressions régulières) : UN pour tout l'export, et non un par base. Le flux
  // refait le rendu de la préparation dans le même ordre : il repart d'un budget neuf (même résultat, travail total borné à deux budgets).
  let baseBudget = readBudget();
  // Texte d'une page, produit à la préparation (taille estimée, fichiers inscrits) puis de nouveau pendant le flux.
  const render = (n: Node): Buffer => {
    if (n.kind === 'base') {
      const props = propertiesOf(db, n.id);
      return Buffer.from(toCsv(props, presentRows({ db, auth: req.auth, spaces: visible, baseId: n.id }, props, !!req.auth, undefined, baseBudget)), 'utf8');
    }
    const doc = docOf(n.id);
    const names = new Map(readersAmong(db, n.id, mentionIds(doc), 200).map((u) => [u.id, u.name]));
    const links: ExportLinks = {
      page: (id) => (fileOfPage.has(id) ? relative(n.file, fileOfPage.get(id)!) : null),
      file: (id) => { const f = ATTACHMENT_ID.test(id) ? fileFor(id) : null; return f ? relative(n.file, f.path) : null; },
      image: (src) => { const f = imageFor(src, n.id); return f ? relative(n.file, f.path) : null; },
    };
    const title = `${n.icon ? `${n.icon} ` : ''}${n.title || 'Sans titre'}`;
    return Buffer.from(opts.format === 'html'
      ? htmlPage(title, renderHtml(doc, titleOf, (id) => names.get(id) ?? null, links))
      : toMarkdown(n.title, n.icon, doc, titleOf, (id) => names.get(id) ?? null, links), 'utf8');
  };

  // Préparation par lots : la boucle d'événements reprend la main entre deux lots.
  const sizes = new Map<string, number>();
  for (let i = 0; i < all.length; i += PREPARE_BATCH) {
    await new Promise((done) => setImmediate(done));
    for (const n of all.slice(i, i + PREPARE_BATCH)) sizes.set(n.id, render(n).length);
  }
  frozen = true;
  baseBudget = readBudget();

  const pageEntries: ZipEntry[] = all.map((n) => ({ name: n.file, size: sizes.get(n.id)!, exact: false, mtime: n.updated_at, body: () => render(n) }));
  const fileEntries = [...new Map([...files.values(), ...images.values()].filter((f): f is { path: string; entry: ZipEntry } => !!f).map((f) => [f.path, f.entry])).values()];
  const entries = [...pageEntries, ...fileEntries];
  const bytes = entries.reduce((s, e) => s + e.size, 0);
  if (bytes > opts.limits.maxBytes) throw new HttpError(413, `Export trop volumineux (${Math.round(opts.limits.maxBytes / MB)} Mo au plus) : exportez une partie de l’arborescence`);
  return {
    stream: zipStream(entries),
    summary: { pages: all.length, files: [...files.values()].filter(Boolean).length, images: [...images.values()].filter(Boolean).length, missing, bytes },
  };

}

// Chaîne base64 de l'image `data:` dont l'adresse a l'empreinte `key`, ou null.
function findDataImage(doc: DocNode, key: string): string | null {
  const src = doc.type === 'image' ? doc.attrs?.src : undefined;
  if (typeof src === 'string' && src.startsWith('data:') && sha(src) === key) return DATA_IMAGE.exec(src)?.[2] ?? null;
  for (const c of doc.content ?? []) { const r = findDataImage(c, key); if (r) return r; }
  return null;
}
