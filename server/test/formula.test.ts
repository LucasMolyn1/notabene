import { describe, expect, it } from 'vitest';
import { type Budget, evaluate, FormulaError, MAX_FORMULA_CHARS, parseFormula, referencedProperties, type Value } from '../src/lib/formula.js';

// Comme l'application : les colonnes se lisent dans une Map, jamais dans un objet indexé par le nom.
const run = (src: string, cols: Record<string, Value> = {}) => { const m = new Map(Object.entries(cols)); return evaluate(parseFormula(src), (n) => m.get(n) ?? null); };
const bad = (src: string) => expect(() => parseFormula(src)).toThrow(FormulaError);

describe('calcul', () => {
  it('opérations et priorités', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 - 4 - 3')).toBe(3);
    expect(run('7 % 4')).toBe(3);
    expect(run('-2 * -3')).toBe(6);
    expect(run('2 + 3 > 4 && 1 < 2')).toBe(true);
    expect(run('!(1 == 2)')).toBe(true);
    expect(run('1 + 2 == 3')).toBe(true);
    expect(run('"a" + "b" + 1')).toBe('ab1');
  });

  it('colonnes : valeurs absentes donnent null, pas d’erreur', () => {
    expect(run('prop("Prix") * prop("Quantité")', { Prix: 4, Quantité: 3 })).toBe(12);
    expect(run('prop("Prix") * prop("Quantité")', { Prix: 4 })).toBeNull();
    expect(run('prop("Absente") + 1')).toBeNull();
    expect(run('concat("Bonjour ", prop("Nom"))', { Nom: 'Léa' })).toBe('Bonjour Léa');
    expect(run('concat("Bonjour ", prop("Nom"))')).toBe('Bonjour ');
    expect(referencedProperties(parseFormula('prop("A") + if(prop("B"), prop("A"), 1)')).sort()).toEqual(['A', 'B']);
  });

  it('erreurs d’exécution : null, jamais une exception', () => {
    expect(run('1 / 0')).toBeNull();
    expect(run('5 % 0')).toBeNull();
    expect(run('"a" * 2')).toBeNull();
    expect(run('abs("x")')).toBeNull();
    expect(run('round(1.5, 99)')).toBeNull();
    expect(run('9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999 * 9999999999999999')).toBeNull();
  });

  it('fonctions', () => {
    expect(run('if(1 > 2, "oui", "non")')).toBe('non');
    expect(run('round(2.567, 1)')).toBe(2.6);
    expect(run('round(2.5)')).toBe(3);
    expect(run('floor(2.9) + ceil(2.1)')).toBe(5);
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1, 2)')).toBe(3);
    expect(run('length("Équipe")')).toBe(6);
    expect(run('upper("é")')).toBe('É');
    expect(run('contains("Bonjour le monde", "LE")')).toBe(true);
    expect(run('isEmpty(prop("X"))')).toBe(true);
    expect(run('number("12,5") + 1')).toBe(13.5);
    expect(run('number("abc")')).toBeNull();
    expect(run('text(12) + "€"')).toBe('12€');
    expect(run('dateDiff(prop("Fin"), prop("Début"))', { Fin: '2026-03-01', Début: '2026-02-01' })).toBe(28);
    expect(run('year(prop("D")) * 100 + month(prop("D"))', { D: '2026-11-30' })).toBe(202611);
    expect(run('dateDiff("2026-02-30", "2026-01-01")')).not.toBe(NaN);
  });

  it('if n’évalue que la branche choisie et && / || court-circuitent', () => {
    let reads = 0;
    const ast = parseFormula('if(true, 1, prop("X"))');
    expect(evaluate(ast, () => { reads++; return 1; })).toBe(1);
    expect(reads).toBe(0);
    reads = 0;
    expect(evaluate(parseFormula('false && prop("X")'), () => { reads++; return true; })).toBe(false);
    expect(reads).toBe(0);
  });

  it('un texte long est tronqué', () => {
    const out = run('prop("A") + prop("A") + prop("A")', { A: 'x'.repeat(1900) });
    expect(typeof out === 'string' && out.length <= 2000).toBe(true);
  });
});

