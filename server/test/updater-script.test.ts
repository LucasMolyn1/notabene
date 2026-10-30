// Exécute le vrai script de mise à jour de l'hôte contre de fausses commandes (docker, curl, logger) placées en tête du PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/updater/notabene-updater.sh');
const OLD = 'ghcr.io/lucasmolyn1/notabene:3.1.0@sha256:' + 'a'.repeat(64);
const DIGEST = 'sha256:' + 'b'.repeat(64);
let root: string;
let exchange: string;
let compose: string;
let bin: string;

const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nb-updater-'));
  exchange = join(root, 'exchange'); compose = join(root, 'compose'); bin = join(root, 'bin');
  for (const d of [exchange, compose, bin, join(root, 'state')]) mkdirSync(d);
  writeFileSync(join(compose, '.env'), `PUBLIC_URL=https://x\nNOTABENE_IMAGE=${OLD}\n`);
  writeFileSync(join(root, 'conf'), `COMPOSE_DIR=${compose}\nEXCHANGE_DIR=${exchange}\nSTATE_DIR=${join(root, 'state')}\nHEALTH_TIMEOUT=2\nHEALTH_URL=http://health.invalid/healthz\n`);
  // docker : « compose ps -q », « inspect » (version installée ou digest), « pull », « compose up », « compose exec » (sauvegarde).
  stub('docker', `
log="${root}/docker.log"; echo "$*" >> "$log"
case "$1 $2" in
  "compose ps") echo cid123 ;;
  "compose up") touch "${root}/upped" ;;
  "compose exec") [ -n "$STUB_BACKUP_FAIL" ] && exit 1; exit 0 ;;
  "pull ghcr.io/lucasmolyn1/notabene:"*) exit 0 ;;
  inspect*)
    case "$*" in
      *RepoDigests*) echo "ghcr.io/lucasmolyn1/notabene@${DIGEST}" ;;
      *) if [ -e "${root}/upped" ] && [ -z "$STUB_HEALTH_FAIL" ]; then echo "$STUB_LATEST"; else echo "\${STUB_CURRENT:-3.1.0}"; fi ;;
    esac ;;
esac`);
  stub('curl', `
case "$*" in
  *releases/latest*) [ -n "$STUB_GITHUB_DOWN" ] && exit 22; printf '{"tag_name":"v%s","prerelease":false}' "$STUB_LATEST" ;;
  *health.invalid*) [ -n "$STUB_HEALTH_FAIL" ] && [ ! -e "${root}/rolledback" ] && exit 7; exit 0 ;;
esac`);
  stub('logger', 'exit 0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (env: Record<string, string> = {}) => spawnSync('bash', [SCRIPT], {
  env: { PATH: `${bin}:${process.env.PATH}`, NOTABENE_UPDATER_CONF: join(root, 'conf'), STUB_LATEST: '3.2.0', ...env }, encoding: 'utf8',
});
const request = (body: string) => writeFileSync(join(exchange, 'request.json'), body);
const status = () => JSON.parse(readFileSync(join(exchange, 'status.json'), 'utf8')) as { state: string; version: string; message: string; heartbeat: number };
const envImage = () => /^NOTABENE_IMAGE=(.*)$/m.exec(readFileSync(join(compose, '.env'), 'utf8'))![1];

