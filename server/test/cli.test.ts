import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/cli.js';
import { openDb, type DB } from '../src/db.js';
import { verifyPassword } from '../src/lib/password.js';

let dir: string;
let db: DB;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'nb-cli-')); db = openDb(resolve(dir, 'n.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('create-admin', () => {
  it('crée un administrateur local avec un mot de passe haché', async () => {
    const r = await createAdmin(db, { email: 'Admin@Example.com', name: 'Chef', password: 'un-mot-de-passe-solide' });
    expect(r.created).toBe(true);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.id) as { role: string; sub: string; password_hash: string };
    expect(u.role).toBe('admin');
    expect(u.sub).toBe('local:admin@example.com');
    expect(u.password_hash).not.toContain('un-mot-de-passe');
    expect(await verifyPassword('un-mot-de-passe-solide', u.password_hash)).toBe(true);
  });

  it('refuse un mot de passe faible, un doublon sans --reset', async () => {
    await expect(createAdmin(db, { email: 'a@example.com', password: 'court' })).rejects.toThrow(/12 caractères/);
    await createAdmin(db, { email: 'a@example.com', password: 'un-mot-de-passe-solide' });
    await expect(createAdmin(db, { email: 'a@example.com', password: 'un-autre-mot-de-passe' })).rejects.toThrow(/--reset/);
  });

  it('--reset change le mot de passe, retire la MFA, déverrouille et ferme les sessions', async () => {
    const r = await createAdmin(db, { email: 'a@example.com', password: 'un-mot-de-passe-solide' });
    db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'x', locked_until = ?, role = 'reader' WHERE id = ?").run(Date.now() + 1e6, r.id);
    db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run('h', r.id, 'c', 1, Date.now() + 1e6, 1);
    const again = await createAdmin(db, { email: 'a@example.com', password: 'nouveau-mot-de-passe-1', reset: true });
    expect(again).toEqual({ id: r.id, created: false });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.id) as { role: string; totp_enabled: number; locked_until: number | null; password_hash: string };
    expect([u.role, u.totp_enabled, u.locked_until]).toEqual(['admin', 0, null]);
    expect(await verifyPassword('nouveau-mot-de-passe-1', u.password_hash)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(r.id)).toEqual({ n: 0 });
  });
});
