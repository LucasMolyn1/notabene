// Pièces jointes dans les sauvegardes. Une sauvegarde `notabene-X.db` (ou `.db.age`) est accompagnée du dossier
// `notabene-X.attachments/` : un fichier par pièce jointe connue de la base sauvegardée, `<id>` en clair ou `<id>.age` si la
// sauvegarde est chiffrée (chaque fichier chiffré à part, pour la même clé publique que la base). La base sauvegardée sert
// d'inventaire : identifiant, taille et empreinte SHA-256 de chaque fichier, contrôlés à la vérification et à la restauration.
//
// Cohérence : la base est copiée d'abord, puis les fichiers qu'elle référence. Un fichier supprimé entre les deux (la ligne a
// aussi disparu de la base vivante) est retiré de la copie de la base : la sauvegarde ne référence que des fichiers présents.
// Les fichiers ne changent jamais une fois enregistrés : un fichier déjà présent dans la sauvegarde précédente (même clé) est
// repris par lien physique au lieu d'être recopié, ce qui évite de multiplier l'espace occupé par la rotation.
import { createHash } from 'node:crypto';
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Decrypter, Encrypter } from 'age-encryption';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { DB } from '../db.js';
import { ATTACHMENT_ID, moveFile, tempName } from './attachments.js';

export const MANIFEST = 'manifest.json';
const FORMAT = 'notabene-attachments/1';
const manifestSchema = z.object({ format: z.literal(FORMAT), recipient: z.string().max(2000).nullable(), files: z.number().int().min(0) });
const ATTACHMENTS_DIR = /^notabene-\d{8}-\d{6}\.attachments$/;

interface Row { id: string; size: number; sha256: string }

/** Dossier des pièces jointes d'une sauvegarde : `notabene-X.db(.age)` donne `notabene-X.attachments`. */
export const attachmentsBackupDir = (backupFile: string) => `${backupFile.replace(/\.db(\.age)?$/, '')}.attachments`;

const readRows = (dbFile: string): Row[] => {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get();
    return has ? (db.prepare('SELECT id, size, sha256 FROM attachments ORDER BY rowid').all() as Row[]) : [];
  } finally {
    db.close();
  }
};

const webStream = (path: string) => Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
const sink = () => new Writable({ write(_chunk, _enc, done) { done(); } });

/**
 * Lit `src` (en le déchiffrant si `identity`), l'écrit dans `dest` (en le chiffrant si `encryptTo` ; 0600, jamais par-dessus un
 * fichier existant) ou nulle part si `dest` est nul, et renvoie la taille et l'empreinte du contenu en clair.
 */
export async function transfer(src: string, dest: string | null, mode: { encryptTo?: string; identity?: string } = {}): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const tap = () => new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { hash.update(chunk); size += chunk.length; ctl.enqueue(chunk); } });
  let out: ReadableStream<Uint8Array>;
  if (mode.encryptTo) {
    const enc = new Encrypter();
    enc.addRecipient(mode.encryptTo);
    out = await enc.encrypt(webStream(src).pipeThrough(tap()));
  } else if (mode.identity) {
    const dec = new Decrypter();
    dec.addIdentity(mode.identity.trim());
    out = (await dec.decrypt(webStream(src))).pipeThrough(tap());
  } else {
    out = webStream(src).pipeThrough(tap());
  }
  try {
    await pipeline(Readable.fromWeb(out as unknown as NodeReadableStream<Uint8Array>), dest ? createWriteStream(dest, { flags: 'wx', mode: 0o600 }) : sink());
  } catch (err) {
    if (dest && (err as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(dest, { force: true });
    throw err;
  }
  return { size, sha256: hash.digest('hex') };
}

// Reprend un fichier de la sauvegarde précédente : lien physique, ou copie si le système de fichiers ne le permet pas.
function reuse(from: string, to: string): void {
  try { linkSync(from, to); } catch { copyFileSync(from, to, constants.COPYFILE_EXCL); }
}

/** Dernière sauvegarde complète du dossier dont les pièces jointes sont chiffrées pour la même clé (ou en clair). */
export function previousAttachmentsBackup(dir: string, recipient: string | null): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((n) => ATTACHMENTS_DIR.test(n)).sort().reverse()) {
    const stem = name.slice(0, -'.attachments'.length);
    if (!existsSync(join(dir, `${stem}.db`)) && !existsSync(join(dir, `${stem}.db.age`))) continue;
    try {
      const m = manifestSchema.parse(JSON.parse(readFileSync(join(dir, name, MANIFEST), 'utf8')));
      if (m.recipient === recipient) return join(dir, name);
    } catch { /* manifeste absent ou illisible : sauvegarde ignorée */ }
  }
  return null;
}

