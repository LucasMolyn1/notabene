import { describe, expect, it } from 'vitest';
import { assertSafeUrl, sign } from '../src/lib/webhooks.js';

describe('webhooks', () => {
  it('signe de façon déterministe avec le secret et l’horodatage', () => {
    expect(sign('s', '1', '{}')).toBe(sign('s', '1', '{}'));
    expect(sign('s', '1', '{}')).not.toBe(sign('s', '2', '{}'));
    expect(sign('s', '1', '{}')).not.toBe(sign('t', '1', '{}'));
  });

  it('refuse http, identifiants et adresses internes', async () => {
    await expect(assertSafeUrl('http://example.com/h', false)).rejects.toThrow();
    await expect(assertSafeUrl('https://user:pw@example.com/h', false)).rejects.toThrow();
    await expect(assertSafeUrl('https://127.0.0.1/h', false)).rejects.toThrow('interne');
    await expect(assertSafeUrl('https://192.168.1.10/h', false)).rejects.toThrow('interne');
    await expect(assertSafeUrl('https://[::1]/h', false)).rejects.toThrow('interne');
    await expect(assertSafeUrl('https://[::ffff:10.0.0.1]/h', false)).rejects.toThrow('interne');
  });

  it('autorise les adresses privées en http si configuré', async () => {
    await expect(assertSafeUrl('http://192.168.1.10/h', true)).resolves.toBeInstanceOf(URL);
  });
});
