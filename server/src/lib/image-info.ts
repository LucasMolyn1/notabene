// Lecture de l'en-tête d'une image raster (PNG, JPEG, WebP, et GIF sur demande) : type et dimensions, sans la décoder.
// Sert à refuser ce qui n'est pas une photo (SVG, HTML déguisé) et les images minuscules en octets mais immenses en pixels,
// qui coûteraient de la mémoire à chaque navigateur qui les affiche.
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
// `gif` : accepter le GIF (refusé par défaut, la photo de profil ne le prend pas) ; `animated` : accepter un WebP animé.
export interface ImageInfoOptions { gif?: boolean; animated?: boolean }
export interface ImageInfo { mime: ImageMime; width: number; height: number }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // octets de remplissage
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (SOF.has(marker)) return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer, animated: boolean): ImageInfo | null {
  if (b.length < 30 || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : null;
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const v = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    const width = 1 + u24(b, 24);
    const height = 1 + u24(b, 27);
    if (b[20]! & 0x02) {
      if (!animated) return null; // animée
      // Chaque image (ANMF) doit tenir dans le canevas déclaré, et leur nombre est borné.
      const chunks = riffChunks(b);
      if (!chunks) return null;
      let frames = 0;
      for (const c of chunks) {
        if (c.fourcc !== 'ANMF') continue;
        if (++frames > MAX_FRAMES || c.size < 16) return null;
        const x = 2 * u24(b, c.data), y = 2 * u24(b, c.data + 3), w = 1 + u24(b, c.data + 6), h = 1 + u24(b, c.data + 9);
        if (x + w > width || y + h > height) return null;
      }
      if (frames === 0) return null;
    }
    return { mime: 'image/webp', width, height };
  }
  return null;
}

// Images au plus dans un GIF ou un WebP animé : au-delà, le coût de décodage pour chaque navigateur n'est plus borné par le poids.
export const MAX_FRAMES = 300;

const u24 = (b: Buffer, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

export interface RiffChunk { fourcc: string; start: number; data: number; size: number; end: number }

/** Morceaux d'un fichier RIFF (WebP) : null si un morceau déborde du fichier ou de la taille RIFF déclarée. */
export function riffChunks(b: Buffer): RiffChunk[] | null {
  if (b.length < 12) return null;
  const limit = 8 + b.readUInt32LE(4);
  if (limit > b.length || limit < 12) return null;
  const out: RiffChunk[] = [];
  let i = 12;
  while (i < limit) {
    if (i + 8 > limit) return null;
    const size = b.readUInt32LE(i + 4);
    const dataEnd = i + 8 + size;
    if (dataEnd > limit) return null;
    // Octet de bourrage d'un morceau de taille impaire : toléré s'il manque en toute fin de fichier.
    const end = Math.min(dataEnd + (size & 1), limit);
    out.push({ fourcc: b.toString('latin1', i, i + 4), start: i, data: i + 8, size, end });
    i = end;
  }
  return out;
}

export interface GifLayout { width: number; height: number; frames: number; blocks: { start: number; end: number; metadata: boolean }[] }

/**
 * Structure d'un GIF : en-tête, puis extensions (sous-blocs sautés) et descripteurs d'image (0x2C), jusqu'au bloc de fin.
 * Null si un bloc est tronqué ou inconnu, si une image déborde de l'écran logique, si aucune image ou plus de MAX_FRAMES.
 * `metadata` marque les blocs sans effet sur l'affichage (commentaires, extensions d'application autres que la boucle).
 */
export function gifLayout(b: Buffer): GifLayout | null {
  if (b.length < 13) return null;
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let i = 13 + (b[10]! & 0x80 ? 3 * (1 << ((b[10]! & 7) + 1)) : 0);
  if (i > b.length) return null;
  const blocks: GifLayout['blocks'] = [{ start: 0, end: i, metadata: false }];
  // Fin d'une suite de sous-blocs (taille, données), terminateur compris ; -1 si elle est tronquée.
  const subBlocks = (j: number): number => {
    for (;;) {
      if (j >= b.length) return -1;
      const n = b[j]!;
      if (n === 0) return j + 1;
      j += 1 + n;
    }
  };
  let frames = 0;
  while (i < b.length) {
    const type = b[i]!;
    if (type === 0x3b) { blocks.push({ start: i, end: i + 1, metadata: false }); break; }
    if (type === 0x21) {
      if (i + 2 > b.length) return null;
      const label = b[i + 1]!;
      const end = subBlocks(i + 2);
      if (end < 0) return null;
      const app = label === 0xff ? b.toString('latin1', i + 3, Math.min(i + 14, b.length)) : '';
      const loop = b[i + 2] === 11 && (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0');
      blocks.push({ start: i, end, metadata: label === 0xfe || (label === 0xff && !loop) });
      i = end;
      continue;
    }
    if (type === 0x2c) {
      if (i + 10 > b.length) return null;
      const left = b.readUInt16LE(i + 1), top = b.readUInt16LE(i + 3), w = b.readUInt16LE(i + 5), h = b.readUInt16LE(i + 7);
      if (left + w > width || top + h > height) return null;
      if (++frames > MAX_FRAMES) return null;
      const p = b[i + 9]!;
      // Table de couleurs locale éventuelle, puis taille de code LZW (un octet), puis les données en sous-blocs.
      const lzw = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0) + 1;
      if (lzw > b.length) return null;
      const end = subBlocks(lzw);
      if (end < 0) return null;
      blocks.push({ start: i, end, metadata: false });
      i = end;
      continue;
    }
    return null;
  }
  return frames === 0 ? null : { width, height, frames, blocks };
}

function gif(b: Buffer): ImageInfo | null {
  const layout = gifLayout(b);
  return layout ? { mime: 'image/gif', width: layout.width, height: layout.height } : null;
}

export function imageInfo(b: Buffer, opts: ImageInfoOptions = {}): ImageInfo | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG) && b.toString('latin1', 12, 16) === 'IHDR') return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF') return webp(b, !!opts.animated);
  if (opts.gif && b.length >= 6 && b.toString('latin1', 0, 3) === 'GIF') return gif(b);
  return null;
}