export interface AttachmentBackupReport {
  /** Fichiers référencés par la sauvegarde. */
  files: number;
  copied: number;
  /** Repris de la sauvegarde précédente. */
  reused: number;
  /** Supprimés pendant la sauvegarde : retirés de la copie de la base. */
  dropped: string[];
  /** Ligne présente dans la base vivante mais fichier absent du disque. */
  missing: string[];
  /** Contenu différent de l'empreinte enregistrée : non copié. */
  corrupt: string[];
}

/** Copie dans `dest` les fichiers référencés par la copie de base `snapshot` (en clair, modifiable). */
export async function backupAttachments(opts: { live: DB; snapshot: string; source: string; dest: string; recipient?: string; previous?: string | null }): Promise<AttachmentBackupReport> {
  const report: AttachmentBackupReport = { files: 0, copied: 0, reused: 0, dropped: [], missing: [], corrupt: [] };
  const rows = readRows(opts.snapshot);
  mkdirSync(opts.dest, { recursive: true, mode: 0o700 });
  const ext = opts.recipient ? '.age' : '';
  const stillLive = opts.live.prepare('SELECT 1 FROM attachments WHERE id = ?');
  for (const r of rows) {
    if (!ATTACHMENT_ID.test(r.id)) { report.corrupt.push(r.id); continue; }
    const out = join(opts.dest, r.id + ext);
    const prev = opts.previous ? join(opts.previous, r.id + ext) : null;
    if (prev && existsSync(prev) && (ext || statSync(prev).size === r.size)) { reuse(prev, out); report.reused++; continue; }
    const src = join(opts.source, r.id);
    if (!existsSync(src)) {
      (stillLive.get(r.id) ? report.missing : report.dropped).push(r.id);
      continue;
    }
    try {
      const got = await transfer(src, out, { encryptTo: opts.recipient });
      if (got.sha256 !== r.sha256 || got.size !== r.size) { rmSync(out, { force: true }); report.corrupt.push(r.id); } else report.copied++;
    } catch (err) {
      // Effacé pendant la lecture (ligne disparue) : retiré comme ci-dessus. Toute autre erreur fait échouer la sauvegarde.
      if (stillLive.get(r.id)) throw err;
      report.dropped.push(r.id);
    }
  }
  if (report.dropped.length) {
    const snap = new Database(opts.snapshot, { fileMustExist: true });
    try {
      const del = snap.prepare('DELETE FROM attachments WHERE id = ?');
      const gc = snap.prepare('DELETE FROM attachment_gc WHERE id = ?');
      snap.transaction(() => { for (const id of report.dropped) { del.run(id); gc.run(id); } })();
    } finally {
      snap.close();
    }
  }
  report.files = rows.length - report.dropped.length;
  writeFileSync(join(opts.dest, MANIFEST), JSON.stringify({ format: FORMAT, recipient: opts.recipient ?? null, files: report.files }), { mode: 0o600 });
  return report;
}

