// Import d'un document Word (.docx) ou PDF : une page créée à partir du texte et de la structure.
// La conversion tourne dans un processus enfant isolé (doc-worker.js) : modèle de permissions de Node (lecture seule de
// node_modules), mémoire surveillée, délai maximal, aucun accès à la base, au réseau ni au reste du disque. Un .docx est une archive ZIP : elle est d'abord contrôlée par notre lecteur (bombe, chemins, taille réelle des entrées,
// somme de contrôle) avant d'être confiée au worker. Un PDF est lu pour son texte seulement (pas de mise en page, pas d'OCR).
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '../db.js';
import { type AttachmentCloner, type AttachmentWriter, INLINE_MIMES } from './attachments.js';
import { type DocNode, sanitizeDoc } from './content.js';
import { HttpError } from './http.js';
import { type ImportResult, markdownToDoc } from './markdown-import.js';
import type { ImportReport, ReportItem } from './notion-import.js';
import { createPage, updatePage } from './pages.js';
import { ZipArchive } from './zip-read.js';

export type DocKind = 'docx' | 'pdf';

export interface DocLimits { timeoutMs: number; maxPages: number; zipEntries: number; zipUncompressedBytes: number; zipRatio: number }

interface WorkerOk { ok: true; markdown: string; images: { mime: string; data: Uint8Array }[]; notes: string[] }
interface WorkerErr { ok: false; status: number; message: string }

const require = createRequire(import.meta.url);
const WORKER_FILE = new URL('./doc-worker.js', import.meta.url);
const MAX_IMAGES = 200;
const MAX_TITLE = 200;

/** Type d'après les octets (jamais d'après le nom ni le type annoncé). */
export function sniffDocument(buf: Buffer): DocKind | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'docx'; // ZIP ; la structure Word est vérifiée ensuite
  return null;
}

const MAX_CHILD_RSS = 1024 * 1024 * 1024; // mémoire résidente maximale du processus de conversion (Linux)
const MAX_DOCX_UNCOMPRESSED = 200 * 1024 * 1024; // un document Word décompressé n'a pas à dépasser ce volume

/** Dossier node_modules qui contient mammoth (et ses dépendances) : seul endroit lisible par le processus de conversion. */
const modulesDir = (() => { const f = require.resolve('mammoth'); return f.slice(0, f.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length); })();

function runWorker(kind: DocKind, data: Buffer, limits: DocLimits, maxImageBytes: number): Promise<WorkerOk> {
  return new Promise((resolve, reject) => {
    let done = false;
    // Processus enfant : ni variable d'environnement, ni écriture, ni réseau, ni sous-processus (modèle de permissions de Node) ;
    // lecture limitée à node_modules et au script. Le canal IPC est la seule voie de communication.
    const child = fork(fileURLToPath(WORKER_FILE), [], {
      execArgv: ['--permission', `--allow-fs-read=${modulesDir}`, `--allow-fs-read=${fileURLToPath(WORKER_FILE)}`, '--max-old-space-size=512'],
      env: {}, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); clearInterval(watch); child.kill('SIGKILL'); fn(); };
    const timer = setTimeout(() => finish(() => reject(new HttpError(422, `Conversion trop longue (plus de ${Math.round(limits.timeoutMs / 1000)} s) : document trop complexe`))), limits.timeoutMs);
    // Mémoire résidente (hors tas V8 : flux décompressés d'un PDF) surveillée, processus tué au-delà du plafond.
    const watch = setInterval(() => {
      if (!child.pid) return;
      try {
        const pages = Number(readFileSync(`/proc/${child.pid}/statm`, 'utf8').split(' ')[1]);
        if (pages * 4096 > MAX_CHILD_RSS) finish(() => reject(new HttpError(422, 'Document trop volumineux pour être converti')));
      } catch { /* pas de /proc (hors Linux) : seul le délai protège */ }
    }, 250);
    child.on('message', (m: WorkerOk | WorkerErr) => finish(() => (m.ok ? resolve(m) : reject(new HttpError(m.status, m.message)))));
    child.on('error', () => finish(() => reject(new HttpError(422, 'Document illisible ou non pris en charge'))));
    child.on('exit', () => finish(() => reject(new HttpError(422, 'Conversion interrompue : document trop volumineux ou illisible'))));
    child.send({ kind, data, maxPages: limits.maxPages, maxImages: MAX_IMAGES, maxImageBytes, mammothPath: require.resolve('mammoth'), pdfjsUrl: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href });
  });
}

