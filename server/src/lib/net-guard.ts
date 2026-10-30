// Protection SSRF des requêtes sortantes : l'adresse contrôlée est celle à laquelle on se connecte.
// Le nom est résolu UNE fois, au moment de la connexion (lookup de l'agent) ; une seconde résolution qui
// renverrait une autre adresse (rebinding DNS) n'existe donc pas.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch, type RequestInit } from 'undici';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], // NAT64 : l'adresse IPv4 incluse peut être interne
  ['2002::', 16], // 6to4 : idem
] as const) blocked.addSubnet(net, bits, 'ipv6');

// Adresse interne, réservée ou de diffusion : refusée. Gère les IPv4 écrites en IPv6 (::ffff:a.b.c.d et forme hexadécimale).
export function isBlockedAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const kind = isIP(v);
  if (kind === 0) return true; // pas une adresse : on refuse par prudence
  if (kind === 4) return blocked.check(v, 'ipv4');
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v);
  if (mapped) {
    if (mapped[1]) return isBlockedAddress(mapped[1]);
    const hi = parseInt(mapped[2]!, 16);
    const lo = parseInt(mapped[3]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(v, 'ipv6');
}

type Resolver = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

// Fonction `lookup` de l'agent : refuse si UNE des adresses du nom est interne, sinon renvoie les adresses vérifiées.
export function guardedLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return (hostname: string, options: { all?: boolean }, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) return cb(new Error('Adresse interne refusée'));
      return options?.all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup() as never } });
const openAgent = new Agent();

// fetch sortant : sans `allowPrivate`, toute connexion vers une adresse interne échoue, quel que soit le nom utilisé.
export const safeFetch = (url: URL, init: RequestInit, allowPrivate: boolean) =>
  fetch(url, { ...init, dispatcher: allowPrivate ? openAgent : guardedAgent });

// Même garde, sous la forme d'une fonction `fetch` à confier à un SDK (option `fetch` du client Anthropic).
export const guardedFetch = (allowPrivate: boolean) => ((input: unknown, init?: unknown) =>
  fetch(input as never, { ...(init as object), dispatcher: allowPrivate ? openAgent : guardedAgent } as never)) as unknown as typeof globalThis.fetch;
