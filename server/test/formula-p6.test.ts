// Formules étendues (P6) : dates, listes, expressions régulières linéaires.
import { describe, expect, it } from 'vitest';
import { type Budget, evaluate, FormulaError, listReferences, parseFormula, type Value } from '../src/lib/formula.js';

const run = (src: string, cols: Record<string, Value> = {}, lists: Record<string, string[]> = {}, budget?: Budget) => {
  const m = new Map(Object.entries(cols));
  const l = new Map(Object.entries(lists));
  return evaluate(parseFormula(src), (n) => m.get(n) ?? null, budget, (n) => l.get(n) ?? null);
};
const bad = (src: string) => expect(() => parseFormula(src), src).toThrow(FormulaError);

describe('dates', () => {
  it('dateAdd, day, weekday', () => {
    expect(run('dateAdd(prop("D"), 3)', { D: '2026-02-27' })).toBe('2026-03-02');
    expect(run('dateAdd(prop("D"), -1)', { D: '2026-01-01' })).toBe('2025-12-31');
    expect(run('dateAdd("2024-02-28", 1)')).toBe('2024-02-29');
    expect(run('dateAdd("2026-02-30", 1)')).toBeNull();
    expect(run('dateAdd("2026-01-01", 1.5)')).toBeNull();
    expect(run('dateAdd("9999-12-31", 1)')).toBeNull();
    expect(run('dateAdd("2026-01-01", 99999999)')).toBeNull();
    expect(run('day("2026-11-10")')).toBe(10);
    expect(run('weekday("2026-11-09")')).toBe(1); // lundi
    expect(run('weekday("2026-11-15")')).toBe(7); // dimanche
    expect(run('weekday("1970-01-01")')).toBe(4); // jeudi
    expect(run('weekday("1969-12-29")')).toBe(1);
    expect(run('day("x")')).toBeNull();
  });

  it('formatDate : jetons AAAA MM JJ, le reste copié', () => {
    expect(run('formatDate("2026-03-07", "JJ/MM/AAAA")')).toBe('07/03/2026');
    expect(run('formatDate("2026-03-07", "MM/AAAA")')).toBe('03/2026');
    expect(run('formatDate("2026-03-07", "AAAA")')).toBe('2026');
    expect(run('formatDate("2026-03-07", "le JJ")')).toBe('le 07');
    expect(run('formatDate("2026-03-07", "AAAA-MM-JJ")')).toBe('2026-03-07');
    expect(run('formatDate("2026-03-07", "AAA M J")')).toBe('AAA M J');
    expect(run('formatDate("pas une date", "AAAA")')).toBeNull();
    expect(run('formatDate("2026-03-07", 5)')).toBeNull();
  });
});

describe('listes (Sélection multiple)', () => {
  it('listCount et listHas lisent une liste propre, sans objet', () => {
    expect(run('listCount(prop("Tags"))', {}, { Tags: ['a, b', 'c'] })).toBe(2);
    expect(run('listCount(prop("Tags"))', {}, { Tags: [] })).toBe(0);
    expect(run('listHas(prop("Tags"), "A, B")', {}, { Tags: ['a, b', 'c'] })).toBe(true);
    expect(run('listHas(prop("Tags"), "a")', {}, { Tags: ['a, b', 'c'] })).toBe(false);
    expect(run('listHas(prop("Tags"), 3)', {}, { Tags: ['3'] })).toBeNull();
    expect(run('listCount(prop("Inconnue"))')).toBeNull();
    // Sans lecteur de listes (autre appelant) : vide.
    expect(evaluate(parseFormula('listCount(prop("Tags"))'), () => 'a, b')).toBeNull();
    expect(listReferences(parseFormula('listCount(prop("A")) + if(listHas(prop("B"), "x"), 1, 0)')).sort()).toEqual(['A', 'B']);
  });

  it('le premier argument est une colonne', () => {
    bad('listCount("a, b")');
    bad('listHas(concat("a"), "a")');
    bad('listCount()');
    bad('listHas(prop("T"))');
  });
});

describe('expressions régulières linéaires', () => {
  it('regexTest, regexExtract, regexReplace (remplacement littéral)', () => {
    expect(run('regexTest(prop("Réf"), "^[A-Z]+-\\\\d+$")', { Réf: 'ABC-12' })).toBe(true);
    expect(run('regexTest(prop("Réf"), "^\\\\d+$")', { Réf: 'ABC' })).toBe(false);
    expect(run('regexExtract(prop("T"), "\\\\d+")', { T: 'commande 4521 du jour' })).toBe('4521');
    expect(run('regexExtract(prop("T"), "x")', { T: 'abc' })).toBeNull();
    expect(run('regexReplace(prop("T"), "\\\\s+", "$1 ")', { T: 'a  b   c' })).toBe('a$1 b$1 c');
    expect(run('regexTest(prop("Absent"), "^$")')).toBe(true);
  });

  it('motif littéral invalide : erreur à l’enregistrement ; motif calculé invalide : null', () => {
    for (const p of ['(a', 'a{2}', '(?=a)', 'a*?', '(a)\\\\1', 'x'.repeat(101)]) bad(`regexTest("a", "${p}")`);
    expect(run('regexTest("a", prop("M"))', { M: '(a' })).toBeNull();
    expect(run('regexReplace("a", prop("M"), "b")', { M: 'a{2}' })).toBeNull();
    expect(run('regexTest("a", 3)')).toBeNull();
  });

  it('comptent parmi les fonctions de texte et dans le budget', () => {
    bad(Array.from({ length: 9 }, () => 'regexTest("a", "a")').join(' && '));
    // Motif pathologique sur un long texte : temps borné, puis budget épuisé = null.
    const long = 'a'.repeat(2000);
    const t0 = performance.now();
    const budget: Budget = { chars: 1000 };
    expect(run('regexTest(prop("T"), "(a+)+b")', { T: long }, {}, budget)).toBeNull();
    expect(run('regexTest(prop("T"), "(a+)+b")', { T: long })).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('jamais RegExp sur un motif de formule', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/lib/formula.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/lib/regex-linear.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/new RegExp|RegExp\(/);
  });
});
