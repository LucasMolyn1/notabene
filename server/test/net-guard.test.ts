import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { guardedLookup, isBlockedAddress, safeFetch } from '../src/lib/net-guard.js';

describe('adresses refusées', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '100::1',
    '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '[::1]', 'pas-une-ip',
  ])('refuse %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('accepte %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false));
});

describe('résolution gardée (rebinding DNS)', () => {
  const resolverOf = (...answers: string[][]) => {
    let i = 0;
    return (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => {
      const addrs = answers[Math.min(i++, answers.length - 1)]!;
      cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    };
  };
  const run = (lookup: ReturnType<typeof guardedLookup>, all = false) =>
    new Promise<{ err: Error | null; address?: unknown }>((resolve) => lookup('x.example.org', { all }, (err, address) => resolve({ err, address })));

  it('contrôle l’adresse utilisée à CHAQUE connexion', async () => {
    // Première réponse publique, seconde interne : chaque connexion est vérifiée séparément.
    const lookup = guardedLookup(resolverOf(['93.184.216.34'], ['127.0.0.1']) as never);
    expect((await run(lookup)).address).toBe('93.184.216.34');
    expect((await run(lookup)).err?.message).toMatch(/interne/);
  });

  it('refuse si une seule des adresses est interne', async () => {
    const lookup = guardedLookup(resolverOf(['93.184.216.34', '10.0.0.5']) as never);
    expect((await run(lookup, true)).err).toBeTruthy();
  });

  it('transmet les erreurs de résolution', async () => {
    const lookup = guardedLookup(((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('ENOTFOUND'))) as never);
    expect((await run(lookup)).err?.message).toBe('ENOTFOUND');
  });
});

describe('safeFetch', () => {
  it('ne se connecte jamais à une adresse interne, même via un nom', async () => {
    let hit = false;
    const server = createServer((_q, r) => { hit = true; r.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // « localhost » se résout en 127.0.0.1 : bloqué par le lookup de l'agent.
      await expect(safeFetch(new URL(`http://localhost:${port}/`), {}, false)).rejects.toThrow();
      expect(hit).toBe(false);
      // Avec WEBHOOK_ALLOW_PRIVATE, la connexion passe.
      const res = await safeFetch(new URL(`http://localhost:${port}/`), {}, true);
      expect(res.status).toBe(200);
      expect(hit).toBe(true);
    } finally {
      server.close();
    }
  });
});
