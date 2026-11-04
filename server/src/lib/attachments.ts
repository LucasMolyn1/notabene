// Pièces jointes : fichiers sur disque (DATA_DIR/attachments/<identifiant>), métadonnées en base (table `attachments`).
// Le nom sur disque est toujours l'identifiant aléatoire, jamais le nom d'origine ; le type est déduit des premiers octets,
// jamais de l'extension ni du Content-Type envoyé par le client. Rien n'est servi en ligne sauf une image raster reconnue.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DB } from '../db.js';

// Types reconnus par signature. Tout le reste est servi en application/octet-stream.
export const ATTACHMENT_MIMES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'application/zip',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav',
  'application/octet-stream',
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

// Seules ces images raster sont affichées dans le navigateur ; tout le reste est proposé au téléchargement.
export const INLINE_MIMES = new Set<AttachmentMime>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Octets lus en tête de fichier pour reconnaître le type.
export const SNIFF_BYTES = 64;

// Identifiant de 128 bits : forme fixe, ce qui permet de reconnaître sans ambiguïté un fichier du dossier.
export const ATTACHMENT_ID = /^[A-Za-z0-9_-]{22}$/;
export const newAttachmentId = () => randomBytes(16).toString('base64url');
const TMP_PREFIX = '.tmp-';
export const tempName = () => `${TMP_PREFIX}${randomBytes(12).toString('hex')}`;

export const attachmentsDir = (dataDir: string) => resolve(dataDir, 'attachments');
// Chemin d'un fichier : l'identifiant est revalidé ici, jamais un nom choisi par le client.
export function attachmentPath(dir: string, id: string): string {
  if (!ATTACHMENT_ID.test(id)) throw new Error('identifiant de pièce jointe invalide');
  return join(dir, id);
}

const ascii = (b: Buffer, start: number, end: number) => b.toString('latin1', start, end);

/** Type d'un fichier d'après ses premiers octets. Un SVG, un HTML ou un script n'a pas de signature reconnue : octet-stream. */
export function sniffMime(b: Buffer): AttachmentMime {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const kind = ascii(b, 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06))) return 'application/zip';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') return 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 3 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe6) === 0xe2))) return 'audio/mpeg';
  return 'application/octet-stream';
}

// Caractères de contrôle, séparateurs de ligne et inversions de sens d'écriture (qui maquillent une extension : « fdp.exe » lu « exe.pdf »).
const UNSAFE_RANGES: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff]];
const unsafeChar = (c: string) => { const n = c.codePointAt(0)!; return UNSAFE_RANGES.some(([a, b]) => n >= a && n <= b); };
const MAX_NAME = 200;

/** Nom d'origine assaini : dernier segment seulement (aucun chemin), sans caractère de contrôle, borné. Jamais vide. */
export function sanitizeFilename(raw: string | undefined): string {
  let name = [...(raw ?? '').normalize('NFC')].filter((c) => !unsafeChar(c)).join('');
  name = name.split(/[/\\]/).pop() ?? '';
  // Pas de nom fait de points (« . », « .. ») ni d'espaces ou de points en bordure (Windows les retire).
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ');
  if ([...name].length > MAX_NAME) {
    const chars = [...name];
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = chars.slice(0, MAX_NAME - [...ext].length).join('') + ext;
  }
  return name || 'fichier';
}

/** En-tête Content-Disposition (RFC 6266 / 5987) : repli ASCII sans guillemet ni barre oblique inverse, et nom UTF-8 encodé. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_') || 'fichier';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const usedBytes = (db: DB): number => (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachments').get() as { n: number }).n;
export const userBytes = (db: DB, userId: string): number => (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE uploader_id = ?').get(userId) as { n: number }).n;

/**
 * Efface du disque les fichiers dont la ligne a disparu (suppression d'une pièce jointe, d'une page, d'un espace : le déclencheur
 * de la table les inscrit dans `attachment_gc`). Une erreur autre que « fichier absent » laisse l'entrée pour un nouvel essai.
 */
export async function drainAttachmentGc(db: DB, dir: string): Promise<number> {
  // Une entrée dont la ligne existe encore n'est jamais traitée : on n'efface pas le fichier d'une pièce jointe vivante.
  db.prepare('DELETE FROM attachment_gc WHERE id IN (SELECT id FROM attachments)').run();
  const rows = db.prepare('SELECT id FROM attachment_gc WHERE id NOT IN (SELECT id FROM attachments) LIMIT 500').all() as { id: string }[];
  let removed = 0;
  for (const { id } of rows) {
    if (ATTACHMENT_ID.test(id)) {
      try { await unlink(join(dir, id)); removed++; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
    }
    db.prepare('DELETE FROM attachment_gc WHERE id = ?').run(id);
  }
  return removed;
}

export const quarantineDir = (dataDir: string) => resolve(dataDir, 'attachments-quarantaine');

/**
 * Nettoyage au démarrage (avant toute requête) : file d'effacement d'abord (lignes supprimées, fichiers à effacer), puis fichiers
 * temporaires d'un envoi interrompu (effacés). Un fichier sans ligne en base n'est pas effacé mais déplacé en quarantaine : une base
 * restaurée plus ancienne que le dossier, par exemple, ne doit pas faire perdre de fichiers. Ne touche qu'aux noms produits ici.
 */
export async function sweepAttachments(db: DB, dir: string, quarantine: string): Promise<{ temp: number; quarantined: number }> {
  if (!existsSync(dir)) { db.prepare('DELETE FROM attachment_gc').run(); return { temp: 0, quarantined: 0 }; }
  while (await drainAttachmentGc(db, dir) > 0) { /* par lots de 500 */ }
  const known = db.prepare('SELECT 1 FROM attachments WHERE id = ?');
  let temp = 0;
  let quarantined = 0;
  for (const name of readdirSync(dir)) {
    try {
      if (name.startsWith(TMP_PREFIX)) { unlinkSync(join(dir, name)); temp++; }
      else if (ATTACHMENT_ID.test(name) && !known.get(name)) {
        mkdirSync(quarantine, { recursive: true, mode: 0o700 });
        renameSync(join(dir, name), join(quarantine, name));
        quarantined++;
      }
    } catch { /* fichier disparu entre-temps ou non déplaçable : repris au prochain démarrage */ }
  }
  return { temp, quarantined };
}
