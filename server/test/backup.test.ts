import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { assertBackupAllowed, backupTo, decryptFile, encryptFile, newBackupKeys, pruneBackups, readableBackup, restoreFrom, verifyBackup } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'nb-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sauvegarde et restauration', () => {
  it('sauvegarde, vérifie puis restaure une base', async () => {
    const dbFile = resolve(dir, 'notabene.db');
    const db = openDb(dbFile);
    seedDemo(db);
    const pages = (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
    const backup = resolve(dir, 'b', 'notabene-20260101-000000.db');
    await backupTo(db, backup);
    expect(verifyBackup(backup).pages).toBe(pages);
    // Une sauvegarde reste un fichier unique, même après vérification.
    expect(existsSync(`${backup}-wal`)).toBe(false);
    expect(existsSync(`${backup}-shm`)).toBe(false);

    db.prepare('DELETE FROM pages').run();
    db.close();
    const { previous } = restoreFrom(backup, dbFile);
    expect(previous && existsSync(previous)).toBe(true);
    const restored = new Database(dbFile, { readonly: true });
    expect((restored.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n).toBe(pages);
    restored.close();
  });

  it('refuse un fichier qui n’est pas une base Notabene saine', () => {
    const bad = resolve(dir, 'bad.db');
    writeFileSync(bad, 'pas une base');
    expect(() => verifyBackup(bad)).toThrow();
    const other = new Database(resolve(dir, 'other.db'));
    other.exec('CREATE TABLE x (a)');
    other.close();
    expect(() => verifyBackup(resolve(dir, 'other.db'))).toThrow(/table manquante/);
    expect(() => restoreFrom(bad, resolve(dir, 'target.db'))).toThrow();
    expect(existsSync(resolve(dir, 'target.db'))).toBe(false);
  });

  it('ne conserve que les sauvegardes les plus récentes', () => {
    for (const d of ['20260101-000000', '20260102-000000', '20260103-000000']) writeFileSync(resolve(dir, `notabene-${d}.db`), 'x');
    writeFileSync(resolve(dir, 'autre.txt'), 'x');
    expect(pruneBackups(dir, 2)).toEqual(['notabene-20260101-000000.db']);
    expect(readdirSync(dir).sort()).toEqual(['autre.txt', 'notabene-20260102-000000.db', 'notabene-20260103-000000.db']);
  });
});

describe('route de téléchargement', () => {
  it('est réservée aux administrateurs connectés par session', async () => {
    const db = openDb(':memory:');
    seedDemo(db);
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test',  PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' }), db, clientDir: '/nonexistent' });
    const sess = async (role: string) => {
      const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
      return { nb_session: r.cookies.find((c) => c.name === 'nb_session')!.value };
    };
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/backup' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/backup', cookies: await sess('editor') })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/v3/admin/backup', cookies: await sess('admin') });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toMatch(/notabene-\d{8}-\d{6}\.db/);
    expect(ok.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
    await app.close();
    db.close();
  });

  describe('chiffrement age', () => {
    it('chiffre une sauvegarde, la vérifie et la restaure avec la clé privée', async () => {
      const dbFile = resolve(dir, 'notabene.db');
      const db = openDb(dbFile);
      seedDemo(db);
      const pages = (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
      const plain = resolve(dir, 'b', 'notabene-20260101-000000.db');
      await backupTo(db, plain);
      const keys = await newBackupKeys();
      const enc = await encryptFile(plain, keys.recipient);
      expect(enc).toBe(`${plain}.age`);
      expect(existsSync(plain)).toBe(false); // jamais de clair à côté
      expect(readFileSync(enc).subarray(0, 15).toString('latin1')).not.toContain('SQLite format');
      expect(readFileSync(enc).includes(Buffer.from('Bienvenue sur Notabene'))).toBe(false);

      const keyFile = resolve(dir, 'identity.txt');
      writeFileSync(keyFile, keys.identity);
      const src = await readableBackup(enc, { BACKUP_AGE_IDENTITY_FILE: keyFile });
      expect(verifyBackup(src.path).pages).toBe(pages);
      src.cleanup();
      expect(existsSync(src.path)).toBe(false);

      // Mauvaise clé : échec net, rien ne reste.
      const other = resolve(dir, 'other.txt');
      writeFileSync(other, (await newBackupKeys()).identity);
      await expect(readableBackup(enc, { BACKUP_AGE_IDENTITY_FILE: other })).rejects.toThrow(/Déchiffrement impossible/);
      await expect(readableBackup(enc, {})).rejects.toThrow(/BACKUP_AGE_IDENTITY_FILE/);
      await expect(decryptFile(enc, (await newBackupKeys()).identity, resolve(dir, 'x.db'))).rejects.toThrow();
      db.close();
    });

    it('la rotation traite aussi les fichiers chiffrés', () => {
      const d = resolve(dir, 'rot');
      mkdirSync(d);
      for (const n of ['20260101-000000.db.age', '20260102-000000.db.age', '20260103-000000.db']) writeFileSync(resolve(d, `notabene-${n}`), 'x');
      expect(pruneBackups(d, 2)).toEqual(['notabene-20260101-000000.db.age']);
    });

    it('refuse une sauvegarde en clair en production sans choix explicite', () => {
      expect(() => assertBackupAllowed({ NODE_ENV: 'production' })).toThrow(/chiffrée/);
      expect(() => assertBackupAllowed({ NODE_ENV: 'production', BACKUP_AGE_RECIPIENT: 'age1x' })).not.toThrow();
      expect(() => assertBackupAllowed({ NODE_ENV: 'production', BACKUP_ALLOW_PLAINTEXT: 'true' })).not.toThrow();
      expect(() => assertBackupAllowed({ NODE_ENV: 'development' })).not.toThrow();
    });
  });
});
