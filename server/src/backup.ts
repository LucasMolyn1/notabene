// Sauvegarde et restauration de la base SQLite et des pièces jointes (DATA_DIR/attachments, voir lib/attachment-backup.ts).
// CLI : node dist/server/backup.js backup [dossier] | verify <fichier> | restore <fichier> --yes [--allow-missing] | keygen
// Chiffrement : BACKUP_AGE_RECIPIENT (clé publique age) chiffre chaque sauvegarde, base et fichiers ; la clé privée n'est
// nécessaire qu'à la vérification et à la restauration (BACKUP_AGE_IDENTITY_FILE).
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { DB } from './db.js';
import {
  attachmentsBackupDir, backupAttachments, previousAttachmentsBackup, restoreAttachments, verifyAttachments,
  type AttachmentBackupReport, type AttachmentCheck, type AttachmentRestoreReport,
} from './lib/attachment-backup.js';
import { attachmentsDir, quarantineDir } from './lib/attachments.js';

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
    // Les flux iCalendar des bases (empreintes de jetons secrets) ne sont jamais gardés dans une sauvegarde.
    copy.pragma('secure_delete = ON');
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'base_ical_feeds'").get()) copy.prepare('DELETE FROM base_ical_feeds').run();
    // Ni les empreintes des liens de formulaires : une restauration ne rouvre aucun formulaire (la configuration est gardée).
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'base_forms'").get()) copy.prepare('UPDATE base_forms SET token_hash = NULL, link_created_at = NULL').run();
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

// Vérifie qu'un fichier est une base BeNote saine avant de l'utiliser.
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

const BACKUP_FILE = /^(notabene-\d{8}-\d{6})\.db(\.age)?$/;
const BACKUP_ATTACHMENTS = /^(notabene-\d{8}-\d{6})\.attachments$/;
const BACKUP_PARTIAL = /^\.notabene-\d{8}-\d{6}\.partiel$/;
const DAY = 86_400_000;

