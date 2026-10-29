// Copie les polices d'Excalidraw dans client/public pour les servir localement
// (sinon Excalidraw les télécharge depuis un CDN, ce que la CSP interdit).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

// PlantUML (moteur JS/TeaVM + Graphviz WASM) : servi localement, chargé à la demande.
const plantumlFrom = resolve(root, 'node_modules/@plantuml/core');
const plantumlTo = resolve(root, 'client/public/plantuml');
if (!existsSync(plantumlFrom)) {
  console.error('@plantuml/core introuvable (avez-vous lancé npm install ?)');
  process.exit(1);
}
rmSync(plantumlTo, { recursive: true, force: true });
mkdirSync(plantumlTo, { recursive: true });
for (const file of ['plantuml.js', 'viz-global.js', 'themes.js', 'LICENSE']) cpSync(resolve(plantumlFrom, file), resolve(plantumlTo, file));
console.log('PlantUML copié dans client/public/plantuml/');