// Le script vise un hôte Linux (flock, mv -T, sed GNU) : ignoré ailleurs (macOS), exécuté dans la CI.
describe.skipIf(process.platform !== 'linux')('service de mise à jour de l’hôte', () => {
  it('sans demande : écrit seulement un signe de vie', () => {
    expect(run().status).toBe(0);
    expect(status()).toMatchObject({ state: 'idle' });
    expect(status().heartbeat).toBeGreaterThan(Date.now() / 1000 - 5);
    expect(envImage()).toBe(OLD);
  });

  it('met à jour vers la dernière release : sauvegarde, image épinglée par digest, statut « success », demande consommée', () => {
    request('{"version":"3.2.0","requestedBy":"a"}');
    expect(run().status).toBe(0);
    expect(status()).toMatchObject({ state: 'success', version: '3.2.0' });
    expect(envImage()).toBe(`ghcr.io/lucasmolyn1/notabene:3.2.0@${DIGEST}`);
    expect(existsSync(join(exchange, 'request.json'))).toBe(false);
    const log = readFileSync(join(root, 'docker.log'), 'utf8');
    expect(log).toContain('backup.js backup');
    expect(log.indexOf('backup.js backup')).toBeLessThan(log.indexOf('pull '));
  });

  it('refuse une version qui n’est pas la dernière release, sans rien toucher', () => {
    request('{"version":"3.1.5"}');
    run();
    expect(status()).toMatchObject({ state: 'failed' });
    expect(status().message).toContain('pas la dernière release');
    expect(envImage()).toBe(OLD);
    expect(existsSync(join(root, 'upped'))).toBe(false);
  });

  it('refuse une demande piégée : aucune commande injectée, rien n’est modifié', () => {
    for (const body of ['{"version":"3.2.0; touch /tmp/pwn"}', '{"version":"$(id)"}', '{"version":"../../etc"}', 'n’importe quoi', '']) {
      request(body);
      run();
      expect(status().state).toBe('failed');
      expect(envImage()).toBe(OLD);
    }
    expect(existsSync('/tmp/pwn')).toBe(false);
  });

  it('ignore un lien symbolique posé à la place de la demande, et ne suit pas celui de status.json', () => {
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'ne pas toucher');
    symlinkSync(secret, join(exchange, 'status.json'));
    symlinkSync(secret, join(exchange, 'request.json'));
    run();
    expect(readFileSync(secret, 'utf8')).toBe('ne pas toucher');
    expect(status().state).toBe('failed'); // status.json est devenu un vrai fichier
    expect(envImage()).toBe(OLD);
  });

  it('annule sans sauvegarde réussie (REQUIRE_BACKUP par défaut)', () => {
    request('{"version":"3.2.0"}');
    run({ STUB_BACKUP_FAIL: '1' });
    expect(status()).toMatchObject({ state: 'failed' });
    expect(status().message).toContain('Sauvegarde impossible');
    expect(envImage()).toBe(OLD);
    expect(readFileSync(join(root, 'docker.log'), 'utf8')).not.toContain('pull ');
  });

  it('annule si GitHub est injoignable', () => {
    request('{"version":"3.2.0"}');
    run({ STUB_GITHUB_DOWN: '1' });
    expect(status().message).toContain('GitHub injoignable');
    expect(envImage()).toBe(OLD);
  });

  it('refuse de « mettre à jour » vers la version déjà installée', () => {
    request('{"version":"3.2.0"}');
    run({ STUB_CURRENT: '3.2.0' });
    expect(status().message).toContain('Déjà à jour');
  });

  it('revient à l’ancienne image quand la nouvelle ne devient jamais saine', () => {
    request('{"version":"3.2.0"}');
    // La nouvelle version ne répond pas ; après le retour arrière (ancienne image rétablie dans .env) tout répond.
    stub('curl', `
case "$*" in
  *releases/latest*) printf '{"tag_name":"v3.2.0"}' ;;
  *health.invalid*) grep -q '3.1.0@' "${compose}/.env" && exit 0; exit 7 ;;
esac`);
    stub('docker', `
echo "$*" >> "${root}/docker.log"
case "$1 $2" in
  "compose ps") echo cid123 ;;
  "compose up") exit 0 ;;
  "compose exec") exit 0 ;;
  "pull ghcr.io/lucasmolyn1/notabene:"*) exit 0 ;;
  inspect*) case "$*" in *RepoDigests*) echo "ghcr.io/lucasmolyn1/notabene@${DIGEST}" ;; *) grep -q '3.1.0@' "${compose}/.env" && echo 3.1.0 || echo 3.2.0 ;; esac ;;
esac`);
    run();
    expect(status()).toMatchObject({ state: 'failed', version: '3.2.0' });
    expect(status().message).toContain('retour à la 3.1.0 effectué');
    expect(envImage()).toBe(OLD);
  });
});

it.skipIf(process.platform !== 'linux')('le script est valide pour bash', () => {
  expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
});
