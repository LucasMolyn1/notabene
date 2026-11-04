// Pièces jointes : fichiers sur disque (DATA_DIR/attachments/<identifiant>), métadonnées en base (table `attachments`).
// Le nom sur disque est toujours l'identifiant aléatoire, jamais le nom d'origine ; le type est déduit des premiers octets,
// jamais de l'extension ni du Content-Type envoyé par le client. Rien n'est servi en ligne sauf une image raster reconnue.
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { DB } from '../db.js';
import { HttpError } from './http.js';

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
        moveFile(join(dir, name), join(quarantine, name));
        quarantined++;
      }
    } catch { /* fichier disparu entre-temps ou non déplaçable : repris au prochain démarrage */ }
  }
  return { temp, quarantined };
}

/** Déplace un fichier sans jamais écraser la destination ; copie puis efface si les deux dossiers sont sur des volumes différents. */
export function moveFile(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`destination déjà présente : ${to}`);
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    unlinkSync(from);
  }
}

// ---- Requêtes partielles (Range, RFC 9110 section 14) -------------------------------------
// Une seule plage d'octets est servie (lecture vidéo et audio). Plusieurs plages, une autre unité ou une forme invalide :
// l'en-tête est ignoré et le fichier entier est renvoyé, comme la norme le permet. Bornes limitées à 15 chiffres.
const rangeHeader = z.string().max(100).regex(/^bytes=(\d{0,15})-(\d{0,15})$/);