// Fichier d'une pièce jointe dans le dossier de sauvegarde : chiffré (`<id>.age`) ou en clair (`<id>`).
function locate(dir: string, id: string, identity: string | undefined): { path: string; identity?: string } | null {
  const enc = join(dir, `${id}.age`);
  if (existsSync(enc)) {
    if (!identity) throw new Error('Pièces jointes chiffrées : indiquez la clé privée avec BACKUP_AGE_IDENTITY_FILE.');
    return { path: enc, identity };
  }
  const plain = join(dir, id);
  return existsSync(plain) ? { path: plain } : null;
}

export interface AttachmentCheck { files: number; missing: string[]; corrupt: string[] }

/** Vérifie que chaque pièce jointe de la base `dbFile` (en clair) est présente dans `dir` et conforme à son empreinte. */
export async function verifyAttachments(dbFile: string, dir: string, identity?: string): Promise<AttachmentCheck> {
  const rows = readRows(dbFile);
  const report: AttachmentCheck = { files: rows.length, missing: [], corrupt: [] };
  for (const r of rows) {
    const found = ATTACHMENT_ID.test(r.id) && existsSync(dir) ? locate(dir, r.id, identity) : null;
    if (!found) { report.missing.push(r.id); continue; }
    try {
      const got = await transfer(found.path, null, { identity: found.identity });
      if (got.sha256 !== r.sha256 || got.size !== r.size) report.corrupt.push(r.id);
    } catch {
      report.corrupt.push(r.id);
    }
  }
  return report;
}

export interface AttachmentRestoreReport extends AttachmentCheck {
  /** Déjà présents et identiques : laissés en place. */
  kept: number;
  restored: number;
  /** Fichiers en place différents de la sauvegarde : déplacés en quarantaine, jamais écrasés. */
  quarantined: string[];
}

/**
 * Restaure les pièces jointes de la base `dbFile` (en clair) depuis `from` vers le dossier vivant `to`, sans rien écraser :
 * un fichier déjà présent et identique est gardé, un fichier différent part en quarantaine avant d'être remplacé, et chaque
 * fichier restauré est écrit à part puis contrôlé avant d'être mis en place. Les fichiers du dossier vivant que la base
 * restaurée ne connaît pas sont laissés : le démarrage suivant les met en quarantaine (sweepAttachments).
 */
export async function restoreAttachments(opts: { dbFile: string; from: string; to: string; quarantine: string; identity?: string }): Promise<AttachmentRestoreReport> {
  const rows = readRows(opts.dbFile);
  const report: AttachmentRestoreReport = { files: rows.length, missing: [], corrupt: [], kept: 0, restored: 0, quarantined: [] };
  if (!rows.length) return report;
  mkdirSync(opts.to, { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  for (const r of rows) {
    if (!ATTACHMENT_ID.test(r.id)) { report.corrupt.push(r.id); continue; }
    const dest = join(opts.to, r.id);
    if (existsSync(dest)) {
      const cur = await transfer(dest, null).catch(() => null);
      if (cur && cur.sha256 === r.sha256 && cur.size === r.size) { report.kept++; continue; }
    }
    const found = existsSync(opts.from) ? locate(opts.from, r.id, opts.identity) : null;
    if (!found) { report.missing.push(r.id); continue; }
    const tmp = join(opts.to, tempName());
    try {
      const got = await transfer(found.path, tmp, { identity: found.identity });
      if (got.sha256 !== r.sha256 || got.size !== r.size) throw new Error('empreinte');
    } catch {
      rmSync(tmp, { force: true });
      report.corrupt.push(r.id);
      continue;
    }
    if (existsSync(dest)) {
      mkdirSync(opts.quarantine, { recursive: true, mode: 0o700 });
      moveFile(dest, join(opts.quarantine, `${r.id}.avant-restauration-${stamp}`));
      report.quarantined.push(r.id);
    }
    renameSync(tmp, dest);
    report.restored++;
  }
  return report;
}
