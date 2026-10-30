// Démarre le serveur de test sur une base neuve avec un administrateur (Playwright lance ce script comme webServer).
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const dataDir = process.env.DATA_DIR;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const r = spawnSync('node', ['dist/server/cli.js', 'create-admin', process.env.E2E_ADMIN_EMAIL, '--name', 'Admin E2E'], {
  env: { ...process.env, NOTABENE_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD },
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status ?? 1);
await import('../dist/server/index.js');
