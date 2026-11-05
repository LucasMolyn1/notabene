// Lecture d'une archive ZIP non fiable (import Notion), entièrement en mémoire : rien n'est jamais écrit sur le disque d'après un nom
// d'entrée, rien n'est exécuté. Le répertoire central est lu à la main (noms bruts décodés en UTF-8 par nous, attributs de lien
// symbolique, chiffrement) ; la décompression passe par zlib avec un plafond de sortie, ce qui borne la mémoire même si l'archive ment
// sur ses tailles.
//
// Archive refusée en entier (413 ou 400) : trop d'entrées, volume décompressé annoncé trop grand, taux de compression suspect
// (bombe ZIP), taille réelle différente de la taille annoncée, structure invalide, ZIP64, archive multi-volumes.
// Entrée écartée avec son motif (l'import des autres continue) : chemin absolu ou avec « .. », caractère de contrôle, nom réservé,
// lien symbolique, entrée chiffrée, méthode de compression inconnue, doublon, ZIP imbriqué au-delà d'un niveau.
import { crc32, inflateRawSync } from 'node:zlib';
import { HttpError } from './http.js';

/** Archive refusée en entier (structure invalide, bombe, taille ou somme fausse) : jamais rattrapée par l'import fichier par fichier. */
export class ZipError extends HttpError {}

export interface ZipLimits {
  /** Nombre d'entrées, archives imbriquées comprises. */
  maxEntries: number;
  /** Volume décompressé total annoncé, archives imbriquées comprises (octets). */
  maxTotalBytes: number;
  /** Taux de compression maximal d'une entrée de plus de RATIO_MIN_BYTES. */
  maxRatio: number;
}

export interface ZipItem {
  /** Chemin vérifié (« / » comme séparateur, sans segment vide, « . » ni « .. »), NFC. */
  path: string;
  /** Taille décompressée annoncée, contrôlée à la lecture. */
  size: number;
  /** Archive imbriquée d'où vient l'entrée (nom de l'entrée de premier niveau), sinon null. */
  nested: string | null;
}

export interface ZipSkip { path: string; reason: string }

interface Raw extends ZipItem { method: number; crc: number; compressed: number; dataStart: number; src: Buffer }

// En dessous de cette taille, un taux élevé est normal (fichier vide ou répétitif) et sans danger.
export const RATIO_MIN_BYTES = 1024 * 1024;

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
// Noms de périphériques Windows : jamais acceptés comme nom de fichier, même sans extension.
const RESERVED_STEM = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const reserved = (segment: string) => RESERVED_STEM.test(segment.split('.')[0]!.trimEnd());
// Fichiers ajoutés par les systèmes d'exploitation, sans intérêt pour l'import.
const SYSTEM = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Nom d'entrée décodé : UTF-8 que l'en-tête le déclare ou non (Notion ne le déclare pas toujours), sinon Latin-1. */
function decodeName(bytes: Buffer): string {
  try { return utf8.decode(bytes).normalize('NFC'); } catch { return bytes.toString('latin1').normalize('NFC'); }
}

/** Motif de refus d'un chemin, ou null s'il est acceptable. */
export function unsafePath(path: string): string | null {
  if (CONTROL.test(path)) return 'nom avec caractère de contrôle';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('//')) return 'chemin absolu';
  if (path.length > 1000) return 'chemin trop long';
  const segments = path.split('/');
  if (segments.length > 40) return 'arborescence trop profonde';
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'chemin avec « .. » ou segment vide';
  if (segments.some(reserved)) return 'nom de fichier réservé';
  return null;
}

/** Archive lue : entrées utilisables, entrées écartées, et décompression contrôlée. */
export class ZipArchive {
  readonly items: ZipItem[] = [];
  readonly skipped: ZipSkip[] = [];
  private readonly raw = new Map<string, Raw>();
  private declared = 0;
  private entries = 0;
  /** Octets réellement décompressés jusqu'ici. */
  inflated = 0;

  constructor(buf: Buffer, private readonly limits: ZipLimits) {
    this.list(buf, null);
  }

  /** Contenu décompressé d'une entrée, vérifié (taille exacte, somme CRC-32). */
  read(path: string): Buffer {
    const e = this.raw.get(path);
    if (!e) throw new HttpError(404, 'Entrée absente de l’archive');
    return this.inflate(e);
  }

