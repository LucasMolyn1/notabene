// Sauvegarde et restauration de la base SQLite.
// CLI : node dist/server/backup.js backup [dossier] | verify <fichier> | restore <fichier> --yes
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { DB } from './db.js';

const pad = (n: number) => String(n).padStart(2, '0');
export const backupName = (d = new Date()) =>
  `notabene-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.db`;

// Copie cohérente (API de sauvegarde en ligne de SQLite : sûre pendant que le serveur écrit).
export async function backupTo(db: DB, file: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  await db.backup(file);
  chmodSync(file, 0o600);
}

// Vérifie qu'un fichier est une base Notabene saine avant de l'utiliser.
export function verifyBackup(file: string): { users: number; pages: number; version: number } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`base corrompue : ${String(check)}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    for (const t of ['users', 'pages', 'spaces', 'sessions']) if (!tables.has(t)) throw new Error(`table manquante : ${t}`);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { users: count('users'), pages: count('pages'), version: db.pragma('user_version', { simple: true }) as number };
  } finally {
    db.close();
  }
}

// Conserve les `keep` sauvegardes les plus récentes du dossier.
export function pruneBackups(dir: string, keep: number): string[] {
  const files = readdirSync(dir).filter((f) => /^notabene-\d{8}-\d{6}\.db$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) rmSync(resolve(dir, f));
  return old;
}

// Remplace la base cible. Le serveur doit être arrêté. L'ancienne base est conservée à côté.
export function restoreFrom(file: string, target: string): { previous: string | null } {
  verifyBackup(file);
  let previous: string | null = null;
  if (existsSync(target)) {
    previous = `${target}.avant-restauration-${Date.now()}`;
    renameSync(target, previous);
  }
  for (const ext of ['-wal', '-shm']) rmSync(`${target}${ext}`, { force: true });
  copyFileSync(file, target);
  chmodSync(target, 0o600);
  return { previous };
}

async function main(argv: string[]) {
  const [cmd, arg] = argv;
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const dbFile = resolve(dataDir, 'notabene.db');
  const keep = Number(process.env.BACKUP_KEEP ?? 14);

  if (cmd === 'backup') {
    const dir = resolve(arg ?? resolve(dataDir, 'backups'));
    const db = new Database(dbFile, { fileMustExist: true });
    try {
      const file = resolve(dir, backupName());
      await backupTo(db, file);
      const info = verifyBackup(file);
      console.log(`Sauvegarde créée : ${file} (${Math.round(statSync(file).size / 1024)} Ko, ${info.pages} pages, ${info.users} utilisateurs)`);
      const removed = pruneBackups(dir, keep);
      if (removed.length) console.log(`Anciennes sauvegardes supprimées : ${removed.length} (conservées : ${keep})`);
    } finally {
      db.close();
    }
  } else if (cmd === 'verify' && arg) {
    const info = verifyBackup(resolve(arg));
    console.log(`OK : ${basename(arg)} (${info.pages} pages, ${info.users} utilisateurs, schéma v${info.version})`);
  } else if (cmd === 'restore' && arg) {
    if (!argv.includes('--yes')) {
      console.error('La restauration remplace la base actuelle. Arrêtez le serveur puis relancez avec --yes.');
      process.exit(2);
    }
    const { previous } = restoreFrom(resolve(arg), dbFile);
    console.log(`Base restaurée depuis ${arg}.${previous ? ` Ancienne base conservée : ${previous}` : ''} Redémarrez le serveur.`);
  } else {
    console.error('Usage : backup [dossier] | verify <fichier> | restore <fichier> --yes');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
