// Moteur d'expressions régulières linéaire des formules : correction, refus, temps borné, équivalence avec RegExp.
import { describe, expect, it } from 'vitest';
import { compileRegex, MAX_PATTERN, MAX_STATES, RegexBudgetError, RegexError, regexExtract, regexReplace, regexSearch, regexTest } from '../src/lib/regex-linear.js';

const steps = () => ({ left: 10_000_000 });
const test = (p: string, s: string) => regexTest(compileRegex(p), s, steps());
const extract = (p: string, s: string) => regexExtract(compileRegex(p), s, steps());
const replace = (p: string, s: string, r: string) => regexReplace(compileRegex(p), s, r, steps());

describe('moteur linéaire : correction', () => {
  it('littéraux, point, classes, échappements, ancres, alternative, groupes, quantificateurs', () => {
    expect(test('abc', 'xxabcxx')).toBe(true);
    expect(test('abc', 'ab')).toBe(false);
    expect(test('a.c', 'abc')).toBe(true);
    expect(test('a.c', 'a\nc')).toBe(false);
    expect(test('[a-c]+$', 'zzabc')).toBe(true);
    expect(test('^[^0-9]+$', 'abc')).toBe(true);
    expect(test('^[^0-9]+$', 'ab1')).toBe(false);
  });

  it('extrait le premier match le plus à gauche, glouton', () => {
    expect(extract('\\d+', 'abc 123 456')).toBe('123');
    expect(extract('a*', 'baaa')).toBe('');
    expect(extract('(ab|a)c?', 'xabc')).toBe('abc');
    expect(extract('\\w+@\\w+\\.\\w+', 'écrire à jean@exemple.fr vite')).toBe('jean@exemple.fr');
    expect(extract('x', 'abc')).toBeNull();
    expect(extract('^$', '')).toBe('');
    expect(extract('\\s+', 'a \t b')).toBe(' \t ');
    expect(extract('[\\d-]+', 'tel 01-02-03')).toBe('01-02-03');
    expect(extract('\\.\\*\\(', 'a.*(b')).toBe('.*(');
  });

  it('remplace littéralement, sans $1 ni $&', () => {
    expect(replace('\\d', 'a1b22', '#')).toBe('a#b##');
    expect(replace('(a)', 'banana', '$1$&')).toBe('b$1$&n$1$&n$1$&');
    expect(replace('x*', 'abc', '-')).toBe('-a-b-c-');
    expect(replace('^', 'abc', '>')).toBe('>abc');
    expect(replace('$', 'abc', '<')).toBe('abc<');
  });

  it('refuse ce qui sort du sous-ensemble', () => {
    for (const bad of ['a{2}', 'a{2,3}', '(?=a)', '(?!a)', '(?<=a)b', '(?:a)', '(a)\\1', 'a*?', 'a+?', 'a**', '*a', '+', '?', '(a', 'a)', '[abc', '[]', '[z-a]', '\\', '\\b', '\\p{L}', '^*', '$+', '[\\d-z]', 'a}', '\\0'])
      expect(() => compileRegex(bad), bad).toThrow(RegexError);
    expect(() => compileRegex('a'.repeat(MAX_PATTERN + 1))).toThrow(RegexError);
    // Trop d'états : bien au-delà de MAX_STATES instructions.
    expect(() => compileRegex('a|'.repeat(50))).toThrow(/états/);
    expect(MAX_STATES).toBeGreaterThan(MAX_PATTERN);
    expect(() => compileRegex('a'.repeat(MAX_PATTERN))).not.toThrow();
  });
});

describe('moteur linéaire : temps borné', () => {
  it('motifs pathologiques pour un moteur à retour arrière : réponse immédiate', () => {
    const text = `${'a'.repeat(2000)}!`;
    const t0 = performance.now();
    for (const p of ['(a+)+b', '(a|a)*b', '(a*)*b', '(a|aa)+b', '^(a+)+b', '(.*a)*b', '(\\w+\\s?)+b', '([a-z]+)*=']) {
      expect(test(p, text), p).toBe(false);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('le travail est compté : budget épuisé = erreur dédiée, jamais une boucle', () => {
    const prog = compileRegex('(a|b|c|d)*z');
    expect(() => regexSearch(prog, 'abcd'.repeat(500), 0, { left: 1000 })).toThrow(RegexBudgetError);
    // Le remplacement d'un motif qui ne progresse pas reste borné par le compteur.
    expect(() => regexReplace(compileRegex('(a.*z|a)'), 'a'.repeat(2000), '-', { left: 100_000 })).toThrow(RegexBudgetError);
  });
});

describe('moteur linéaire : équivalence avec RegExp sur le sous-ensemble', () => {
  const cases: [string, string[]][] = [
    ['ab*c', ['ac', 'abbbc', 'xabcx', 'ab']],
    ['(ab|cd)+', ['ababcd', 'xcdab', 'a']],
    ['^\\d+(\\.\\d+)?$', ['12', '12.5', '12.', '.5', 'a1']],
    ['[A-Z][a-z]*', ['bonjour Paul', 'ABC', 'x']],
    ['colou?r', ['color', 'colour', 'colouur']],
    ['\\W+', ['a, b; c', 'abc']],
    ['\\S+$', ['fin de ligne ', 'fin']],
    ['(a|ab)(c|bcd)', ['abcd', 'abc']],
    ['a?a?a?aaa', ['aaa', 'aaaa', 'aa']],
    ['[^aeiou ]+', ['bonjour le monde']],
    ['x*y*', ['', 'xxyy', 'yx']],
    ['(a*)b', ['aaab', 'b', 'aaa']],
    ['.+@.+', ['a@b', '@', 'a@']],
  ];
  it('mêmes positions de match que RegExp (sans drapeau)', () => {
    for (const [p, texts] of cases) {
      const prog = compileRegex(p);
      for (const s of texts) {
        const m = new RegExp(p).exec(s);
        const got = regexSearch(prog, s, 0, steps());
        expect(got, `${p} sur ${JSON.stringify(s)}`).toEqual(m ? { start: m.index, end: m.index + m[0].length } : null);
        expect(regexReplace(prog, s, '#', steps()), `${p} remplacé dans ${JSON.stringify(s)}`).toBe(s.replace(new RegExp(p, 'g'), () => '#'));
      }
    }
  });

  it('fuzz léger : motifs et textes aléatoires du sous-ensemble', () => {
    // Générateur déterministe (pas de Math.random : reproductible).
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const atoms = ['a', 'b', '.', '[ab]', '[^a]', '\\d', '\\w', '(a|b)', '(ab)', '1'];
    const quants = ['', '', '*', '+', '?'];
    for (let k = 0; k < 400; k++) {
      let p = rnd(4) === 0 ? '^' : '';
      const len = 1 + rnd(4);
      for (let i = 0; i < len; i++) p += atoms[rnd(atoms.length)]! + quants[rnd(quants.length)]!;
      if (rnd(3) === 0) p += `|${atoms[rnd(atoms.length)]!}`;
      if (rnd(4) === 0) p += '$';
      let s = '';
      const slen = rnd(8);
      for (let i = 0; i < slen; i++) s += 'ab1 '[rnd(4)]!;
      const m = new RegExp(p).exec(s);
      const got = regexSearch(compileRegex(p), s, 0, steps());
      expect(got, `${p} sur ${JSON.stringify(s)}`).toEqual(m ? { start: m.index, end: m.index + m[0].length } : null);
    }
  });
});
