// Exécute le vrai script d'installation du service de mise à jour contre de fausses commandes (docker, systemctl)
// et des dossiers temporaires : rien n'est installé sur la machine qui lance les tests.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/install-updater.sh');
let root: string;
let repo: string;
let bin: string;

const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nb-install-'));
  repo = join(root, 'repo'); bin = join(root, 'bin');
  for (const d of [repo, bin, join(root, 'sbin'), join(root, 'etc'), join(root, 'systemd')]) mkdirSync(d);
  writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  notabene:\n    volumes:\n      - notabene-data:/data\n');
  writeFileSync(join(repo, '.env'), 'PUBLIC_URL=https://x\n');
  stub('docker', `echo "$*" >> "${root}/docker.log"`);
  stub('systemctl', `echo "$*" >> "${root}/systemctl.log"`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], {
  env: {
    PATH: `${bin}:${process.env.PATH}`, NOTABENE_INSTALL_TEST: '1', COMPOSE_DIR: repo, EXCHANGE_DIR: join(root, 'exchange'),
    EXCHANGE_GID: String(process.getgid?.() ?? 0), SBIN_DIR: join(root, 'sbin'), ETC_DIR: join(root, 'etc'), SYSTEMD_DIR: join(root, 'systemd'),
  },
  encoding: 'utf8',
});
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('installation du service de mise à jour', () => {
  it('installe le service, le dossier d’échange, le volume et le .env sans toucher à docker-compose.yml', () => {
    const before = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(join(repo, 'docker-compose.yml'), 'utf8')).toBe(before);
    expect(readFileSync(join(repo, 'docker-compose.updater.yml'), 'utf8')).toContain(`${join(root, 'exchange')}:/updater`);
    const env = readFileSync(join(repo, '.env'), 'utf8');
    expect(env).toContain('COMPOSE_FILE=docker-compose.yml:docker-compose.updater.yml');
    expect(env).toContain('UPDATER_DIR=/updater');
    expect(env).not.toContain('UPDATE_CHECK');
    expect(statSync(join(root, 'exchange')).mode & 0o777).toBe(0o770);
    expect(statSync(join(root, 'etc', 'notabene-updater.conf')).mode & 0o777).toBe(0o600);
    expect(read('etc', 'notabene-updater.conf')).toContain(`COMPOSE_DIR=${repo}`);
    expect(read('etc', 'notabene-updater.conf')).toContain('REQUIRE_BACKUP=true');
    expect(existsSync(join(root, 'sbin', 'notabene-updater.sh'))).toBe(true);
    expect(read('systemctl.log')).toContain('enable --now notabene-updater.timer');
    expect(read('docker.log')).toContain('compose up -d');
    // Sans clé de sauvegarde, l'utilisateur est prévenu au lieu de découvrir l'échec au premier clic.
    expect(r.stdout).toContain('BACKUP_AGE_RECIPIENT');
  });

  it('est relançable : rien n’est dupliqué et la configuration de l’administrateur est conservée', () => {
    run();
    writeFileSync(join(root, 'etc', 'notabene-updater.conf'), 'COMPOSE_DIR=/autre\nEXCHANGE_DIR=/x\nHEALTH_TIMEOUT=300\n');
    const r = run();
    expect(r.status).toBe(0);
    const env = readFileSync(join(repo, '.env'), 'utf8');
    expect(env.match(/^COMPOSE_FILE=/gm)).toHaveLength(1);
    expect(env.match(/^UPDATER_DIR=/gm)).toHaveLength(1);
    expect(read('etc', 'notabene-updater.conf')).toContain('HEALTH_TIMEOUT=300');
    expect(r.stdout).toContain('Configuration existante conservée');
  });

  it('ajoute le fichier à un COMPOSE_FILE existant et n’active la vérification que si on le demande', () => {
    writeFileSync(join(repo, '.env'), 'COMPOSE_FILE=docker-compose.yml:perso.yml\n');
    expect(run('--sans-demarrage').status).toBe(0);
    let env = readFileSync(join(repo, '.env'), 'utf8');
    expect(env).toContain('COMPOSE_FILE=docker-compose.yml:perso.yml:docker-compose.updater.yml');
    expect(env).not.toContain('UPDATE_CHECK');
    expect(existsSync(join(root, 'docker.log'))).toBe(false);
    run('--activer-verification');
    env = readFileSync(join(repo, '.env'), 'utf8');
    expect(env).toContain('UPDATE_CHECK=true');
  });

  it('--sans-sauvegarde est réservé à la demande explicite', () => {
    run('--sans-sauvegarde');
    expect(read('etc', 'notabene-updater.conf')).toContain('REQUIRE_BACKUP=false');
  });

  it('ne double pas un volume /updater déjà ajouté à la main', () => {
    writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  notabene:\n    volumes:\n      - /srv/x:/updater\n');
    expect(run().status).toBe(0);
    expect(existsSync(join(repo, 'docker-compose.updater.yml'))).toBe(false);
    expect(readFileSync(join(repo, '.env'), 'utf8')).not.toContain('COMPOSE_FILE');
  });

  it('refuse sans .env, sans droits root et avec une option inconnue', () => {
    rmSync(join(repo, '.env'));
    expect(run().status).not.toBe(0);
    writeFileSync(join(repo, '.env'), 'X=1\n');
    expect(run('--nimporte').status).toBe(2);
    const noTestFlag = spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH ?? '', COMPOSE_DIR: repo }, encoding: 'utf8' });
    if (process.getuid?.() !== 0) expect(noTestFlag.status).toBe(1);
  });
});
