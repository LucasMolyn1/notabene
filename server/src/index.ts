import { accessSync, constants, mkdirSync } from 'node:fs';
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

// Dossier de données monté depuis l'hôte : il doit appartenir à l'utilisateur du conteneur, sinon l'erreur SQLite est peu parlante.
try {
  mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  accessSync(config.DATA_DIR, constants.W_OK);
} catch (err) {
  const uid = process.getuid?.() ?? 1000;
  console.error(`DATA_DIR (${config.DATA_DIR}) n'est pas inscriptible par l'utilisateur ${uid} : sur un dossier monté, exécutez « chown ${uid}:${process.getgid?.() ?? uid} <dossier> » sur l'hôte. (${(err as Error).message})`);
  process.exit(1);
}
const db = openDb(resolve(config.DATA_DIR, 'notabene.db'));
if (config.SEED_DEMO && seedDemo(db)) console.log('Contenu de démonstration créé.');
const retention = {
  trashDays: config.TRASH_RETENTION_DAYS,
  notificationDays: config.NOTIFICATION_RETENTION_DAYS,
  auditIpDays: config.AUDIT_IP_RETENTION_DAYS,
  auditDays: config.AUDIT_RETENTION_DAYS,
};
cleanup(db, retention);
setInterval(() => cleanup(db, retention), 3_600_000).unref();

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
if (config.TRUST_PROXY === true && config.NODE_ENV === 'production') {
  app.log.warn('TRUST_PROXY=true fait confiance à tous les sauts de X-Forwarded-For : un client peut falsifier son adresse. Préférez un nombre de sauts (ex. TRUST_PROXY=2) ou la liste de vos proxys.');
}
if (config.DEV_LOGIN) app.log.warn('DEV_LOGIN actif : connexion sans fournisseur d’identité (développement uniquement).');
