// Administration en ligne de commande, à lancer sur la machine qui héberge la base :
//   node dist/server/cli.js create-admin <email> [--name "Nom"] [--reset]
//   node dist/server/cli.js migrate-images [--dry-run] [--revert <exécution>] [--status]
// Le mot de passe est saisi sans écho (ou lu sur l'entrée standard / NOTABENE_ADMIN_PASSWORD, pour l'automatisation).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { attachmentsDir } from './lib/attachments.js';
import { audit } from './lib/audit.js';
import { dryRun, type MigrationLimits, migrationStatus, recentlyCoEdited, REASON_LABELS, startConversion, startRevert, type SkipReason } from './lib/image-migration.js';
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

// Plafonds des pièces jointes : mêmes variables et mêmes valeurs par défaut que le serveur (config.ts).
const MB = 1024 * 1024;
export function migrationLimits(env: NodeJS.ProcessEnv): MigrationLimits {
  const n = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
  const c = z.object({ ATTACHMENT_MAX_MB: n(1024, 25), ATTACHMENTS_TOTAL_MB: n(10_485_760, 5120), ATTACHMENT_USER_MB: n(10_485_760, 1024) }).parse(env);
  return { fileBytes: c.ATTACHMENT_MAX_MB * MB, totalBytes: c.ATTACHMENTS_TOTAL_MB * MB, userBytes: c.ATTACHMENT_USER_MB * MB };
}

const describe = (reasons: Partial<Record<SkipReason, number>>) =>
  Object.entries(reasons).map(([k, n]) => `  ${n} : ${REASON_LABELS[k as SkipReason]}`).join('\n');

/**
 * Conversion des images base64 en pièces jointes (voir lib/image-migration.ts). `--dry-run` : estimation, rien n'est écrit ;
 * `--revert <exécution>` : défait une conversion ; `--status` : dernières exécutions. Une page récemment co-éditée (moins de
 * dix minutes) est ignorée : la commande ne voit pas les salles du serveur en cours.
 */
export async function migrateImages(db: DB, args: string[], opts: { dataDir: string; limits: MigrationLimits; log?: (line: string) => void }): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const ctx = {
    db, filesDir: attachmentsDir(opts.dataDir), limits: opts.limits, busy: recentlyCoEdited(db), source: 'cli' as const, startedBy: null,
    yieldBetweenBatches: () => new Promise<void>((done) => setImmediate(done)),
  };
  if (args.includes('--status')) {
    const s = migrationStatus(db);
    log(`Pages contenant encore des images base64 : ${s.pendingPages}`);
    for (const r of s.runs) log(`${r.id}  ${r.kind}  ${r.status}  ${new Date(r.startedAt).toISOString()}  pages ${r.stats.converted + r.stats.reverted}, ignorées ${r.stats.skipped}, images ${r.stats.images}${r.reverts ? `  (défait ${r.reverts})` : ''}`);
    return 0;
  }
  if (args.includes('--dry-run')) {
    const r = dryRun(ctx);
    log(`Estimation (rien n'est modifié) : ${r.pages} page(s), ${r.images} image(s), ${(r.bytes / MB).toFixed(1)} Mo à convertir.`);
    if (Object.keys(r.reasons).length) log(`Laissées en place ou ignorées :\n${describe(r.reasons)}`);
    for (const p of r.skipped) log(`  - ${p.pageId}  ${p.title || 'Sans titre'}  (${p.reasons.join(', ')})`);
    return 0;
  }
  const at = args.indexOf('--revert');
  const revertOf = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!revertOf || !/^[A-Za-z0-9_-]{1,64}$/.test(revertOf))) throw new Error('Usage : migrate-images --revert <identifiant de l’exécution> (voir --status)');
  const started = revertOf ? startRevert(ctx, revertOf) : startConversion(ctx);
  audit(db, null, revertOf ? 'cli.images.migration.revert' : 'cli.images.migration.start', started.id, revertOf ? { reverts: revertOf } : undefined);
  log(`Exécution ${started.id} : ${revertOf ? `retour arrière de ${revertOf}` : 'conversion'} en cours…`);
  const stats = await started.run();
  audit(db, null, 'cli.images.migration.end', started.id, { ...stats });
  log(revertOf
    ? `Terminé : ${stats.reverted} page(s) rétablie(s), ${stats.images} image(s).`
    : `Terminé : ${stats.converted} page(s) convertie(s), ${stats.images} image(s), ${(stats.bytes / MB).toFixed(1)} Mo.`);
  if (stats.skipped || Object.keys(stats.reasons).length) log(`Ignorées ou laissées en place (détail : --status puis l'API d'administration) :\n${describe(stats.reasons)}`);
  if (!revertOf) log(`Pour défaire : migrate-images --revert ${started.id}`);
  return 0;
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
  if (cmd === 'migrate-images') {
    const dataDir = resolve(process.env.DATA_DIR ?? './data');
    const db = openDb(resolve(dataDir, 'notabene.db'));
    try { process.exitCode = await migrateImages(db, argv.slice(1), { dataDir, limits: migrationLimits(process.env) }); } finally { db.close(); }
    return;
  }
  if (cmd !== 'create-admin' || !email) {
    console.error('Usage : create-admin <email> [--name "Nom"] [--reset]\n        migrate-images [--dry-run] [--revert <exécution>] [--status]\nMot de passe : saisi sans écho, ou lu sur stdin, ou variable NOTABENE_ADMIN_PASSWORD.');
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