// Conserve les `keep` sauvegardes les plus récentes du dossier, avec leurs pièces jointes. Retire aussi les dossiers de pièces
// jointes sans base (sauvegarde interrompue) et les dossiers de travail abandonnés depuis plus d'un jour.
export function pruneBackups(dir: string, keep: number): string[] {
  const entries = readdirSync(dir);
  const files = entries.filter((f) => BACKUP_FILE.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  const kept = new Set(files.slice(old.length).map((f) => BACKUP_FILE.exec(f)![1]));
  for (const f of old) for (const ext of ['', '-wal', '-shm']) rmSync(resolve(dir, f + ext), { force: true });
  for (const e of entries) {
    const att = BACKUP_ATTACHMENTS.exec(e);
    const stale = BACKUP_PARTIAL.test(e) && Date.now() - statSync(resolve(dir, e)).mtimeMs > DAY;
    if ((att && !kept.has(att[1]!)) || stale) rmSync(resolve(dir, e), { recursive: true, force: true });
  }
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

const identityFrom = (env: NodeJS.ProcessEnv) => (env.BACKUP_AGE_IDENTITY_FILE ? readFileSync(env.BACKUP_AGE_IDENTITY_FILE, 'utf8') : undefined);

/**
 * Sauvegarde complète : copie cohérente de la base, puis des pièces jointes qu'elle référence, chiffrées si BACKUP_AGE_RECIPIENT.
 * Tout est préparé dans un dossier de travail (`.notabene-X.partiel`) puis mis en place : le dossier des pièces jointes d'abord,
 * la base en dernier. Une base présente dans le dossier signifie donc une sauvegarde terminée.
 */
export async function createBackup(db: DB, opts: { dataDir: string; dir: string; env?: NodeJS.ProcessEnv; now?: Date }) {
  const env = opts.env ?? process.env;
  assertBackupAllowed(env);
  const recipient = env.BACKUP_AGE_RECIPIENT || undefined;
  const name = backupName(opts.now);
  const stem = name.slice(0, -'.db'.length);
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const staging = resolve(opts.dir, `.${stem}.partiel`);
  mkdirSync(staging, { mode: 0o700 }); // échoue si une sauvegarde de la même seconde est en cours
  try {
    let file = resolve(staging, name);
    await backupTo(db, file);
    const stagedFiles = resolve(staging, `${stem}.attachments`);
    const attachments: AttachmentBackupReport = await backupAttachments({
      live: db, snapshot: file, source: attachmentsDir(opts.dataDir), dest: stagedFiles, recipient,
      previous: previousAttachmentsBackup(opts.dir, recipient ?? null),
    });
    const info = verifyBackup(file);
    if (recipient) file = await encryptFile(file, recipient);
    const filesDir = resolve(opts.dir, `${stem}.attachments`);
    renameSync(stagedFiles, filesDir);
    const final = resolve(opts.dir, basename(file));
    renameSync(file, final);
    return { file: final, attachmentsDir: filesDir, encrypted: !!recipient, info, attachments };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Vérification complète d'une sauvegarde : base, puis présence et empreinte de chaque pièce jointe. */
export async function verifyFullBackup(file: string, env: NodeJS.ProcessEnv = process.env): Promise<ReturnType<typeof verifyBackup> & { attachments: AttachmentCheck }> {
  const src = await readableBackup(file, env);
  try {
    const info = verifyBackup(src.path);
    return { ...info, attachments: await verifyAttachments(src.path, attachmentsBackupDir(file), identityFrom(env)) };
  } finally {
    src.cleanup();
  }
}

/**
 * Restauration complète (serveur arrêté) : pièces jointes d'abord, ajoutées au dossier vivant sans rien écraser, puis la base.
 * S'il manque des fichiers ou que certains sont altérés, la base n'est pas remplacée, sauf `allowMissing`.
 */
export async function restoreBackup(file: string, opts: { dataDir: string; env?: NodeJS.ProcessEnv; allowMissing?: boolean }): Promise<{ previous: string | null; attachments: AttachmentRestoreReport }> {
  const env = opts.env ?? process.env;
  const src = await readableBackup(file, env);
  try {
    verifyBackup(src.path);
    const attachments = await restoreAttachments({
      dbFile: src.path, from: attachmentsBackupDir(file), to: attachmentsDir(opts.dataDir), quarantine: quarantineDir(opts.dataDir), identity: identityFrom(env),
    });
    const bad = attachments.missing.length + attachments.corrupt.length;
    if (bad && !opts.allowMissing) {
      throw new Error(`Restauration interrompue, base actuelle conservée : ${attachments.missing.length} pièce(s) jointe(s) absente(s) et ${attachments.corrupt.length} altérée(s) dans la sauvegarde (${list([...attachments.missing, ...attachments.corrupt])}). Relancez avec --allow-missing pour restaurer quand même.`);
    }
    const { previous } = restoreFrom(src.path, resolve(opts.dataDir, 'notabene.db'));
    return { previous, attachments };
  } finally {
    src.cleanup();
  }
}

const list = (ids: string[]) => `${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, et ${ids.length - 10} autre(s)` : ''}`;

async function main(argv: string[]) {
  const [cmd, arg] = argv;
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const dbFile = resolve(dataDir, 'notabene.db');
  const keep = Number(process.env.BACKUP_KEEP ?? 14);

  if (cmd === 'keygen') {
    const k = await newBackupKeys();
    console.log(`Clé publique (à mettre dans BACKUP_AGE_RECIPIENT sur le serveur) :\n${k.recipient}\n\nClé privée (à garder HORS du serveur, par exemple dans un gestionnaire de secrets ; sans elle, les sauvegardes sont perdues) :\n${k.identity}`);
  } else if (cmd === 'backup') {
    const dir = resolve(arg ?? resolve(dataDir, 'backups'));
    const db = new Database(dbFile, { fileMustExist: true });
    try {
      const r = await createBackup(db, { dataDir, dir });
      const a = r.attachments;
      console.log(`Sauvegarde créée${r.encrypted ? ' (chiffrée)' : ''} : ${r.file} (${Math.round(statSync(r.file).size / 1024)} Ko, ${r.info.pages} pages, ${r.info.users} utilisateurs, ${a.files} pièce(s) jointe(s) : ${a.copied} copiée(s), ${a.reused} reprise(s) de la sauvegarde précédente)`);
      if (a.dropped.length) console.log(`Pièces jointes supprimées pendant la sauvegarde, retirées de la copie : ${a.dropped.length}`);
      if (a.missing.length || a.corrupt.length) {
        console.error(`ATTENTION : sauvegarde incomplète. Fichiers absents du disque : ${a.missing.length}${a.missing.length ? ` (${list(a.missing)})` : ''} ; altérés : ${a.corrupt.length}${a.corrupt.length ? ` (${list(a.corrupt)})` : ''}.`);
        process.exitCode = 3;
      }
      const removed = pruneBackups(dir, keep);
      if (removed.length) console.log(`Anciennes sauvegardes supprimées : ${removed.length} (conservées : ${keep})`);
    } finally {
      db.close();
    }
  } else if (cmd === 'verify' && arg) {
    const r = await verifyFullBackup(resolve(arg));
    const a = r.attachments;
    if (a.missing.length || a.corrupt.length) {
      console.error(`PROBLÈME : ${basename(arg)} : base saine (${r.pages} pages, schéma v${r.version}), mais ${a.missing.length} pièce(s) jointe(s) absente(s)${a.missing.length ? ` (${list(a.missing)})` : ''} et ${a.corrupt.length} altérée(s)${a.corrupt.length ? ` (${list(a.corrupt)})` : ''} sur ${a.files}.`);
      process.exitCode = 1;
    } else {
      console.log(`OK : ${basename(arg)} (${r.pages} pages, ${r.users} utilisateurs, schéma v${r.version}, ${a.files} pièce(s) jointe(s) vérifiée(s))`);
    }
  } else if (cmd === 'restore' && arg) {
    if (!argv.includes('--yes')) {
      console.error('La restauration remplace la base actuelle. Arrêtez le serveur puis relancez avec --yes.');
      process.exit(2);
    }
    const r = await restoreBackup(resolve(arg), { dataDir, allowMissing: argv.includes('--allow-missing') });
    const a = r.attachments;
    console.log(`Base restaurée depuis ${arg}.${r.previous ? ` Ancienne base conservée : ${r.previous}.` : ''}`);
    console.log(`Pièces jointes : ${a.restored} restaurée(s), ${a.kept} déjà en place${a.quarantined.length ? `, ${a.quarantined.length} différente(s) mise(s) en quarantaine (${quarantineDir(dataDir)})` : ''}${a.missing.length + a.corrupt.length ? `, ${a.missing.length + a.corrupt.length} manquante(s) ou altérée(s)` : ''}.`);
    console.log('Redémarrez le serveur. Les fichiers que la base restaurée ne connaît pas seront mis en quarantaine au démarrage.');
  } else {
    console.error('Usage : backup [dossier] | verify <fichier> | restore <fichier> --yes [--allow-missing] | keygen');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
