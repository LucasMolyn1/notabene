// Archive tar (POSIX ustar, sans compression) produite en flux et sans dépendance : export des données personnelles avec
// leurs fichiers. Lisible partout (tar, 7-Zip, explorateur de Windows 11, Finder). Les noms d'entrée sont construits par
// l'appelant : ASCII imprimable, moins de 100 octets, sans chemin absolu ni « .. ». Taille par fichier inférieure à 8 Gio.

export interface TarEntry {
  name: string;
  size: number;
  /** Date de modification, en millisecondes. */
  mtime: number;
  body: () => Buffer | AsyncIterable<Buffer>;
}

const BLOCK = 512;
const MAX_SIZE = 8 ** 11 - 1;
const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x20-\x7e]{1,99}$/;

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`;

export function tarHeader(name: string, size: number, mtime: number): Buffer {
  if (!SAFE_NAME.test(name)) throw new Error('nom d’entrée tar invalide');
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) throw new Error('taille d’entrée tar invalide');
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'ascii');
  h.write(octal(0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.max(0, Math.floor(mtime / 1000)), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // somme de contrôle calculée avec ce champ rempli d'espaces
  h.write('0', 156, 'ascii'); // fichier ordinaire
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** Flux de l'archive. Un fichier dont la taille réelle diffère de celle annoncée interrompt le flux (archive jamais incohérente). */
export async function* tarStream(entries: Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for (const e of entries) {
    yield tarHeader(e.name, e.size, e.mtime);
    const body = e.body();
    let written = 0;
    if (Buffer.isBuffer(body)) {
      written = body.length;
      if (written === e.size) yield body;
    } else {
      for await (const chunk of body) {
        written += chunk.length;
        if (written > e.size) break;
        yield chunk;
      }
    }
    if (written !== e.size) throw new Error(`taille inattendue pour ${e.name}`);
    const pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}
