// Retrait des métadonnées d'une image raster avant stockage, sans la décoder ni dépendance : EXIF (position GPS, appareil, date),
// XMP, commentaires et textes libres. Seuls les blocs nécessaires à l'affichage sont recopiés, et rien après la fin de l'image.
// Renvoie null si la structure du fichier est incohérente (bloc tronqué ou débordant) : l'image est alors refusée.
import { gifLayout, type ImageMime, riffChunks } from './image-info.js';

const PNG_SIGNATURE = 8;
// Morceaux PNG de texte et d'EXIF : aucun effet sur l'affichage.
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function png(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, PNG_SIGNATURE)];
  let i = PNG_SIGNATURE;
  while (i < b.length) {
    // Longueur (4), type (4), données, CRC (4).
    if (i + 12 > b.length) return null;
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break; // tout ce qui suit est ignoré
  }
  return Buffer.concat(out);
}

const startsWith = (b: Buffer, at: number, text: string) => b.toString('latin1', at, at + text.length) === text;

function jpeg(b: Buffer): Buffer | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // octets de remplissage
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (marker === 0xd9) return null; // fin d'image avant toute donnée
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return null;
    if (marker === 0xda) {
      // Début des données compressées : recopiées telles quelles jusqu'au dernier marqueur de fin d'image (rien après lui).
      const eoi = b.lastIndexOf(Buffer.from([0xff, 0xd9]));
      out.push(b.subarray(i, eoi > end ? eoi + 2 : b.length));
      return Buffer.concat(out);
    }
    // APP1 à APP15 (EXIF, XMP, IPTC...) et commentaires retirés, sauf le profil de couleur (APP2) et l'en-tête Adobe (APP14).
    const app = marker >= 0xe1 && marker <= 0xef;
    const keep = (!app && marker !== 0xfe)
      || (marker === 0xe2 && startsWith(b, i + 4, 'ICC_PROFILE\0'))
      || (marker === 0xee && startsWith(b, i + 4, 'Adobe'));
    if (keep) out.push(b.subarray(i, end));
    i = end;
  }
  return null; // aucune donnée d'image
}

// Drapeaux VP8X « EXIF présent » (0x08) et « XMP présent » (0x04).
const VP8X_META_FLAGS = 0x08 | 0x04;

function webp(b: Buffer): Buffer | null {
  if (b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks = riffChunks(b);
  if (!chunks) return null;
  const parts: Buffer[] = [];
  for (const c of chunks) {
    if (c.fourcc === 'EXIF' || c.fourcc === 'XMP ') continue;
    // Bourrage manquant en toute fin de fichier : ajouté (zéro), pour que chaque morceau garde une taille paire.
    const part = Buffer.alloc(8 + c.size + (c.size & 1));
    b.copy(part, 0, c.start, c.end);
    if (c.fourcc === 'VP8X' && c.size >= 1) part[8] = part[8]! & ~VP8X_META_FLAGS;
    parts.push(part);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4); // taille RIFF recalculée
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function gif(b: Buffer): Buffer | null {
  const layout = gifLayout(b);
  if (!layout) return null;
  const parts = layout.blocks.filter((x) => !x.metadata).map((x) => b.subarray(x.start, x.end));
  // Bloc de fin toujours présent ; rien après lui.
  if (b[layout.blocks.at(-1)!.start] !== 0x3b) parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** Copie de l'image sans ses métadonnées, ou null si sa structure est incohérente. */
export function stripImageMetadata(b: Buffer, mime: ImageMime): Buffer | null {
  switch (mime) {
    case 'image/png': return png(b);
    case 'image/jpeg': return jpeg(b);
    case 'image/webp': return webp(b);
    case 'image/gif': return gif(b);
    default: return null;
  }
}
