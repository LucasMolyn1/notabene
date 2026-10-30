// Bases à un schéma ancien : on applique les N premières migrations puis on rend la main, au lieu de défaire à la main
// les migrations récentes (qui casse à chaque nouvelle migration).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db.js';

/** Crée un fichier de base au schéma `version`, avec un espace, une page et un utilisateur ; renvoie son chemin. */
export function oldDb(version: number, extra?: (db: Database.Database) => void): string {
  const file = join(mkdtempSync(join(tmpdir(), 'nb-mig-')), `v${version}.db`);
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i]!);
  db.pragma(`user_version = ${version}`);
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s1', 'Espace', 0, 0)").run();
  db.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES ('u1', 'sub:u1', 'U', 'editor', 0)").run();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('p1', 's1', 'Page', '{}', '', 0, 0)").run();
  extra?.(db);
  db.close();
  return file;
}
