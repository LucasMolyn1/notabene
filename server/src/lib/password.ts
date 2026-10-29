// Mots de passe : scrypt (mémoire-dur, natif Node), sel aléatoire, comparaison en temps constant.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hash factice : vérifié quand le compte n'existe pas, pour ne pas révéler son existence par le temps de réponse.
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString('hex')));

export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 12) return 'Le mot de passe doit faire au moins 12 caractères';
  if (password.length > 128) return 'Le mot de passe ne doit pas dépasser 128 caractères';
  if (new Set(password).size < 5) return 'Le mot de passe est trop répétitif';
  if (email && password.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length >= 4) return 'Le mot de passe ne doit pas contenir votre identifiant';
  return null;
}
