// Conversion des images base64 (`data:`) des pages en pièces jointes, et son retour arrière.
// Règles (aucune perte) :
//  - une seule exécution à la fois, y compris entre la commande en ligne et le serveur (index unique partiel en base) ;
//  - page par page, chacune dans sa transaction : une exécution interrompue se relance sans rien refaire (une page déjà
//    convertie n'a plus d'image base64 raster) ; les fichiers sont écrits avant la transaction et effacés si elle échoue ;
//  - avant toute modification, une version de la page garde le contenu d'origine (historique), puis une version du résultat ;
//  - journal (tables image_migration_*) : de quoi rétablir chaque image à l'identique (`revert`), en vérifiant son empreinte ;
//  - type vérifié sur les octets : seules les images raster reconnues (PNG, JPEG, GIF, WebP) sont converties ; un SVG, un
//    contenu non reconnu ou trop lourd reste tel quel dans la page, et la page est signalée ;
//  - plafonds respectés (instance, quota de l'auteur de la page, taille d'un fichier) : page ignorée et signalée sinon ;
//  - une page en cours de co-édition n'est pas touchée (ignorée et signalée, reprise à l'exécution suivante).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { attachmentPath, INLINE_MIMES, newAttachmentId, reservations, sniffMime, tempName, usedBytes, userBytes, type AttachmentMime } from './attachments.js';
import { type DocNode, docText } from './content.js';
import { HttpError } from './http.js';

export type SkipReason = 'coedition' | 'quota' | 'svg' | 'unrecognized' | 'too_large' | 'changed' | 'missing_page' | 'missing_file' | 'checksum';
export const SKIP_LABELS: Record<SkipReason, string> = {
  coedition: 'Page en cours de co-édition : reprise à la prochaine exécution',
  quota: 'Plafond de stockage des pièces jointes atteint (instance ou auteur de la page)',
  svg: 'Image SVG : laissée dans la page (jamais convertie)',
  unrecognized: 'Contenu non reconnu comme une image PNG, JPEG, GIF ou WebP : laissé dans la page',
  too_large: 'Image plus lourde que la taille maximale d’une pièce jointe : laissée dans la page',
  changed: 'Page modifiée pendant le traitement : reprise à la prochaine exécution',
  missing_page: 'Page supprimée depuis la conversion',
  missing_file: 'Fichier de la pièce jointe absent du disque : image non rétablie',
  checksum: 'Fichier de la pièce jointe altéré (empreinte différente) : image non rétablie',
};
/** Motifs et remarques renvoyés par l'API, avec leur libellé (`modified` : retour arrière d'une page modifiée depuis). */
export const REASON_LABELS: Record<SkipReason | 'modified', string> = {
  ...SKIP_LABELS,
  modified: 'Page modifiée depuis la conversion : seules les images ont été rétablies',
};

export interface MigrationLimits { totalBytes: number; userBytes: number; fileBytes: number }
export interface MigrationContext {
  db: DB;
  filesDir: string;
  limits: MigrationLimits;
  /** Page en cours de co-édition (à ne pas toucher). */
  busy: (pageId: string) => boolean;
  source: 'cli' | 'api';
  startedBy: string | null;
  batchSize?: number;
  /** Après chaque page modifiée (événement pour les écrans ouverts). */
  onChanged?: (page: { id: string; spaceId: string; version: number }) => void;
  /** Arrêt demandé (fermeture du serveur) : l'exécution s'arrête entre deux pages, marquée interrompue. */
  shouldStop?: () => boolean;
  /** Rend la main entre deux lots (serveur : ne pas bloquer les requêtes). */
  yieldBetweenBatches?: () => Promise<void>;
}

export interface RunStats {
  pages: number; converted: number; reverted: number; skipped: number; images: number; bytes: number;
  reasons: Partial<Record<SkipReason, number>>;
}
export interface RunRow {
  id: string; kind: 'convert' | 'revert'; reverts: string | null; status: 'running' | 'done' | 'interrupted' | 'failed'; source: 'cli' | 'api';
  started_by: string | null; started_at: number; heartbeat_at: number; finished_at: number | null; cursor: number; stats: string; error: string | null;
}

