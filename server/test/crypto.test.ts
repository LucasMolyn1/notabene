import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/crypto.js';

const box = () => new SecretBox(randomBytes(32).toString('base64'));

describe('SecretBox', () => {
  it('chiffre et déchiffre', () => {
    const b = box();
    expect(b.open(b.seal('secret', 'ctx'), 'ctx')).toBe('secret');
  });
  it('lie le chiffré à son usage (AAD)', () => {
    const b = box();
    expect(() => b.open(b.seal('secret', 'ctx-a'), 'ctx-b')).toThrow();
  });
  it('refuse un contenu ou une étiquette modifiés, ou tronquée', () => {
    const b = box();
    const [v, iv, tag, data] = b.seal('secret', 'ctx').split('.') as [string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => b.open([v, iv, tag, flip(data)].join('.'), 'ctx')).toThrow();
    expect(() => b.open([v, iv, flip(tag), data].join('.'), 'ctx')).toThrow();
    expect(() => b.open([v, iv, Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url'), data].join('.'), 'ctx')).toThrow(/invalide/);
  });
  it('refuse une autre clé', () => {
    expect(() => box().open(box().seal('x', 'c'), 'c')).toThrow();
  });
});
