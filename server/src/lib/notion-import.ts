// Import d'un export Notion au format « Markdown & CSV » (archive ZIP lue par lib/zip-read.ts).
//
// Structure observée sur de vrais exports : chaque page est un fichier « Titre <id 32 hex>.md » ; ses sous-pages et ses fichiers sont
// dans un dossier « Titre/ » à côté d'elle. Une base est « Titre <id>.csv » (colonnes visibles) et « Titre <id>_all.csv » (toutes les
// colonnes), ses lignes sont des pages « .md » dans le dossier « Titre/ ». Liens relatifs encodés (%20), images en « ![](Titre/x.png) »,
// fichiers en « [x.pdf](Titre/x.pdf) », callouts en citations commençant par un émoji.
//
// Tout passe par la conversion Markdown existante (lib/markdown-import.ts, le HTML éventuel par lib/html-import.ts) puis par
// sanitizeDoc. Le format HTML de Notion n'est pas pris en charge (fichiers .html écartés avec leur motif).
// L'import se fait dans une seule transaction ; une simulation exécute exactement le même code puis annule la transaction.
import { posix } from 'node:path';
import type { Auth } from '../auth/context.js';
import type { DB } from '../db.js';
import { type AttachmentCloner, type AttachmentWriter, INLINE_MIMES, type StoredAttachment } from './attachments.js';
import {
  addProperty, addRow, createBase, MAX_BASE_CHARS, MAX_PROPERTIES, MAX_ROW_CHARS, MAX_ROWS, MAX_TEXT, propertiesOf, reindexBase, updateProperty,
} from './bases.js';
import { type DocNode, sanitizeDoc } from './content.js';
import { HttpError } from './http.js';
import { IMPORT_LIMITS, type ImportResult, markdownToDoc, type ResolvedFile } from './markdown-import.js';
import { createPage, updatePage } from './pages.js';
import { type ZipArchive, ZipError } from './zip-read.js';

export type ReportKind = 'page' | 'base' | 'table' | 'folder' | 'attachment' | 'file';
export interface ReportItem {
  path: string;
  status: 'imported' | 'skipped';
  kind: ReportKind;
  title?: string;
  pageId?: string;
  reason?: string;
  notes?: string[];
}
export interface ImportSummary {
  pages: number; bases: number; tables: number; folders: number; attachments: number; skipped: number;
  links: { resolved: number; unresolved: number };
  /** Lignes du rapport non listées (au-delà de REPORT_MAX_ITEMS). */
  truncated?: number;
}
export interface ImportReport { summary: ImportSummary; items: ReportItem[] }
const REPORT_MAX_ITEMS = 5000;
const TEXT_TOTAL_BYTES = 50_000_000;

export interface NotionImportInput {
  zip: ZipArchive;
  spaceId: string;
  parentId: string | null;
  userId: string | null;
  auth: Auth | null;
  writer: AttachmentWriter;
  cloner?: AttachmentCloner;
  dryRun: boolean;
}

// Lignes d'un tableau de repli (base trop complexe pour devenir une base BeNote).
export const TABLE_MAX_ROWS = 500;
const MAX_TITLE = 300;
const MAX_COLUMN_NAME = 60;
const NOTION_ID = /^(.*?)\s+([0-9a-f]{32})$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
// Marque d'ordre des octets (U+FEFF) en tête des CSV de Notion.
const noBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const clean = (s: string, max: number) => s.replace(CONTROL, '').normalize('NFC').trim().slice(0, max);

// Simulation : la transaction est annulée en levant cette erreur, une fois le rapport établi.
class DryRun extends Error { constructor(readonly report: ImportReport) { super('simulation'); } }

interface Node {
  path: string;
  dir: string;
  kind: 'page' | 'base';
  stem: string;
  notionId: string | null;
  title: string;
  body: string;
  /** Lignes d'une base (CSV) ; null pour une page. */
  rows: string[][] | null;
  /** Base convertie en tableau dans une page (trop complexe pour une base BeNote). */
  asTable: string | null;
  pageId?: string;
  item: ReportItem;
}

