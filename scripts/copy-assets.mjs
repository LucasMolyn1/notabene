// Copie les polices d'Excalidraw dans client/public pour les servir localement
// (sinon Excalidraw les télécharge depuis un CDN, ce que la CSP interdit).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const from = resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const to = resolve(root, 'client/public/excalidraw-assets/fonts');

if (!existsSync(from)) {
  console.error(`Polices Excalidraw introuvables : ${from} (avez-vous lancé npm install ?)`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('Polices Excalidraw copiées dans client/public/excalidraw-assets/');