const STALE_MS = 5 * 60_000;
const DATA_SRC = /^(data:image\/([a-z0-9.+-]+);base64,)([A-Za-z0-9+/=]+)$/i;
const SRC_MARK = '"src":"data:';
const EXT: Partial<Record<AttachmentMime, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const emptyStats = (): RunStats => ({ pages: 0, converted: 0, reverted: 0, skipped: 0, images: 0, bytes: 0, reasons: {} });
const newRunId = () => randomBytes(9).toString('base64url');

export const toRun = (r: RunRow) => ({
  id: r.id, kind: r.kind, reverts: r.reverts, status: r.status, source: r.source, startedBy: r.started_by,
  startedAt: r.started_at, heartbeatAt: r.heartbeat_at, finishedAt: r.finished_at, stats: JSON.parse(r.stats) as RunStats, error: r.error,
});

/** Co-édition récente d'après l'état enregistré (pour la commande en ligne, qui ne voit pas les salles du serveur). */
export const recentlyCoEdited = (db: DB, withinMs = 10 * 60_000) => {
  const stmt = db.prepare('SELECT 1 FROM page_ydocs WHERE page_id = ? AND updated_at > ?');
  return (pageId: string) => !!stmt.get(pageId, Date.now() - withinMs);
};

// ---- Analyse d'un document ----------------------------------------------------------------
interface Found { src: string; prefix: string; b64: string; bytes: Buffer; mime: AttachmentMime }
interface Scan { found: Map<string, Found>; reasons: Partial<Record<SkipReason, number>> }

const bump = (r: Partial<Record<SkipReason, number>>, k: SkipReason, n = 1) => { r[k] = (r[k] ?? 0) + n; };