  private inflate(e: Raw): Buffer {
    const data = e.src.subarray(e.dataStart, e.dataStart + e.compressed);
    let out: Buffer;
    if (e.method === 0) out = data;
    else {
      try {
        // Plafond de sortie : zlib s'arrête dès que la taille annoncée serait dépassée (une archive qui ment ne remplit pas la mémoire).
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
      } catch (err) {
        if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(413, `Archive refusée : « ${e.path.slice(0, 200)} » est plus gros que ce qu’annonce l’archive`);
        throw new ZipError(400, `Archive corrompue : « ${e.path.slice(0, 200)} » ne se décompresse pas`);
      }
    }
    if (out.length !== e.size) throw new ZipError(400, `Archive corrompue : taille inattendue pour « ${e.path.slice(0, 200)} »`);
    if (crc32(out) >>> 0 !== e.crc) throw new ZipError(400, `Archive corrompue : somme de contrôle fausse pour « ${e.path.slice(0, 200)} »`);
    this.inflated += out.length;
    return out;
  }

  private list(buf: Buffer, nested: string | null) {
    const bad = (m: string): never => { throw new ZipError(400, `Archive ZIP invalide${nested ? ` (dans « ${nested.slice(0, 120)} »)` : ''} : ${m}`); };
    if (buf.length < 22) bad('fichier trop court');
    // Fin du répertoire central : dans les 22 + 65 535 derniers octets (commentaire d'archive au plus).
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) { eocd = i; break; }
    }
    if (eocd < 0) bad('fin de répertoire introuvable');
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) bad('format ZIP64 non pris en charge (archive de plus de 4 Go ou de 65 535 fichiers)');
    if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) bad('archive en plusieurs volumes');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) bad('format ZIP64 non pris en charge');
    if (cdOffset + cdSize > eocd) bad('répertoire central hors de l’archive');
    this.entries += count;
    if (this.entries > this.limits.maxEntries) throw new ZipError(413, `Archive refusée : plus de ${this.limits.maxEntries} fichiers`);

    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CEN) bad('répertoire central incohérent');
      const madeBy = buf.readUInt16LE(p + 4);
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      const compressed = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const external = buf.readUInt32LE(p + 38);
      const local = buf.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) bad('répertoire central incohérent');
      const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) bad('format ZIP64 non pris en charge');

      // Barre oblique inverse : séparateur sous Windows. Un dossier (nom finissant par « / ») n'a pas de contenu.
      const name = rawName.replace(/\\/g, '/');
      const shown = name.slice(0, 300);
      if (name.endsWith('/') && size === 0) continue;
      if (SYSTEM.test(name)) { this.skipped.push({ path: shown, reason: 'fichier système (macOS, Windows)' }); continue; }
      const unsafe = unsafePath(name);
      if (unsafe) { this.skipped.push({ path: shown, reason: unsafe }); continue; }
      // Lien symbolique (attributs Unix) : jamais suivi.
      if (madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000) { this.skipped.push({ path: shown, reason: 'lien symbolique' }); continue; }
      if (flags & 0x1) { this.skipped.push({ path: shown, reason: 'fichier chiffré' }); continue; }
      if (method !== 0 && method !== 8) { this.skipped.push({ path: shown, reason: 'méthode de compression non prise en charge' }); continue; }
      if (method === 0 && compressed !== size) bad(`taille incohérente pour « ${shown} »`);
      // Taux de compression : au-delà du plafond, l'archive est une bombe ou en contient une.
      if (size > RATIO_MIN_BYTES && size > compressed * this.limits.maxRatio) {
        throw new ZipError(413, `Archive refusée : taux de compression suspect pour « ${shown} » (plus de ${this.limits.maxRatio} pour 1)`);
      }
      this.declared += size;
      if (this.declared > this.limits.maxTotalBytes) {
        throw new ZipError(413, `Archive refusée : plus de ${Math.round(this.limits.maxTotalBytes / 1024 / 1024)} Mo une fois décompressée`);
      }
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) bad(`en-tête local introuvable pour « ${shown} »`);
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (dataStart + compressed > buf.length) bad(`données hors de l’archive pour « ${shown} »`);
      const entry: Raw = { path: name, size, nested, method, crc, compressed, dataStart, src: buf };

      // Archive imbriquée (Notion découpe un gros export en « …-Part-1.zip ») : un seul niveau, à la racine, mêmes plafonds.
      if (/\.zip$/i.test(name) && !name.includes('/')) {
        if (nested) { this.skipped.push({ path: shown, reason: 'archive ZIP imbriquée sur plus d’un niveau' }); continue; }
        this.list(this.inflate(entry), name);
        continue;
      }
      if (this.raw.has(name)) { this.skipped.push({ path: shown, reason: 'fichier en double dans l’archive' }); continue; }
      this.raw.set(name, entry);
      this.items.push({ path: name, size, nested });
    }
  }
}
