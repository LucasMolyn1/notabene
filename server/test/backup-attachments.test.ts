// Sauvegarde, vérification et restauration des pièces jointes (lot 10b).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupTo, createBackup, newBackupKeys, pruneBackups, restoreBackup, verifyFullBackup } from '../src/backup.js';
import { type DB, openDb } from '../src/db.js';
import { attachmentsBackupDir, backupAttachments, verifyAttachments } from '../src/lib/attachment-backup.js';
import { attachmentsDir, newAttachmentId, quarantineDir } from '../src/lib/attachments.js';
import { seedDemo } from '../src/seed.js';

let root: string;
let dataDir: string;
let backups: string;
let db: DB;
const env = { NODE_ENV: 'test' };

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'nb-bak-'));
  dataDir = join(root, 'data');
  backups = join(dataDir, 'backups');
  mkdirSync(dataDir);
  db = openDb(join(dataDir, 'notabene.db'));
  seedDemo(db);
});
afterEach(() => { try { db.close(); } catch { /* déjà fermée */ } rmSync(root, { recursive: true, force: true }); });

const page = () => (db.prepare("SELECT id FROM pages WHERE kind = 'doc' LIMIT 1").get() as { id: string }).id;
const files = () => attachmentsDir(dataDir);

// Pièce jointe vivante : ligne en base et fichier sur disque.
function attach(content: string): string {
  const id = newAttachmentId();
  const data = Buffer.from(content);
  mkdirSync(files(), { recursive: true, mode: 0o700 });
  writeFileSync(join(files(), id), data, { mode: 0o600 });
  db.prepare('INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
    .run(id, page(), `${content}.txt`, 'application/octet-stream', data.length, createHash('sha256').update(data).digest('hex'), Date.now());
  return id;
}
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

describe('sauvegarde des pièces jointes', () => {
  it('copie les fichiers référencés à côté de la base, en 0600, et les vérifie', async () => {
    const a = attach('alpha');
    const b = attach('beta');
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    expect(r.attachments).toMatchObject({ files: 2, copied: 2, reused: 0, missing: [], corrupt: [], dropped: [] });
    expect(r.attachmentsDir).toBe(attachmentsBackupDir(r.file));
    expect(readdirSync(r.attachmentsDir).sort()).toEqual([a, b, 'manifest.json'].sort());
    expect(readFileSync(join(r.attachmentsDir, a)).toString()).toBe('alpha');
    expect(statSync(join(r.attachmentsDir, a)).mode & 0o777).toBe(0o600);
    expect(statSync(r.attachmentsDir).mode & 0o777).toBe(0o700);
    // Aucun dossier de travail laissé.
    expect(readdirSync(backups).sort()).toEqual(['notabene-20260101-000000.attachments', 'notabene-20260101-000000.db']);
    expect((await verifyFullBackup(r.file, env)).attachments).toEqual({ files: 2, missing: [], corrupt: [] });
  });

  it('reprend par lien physique les fichiers de la sauvegarde précédente ; la rotation retire les dossiers', async () => {
    const a = attach('alpha');
    const first = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    const b = attach('beta');
    const second = await createBackup(db, { dataDir, dir: backups, env, now: at(1) });
    expect(second.attachments).toMatchObject({ files: 2, copied: 1, reused: 1 });
    expect(statSync(join(second.attachmentsDir, a)).ino).toBe(statSync(join(first.attachmentsDir, a)).ino);
    expect(existsSync(join(second.attachmentsDir, b))).toBe(true);

    // Restes d'une sauvegarde interrompue : dossier sans base, dossier de travail ancien (le récent est laissé).
    mkdirSync(join(backups, 'notabene-20250101-000000.attachments'));
    mkdirSync(join(backups, '.notabene-20250101-000000.partiel'));
    utimesSync(join(backups, '.notabene-20250101-000000.partiel'), new Date(0), new Date(0));
    mkdirSync(join(backups, '.notabene-20260101-000002.partiel'));
    expect(pruneBackups(backups, 1)).toEqual(['notabene-20260101-000000.db']);
    expect(readdirSync(backups).sort()).toEqual(['.notabene-20260101-000002.partiel', 'notabene-20260101-000001.attachments', 'notabene-20260101-000001.db']);
    // Le fichier repris survit à la suppression de la sauvegarde d'origine.
    expect(readFileSync(join(second.attachmentsDir, a)).toString()).toBe('alpha');
  });

  it('pièce jointe supprimée pendant la sauvegarde : retirée de la copie, qui reste cohérente ; fichier disparu : signalé', async () => {
    const gone = attach('supprimee');
    const lost = attach('perdue');
    const kept = attach('gardee');
    const snap = join(root, 'snap.db');
    await backupTo(db, snap);
    // Après la copie de la base : suppression normale (ligne et fichier), puis fichier effacé à la main (ligne restée).
    db.prepare('DELETE FROM attachments WHERE id = ?').run(gone);
    rmSync(join(files(), gone));
    rmSync(join(files(), lost));
    const r = await backupAttachments({ live: db, snapshot: snap, source: files(), dest: join(root, 'out') });
    expect(r).toMatchObject({ files: 2, copied: 1, dropped: [gone], missing: [lost], corrupt: [] });
    const copy = new Database(snap, { readonly: true });
    expect((copy.prepare('SELECT id FROM attachments ORDER BY id').all() as { id: string }[]).map((x) => x.id).sort()).toEqual([kept, lost].sort());
    copy.close();
  });

  it('fichier altéré sur le disque : non copié, signalé', async () => {
    const a = attach('original');
    writeFileSync(join(files(), a), 'modifie');
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    expect(r.attachments.corrupt).toEqual([a]);
    expect(existsSync(join(r.attachmentsDir, a))).toBe(false);
  });

  it('verify signale les fichiers absents ou altérés de la sauvegarde', async () => {
    const a = attach('alpha');
    const b = attach('beta');
    attach('gamma');
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    rmSync(join(r.attachmentsDir, a));
    writeFileSync(join(r.attachmentsDir, b), 'betA');
    const check = await verifyFullBackup(r.file, env);
    expect(check.attachments).toEqual({ files: 3, missing: [a], corrupt: [b] });
    // Dossier entier absent : tout manque.
    rmSync(r.attachmentsDir, { recursive: true });
    expect((await verifyFullBackup(r.file, env)).attachments.missing).toHaveLength(3);
  });
});

describe('sauvegarde chiffrée', () => {
  it('chiffre chaque fichier pour la même clé que la base ; vérifie et restaure avec la clé privée', async () => {
    const keys = await newBackupKeys();
    const keyFile = join(root, 'identity.txt');
    writeFileSync(keyFile, keys.identity);
    const a = attach('contenu confidentiel');
    const r = await createBackup(db, { dataDir, dir: backups, env: { ...env, BACKUP_AGE_RECIPIENT: keys.recipient }, now: at(0) });
    expect(r.file.endsWith('.db.age')).toBe(true);
    expect(readdirSync(r.attachmentsDir).sort()).toEqual([`${a}.age`, 'manifest.json']);
    expect(readFileSync(join(r.attachmentsDir, `${a}.age`)).includes(Buffer.from('confidentiel'))).toBe(false);

    await expect(verifyFullBackup(r.file, env)).rejects.toThrow(/BACKUP_AGE_IDENTITY_FILE/);
    const withKey = { ...env, BACKUP_AGE_IDENTITY_FILE: keyFile };
    expect((await verifyFullBackup(r.file, withKey)).attachments).toEqual({ files: 1, missing: [], corrupt: [] });
    // Mauvaise clé pour les fichiers : altérés (indéchiffrables).
    const otherFile = join(root, 'other.txt');
    writeFileSync(otherFile, (await newBackupKeys()).identity);
    const db2 = join(root, 'plain.db');
    await backupTo(db, db2);
    expect((await verifyAttachments(db2, r.attachmentsDir, readFileSync(otherFile, 'utf8'))).corrupt).toEqual([a]);

    // Clé changée : rien n'est repris de la sauvegarde précédente (fichiers chiffrés pour une autre clé).
    const next = await newBackupKeys();
    const second = await createBackup(db, { dataDir, dir: backups, env: { ...env, BACKUP_AGE_RECIPIENT: next.recipient }, now: at(1) });
    expect(second.attachments).toMatchObject({ copied: 1, reused: 0 });
    const third = await createBackup(db, { dataDir, dir: backups, env: { ...env, BACKUP_AGE_RECIPIENT: next.recipient }, now: at(2) });
    expect(third.attachments).toMatchObject({ copied: 0, reused: 1 });

    db.close();
    rmSync(files(), { recursive: true });
    const res = await restoreBackup(r.file, { dataDir, env: withKey });
    expect(res.attachments).toMatchObject({ restored: 1, missing: [], corrupt: [] });
    expect(readFileSync(join(files(), a)).toString()).toBe('contenu confidentiel');
    expect(statSync(join(files(), a)).mode & 0o777).toBe(0o600);
  });
});

describe('restauration des pièces jointes', () => {
  it('ajoute les fichiers sans rien écraser : identiques gardés, différents mis en quarantaine', async () => {
    const same = attach('identique');
    const damaged = attach('abime');
    const lost = attach('perdu');
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    const extra = attach('plus-recent');
    db.close();
    writeFileSync(join(files(), damaged), 'ABIME');
    rmSync(join(files(), lost));

    const res = await restoreBackup(r.file, { dataDir, env });
    expect(res.attachments).toMatchObject({ files: 3, kept: 1, restored: 2, quarantined: [damaged], missing: [], corrupt: [] });
    expect(res.previous && existsSync(res.previous)).toBe(true);
    expect(readFileSync(join(files(), same)).toString()).toBe('identique');
    expect(readFileSync(join(files(), damaged)).toString()).toBe('abime');
    expect(readFileSync(join(files(), lost)).toString()).toBe('perdu');
    // Le fichier remplacé est conservé en quarantaine ; le fichier inconnu de la base restaurée reste (quarantaine au démarrage).
    const q = readdirSync(quarantineDir(dataDir));
    expect(q).toHaveLength(1);
    expect(q[0]!.startsWith(`${damaged}.avant-restauration-`)).toBe(true);
    expect(readFileSync(join(quarantineDir(dataDir), q[0]!)).toString()).toBe('ABIME');
    expect(existsSync(join(files(), extra))).toBe(true);
    // Aucun temporaire laissé.
    expect(readdirSync(files()).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('sauvegarde incomplète : base actuelle conservée, sauf --allow-missing', async () => {
    const a = attach('alpha');
    attach('beta');
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    db.prepare("UPDATE pages SET title = 'modifiee depuis'").run();
    db.close();
    rmSync(join(r.attachmentsDir, a));
    rmSync(join(files(), a));

    await expect(restoreBackup(r.file, { dataDir, env })).rejects.toThrow(/base actuelle conservée.*1 pièce\(s\) jointe\(s\) absente\(s\)/);
    const live = new Database(join(dataDir, 'notabene.db'), { readonly: true });
    expect((live.prepare("SELECT COUNT(*) AS n FROM pages WHERE title = 'modifiee depuis'").get() as { n: number }).n).toBeGreaterThan(0);
    live.close();

    const res = await restoreBackup(r.file, { dataDir, env, allowMissing: true });
    expect(res.attachments.missing).toEqual([a]);
    const restored = new Database(join(dataDir, 'notabene.db'), { readonly: true });
    expect((restored.prepare("SELECT COUNT(*) AS n FROM pages WHERE title = 'modifiee depuis'").get() as { n: number }).n).toBe(0);
    restored.close();
  });

  it('sauvegarde antérieure aux pièces jointes (sans dossier) : restaurée normalement', async () => {
    const r = await createBackup(db, { dataDir, dir: backups, env, now: at(0) });
    rmSync(r.attachmentsDir, { recursive: true });
    db.close();
    const res = await restoreBackup(r.file, { dataDir, env });
    expect(res.attachments).toMatchObject({ files: 0, restored: 0 });
  });
});
