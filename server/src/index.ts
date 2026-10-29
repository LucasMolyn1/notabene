import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { cleanup, openDb } from './db.js';
import { seedDemo } from './seed.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
const db = openDb(resolve(config.DATA_DIR, 'notabene.db'));
if (config.SEED_DEMO && seedDemo(db)) console.log('Contenu de démonstration créé.');
cleanup(db);
setInterval(() => cleanup(db), 3_600_000).unref();

const app = await buildApp({
  config,
  db,
  logger: { level: config.LOG_LEVEL, ...(config.NODE_ENV === 'development' ? { transport: undefined } : {}) },
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} reçu, arrêt…`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
if (config.DEV_LOGIN) app.log.warn('DEV_LOGIN actif : connexion sans fournisseur d’identité (développement uniquement).');
