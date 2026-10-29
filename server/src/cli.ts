// Administration en ligne de commande, à lancer sur la machine qui héberge la base :
//   node dist/server/cli.js create-admin <email> [--name "Nom"] [--reset]
// Le mot de passe est saisi sans écho (ou lu sur l'entrée standard / NOTABENE_ADMIN_PASSWORD, pour l'automatisation).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit } from './lib/audit.js';
import { newId } from './lib/http.js';
import { hashPassword, passwordProblem } from './lib/password.js';
import { openDb, type DB } from './db.js';

export interface AdminResult { id: string; created: boolean }

// Crée un administrateur local, ou (reset) réinitialise un compte local existant :
// nouveau mot de passe, rôle admin, déverrouillage, MFA retirée, sessions fermées.
export async function createAdmin(db: DB, opts: { email: string; name?: string; password: string; reset?: boolean }): Promise<AdminResult> {
  const email = opts.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Adresse e-mail invalide');
  const problem = passwordProblem(opts.password, email);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(opts.password);
  const existing = db.prepare('SELECT id, password_hash FROM users WHERE sub = ?').get(`local:${email}`) as { id: string; password_hash: string | null } | undefined;
  if (existing) {
    if (!opts.reset) throw new Error('Ce compte existe déjà : ajoutez --reset pour réinitialiser son mot de passe');
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, role = 'admin', disabled = 0, failed_logins = 0, locked_until = NULL, totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?")
        .run(hash, existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      audit(db, null, 'cli.admin.reset', existing.id);
    })();
    return { id: existing.id, created: false };
  }
  const id = newId();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, `local:${email}`, email, (opts.name ?? email.split('@')[0]!).slice(0, 120), 'admin', Date.now(), hash);
    audit(db, null, 'cli.admin.create', id);
  })();
  return { id, created: true };
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  return new Promise((done) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          return done(value);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(argv: string[]) {
  const [cmd, email, ...rest] = argv;
  if (cmd !== 'create-admin' || !email) {
    console.error('Usage : create-admin <email> [--name "Nom"] [--reset]\nMot de passe : saisi sans écho, ou lu sur stdin, ou variable NOTABENE_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const nameAt = rest.indexOf('--name');
  const name = nameAt >= 0 ? rest[nameAt + 1] : undefined;
  const db = openDb(resolve(resolve(process.env.DATA_DIR ?? './data'), 'notabene.db'));
  try {
    let password = process.env.NOTABENE_ADMIN_PASSWORD;
    if (!password) {
      password = await readSecret('Mot de passe (12 caractères minimum) : ');
      if (process.stdin.isTTY && (await readSecret('Confirmez le mot de passe : ')) !== password) throw new Error('Les mots de passe ne correspondent pas');
    }
    const r = await createAdmin(db, { email, name, password, reset: rest.includes('--reset') });
    console.log(r.created ? `Administrateur créé : ${email}` : `Compte réinitialisé : ${email} (MFA retirée, sessions fermées)`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