/** Images base64 d'un document : celles à convertir (raster reconnue, sous la taille maximale) et les autres, par motif. */
export function scanDoc(doc: DocNode, fileBytes: number): Scan {
  const found = new Map<string, Found>();
  const reasons: Partial<Record<SkipReason, number>> = {};
  const seen = new Set<string>();
  const walk = (n: DocNode) => {
    const src = n.type === 'image' ? n.attrs?.src : undefined;
    if (typeof src === 'string' && src.startsWith('data:') && !seen.has(src)) {
      seen.add(src);
      const m = DATA_SRC.exec(src);
      if (!m) bump(reasons, 'unrecognized');
      else if (/svg/i.test(m[2]!)) bump(reasons, 'svg');
      else {
        const bytes = Buffer.from(m[3]!, 'base64');
        const mime = sniffMime(bytes.subarray(0, 64));
        if (!INLINE_MIMES.has(mime) || !bytes.length) bump(reasons, 'unrecognized');
        else if (bytes.length > fileBytes) bump(reasons, 'too_large');
        else found.set(src, { src, prefix: m[1]!, b64: m[3]!, bytes, mime });
      }
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return { found, reasons };
}

/** Copie du document où chaque image dont `src` figure dans `map` reçoit la nouvelle adresse (attributs dans le même ordre). */
function replaceSrc(doc: DocNode, map: Map<string, string>): { doc: DocNode; count: number } {
  let count = 0;
  const walk = (n: DocNode): DocNode => {
    const out: DocNode = { ...n };
    const src = n.type === 'image' ? n.attrs?.src : undefined;
    if (typeof src === 'string' && map.has(src)) { out.attrs = { ...n.attrs, src: map.get(src)! }; count++; }
    if (n.content) out.content = n.content.map(walk);
    return out;
  };
  return { doc: walk(doc), count };
}

// ---- Verrou d'exécution -------------------------------------------------------------------
function acquire(db: DB, kind: 'convert' | 'revert', ctx: MigrationContext, reverts: string | null): string {
  // BEGIN IMMEDIATE : deux processus (commande en ligne et serveur) ne peuvent pas lire « rien en cours » en même temps.
  return db.transaction(() => {
    const now = Date.now();
    const cur = db.prepare("SELECT id, heartbeat_at FROM image_migration_runs WHERE status = 'running'").get() as { id: string; heartbeat_at: number } | undefined;
    if (cur) {
      if (now - cur.heartbeat_at < STALE_MS) throw new HttpError(409, 'Une conversion des images est déjà en cours');
      // Exécution abandonnée (processus arrêté sans finir) : marquée interrompue, son journal reste valable.
      db.prepare("UPDATE image_migration_runs SET status = 'interrupted', finished_at = ? WHERE id = ?").run(now, cur.id);
    }
    const id = newRunId();
    db.prepare(
      `INSERT INTO image_migration_runs (id, kind, reverts, status, source, started_by, started_at, heartbeat_at, stats) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    ).run(id, kind, reverts, ctx.source, ctx.startedBy, now, now, JSON.stringify(emptyStats()));
    return id;
  }).immediate();
}

/** Exécutions du serveur restées « en cours » après un arrêt brutal : marquées interrompues au démarrage. */
export function releaseStaleServerRuns(db: DB): void {
  db.prepare("UPDATE image_migration_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND source = 'api'").run(Date.now());
}

// N'écrivent que sur une exécution encore « en cours » : une exécution déclarée abandonnée (et peut-être remplacée) ne revient pas.
// Une exécution qui a perdu son verrou s'arrête (`heartbeat` renvoie faux).
const heartbeat = (db: DB, id: string, stats: RunStats, cursor: number): boolean =>
  db.prepare("UPDATE image_migration_runs SET heartbeat_at = ?, stats = ?, cursor = ? WHERE id = ? AND status = 'running'").run(Date.now(), JSON.stringify(stats), cursor, id).changes === 1;

function finish(db: DB, id: string, status: 'done' | 'interrupted' | 'failed', stats: RunStats, error: string | null = null) {
  db.prepare("UPDATE image_migration_runs SET status = ?, finished_at = ?, heartbeat_at = ?, stats = ?, error = ? WHERE id = ? AND status = 'running'")
    .run(status, Date.now(), Date.now(), JSON.stringify(stats), error, id);
}
const LOST_LOCK = 'Exécution déclarée abandonnée par une autre : arrêtée';

// Version de l'historique : l'état d'origine n'est inscrit que s'il n'est pas déjà la dernière version.
function snapshot(db: DB, page: { id: string; title: string; content: string }, now: number) {
  const last = db.prepare('SELECT content FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(page.id) as { content: string } | undefined;
  if (last?.content !== page.content) {
    db.prepare('INSERT INTO page_versions (page_id, title, content, created_at, created_by, session_start) VALUES (?, ?, ?, ?, NULL, ?)').run(page.id, page.title, page.content, now, now);
  }
}
// Le résultat est inscrit comme une nouvelle version (sans auteur) ; la date de modification de la page ne change pas.
function writePage(db: DB, page: { id: string; title: string }, doc: DocNode, now: number): { content: string; version: number } {
  const content = JSON.stringify(doc);
  db.prepare('UPDATE pages SET content = ?, text = ?, version = version + 1 WHERE id = ?').run(content, docText(doc), page.id);
  db.prepare('INSERT INTO page_versions (page_id, title, content, created_at, created_by, session_start) VALUES (?, ?, ?, ?, NULL, ?)').run(page.id, page.title, content, now, now);
  return { content, version: (db.prepare('SELECT version FROM pages WHERE id = ?').get(page.id) as { version: number }).version };
}

interface PageRow { seq: number; id: string; space_id: string; title: string; content: string; created_by: string | null }
const candidates = (db: DB, after: number, limit: number) => db.prepare(
  `SELECT seq, id, space_id, title, content, created_by FROM pages WHERE kind = 'doc' AND seq > ? AND instr(content, ?) > 0 ORDER BY seq LIMIT ?`,
).all(after, SRC_MARK, limit) as PageRow[];

// ---- Estimation sans rien écrire ----------------------------------------------------------
export interface DryRunReport {
  pages: number; images: number; bytes: number; reasons: Partial<Record<SkipReason, number>>;
  /** `title` à null et `hidden` vrai : page de l'espace personnel d'un autre compte (ni titre ni lien à afficher). */
  skipped: { pageId: string; title: string | null; hidden: boolean; reasons: SkipReason[] }[];
}

export async function dryRun(ctx: MigrationContext, viewerId: string | null = ctx.startedBy): Promise<DryRunReport> {
  const report: DryRunReport = { pages: 0, images: 0, bytes: 0, reasons: {}, skipped: [] };
  const hidden = personalHidden(ctx.db, viewerId);
  let after = 0;
  for (;;) {
    // Par lots, la boucle d'événements reprenant la main entre deux (l'estimation décode chaque image).
    await (ctx.yieldBetweenBatches?.() ?? new Promise((done) => setImmediate(done)));
    const rows = candidates(ctx.db, after, ctx.batchSize ?? 20);
    if (!rows.length) break;
    for (const p of rows) {
      after = p.seq;
      const scan = scanDoc(JSON.parse(p.content) as DocNode, ctx.limits.fileBytes);
      const reasons = Object.keys(scan.reasons) as SkipReason[];
      for (const r of reasons) bump(report.reasons, r, scan.reasons[r]);
      if (ctx.busy(p.id)) { bump(report.reasons, 'coedition'); reasons.push('coedition'); }
      else if (scan.found.size) {
        report.pages++;
        report.images += scan.found.size;
        for (const f of scan.found.values()) report.bytes += f.bytes.length;
      }
      if (reasons.length && report.skipped.length < 500) report.skipped.push({ pageId: p.id, title: hidden(p.id) ? null : p.title, hidden: hidden(p.id), reasons });
    }
  }
  return report;
}

/**
 * Pages d'un espace personnel dont `viewerId` n'est pas le titulaire : leur titre n'est jamais montré (pas même à un
 * administrateur, ni dans la commande en ligne), comme dans le journal d'audit et l'export des données personnelles.
 */
export function personalHidden(db: DB, viewerId: string | null): (pageId: string) => boolean {
  const stmt = db.prepare("SELECT s.owner_id FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = ? AND s.kind = 'personal'");
  return (pageId) => {
    const row = stmt.get(pageId) as { owner_id: string | null } | undefined;
    return !!row && (viewerId === null || row.owner_id !== viewerId);
  };
}

// ---- Conversion ---------------------------------------------------------------------------
/** Démarre une conversion (409 si une autre exécution est en cours) ; `run` la mène à son terme. */
export function startConversion(ctx: MigrationContext): { id: string; run: () => Promise<RunStats> } {
  const id = acquire(ctx.db, 'convert', ctx, null);
  return { id, run: () => convertAll(ctx, id) };
}

async function convertAll(ctx: MigrationContext, runId: string): Promise<RunStats> {
  const { db } = ctx;
  const stats = emptyStats();
  let after = 0;
  try {
    for (;;) {
      if (ctx.shouldStop?.()) { finish(db, runId, 'interrupted', stats); return stats; }
      const rows = candidates(db, after, ctx.batchSize ?? 20);
      if (!rows.length) break;
      for (const p of rows) {
        after = p.seq;
        stats.pages++;
        convertPage(ctx, runId, p, stats);
      }
      if (!heartbeat(db, runId, stats, after)) throw new Error(LOST_LOCK);
      await ctx.yieldBetweenBatches?.();
    }
    finish(db, runId, 'done', stats);
    return stats;
  } catch (err) {
    finish(db, runId, 'failed', stats, (err as Error).message.slice(0, 500));
    throw err;
  }
}

function recordPage(db: DB, runId: string, pageId: string, status: 'converted' | 'reverted' | 'skipped', extra: { reason?: string | null; images?: number; bytes?: number; before?: string | null; after?: string | null } = {}) {
  db.prepare(
    `INSERT INTO image_migration_pages (run_id, page_id, status, reason, images, bytes, before_sha, after_sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, page_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, images = excluded.images, bytes = excluded.bytes,
       before_sha = excluded.before_sha, after_sha = excluded.after_sha, at = excluded.at`,
  ).run(runId, pageId, status, extra.reason ?? null, extra.images ?? 0, extra.bytes ?? 0, extra.before ?? null, extra.after ?? null, Date.now());
}

function skip(db: DB, runId: string, pageId: string, stats: RunStats, reasons: SkipReason[]) {
  stats.skipped++;
  for (const r of reasons) bump(stats.reasons, r);
  recordPage(db, runId, pageId, 'skipped', { reason: reasons.join(',') });
}

function convertPage(ctx: MigrationContext, runId: string, p: PageRow, stats: RunStats): void {
  const { db } = ctx;
  if (ctx.busy(p.id)) { skip(db, runId, p.id, stats, ['coedition']); return; }
  const scan = scanDoc(JSON.parse(p.content) as DocNode, ctx.limits.fileBytes);
  const leftOver = Object.keys(scan.reasons) as SkipReason[];
  if (!scan.found.size) { skip(db, runId, p.id, stats, leftOver); return; }

  const total = [...scan.found.values()].reduce((n, f) => n + f.bytes.length, 0);
  // Fichiers attribués à l'auteur de la page (s'il existe encore) : ils comptent dans son quota comme s'il les avait envoyés.
  const owner = p.created_by && db.prepare('SELECT 1 FROM users WHERE id = ?').get(p.created_by) ? p.created_by : null;
  const held = reservations(db);
  if (usedBytes(db) + held.total + total > ctx.limits.totalBytes
    || (owner && userBytes(db, owner) + (held.byUser.get(owner)?.bytes ?? 0) + total > ctx.limits.userBytes)) {
    skip(db, runId, p.id, stats, ['quota', ...leftOver]);
    return;
  }

  // Fichiers d'abord (temporaire 0600 puis renommage), base ensuite ; effacés si la transaction échoue.
  mkdirSync(ctx.filesDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  const ids = new Map<string, { id: string; f: Found }>();
  try {
    for (const f of scan.found.values()) {
      const id = newAttachmentId();
      const tmp = join(ctx.filesDir, tempName());
      writeFileSync(tmp, f.bytes, { flag: 'wx', mode: 0o600 });
      const final = attachmentPath(ctx.filesDir, id);
      renameSync(tmp, final);
      written.push(final);
      ids.set(f.src, { id, f });
    }
    const result = db.transaction(() => {
      const cur = db.prepare('SELECT title, content FROM pages WHERE id = ?').get(p.id) as { title: string; content: string } | undefined;
      if (!cur || cur.content !== p.content) return null; // modifiée entre la lecture et l'écriture (autre processus)
      const now = Date.now();
      snapshot(db, { id: p.id, title: cur.title, content: cur.content }, now);
      const insert = db.prepare('INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const item = db.prepare('INSERT INTO image_migration_items (run_id, page_id, attachment_id, prefix, sha256, raw) VALUES (?, ?, ?, ?, ?, ?)');
      let n = 0;
      for (const { id, f } of ids.values()) {
        insert.run(id, p.id, owner, `image-${++n}.${EXT[f.mime]}`, f.mime, f.bytes.length, sha(f.bytes), now);
        // Base64 non canonique (rare) : la chaîne d'origine est gardée telle quelle pour un retour à l'identique.
        item.run(runId, p.id, id, f.prefix, sha(f.src), f.bytes.toString('base64') === f.b64 ? null : f.src);
      }
      const { doc } = replaceSrc(JSON.parse(cur.content) as DocNode, new Map([...ids].map(([src, v]) => [src, `/api/v3/attachments/${v.id}`])));
      const out = writePage(db, { id: p.id, title: cur.title }, doc, now);
      recordPage(db, runId, p.id, 'converted', { reason: leftOver.length ? leftOver.join(',') : null, images: ids.size, bytes: total, before: sha(cur.content), after: sha(out.content) });
      return out;
    }).immediate();
    if (!result) {
      for (const f of written) { try { unlinkSync(f); } catch { /* déjà absent */ } }
      skip(db, runId, p.id, stats, ['changed']);
      return;
    }
    stats.converted++;
    stats.images += ids.size;
    stats.bytes += total;
    for (const r of leftOver) bump(stats.reasons, r);
    ctx.onChanged?.({ id: p.id, spaceId: p.space_id, version: result.version });
  } catch (err) {
    for (const f of written) { try { unlinkSync(f); } catch { /* déjà absent */ } }
    throw err;
  }
}

// ---- Retour arrière -----------------------------------------------------------------------
/** Démarre le retour arrière d'une conversion : 404 si elle est inconnue, 409 si une exécution est en cours. */
export function startRevert(ctx: MigrationContext, convertRunId: string): { id: string; run: () => Promise<RunStats> } {
  const src = ctx.db.prepare('SELECT kind, status FROM image_migration_runs WHERE id = ?').get(convertRunId) as { kind: string; status: string } | undefined;
  if (!src || src.kind !== 'convert') throw new HttpError(404, 'Conversion introuvable');
  const id = acquire(ctx.db, 'revert', ctx, convertRunId);
  return { id, run: () => revertAll(ctx, id, convertRunId) };
}

async function revertAll(ctx: MigrationContext, runId: string, convertRunId: string): Promise<RunStats> {
  const { db } = ctx;
  const stats = emptyStats();
  const pages = (db.prepare(
    `SELECT DISTINCT page_id FROM image_migration_items WHERE run_id = ? AND reverted_at IS NULL ORDER BY page_id`,
  ).all(convertRunId) as { page_id: string }[]).map((r) => r.page_id);
  try {
    const size = ctx.batchSize ?? 20;
    for (let i = 0; i < pages.length; i += size) {
      if (ctx.shouldStop?.()) { finish(db, runId, 'interrupted', stats); return stats; }
      for (const pageId of pages.slice(i, i + size)) { stats.pages++; revertPage(ctx, runId, convertRunId, pageId, stats); }
      if (!heartbeat(db, runId, stats, i + size)) throw new Error(LOST_LOCK);
      await ctx.yieldBetweenBatches?.();
    }
    finish(db, runId, 'done', stats);
    return stats;
  } catch (err) {
    finish(db, runId, 'failed', stats, (err as Error).message.slice(0, 500));
    throw err;
  }
}

function revertPage(ctx: MigrationContext, runId: string, convertRunId: string, pageId: string, stats: RunStats): void {
  const { db } = ctx;
  const page = db.prepare('SELECT id, space_id, title, content FROM pages WHERE id = ?').get(pageId) as { id: string; space_id: string; title: string; content: string } | undefined;
  if (!page) { skip(db, runId, pageId, stats, ['missing_page']); return; }
  if (ctx.busy(pageId)) { skip(db, runId, pageId, stats, ['coedition']); return; }
  const items = db.prepare('SELECT attachment_id, prefix, sha256, raw FROM image_migration_items WHERE run_id = ? AND page_id = ? AND reverted_at IS NULL')
    .all(convertRunId, pageId) as { attachment_id: string; prefix: string; sha256: string; raw: string | null }[];
  // Chaque image est reconstruite depuis son fichier et vérifiée sur l'empreinte de la chaîne d'origine : tout ou rien par page.
  const map = new Map<string, string>();
  for (const it of items) {
    let data = it.raw;
    if (data === null) {
      const file = attachmentPath(ctx.filesDir, it.attachment_id);
      if (!existsSync(file)) { skip(db, runId, pageId, stats, ['missing_file']); return; }
      data = it.prefix + readFileSync(file).toString('base64');
    }
    if (sha(data) !== it.sha256) { skip(db, runId, pageId, stats, ['checksum']); return; }
    map.set(`/api/v3/attachments/${it.attachment_id}`, data);
  }
  const original = db.prepare("SELECT before_sha FROM image_migration_pages WHERE run_id = ? AND page_id = ? AND status = 'converted'").get(convertRunId, pageId) as { before_sha: string | null } | undefined;
  const { doc, count } = replaceSrc(JSON.parse(page.content) as DocNode, map);
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string } | undefined;
    if (!cur || cur.content !== page.content) return { changed: true, out: null };
    const now = Date.now();
    let out: { content: string; version: number } | null = null;
    if (count) {
      snapshot(db, page, now);
      out = writePage(db, page, doc, now);
    }
    db.prepare('UPDATE image_migration_items SET reverted_at = ? WHERE run_id = ? AND page_id = ? AND reverted_at IS NULL').run(now, convertRunId, pageId);
    const after = out ? sha(out.content) : sha(page.content);
    // Page inchangée depuis la conversion : le contenu rétabli est identique à l'octet près à celui d'avant (même empreinte).
    const exact = !!original?.before_sha && after === original.before_sha;
    recordPage(db, runId, pageId, 'reverted', { reason: exact ? null : 'modified', images: count, before: sha(page.content), after });
    return { changed: false, out };
  }).immediate();
  if (result.changed) { skip(db, runId, pageId, stats, ['changed']); return; }
  stats.reverted++;
  stats.images += count;
  if (result.out) ctx.onChanged?.({ id: page.id, spaceId: page.space_id, version: result.out.version });
}

// ---- État ---------------------------------------------------------------------------------
export function migrationStatus(db: DB) {
  const runs = (db.prepare('SELECT * FROM image_migration_runs ORDER BY started_at DESC, rowid DESC LIMIT 20').all() as RunRow[]).map(toRun);
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE kind = 'doc' AND instr(content, ?) > 0").get(SRC_MARK) as { n: number }).n;
  return { pendingPages: pending, current: runs.find((r) => r.status === 'running') ?? null, runs };
}

export function runDetail(db: DB, id: string, viewerId: string | null = null) {
  const hidden = personalHidden(db, viewerId);
  const row = db.prepare('SELECT * FROM image_migration_runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) throw new HttpError(404, 'Exécution introuvable');
  const pages = (db.prepare(
    `SELECT m.page_id, m.status, m.reason, m.images, m.bytes, m.at, p.title FROM image_migration_pages m LEFT JOIN pages p ON p.id = m.page_id
     WHERE m.run_id = ? ORDER BY m.at, m.rowid LIMIT 1000`,
  ).all(id) as { page_id: string; status: string; reason: string | null; images: number; bytes: number; at: number; title: string | null }[])
    .map((r) => ({
      pageId: r.page_id, title: hidden(r.page_id) ? null : r.title, hidden: hidden(r.page_id), status: r.status, images: r.images, bytes: r.bytes, at: r.at,
      reasons: r.reason ? r.reason.split(',') : [],
    }));
  return { ...toRun(row), pages };
}

// ---- Présence du serveur ------------------------------------------------------------------
// Le serveur inscrit un signe de vie toutes les 30 secondes ; la commande en ligne refuse de convertir s'il est récent.
export const SERVER_ALIVE_MS = 90_000;
export function markServerAlive(db: DB, startedAt: number): void {
  db.prepare(
    `INSERT INTO server_presence (id, pid, started_at, seen_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, seen_at = excluded.seen_at`,
  ).run(process.pid, startedAt, Date.now());
}
export const clearServerAlive = (db: DB) => db.prepare('DELETE FROM server_presence WHERE id = 1 AND pid = ?').run(process.pid);
export const serverRunning = (db: DB) => !!db.prepare('SELECT 1 FROM server_presence WHERE id = 1 AND seen_at > ?').get(Date.now() - SERVER_ALIVE_MS);