/** Plage demandée : `null` (fichier entier), `'unsatisfiable'` (416) ou les bornes incluses. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const ok = rangeHeader.safeParse(header.trim());
  if (!ok.success) return null;
  const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(ok.data)!;
  if (a === '' && b === '') return null;
  if (a === '') {
    // Suffixe « bytes=-n » : les n derniers octets.
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: b === '' ? size - 1 : Math.min(Number(b), size - 1) };
}

// ---- Envois en cours ----------------------------------------------------------------------
// Octets reçus mais pas encore enregistrés, par base (une instance) : comptés dans le plafond par les envois et par les copies.
export interface Reservations { total: number; byUser: Map<string, { count: number; bytes: number }> }
const reservationsByDb = new WeakMap<DB, Reservations>();
export function reservations(db: DB): Reservations {
  let r = reservationsByDb.get(db);
  if (!r) { r = { total: 0, byUser: new Map() }; reservationsByDb.set(db, r); }
  return r;
}

// ---- Copie des fichiers cités par un document ----------------------------------------------
// Copier une page, la dupliquer, en faire un modèle ou créer une page depuis un modèle : chaque pièce jointe citée (bloc fichier,
// vidéo, audio, ou image « /api/v3/attachments/<id> ») qui n'appartient pas déjà à la destination devient une nouvelle ligne et un
// nouveau fichier, rattachés à la destination, qui ne dépend donc plus de l'original. On ne copie que ce que la personne peut lire.
// À l'enregistrement d'une page (`dropUnreadable`), une citation illisible ou introuvable est retirée du contenu ; lors d'une copie,
// elle est laissée telle quelle (elle restera introuvable pour qui ne lit pas l'original).
// La copie est synchrone (dans la transaction qui crée la destination) : son volume est plafonné par opération.
export interface AttachmentRef { id: string; page_id: string | null; template_id: string | null; uploader_id: string | null; name: string; mime: string; size: number; sha256: string }
interface Node { type: string; attrs?: Record<string, unknown>; content?: Node[] }
const IMAGE_SRC = /^\/api\/v3\/attachments\/([A-Za-z0-9_-]{22})$/;
const REF_NODES = new Set(['attachment', 'video', 'audio']);

export interface CloneLimits { totalBytes: number; userBytes: number; operationBytes: number }

export class AttachmentCloner {
  private readonly created: string[] = [];
  copied = 0;
  private bytes = 0;
  constructor(
    private readonly db: DB,
    private readonly dir: string,
    private readonly userId: string | null,
    private readonly canRead: (row: AttachmentRef) => boolean,
    private readonly limits: CloneLimits,
  ) {}

  /** Document réécrit avec les identifiants des copies, rattachées à `owner`. À appeler dans la transaction qui crée ou modifie `owner`. */
  clone<T extends Node>(doc: T, owner: { pageId: string } | { templateId: string }, opts: { dropUnreadable?: boolean } = {}): T {
    const map = new Map<string, string | null>();
    const ownerPage = 'pageId' in owner ? owner.pageId : null;
    const ownerTemplate = 'templateId' in owner ? owner.templateId : null;
    const get = this.db.prepare('SELECT id, page_id, template_id, uploader_id, name, mime, size, sha256 FROM attachments WHERE id = ?');
    const earlier = this.db.prepare('SELECT id FROM attachments WHERE page_id = ? AND copied_from = ? LIMIT 1');
    const KEEP = '';
    // Identifiant à écrire : le même (déjà à la destination), celui d'une copie, ou null (citation à retirer ou à laisser).
    const resolve = (id: string): string | null => {
      if (map.has(id)) return map.get(id)!;
      const row = get.get(id) as AttachmentRef | undefined;
      let next: string | null = null;
      if (row && ((ownerPage && row.page_id === ownerPage) || (ownerTemplate && row.template_id === ownerTemplate))) next = KEEP;
      else {
        // Copie déjà faite pour cette page lors d'un enregistrement précédent (la source a pu disparaître depuis).
        const prior = ownerPage ? earlier.get(ownerPage, id) as { id: string } | undefined : undefined;
        if (prior) next = prior.id;
        else if (row && this.canRead(row)) next = this.copy(row, ownerPage, ownerTemplate);
      }
      map.set(id, next);
      return next;
    };
    const walk = (n: Node): Node | null => {
      const out: Node = { ...n };
      if (n.attrs) {
        let ref: string | null = null;
        if (REF_NODES.has(n.type) && typeof n.attrs.id === 'string' && ATTACHMENT_ID.test(n.attrs.id)) ref = n.attrs.id;
        else if (n.type === 'image' && typeof n.attrs.src === 'string') ref = IMAGE_SRC.exec(n.attrs.src)?.[1] ?? null;
        if (ref) {
          const next = resolve(ref);
          if (next === null) { if (opts.dropUnreadable) return null; }
          else if (next !== KEEP) out.attrs = n.type === 'image' ? { ...n.attrs, src: `/api/v3/attachments/${next}` } : { ...n.attrs, id: next };
        }
      }
      if (n.content) out.content = n.content.map(walk).filter((c): c is Node => c !== null);
      return out;
    };
    return (walk(doc) ?? doc) as T;
  }

  private copy(row: AttachmentRef, pageId: string | null, templateId: string | null): string | null {
    this.bytes += row.size;
    if (this.bytes > this.limits.operationBytes) throw new HttpError(413, `Trop de pièces jointes à copier en une fois (${Math.round(this.limits.operationBytes / 1024 / 1024)} Mo au plus)`);
    if (usedBytes(this.db) + reservations(this.db).total + row.size > this.limits.totalBytes) throw new HttpError(413, 'Espace de stockage des pièces jointes plein');
    if (this.userId && userBytes(this.db, this.userId) + (reservations(this.db).byUser.get(this.userId)?.bytes ?? 0) + row.size > this.limits.userBytes) {
      throw new HttpError(413, 'Quota personnel de pièces jointes atteint');
    }
    const next = newAttachmentId();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const to = attachmentPath(this.dir, next);
    try {
      // Clonage léger quand le système de fichiers le permet ; jamais d'écrasement.
      copyFileSync(attachmentPath(this.dir, row.id), to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    } catch {
      return null; // fichier absent du disque : rien à copier
    }
    this.created.push(to);
    chmodSync(to, 0o600);
    this.db.prepare('INSERT INTO attachments (id, page_id, template_id, uploader_id, name, mime, size, sha256, created_at, copied_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(next, pageId, templateId, this.userId, row.name, row.mime, row.size, row.sha256, Date.now(), row.id);
    this.copied++;
    return next;
  }

  /** Transaction annulée : les fichiers déjà copiés sont effacés (leurs lignes ont disparu avec elle). */
  rollback(): void {
    for (const f of this.created.splice(0)) { try { unlinkSync(f); } catch { /* déjà absent */ } }
  }
}

// ---- Pièces jointes qui ne sont plus citées --------------------------------------------------
export const UNREFERENCED_GRACE_MS = 7 * 86_400_000;

/**
 * Une pièce jointe de page qu'aucune version de la page (contenu actuel, historique, état de co-édition) ne cite plus est
 * marquée ; si elle ne l'est toujours pas après le délai de grâce, et qu'aucune autre page ni aucun modèle ne la cite, elle est
 * supprimée (le fichier suit par attachment_gc).
 * Citée de nouveau entre-temps (annulation, restauration d'une version), elle perd sa marque. Renvoie le nombre supprimé.
 */
export function sweepUnreferenced(db: DB, now = Date.now(), graceMs = UNREFERENCED_GRACE_MS): number {
  const pages = db.prepare('SELECT DISTINCT page_id AS id FROM attachments WHERE page_id IS NOT NULL').all() as { id: string }[];
  const ofPage = db.prepare('SELECT id, unreferenced_since FROM attachments WHERE page_id = ?');
  const current = db.prepare('SELECT content FROM pages WHERE id = ?');
  const versions = db.prepare('SELECT content FROM page_versions WHERE page_id = ?');
  const ydoc = db.prepare('SELECT state FROM page_ydocs WHERE page_id = ?');
  const mark = db.prepare('UPDATE attachments SET unreferenced_since = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM attachments WHERE id = ?');
  // Dernier contrôle avant suppression : citée par n'importe quelle page (contenu, historique, co-édition) ou par un modèle, elle reste.
  const citedAnywhere = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM pages WHERE instr(content, @id) > 0)
       OR EXISTS (SELECT 1 FROM page_versions WHERE instr(content, @id) > 0)
       OR EXISTS (SELECT 1 FROM page_templates WHERE instr(content, @id) > 0)
       OR EXISTS (SELECT 1 FROM page_ydocs WHERE instr(state, @raw) > 0)`,
  );
  let removed = 0;
  for (const { id: pageId } of pages) {
    const rows = ofPage.all(pageId) as { id: string; unreferenced_since: number | null }[];
    const pending = new Set(rows.map((r) => r.id));
    const see = (text: string) => { for (const id of pending) if (text.includes(id)) pending.delete(id); };
    see((current.get(pageId) as { content: string } | undefined)?.content ?? '');
    for (const v of versions.iterate(pageId) as Iterable<{ content: string }>) { if (!pending.size) break; see(v.content); }
    const y = ydoc.get(pageId) as { state: Buffer } | undefined;
    if (y && pending.size) see(y.state.toString('latin1'));
    db.transaction(() => {
      for (const r of rows) {
        if (!pending.has(r.id)) { if (r.unreferenced_since !== null) mark.run(null, r.id); }
        else if (r.unreferenced_since === null) mark.run(now, r.id);
        else if (now - r.unreferenced_since >= graceMs) {
          if (citedAnywhere.get({ id: r.id, raw: Buffer.from(r.id) })) mark.run(null, r.id);
          else { remove.run(r.id); removed++; }
        }
      }
    })();
  }
  if (removed) db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (?, NULL, ?, NULL, NULL, ?)').run(now, 'attachment.unreferenced.purge', JSON.stringify({ count: removed }));
  return removed;
}
