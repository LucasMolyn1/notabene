// Lecture de l'en-tête d'une image raster (PNG, JPEG, WebP) : type et dimensions, sans la décoder.
// Sert à refuser ce qui n'est pas une photo (SVG, HTML déguisé) et les images minuscules en octets mais immenses en pixels,
// qui coûteraient de la mémoire à chaque navigateur qui les affiche.
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
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

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : null;
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const v = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    if (b[20]! & 0x02) return null; // animée
    return { mime: 'image/webp', width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  return null;
}

export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG) && b.toString('latin1', 12, 16) === 'IHDR') return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF') return webp(b);
  return null;
}