/** Titre et identifiant Notion d'un nom de fichier (« Titre 0123…abcd.md », « Titre 0123…abcd_all.csv »). */
export function notionName(file: string): { stem: string; id: string | null } {
  const base = posix.basename(file).replace(/\.(md|csv)$/i, '').replace(/_all$/i, '');
  const m = NOTION_ID.exec(base);
  return m ? { stem: m[1]!.trim() || 'Sans titre', id: m[2]!.toLowerCase() } : { stem: base.trim() || 'Sans titre', id: null };
}

/** CSV (RFC 4180) : guillemets doublés, retours à la ligne dans un champ entre guillemets, BOM retiré. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = noBom(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Chemin de l'archive visé par un lien relatif d'un fichier, ou null (adresse externe, hors de l'archive). */
function target(href: string, from: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
  let t = href.split('#')[0]!.split('?')[0]!;
  try { t = decodeURIComponent(t); } catch { /* laissé tel quel */ }
  if (!t) return null;
  const abs = posix.normalize(posix.join(posix.dirname(from), t));
  return abs.startsWith('../') || abs === '..' || abs.startsWith('/') ? null : abs.normalize('NFC');
}

// Page « ligne de base » : les propriétés (« Clé: valeur ») suivent le titre, une par ligne ; gardées une par ligne.
const PROPERTY_LINE = /^[^:]{1,100}: /;
function propertyLines(body: string): string {
  const lines = body.split('\n');
  let start = 0;
  while (start < lines.length && !lines[start]!.trim()) start++;
  let end = start;
  while (end < lines.length && PROPERTY_LINE.test(lines[end]!)) end++;
  if (end === start) return body;
  return [...lines.slice(start, end - 1).map((l) => `${l.trimEnd()}  `), ...lines.slice(end - 1)].join('\n');
}

