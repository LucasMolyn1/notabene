// Version de Notabene : une seule source, le champ « version » de package.json (voir CHANGELOG.md pour la procédure de release).
// Le commit est transmis à la construction de l'image (GIT_COMMIT) : il permet de savoir exactement ce qui tourne sur une instance.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION = (() => {
  try { return (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'inconnue'; }
})();

export const COMMIT = (process.env.GIT_COMMIT ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 12) || null;
