import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const base = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const parse = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { TRUST_PROXY: v }) }).TRUST_PROXY;

describe('TRUST_PROXY : lecture de la valeur', () => {
  it('accepte false, true, un nombre de sauts ou une liste de proxys', () => {
    expect(parse()).toBe(false);
    expect(parse('false')).toBe(false);
    expect(parse('0')).toBe(false);
    expect(parse('true')).toBe(true);
    expect(parse('1')).toBe(1);
    expect(parse('2')).toBe(2);
    expect(parse('10.0.0.5, 192.168.1.0/24')).toBe('10.0.0.5,192.168.1.0/24');
    expect(parse('fd00::/8')).toBe('fd00::/8');
  });

  it('refuse une valeur incohérente plutôt que de la deviner', () => {
    for (const bad of ['oui', '10.0.0.0/33', '10.0.0.5/8/2', 'a.b.c.d', '300.1.1.1', '2,3']) expect(() => parse(bad), bad).toThrow();
  });
});

describe('TRUST_PROXY : adresse retenue pour un client', () => {
  // Un client malveillant ajoute « 9.9.9.9 » à gauche ; le proxy de confiance ajoute l'adresse réelle (1.1.1.1) à droite.
  async function loggedIp(trust?: string) {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
      .run('u', 'local:a@example.com', 'a@example.com', 'A', 'editor', Date.now(), await hashPassword('Sup3r-secret-pass'));
    const app = await buildApp({ config: loadConfig({ ...base, ...(trust === undefined ? {} : { TRUST_PROXY: trust }) }), db, clientDir: '/nonexistent' });
    const res = await app.inject({
      method: 'POST', url: '/auth/local/login', remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, payload: { email: 'a@example.com', password: 'Sup3r-secret-pass' },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare("SELECT ip FROM audit_log WHERE action = 'auth.login'").get() as { ip: string };
    await app.close();
    db.close();
    return row.ip;
  }

  it('sans confiance, l\'adresse est celle de la connexion', async () => {
    expect(await loggedIp()).toBe('10.0.0.5');
  });

  it('avec un saut de confiance, on lit depuis la droite : la valeur du client est ignorée', async () => {
    expect(await loggedIp('1')).toBe('1.1.1.1');
  });

  it('avec deux sauts (HAProxy puis Cloudflare), le deuxième proxy est aussi de confiance', async () => {
    expect(await loggedIp('2')).toBe('9.9.9.9');
  });

  it('avec une liste de proxys, même résultat', async () => {
    expect(await loggedIp('10.0.0.0/8')).toBe('1.1.1.1');
  });

  it('avec true, l\'adresse falsifiée à gauche est retenue (c\'est pourquoi c\'est déconseillé)', async () => {
    expect(await loggedIp('true')).toBe('9.9.9.9');
  });
});

describe('OIDC_ISSUER', () => {
  it('conserve le « / » final, comparé littéralement à la découverte', () => {
    const cfg = loadConfig({ ...base, OIDC_ISSUER: 'https://auth.example.com/application/o/notabene/', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b' });
    expect(cfg.OIDC_ISSUER).toBe('https://auth.example.com/application/o/notabene/');
  });
});
