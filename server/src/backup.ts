// Sauvegarde et restauration de la base SQLite.
// CLI : node dist/server/backup.js backup [dossier] | verify <fichier> | restore <fichier> --yes | keygen
// Chiffrement : BACKUP_AGE_RECIPIENT (clé publique age) chiffre chaque sauvegarde ; la clé privée n'est nécessaire
// qu'à la vérification et à la restauration (BACKUP_AGE_IDENTITY_FILE).
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
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
  // La copie hérite du mode WAL : on la repasse en journal classique pour qu'elle reste un fichier unique
  // (sans -wal/-shm créés à chaque ouverture, même en lecture seule).
  const copy = new Database(file);
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
  for (const ext of ['-wal', '-shm']) rmSync(`${file}${ext}`, { force: true });
  chmodSync(file, 0o600);
}

// ---- Chiffrement des sauvegardes (age) ---------------------------------------------------------
// Le fichier est lu en mémoire : prévu pour des bases de quelques centaines de Mo au plus.
export async function encryptFile(file: string, recipient: string): Promise<string> {
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const out = `${file}.age`;
  writeFileSync(out, await enc.encrypt(readFileSync(file)), { mode: 0o600 });
  rmSync(file); // le clair ne reste jamais à côté du chiffré
  return out;
}

export async function decryptFile(file: string, identity: string, dest: string): Promise<void> {
  const dec = new Decrypter();
  dec.addIdentity(identity.trim());
  writeFileSync(dest, await dec.decrypt(readFileSync(file)), { mode: 0o600 });
}

export async function newBackupKeys() {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

// En production, une sauvegarde en clair doit être un choix explicite.
export function assertBackupAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production' && !env.BACKUP_AGE_RECIPIENT && env.BACKUP_ALLOW_PLAINTEXT !== 'true') {
    throw new Error('Sauvegarde refusée : en production elle doit être chiffrée. Définissez BACKUP_AGE_RECIPIENT (clé publique age, voir « keygen »), ou BACKUP_ALLOW_PLAINTEXT=true pour accepter le clair.');
  }
}

// Donne un fichier de base lisible : déchiffre dans un dossier temporaire si besoin. `cleanup` efface cette copie.
export async function readableBackup(file: string, env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; cleanup: () => void }> {
  if (!file.endsWith('.age')) return { path: file, cleanup: () => undefined };
  const identityFile = env.BACKUP_AGE_IDENTITY_FILE;
  if (!identityFile) throw new Error('Sauvegarde chiffrée : indiquez la clé privée avec BACKUP_AGE_IDENTITY_FILE.');
  const dir = mkdtempSync(resolve(tmpdir(), 'nb-restore-'));
  const path = resolve(dir, 'notabene.db');
  try {
    await decryptFile(file, readFileSync(identityFile, 'utf8'), path);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('Déchiffrement impossible : mauvaise clé privée ou fichier corrompu.');
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
  const files = readdirSync(dir).filter((f) => /^notabene-\d{8}-\d{6}\.db(\.age)?$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) for (const ext of ['', '-wal', '-shm']) rmSync(resolve(dir, f + ext), { force: true });
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

  if (cmd === 'keygen') {
    const k = await newBackupKeys();
    console.log(`Clé publique (à mettre dans BACKUP_AGE_RECIPIENT sur le serveur) :\n${k.recipient}\n\nClé privée (à garder HORS du serveur, par exemple dans un gestionnaire de secrets ; sans elle, les sauvegardes sont perdues) :\n${k.identity}`);
  } else if (cmd === 'backup') {
    assertBackupAllowed(process.env);
    const dir = resolve(arg ?? resolve(dataDir, 'backups'));
    const db = new Database(dbFile, { fileMustExist: true });
    try {
      let file = resolve(dir, backupName());
      await backupTo(db, file);
      const info = verifyBackup(file);
      if (process.env.BACKUP_AGE_RECIPIENT) file = await encryptFile(file, process.env.BACKUP_AGE_RECIPIENT);
      console.log(`Sauvegarde créée${process.env.BACKUP_AGE_RECIPIENT ? ' (chiffrée)' : ''} : ${file} (${Math.round(statSync(file).size / 1024)} Ko, ${info.pages} pages, ${info.users} utilisateurs)`);
      const removed = pruneBackups(dir, keep);
      if (removed.length) console.log(`Anciennes sauvegardes supprimées : ${removed.length} (conservées : ${keep})`);
    } finally {
      db.close();
    }
  } else if (cmd === 'verify' && arg) {
    const src = await readableBackup(resolve(arg));
    try {
      const info = verifyBackup(src.path);
      console.log(`OK : ${basename(arg)} (${info.pages} pages, ${info.users} utilisateurs, schéma v${info.version})`);
    } finally { src.cleanup(); }
  } else if (cmd === 'restore' && arg) {
    if (!argv.includes('--yes')) {
      console.error('La restauration remplace la base actuelle. Arrêtez le serveur puis relancez avec --yes.');
      process.exit(2);
    }
    const src = await readableBackup(resolve(arg));
    try {
      const { previous } = restoreFrom(src.path, dbFile);
      console.log(`Base restaurée depuis ${arg}.${previous ? ` Ancienne base conservée : ${previous}` : ''} Redémarrez le serveur.`);
    } finally { src.cleanup(); }
  } else {
    console.error('Usage : backup [dossier] | verify <fichier> | restore <fichier> --yes | keygen');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
