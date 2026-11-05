// Archive ZIP produite en flux (fflate) : export des données personnelles avec leurs fichiers. Lisible partout (explorateur de
// Windows, Finder, unzip, 7-Zip). Une entrée à la fois, un morceau à la fois : la mémoire ne dépend pas de la taille des fichiers.
// Les fichiers déjà compressés (images, vidéo, audio, PDF, ZIP) sont stockés tels quels ; le reste est compressé (DEFLATE).
// Pas de ZIP64 : chaque fichier et l'archive entière restent sous 4 Gio (vérifié avant d'écrire le premier octet).
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { HttpError } from './http.js';

export interface ZipEntry {
  name: string;
  size: number;
  /** Date de modification, en millisecondes. */
  mtime: number;
  /** Stocker sans recompresser (fichier déjà compressé). */
  store?: boolean;
  /**
   * `false` : `size` n'est qu'une estimation (texte produit pendant le flux, qui peut changer d'ici là) ; la taille réelle n'est
   * pas exigée, mais l'archive entière reste bornée (vérifié octet par octet pendant l'écriture).
   */
  exact?: boolean;
  body: () => Buffer | AsyncIterable<Buffer>;
}

// En-têtes local et central, descripteur de données et nom (UTF-8, 4 octets par caractère au plus) : majorant par entrée.
const OVERHEAD = (name: string) => 30 + 46 + 16 + 2 * 4 * name.length;
export const ZIP_MAX_BYTES = 0xffff_ffff - 1024 * 1024;
const MAX_NAME = 180;

// Caractères de contrôle et inversions de sens d'écriture : retirés des noms d'entrée.
const UNSAFE_RANGES: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff]];
const unsafe = (c: string) => { const n = c.codePointAt(0)!; return UNSAFE_RANGES.some(([a, b]) => n >= a && n <= b); };

/**
 * Nom d'entrée sûr : chemin relatif à « / », sans segment vide, « . » ni « .. », sans barre oblique inverse, deux-points ni caractère
 * de contrôle (une extraction ne peut rien écrire hors de son dossier). Segments bornés ; jamais vide.
 */
export function zipEntryName(raw: string): string {
  const segments = [...raw.normalize('NFC')].filter((c) => !unsafe(c)).join('')
    .replace(/[\\:*?"<>|]/g, '_')
    .split('/')
    .map((s) => s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, ''))
    .filter((s) => s !== '');
  const name = segments.map((s) => [...s].slice(0, MAX_NAME).join('')).join('/');
  return name || 'fichier';
}

// Doublon : « nom (2).ext », « nom (3).ext »…
function unique(name: string, seen: Set<string>): string {
  const key = (n: string) => n.toLocaleLowerCase('fr');
  if (!seen.has(key(name))) { seen.add(key(name)); return name; }
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  const cut = dot > slash + 1 ? dot : name.length;
  for (let i = 2; ; i++) {
    const next = `${name.slice(0, cut)} (${i})${name.slice(cut)}`;
    if (!seen.has(key(next))) { seen.add(key(next)); return next; }
  }
}

// Le format ZIP date les entrées entre 1980 et 2107 (fflate : 2099).
const zipTime = (ms: number) => Math.min(Math.max(ms, Date.UTC(1980, 0, 2)), Date.UTC(2099, 11, 31));

/**
 * Flux de l'archive. Les noms sont assainis et rendus uniques ; un fichier dont la taille réelle diffère de celle annoncée
 * interrompt le flux (archive jamais incohérente avec ce que dit l'export).
 */
// Le contrôle de taille est fait à l'appel (avant toute réponse), pas au premier octet lu : l'erreur reste une vraie réponse 413.
export function zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const seen = new Set<string>();
  const named = entries.map((e) => ({ ...e, name: unique(zipEntryName(e.name), seen) }));
  const total = named.reduce((n, e) => n + e.size + OVERHEAD(e.name), 22);
  if (total > ZIP_MAX_BYTES) throw new HttpError(413, 'Archive trop volumineuse (4 Go au plus) : utilisez l’export JSON sans les fichiers');
  return write(named);
}

async function* write(named: ZipEntry[]): AsyncGenerator<Buffer> {
  // Sortie de fflate : poussée de façon synchrone à chaque morceau ajouté, puis rendue au lecteur avant le morceau suivant.
  const out: Buffer[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else if (chunk.length) out.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
  });
  let total = 0;
  const flush = function* () {
    if (failure) throw failure;
    while (out.length) {
      const chunk = out.shift()!;
      total += chunk.length;
      if (total > ZIP_MAX_BYTES) throw new Error('archive trop volumineuse');
      yield chunk;
    }
  };

  for (const e of named) {
    const file = e.store ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 6 });
    file.mtime = zipTime(e.mtime);
    zip.add(file);
    const body = e.body();
    let written = 0;
    const exact = e.exact !== false;
    if (Buffer.isBuffer(body)) {
      written = body.length;
      if (!exact || written === e.size) file.push(body, true);
    } else {
      for await (const chunk of body) {
        written += chunk.length;
        if (exact && written > e.size) break;
        file.push(chunk, false);
        yield* flush();
      }
      if (!exact || written === e.size) file.push(new Uint8Array(0), true);
    }
    if (exact && written !== e.size) throw new Error(`taille inattendue pour ${e.name}`);
    yield* flush();
  }
  zip.end();
  yield* flush();
}