describe('relecture : logique stricte, texte, dates, budget', () => {
  it('les opérateurs logiques et if exigent des booléens : sinon le résultat est vide', () => {
    for (const src of ['!5', '!0', '!"non"', 'if(5, 1, 2)', 'if("x", 1, 2)', 'prop("X") && true', 'true && prop("X")', 'prop("X") || true', 'false || prop("X")', '!prop("X")', 'if(prop("X"), 1, 2)']) expect(run(src), src).toBeNull();
    expect(run('!true')).toBe(false);
    expect(run('!false')).toBe(true);
    expect(run('false && prop("X")')).toBe(false);
    expect(run('true || prop("X")')).toBe(true);
    expect(run('true && false || true')).toBe(true);
    expect(run('if(1 > 2, "a", "b")')).toBe('b');
  });

  it('texte : booléens en oui/non, ordre français, longueur en caractères', () => {
    expect(run('text(true) + "/" + text(false)')).toBe('oui/non');
    expect(run('"a" < "B"')).toBe(true);
    expect(run('"é" < "f"')).toBe(true);
    expect(run('length("😀é")')).toBe(2);
  });

  it('dates : une date impossible n’est pas ramenée à une autre', () => {
    expect(run('dateDiff("2026-02-31", "2026-01-01")')).toBeNull();
    expect(run('year("0000-99-99")')).toBeNull();
    expect(run('month("2026-13-01")')).toBeNull();
    expect(run('dateDiff("2026-03-01", "2026-02-28")')).toBe(1);
    expect(run('dateDiff("2024-03-01", "2024-02-28")')).toBe(2);
  });

  it('un texte de formule n’accepte ni caractères de contrôle, ni direction du texte, ni retour à la ligne', () => {
    for (const bidi of ['\u202e', '\u2066', '\u200f', '\u0007', '\n', '\r', '\t']) bad(`"a${bidi}b"`);
    bad('"a\\nb"');
    expect(run('"a b"')).toBe('a b');
  });

  it('le travail des fonctions de texte est borné : budget partagé et nombre d’appels', () => {
    const greek = 'ΣΑΣς'.repeat(500);
    const ast = parseFormula('length(lower(upper(prop("T"))))');
    const budget: Budget = { chars: 10_000 };
    let nulls = 0;
    for (let i = 0; i < 20; i++) if (evaluate(ast, () => greek, budget) === null) nulls++;
    expect(nulls).toBeGreaterThan(10);
    expect(evaluate(ast, () => greek)).toBe(2000);
    expect(budget.chars).toBeLessThan(0);
    // Sans texte, le budget n'est pas touché.
    const b2: Budget = { chars: 5 };
    expect(evaluate(parseFormula('1 + 2 * 3'), () => null, b2)).toBe(7);
    expect(b2.chars).toBe(5);
    bad(`${'upper('.repeat(9)}"a"${')'.repeat(9)}`);
    expect(() => parseFormula(`${'upper('.repeat(8)}"a"${')'.repeat(8)}`)).not.toThrow();
  });
});

describe('refus à l’analyse', () => {
  it('syntaxe invalide', () => {
    for (const src of ['', '   ', '1 +', '(1', '1 2', 'foo', 'foo(1)', 'if(1, 2)', 'round()', 'prop(1)', 'prop("a", "b")', 'prop(prop("a"))', '"non fermé', '"x\\q"', '1 @ 2', '1 = 2', 'a.b', '[1]', '{}', '`x`', '1; 2', '$x', '#']) bad(src);
  });

  it('rien d’exécutable : aucun accès à des objets, des prototypes ni des globales', () => {
    for (const src of ['constructor', 'constructor("x")', '__proto__', 'prop("a").constructor', 'this', 'process.exit()', 'globalThis', 'eval("1")', 'Function("return 1")()', 'toString()', 'hasOwnProperty("a")', 'new Date()', 'import("x")', 'require("fs")']) bad(src);
    // Un nom de colonne malveillant n'est qu'un texte : il ne touche aucun objet.
    expect(run('prop("__proto__")')).toBeNull();
    expect(run('prop("constructor")', {})).toBeNull();
    expect(run('prop("toString")')).toBeNull();
  });

  it('limites de taille, de complexité et de profondeur', () => {
    bad('1+'.repeat(MAX_FORMULA_CHARS) + '1');
    bad('1'.repeat(MAX_FORMULA_CHARS + 1));
    bad(`${'('.repeat(40)}1${')'.repeat(40)}`);
    bad(`${'-'.repeat(40)}1`);
    bad(`${'!'.repeat(40)}1`);
    bad(`${'if(1,'.repeat(30)}1${',2)'.repeat(30)}`);
    bad(Array.from({ length: 150 }, () => '1').join('+'));
    expect(() => parseFormula(Array.from({ length: 50 }, () => '1').join('+'))).not.toThrow();
  });

  it('une formule très imbriquée mais valide s’évalue sans dépasser la pile', () => {
    expect(run(`${'('.repeat(20)}1${')'.repeat(20)} + 1`)).toBe(2);
  });
});