/** Contrôle d'un .docx : archive saine, structure Word présente, chaque entrée relue (taille réelle et somme de contrôle). */
function checkDocx(buf: Buffer, limits: DocLimits) {
  const zip = new ZipArchive(buf, { maxEntries: limits.zipEntries, maxTotalBytes: Math.min(limits.zipUncompressedBytes, MAX_DOCX_UNCOMPRESSED), maxRatio: limits.zipRatio });
  if (!zip.items.some((i) => i.path === 'word/document.xml')) throw new HttpError(422, 'Ce fichier n’est pas un document Word (word/document.xml absent)');
  for (const i of zip.items) zip.read(i.path);
  if (zip.skipped.some((s) => s.path.startsWith('word/'))) throw new HttpError(422, 'Document Word invalide (entrée refusée dans « word/ »)');
}

class DryRun extends Error { constructor(readonly report: ImportReport) { super('dry-run'); } }

export interface DocumentImportInput {
  kind: DocKind;
  buffer: Buffer;
  /** Nom d'origine du fichier (titre de la page, extension retirée). */
  filename: string;
  spaceId: string;
  parentId: string | null;
  userId: string;
  writer: AttachmentWriter;
  cloner: AttachmentCloner;
  limits: DocLimits;
  dryRun: boolean;
}

/** Textes voisins de mêmes marques réunis (les caractères protégés par une barre oblique inverse les avaient coupés). */
function mergeText(node: DocNode): DocNode {
  if (!node.content) return node;
  const out: DocNode[] = [];
  for (const child of node.content.map(mergeText)) {
    const last = out[out.length - 1];
    if (last && last.type === 'text' && child.type === 'text' && JSON.stringify(last.marks ?? null) === JSON.stringify(child.marks ?? null)) {
      out[out.length - 1] = { ...last, text: `${last.text ?? ''}${child.text ?? ''}` };
    } else out.push(child);
  }
  return { ...node, content: out };
}

// eslint-disable-next-line no-control-regex
const cleanTitle = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.(docx|pdf)$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'Document importé';

export async function importDocument(db: DB, input: DocumentImportInput): Promise<ImportReport> {
  if (input.kind === 'docx') checkDocx(input.buffer, input.limits);
  const out = await runWorker(input.kind, input.buffer, input.limits, input.writer.fileLimit);
  const title = cleanTitle(input.filename);
  const items: ReportItem[] = [];
  const notes = new Set<string>(out.notes);
  const stats: ImportResult = { pages: 0, folders: 0, links: { resolved: 0, unresolved: 0 }, images: 0 };
  let attachments = 0;

  const run = () => {
    const page = createPage(db, { spaceId: input.spaceId, parentId: input.parentId, title }, input.userId);
    stats.pages = 1;
    const item: ReportItem = { path: input.filename.slice(0, 300), status: 'imported', kind: 'page', title, ...(input.dryRun ? {} : { pageId: page.id }) };
    items.push(item);

    const resolveImage = (href: string): DocNode | null => {
      const m = /^docimg:(\d+)$/.exec(href);
      const img = m ? out.images[Number(m[1])] : undefined;
      if (!img) return null;
      const name = `image-${Number(m![1]) + 1}`;
      try {
        const s = input.writer.store(page.id, name, Buffer.from(img.data));
        if (!INLINE_MIMES.has(s.mime)) { notes.add(`image non affichable (${img.mime}) jointe comme fichier`); }
        attachments++;
        items.push({ path: name, status: 'imported', kind: 'attachment', title: s.name, ...(input.dryRun ? {} : { pageId: page.id }) });
        return INLINE_MIMES.has(s.mime)
          ? { type: 'image', attrs: { src: `/api/v3/attachments/${s.id}` } }
          : { type: 'attachment', attrs: { id: s.id, name: s.name, size: s.size, mime: s.mime } };
      } catch (err) {
        // Image vide, trop lourde ou quota plein : image écartée, l'import continue.
        if (!(err instanceof HttpError)) throw err;
        notes.add(`image non jointe (${name}) : ${err.message}`);
        items.push({ path: name, status: 'skipped', kind: 'attachment', reason: err.message });
        return null;
      }
    };
    try {
      const raw = markdownToDoc(out.markdown, { resolveLink: () => null, resolveImage, from: input.filename, stats, notes });
      updatePage(db, page.id, { content: sanitizeDoc(mergeText(raw)) }, input.userId, input.cloner);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      notes.add(`contenu non importé (${err.message}) : page créée vide`);
    }
    if (stats.images) notes.add(`${stats.images} image(s) non reprise(s)`);
    if (input.kind === 'pdf') notes.add('texte seulement : la mise en page, les images et les tableaux d’un PDF ne sont pas repris');
    if (notes.size) item.notes = [...notes];
    const report: ImportReport = {
      summary: { pages: 1, bases: 0, tables: 0, folders: 0, attachments, skipped: items.filter((i) => i.status === 'skipped').length, links: stats.links },
      items,
    };
    if (input.dryRun) throw new DryRun(report);
    return report;
  };

  try {
    return db.transaction(run)();
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  }
}
