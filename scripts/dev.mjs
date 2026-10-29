// Lance le serveur (tsx watch) et le front (Vite, avec proxy vers l'API) en parallèle.
import { spawn, spawnSync } from 'node:child_process';

spawnSync(process.execPath, ['scripts/copy-assets.mjs'], { stdio: 'inherit' });

const run = (name, args, color) => {
  const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => stream.on('data', (d) => out.write(d.toString().replace(/^(?=.)/gm, prefix)));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
};

const children = [
  run('api', ['tsx', 'watch', '--env-file-if-exists=.env', 'server/src/index.ts'], 36),
  run('web', ['vite'], 35),
];

const stop = () => { for (const c of children) c.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (code) { console.error(`Processus arrêté (code ${code})`); stop(); } });