export function importNotion(db: DB, input: NotionImportInput): ImportReport {
  const { zip, spaceId, userId } = input;
  const items: ReportItem[] = zip.skipped.map((s) => ({ path: s.path, status: 'skipped', kind: 'file', reason: s.reason }));
  const stats: ImportResult = { pages: 0, folders: 0, links: { resolved: 0, unresolved: 0 }, images: 0 };
  const skip = (path: string, kind: ReportKind, reason: string) => items.push({ path: path.slice(0, 300), status: 'skipped', kind, reason });

  // ---- Tri des entrées ----
  const sizes = new Map(zip.items.map((i) => [i.path, i.size]));
  const files = new Map<string, number>(); // fichiers ordinaires (images, PDF…) : chemin -> taille
  const candidates: { path: string; kind: 'page' | 'base' }[] = [];
  for (const it of zip.items) {
    const lower = it.path.toLowerCase();
    if (lower.endsWith('.md')) candidates.push({ path: it.path, kind: 'page' });
    else if (lower.endsWith('_all.csv')) candidates.push({ path: it.path, kind: 'base' });
    else if (lower.endsWith('.csv')) {
      const twin = it.path.replace(/\.csv$/i, '_all.csv');
      if (sizes.has(twin)) skip(it.path, 'base', `doublon de « ${posix.basename(twin)} » (toutes les colonnes), importé à sa place`);
      else candidates.push({ path: it.path, kind: 'base' });
    } else if (/\.html?$/i.test(lower)) skip(it.path, 'page', 'format HTML de Notion non pris en charge : exportez en « Markdown & CSV »');
    else files.set(it.path, it.size);
  }
  // Parents avant enfants ; au-delà du plafond de pages, les plus profondes sont écartées.
  candidates.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const nodes: Node[] = [];
  let textBytes = 0;
  for (const c of candidates) {
    const size = sizes.get(c.path)!;
    if (nodes.length >= IMPORT_LIMITS.files) { skip(c.path, c.kind, `trop de pages (${IMPORT_LIMITS.files} au plus par import)`); continue; }
    if (size > IMPORT_LIMITS.fileBytes) { skip(c.path, c.kind, `plus de ${IMPORT_LIMITS.fileBytes / 1_000_000} Mo : découpez la page`); continue; }
    if (textBytes + size > TEXT_TOTAL_BYTES) { skip(c.path, c.kind, `plus de ${TEXT_TOTAL_BYTES / 1_000_000} Mo de texte au total : importez en plusieurs fois`); continue; }
    textBytes += size;
    const { stem, id } = notionName(c.path);
    const text = noBom(zip.read(c.path).toString('utf8'));
    const item: ReportItem = { path: c.path.slice(0, 300), status: 'imported', kind: c.kind };
    const node: Node = { path: c.path, dir: posix.dirname(c.path) === '.' ? '' : posix.dirname(c.path), kind: c.kind, stem, notionId: id, title: clean(stem, MAX_TITLE) || 'Sans titre', body: '', rows: null, asTable: null, item };
    if (c.kind === 'page') {
      // Le titre exact est celui du « # Titre » de tête (le nom de fichier perd certains caractères) ; il est retiré du corps.
      // Première ligne seulement, coupée à 1000 caractères : aucune expression régulière ne parcourt le texte entier (pas de retour
      // arrière quadratique sur une page piégée).
      const eol = text.indexOf('\n');
      const first = (eol < 0 ? text : text.slice(0, eol)).slice(0, 1000).replace(/\r$/, '');
      const h1 = /^#[ \t]+(.+)$/.exec(first);
      if (h1) { node.title = clean(h1[1]!.replace(/[ \t#]+$/, ''), MAX_TITLE) || node.title; node.body = eol < 0 ? '' : text.slice(eol + 1); } else node.body = text;
    } else node.rows = parseCsv(text);
    nodes.push(node);
    items.push(item);
  }

  // Dossier d'une page ou d'une base : « Titre/ » à côté du fichier (avec ou sans identifiant).
  const owners = new Map<string, Node>();
  for (const n of nodes) {
    for (const folder of [n.stem, n.notionId ? `${n.stem} ${n.notionId}` : null]) {
      if (!folder) continue;
      const key = n.dir ? `${n.dir}/${folder}` : folder;
      if (!owners.has(key)) owners.set(key, n);
      else if (owners.get(key) !== n) (n.item.notes ??= []).push(`dossier « ${folder} » partagé avec une autre page du même nom : ses sous-pages sont rangées sous l’autre`);
    }
  }
  const byPath = new Map<string, Node>();
  const byId = new Map<string, Node>();
  for (const n of nodes) {
    byPath.set(n.path, n);
    if (n.kind === 'base') { byPath.set(n.path.replace(/_all\.csv$/i, '.csv'), n); byPath.set(n.path.replace(/(?<!_all)\.csv$/i, '_all.csv'), n); }
    if (n.notionId && !byId.has(n.notionId)) byId.set(n.notionId, n);
  }

  const run = () => {
    // ---- Structure : pages, bases et dossiers intermédiaires ----
    const folders = new Map<string, string>();
    const parentOf = (dir: string): string | null => {
      if (!dir) return input.parentId;
      const owner = owners.get(dir);
      if (owner?.pageId) return owner.pageId;
      const existing = folders.get(dir);
      if (existing) return existing;
      // Dossier sans page (racine d'un export découpé, par exemple) : page intermédiaire à son nom.
      const parent = parentOf(posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
      const title = clean(notionName(posix.basename(dir)).stem, MAX_TITLE) || 'Sans titre';
      const row = createPage(db, { spaceId, parentId: parent, title }, userId);
      folders.set(dir, row.id);
      stats.folders++;
      items.push({ path: `${dir}/`.slice(0, 300), status: 'imported', kind: 'folder', title, ...(input.dryRun ? {} : { pageId: row.id }) });
      return row.id;
    };

    for (const n of nodes) {
      const parentId = parentOf(n.dir);
      if (n.kind === 'base') {
        const reason = baseProblem(n.rows!);
        if (reason) {
          n.asTable = reason;
          n.item.kind = 'table';
          n.pageId = createPage(db, { spaceId, parentId, title: n.title }, userId).id;
        } else n.pageId = createBase(db, { spaceId, parentId, title: n.title }, userId).id;
      } else {
        n.pageId = createPage(db, { spaceId, parentId, title: n.title }, userId).id;
        stats.pages++;
      }
      n.item.title = n.title;
      if (!input.dryRun) n.item.pageId = n.pageId;
    }

    // ---- Contenu des pages ----
    const used = new Set<string>();
    const failed = new Set<string>();
    const resolveLink = (href: string, from: string) => {
      const t = target(href, from);
      const hit = t ? byPath.get(t) : undefined;
      if (hit) return hit.pageId ?? null;
      // Lien vers une page d'une autre partie de l'export : retrouvée par son identifiant Notion.
      const id = t && !files.has(t) ? /([0-9a-f]{32})(?:\.(?:md|csv))?$/i.exec(t)?.[1]?.toLowerCase() : undefined;
      return (id && byId.get(id)?.pageId) || null;
    };
    const resolveExternal = (href: string) => {
      const m = /^https?:\/\/(?:www\.)?notion\.(?:so|site)\/[^?#]*?([0-9a-f]{32})(?:[?#]|$)/i.exec(href);
      return (m && byId.get(m[1]!.toLowerCase())?.pageId) || null;
    };

    for (const n of nodes) {
      if (n.kind !== 'page') continue;
      const pageId = n.pageId!;
      const notes = new Set<string>(n.item.notes ?? []);
      // Fichiers joints de cette page : chacun une seule fois, même cité plusieurs fois.
      const attached = new Map<string, StoredAttachment | null>();
      const attach = (href: string, from: string): StoredAttachment | null => {
        const t = target(href, from);
        if (!t || !files.has(t)) return null;
        if (attached.has(t)) return attached.get(t)!;
        // Aucune décompression d'un fichier déjà refusé ni d'un fichier annoncé plus gros que le plafond des pièces jointes.
        if (failed.has(t) || files.get(t)! > input.writer.fileLimit) {
          if (!failed.has(t)) { failed.add(t); skip(t, 'attachment', 'Fichier trop lourd pour une pièce jointe'); }
          notes.add(`fichier non joint : ${posix.basename(t)}`);
          attached.set(t, null);
          return null;
        }
        const data = zip.read(t); // archive invalide : tout l'import est refusé
        let stored: StoredAttachment | null = null;
        try {
          stored = input.writer.store(pageId, posix.basename(t), data);
          used.add(t);
          items.push({ path: t.slice(0, 300), status: 'imported', kind: 'attachment', title: stored.name, ...(input.dryRun ? {} : { pageId }) });
        } catch (err) {
          // Fichier vide, trop lourd, stockage ou quota plein : fichier écarté, l'import continue.
          if (!(err instanceof HttpError)) throw err;
          if (!failed.has(t)) { failed.add(t); skip(t, 'attachment', err.message); }
          notes.add(`fichier non joint : ${posix.basename(t)}`);
        }
        attached.set(t, stored);
        return stored;
      };
      const block = (s: StoredAttachment): DocNode => (s.mime.startsWith('video/') ? { type: 'video', attrs: { id: s.id, name: s.name } }
        : s.mime.startsWith('audio/') ? { type: 'audio', attrs: { id: s.id, name: s.name } }
          : { type: 'attachment', attrs: { id: s.id, name: s.name, size: s.size, mime: s.mime } });
      const resolveFile = (href: string, from: string): ResolvedFile | null => {
        const s = attach(href, from);
        return s ? { url: `/api/v3/attachments/${s.id}`, block: block(s) } : null;
      };
      const resolveImage = (href: string, from: string): DocNode | null => {
        const s = attach(href, from);
        if (!s) return null;
        if (INLINE_MIMES.has(s.mime)) return { type: 'image', attrs: { src: `/api/v3/attachments/${s.id}` } };
        notes.add(`image non reconnue (${s.name}) jointe comme fichier`);
        return block(s);
      };

      const parent = owners.get(n.dir);
      const body = parent?.kind === 'base' ? propertyLines(n.body) : n.body;
      const before = { ...stats.links };
      try {
        const raw = markdownToDoc(body, { resolveLink, resolveFile, resolveImage, resolveExternal, emojiCallouts: true, from: n.path, stats, notes });
        updatePage(db, pageId, { content: sanitizeDoc(raw) }, userId, input.cloner);
      } catch (err) {
        if (!(err instanceof HttpError) || err instanceof ZipError) throw err;
        notes.add(`contenu non importé (${err.message}) : page créée vide`);
      }
      const unresolved = stats.links.unresolved - before.unresolved;
      if (unresolved) notes.add(`${unresolved} lien(s) vers une page absente de l’archive, gardé(s) en texte`);
      if (stats.images) { notes.add(`${stats.images} image(s) absente(s) de l’archive, remplacée(s) par leur nom`); stats.images = 0; }
      if (notes.size) n.item.notes = [...notes];
    }

    // ---- Bases ----
    for (const n of nodes) {
      if (n.kind !== 'base') continue;
      const children = nodes.filter((c) => c.kind === 'page' && owners.get(c.dir) === n);
      if (n.asTable) fillTable(db, n, userId);
      else fillBase(db, n, children, input.auth, spaceId, userId);
    }

    // Fichiers que rien ne cite : écartés (Notion cite toujours les fichiers d'une page dans son contenu).
    for (const f of files.keys()) if (!used.has(f) && !failed.has(f)) skip(f, 'file', 'fichier cité par aucune page');

    items.sort((a, b) => a.path.localeCompare(b.path));
    const report: ImportReport = {
      summary: {
        pages: stats.pages,
        bases: nodes.filter((n) => n.kind === 'base' && !n.asTable).length,
        tables: nodes.filter((n) => n.asTable).length,
        folders: stats.folders,
        attachments: items.filter((i) => i.kind === 'attachment' && i.status === 'imported').length,
        skipped: items.filter((i) => i.status === 'skipped').length,
        links: stats.links,
        ...(items.length > REPORT_MAX_ITEMS ? { truncated: items.length - REPORT_MAX_ITEMS } : {}),
      },
      items: items.slice(0, REPORT_MAX_ITEMS),
    };
    if (input.dryRun) throw new DryRun(report);
    return report;
  };

  if (!nodes.length) throw new HttpError(422, 'Aucune page Notion dans l’archive (fichiers « .md » ou « .csv » attendus, format « Markdown & CSV »)');
  try {
    return db.transaction(run)();
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  }
}

// Base simple (devient une base BeNote) : colonnes, lignes et cellules dans les plafonds des bases. Sinon : motif du repli en tableau.
function baseProblem(rows: string[][]): string | null {
  const [header, ...data] = rows;
  if (!header?.length) return 'base vide : importée comme page';
  if (header.length + 1 > MAX_PROPERTIES) return `plus de ${MAX_PROPERTIES - 1} colonnes : importée comme tableau`;
  if (data.length > MAX_ROWS) return `plus de ${MAX_ROWS} lignes : importée comme tableau`;
  let total = 0;
  for (const r of data) {
    if (r.some((v) => v.length > MAX_TEXT)) return `cellule de plus de ${MAX_TEXT} caractères : importée comme tableau`;
    const chars = r.reduce((s, v) => s + v.length + 40, 0);
    if (chars > MAX_ROW_CHARS) return 'ligne trop volumineuse : importée comme tableau';
    total += chars;
  }
  if (total > MAX_BASE_CHARS) return 'base trop volumineuse : importée comme tableau';
  return null;
}

// Colonnes en texte (Notion n'exporte pas leur type) ; une colonne « Page » relie chaque ligne à sa page importée.
function fillBase(db: DB, n: Node, children: Node[], auth: Auth | null, spaceId: string, userId: string | null) {
  const baseId = n.pageId!;
  const [header, ...data] = n.rows!;
  const names = new Set<string>();
  const uniqueName = (raw: string, i: number) => {
    const baseName = clean(raw, MAX_COLUMN_NAME) || `Colonne ${i + 1}`;
    let name = baseName;
    for (let k = 2; names.has(name.toLocaleLowerCase('fr')); k++) name = `${baseName.slice(0, MAX_COLUMN_NAME - 5)} (${k})`;
    names.add(name.toLocaleLowerCase('fr'));
    return name;
  };
  const first = propertiesOf(db, baseId)[0]!;
  const ids = header!.map((h, i) => (i === 0 ? updateProperty(db, baseId, first.id, { name: uniqueName(h, i) }).id : addProperty(db, baseId, { name: uniqueName(h, i), type: 'text' }).id));
  const link = children.length ? addProperty(db, baseId, { name: uniqueName('Page', header!.length), type: 'page_link' }).id : null;
  // Ligne et page : même titre (première colonne). Chaque page ne sert qu'une fois ; une page sans ligne reste sous la base.
  const free = new Map<string, string[]>();
  for (const c of children) free.set(c.title, [...(free.get(c.title) ?? []), c.pageId!]);
  const ctx = { db, auth, spaces: new Set([spaceId]), baseId };
  let linked = 0;
  for (const r of data) {
    const values: Record<string, unknown> = {};
    ids.forEach((id, i) => { const v = (r[i] ?? '').trim(); if (v) values[id] = v; });
    const page = link ? free.get(clean(r[0] ?? '', MAX_TITLE))?.shift() : undefined;
    if (link && page) { values[link] = page; linked++; }
    addRow(ctx, values, userId);
  }
  reindexBase(db, baseId);
  const notes = [...(n.item.notes ?? []), 'colonnes importées en texte (Notion n’exporte pas leur type)'];
  if (link && linked < children.length) notes.push(`${children.length - linked} page(s) de la base sans ligne correspondante`);
  n.item.notes = notes;
}

// Repli : la base devient une page contenant un tableau (lignes au-delà de TABLE_MAX_ROWS non reprises, signalé).
function fillTable(db: DB, n: Node, userId: string | null) {
  const [header = [], ...data] = n.rows!;
  const width = Math.min(data.reduce((m, r) => Math.max(m, r.length), Math.max(header.length, 1)), 60);
  const cell = (type: string, v: string): DocNode => ({ type, content: [v ? { type: 'paragraph', content: [{ type: 'text', text: v.slice(0, MAX_TEXT) }] } : { type: 'paragraph' }] });
  const row = (r: string[], type: string): DocNode => ({ type: 'tableRow', content: Array.from({ length: width }, (_, i) => cell(type, (r[i] ?? '').trim())) });
  const notes = [...(n.item.notes ?? []), n.asTable!];
  if (data.length > TABLE_MAX_ROWS) notes.push(`${data.length - TABLE_MAX_ROWS} ligne(s) au-delà de ${TABLE_MAX_ROWS} non reprises`);
  const content: DocNode[] = header.length ? [{ type: 'table', content: [row(header, 'tableHeader'), ...data.slice(0, TABLE_MAX_ROWS).map((r) => row(r, 'tableCell'))] }] : [{ type: 'paragraph' }];
  try {
    updatePage(db, n.pageId!, { content: sanitizeDoc({ type: 'doc', content }) }, userId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    notes.push(`tableau non importé (${err.message})`);
  }
  n.item.notes = notes;
}
