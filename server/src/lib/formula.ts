// Formules des bases : un petit langage d'expressions, analysé et évalué à la main.
// Jamais `eval`, jamais `new Function`, jamais d'accès à un objet par un nom venu de la formule : les fonctions sont dans une
// table fermée (Map), les colonnes se lisent par un rappel que l'appelant fournit. Pas de boucle, pas de variable, pas de récursion :
// le coût d'une évaluation est borné par la taille de la formule.
// Limites : 500 caractères, 120 nœuds, profondeur 25, résultat texte de 2 000 caractères au plus.
// Une erreur d'exécution (division par zéro, type inattendu, valeur absente) donne `null`, jamais une exception.
export type Value = number | string | boolean | null;

export class FormulaError extends Error {}

export const MAX_FORMULA_CHARS = 500;
const MAX_NODES = 120;
const MAX_DEPTH = 25;
const MAX_STRING = 2000;

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'prop'; name: string }
  | { t: 'un'; op: '-' | '!'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

// ---------- Analyse lexicale ----------
type Tok = { k: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; at: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      // Nombre lu à la main (chiffres, un point facultatif, chiffres) : pas d'expression régulière sur une saisie libre.
      let j = i;
      while (/[0-9]/.test(src[j] ?? '')) j++;
      if (src[j] === '.') { j++; while (/[0-9]/.test(src[j] ?? '')) j++; }
      out.push({ k: 'num', v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (c === '"') {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new FormulaError(`Texte non fermé à la position ${i + 1}`);
        const d = src[j]!;
        if (d === '\\') {
          const e = src[j + 1];
          if (e === '"' || e === '\\') { s += e; j += 2; continue; }
          if (e === 'n') { s += '\n'; j += 2; continue; }
          throw new FormulaError(`Séquence « \\${e ?? ''} » inconnue à la position ${j + 1}`);
        }
        if (d === '"') break;
        s += d;
        j++;
      }
      if (s.length > MAX_STRING) throw new FormulaError('Texte trop long');
      out.push({ k: 'str', v: s, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two, at: i }); i += 2; continue; }
    if ('+-*/%<>!(),'.includes(c)) { out.push({ k: 'op', v: c, at: i }); i++; continue; }
    throw new FormulaError(`Caractère « ${c} » non autorisé à la position ${i + 1}`);
  }
  out.push({ k: 'end', v: '', at: src.length });
  return out;
}

// ---------- Fonctions : nom, nombre d'arguments minimal et maximal ----------
const ARITY: Record<string, [number, number]> = {
  if: [3, 3], round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], min: [2, 10], max: [2, 10],
  length: [1, 1], upper: [1, 1], lower: [1, 1], concat: [1, 10], contains: [2, 2], isEmpty: [1, 1],
  number: [1, 1], text: [1, 1], dateDiff: [2, 2], year: [1, 1], month: [1, 1],
};
const FUNCTIONS = new Map(Object.entries(ARITY));

// ---------- Analyse syntaxique (précédence montante) ----------
const BIN: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function parseFormula(src: string): Node {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaError('La formule est vide');
  if (src.length > MAX_FORMULA_CHARS) throw new FormulaError(`Formule trop longue (${MAX_FORMULA_CHARS} caractères au plus)`);
  const toks = lex(src);
  let pos = 0;
  let nodes = 0;
  const peek = () => toks[pos]!;
  const count = () => { if (++nodes > MAX_NODES) throw new FormulaError('Formule trop complexe'); };
  const fail = (m: string, t = peek()): never => { throw new FormulaError(`${m} à la position ${t.at + 1}`); };

  function expr(minPrec: number, depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError('Formule trop imbriquée');
    let left = unary(depth);
    for (;;) {
      const t = peek();
      const prec = t.k === 'op' ? BIN[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      pos++;
      const right = expr(prec + 1, depth + 1);
      count();
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
  }

  function unary(depth: number): Node {
    const t = peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '!')) {
      pos++;
      count();
      if (depth + 1 > MAX_DEPTH) throw new FormulaError('Formule trop imbriquée');
      return { t: 'un', op: t.v, a: unary(depth + 1) };
    }
    return primary(depth);
  }

  function primary(depth: number): Node {
    const t = peek();
    pos++;
    if (t.k === 'num') { count(); const v = Number(t.v); if (!Number.isFinite(v)) fail('Nombre invalide', t); return { t: 'num', v }; }
    if (t.k === 'str') { count(); return { t: 'str', v: t.v }; }
    if (t.k === 'op' && t.v === '(') {
      const e = expr(1, depth + 1);
      if (peek().k !== 'op' || peek().v !== ')') fail('Parenthèse fermante attendue');
      pos++;
      return e;
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') { count(); return { t: 'bool', v: t.v === 'true' }; }
      if (peek().k !== 'op' || peek().v !== '(') return fail(`« ${t.v} » n'est pas une fonction : écrivez prop("nom de colonne") pour lire une colonne`, t);
      pos++;
      count();
      const args: Node[] = [];
      if (peek().k === 'op' && peek().v === ')') pos++;
      else {
        for (;;) {
          args.push(expr(1, depth + 1));
          if (peek().k === 'op' && peek().v === ',') { pos++; continue; }
          if (peek().k === 'op' && peek().v === ')') { pos++; break; }
          fail('« , » ou « ) » attendu');
        }
      }
      if (t.v === 'prop') {
        const a = args[0];
        if (args.length !== 1 || a?.t !== 'str') return fail('prop() prend un seul texte : prop("nom de colonne")', t);
        return { t: 'prop', name: a.v };
      }
      const arity = FUNCTIONS.get(t.v);
      if (!arity) return fail(`Fonction « ${t.v} » inconnue`, t);
      if (args.length < arity[0] || args.length > arity[1]) return fail(`${t.v}() attend ${arity[0] === arity[1] ? arity[0] : `de ${arity[0]} à ${arity[1]}`} argument(s)`, t);
      return { t: 'call', fn: t.v, args };
    }
    return fail(t.k === 'end' ? 'Expression incomplète' : `Symbole « ${t.v} » inattendu`, t);
  }

  const root = expr(1, 0);
  if (peek().k !== 'end') fail(`Symbole « ${peek().v} » inattendu`);
  return root;
}

/** Noms des colonnes lues par la formule (par prop("…")). */
export function referencedProperties(ast: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === 'prop') out.add(n.name);
    else if (n.t === 'un') walk(n.a);
    else if (n.t === 'bin') { walk(n.a); walk(n.b); }
    else if (n.t === 'call') n.args.forEach(walk);
  };
  walk(ast);
  return [...out];
}

// ---------- Évaluation ----------
const num = (v: Value): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: Value): string => (v === null ? '' : typeof v === 'boolean' ? (v ? 'vrai' : 'faux') : String(v));
const cut = (s: string) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
const finite = (n: number): Value => (Number.isFinite(n) ? n : null);
/** « 12 », « -3,5 », « 4.25 » (espaces autour tolérés) ; tout le reste donne null. */
function parseDecimal(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  const body = t.startsWith('-') ? t.slice(1) : t;
  const [whole = '', frac, extra] = body.split('.');
  if (extra !== undefined || !whole || !/^[0-9]+$/.test(whole) || (frac !== undefined && !/^[0-9]+$/.test(frac))) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayNumber = (v: Value): number | null => {
  if (typeof v !== 'string') return null;
  const m = DATE.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null;
};

function binary(op: string, a: Value, b: Value): Value {
  switch (op) {
    case '&&': return a === true && b === true;
    case '||': return a === true || b === true;
    case '==': return a === b;
    case '!=': return a !== b;
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return cut(str(a) + str(b));
      { const x = num(a); const y = num(b); return x === null || y === null ? null : finite(x + y); }
    case '<': case '>': case '<=': case '>=': {
      if (a === null || b === null || typeof a !== typeof b) return null;
      const lt = (a as number | string | boolean) < (b as number | string | boolean);
      const eq = a === b;
      return op === '<' ? lt : op === '>' ? !lt && !eq : op === '<=' ? lt || eq : !lt;
    }
    default: {
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      if (op === '-') return finite(x - y);
      if (op === '*') return finite(x * y);
      if (y === 0) return null;
      return finite(op === '/' ? x / y : x % y);
    }
  }
}

function call(fn: string, a: Value[]): Value {
  switch (fn) {
    case 'round': { const x = num(a[0]!); if (x === null) return null; const d = a[1] === undefined ? 0 : num(a[1]); if (d === null || d < 0 || d > 10) return null; const f = 10 ** Math.trunc(d); return finite(Math.round(x * f) / f); }
    case 'floor': { const x = num(a[0]!); return x === null ? null : Math.floor(x); }
    case 'ceil': { const x = num(a[0]!); return x === null ? null : Math.ceil(x); }
    case 'abs': { const x = num(a[0]!); return x === null ? null : Math.abs(x); }
    case 'min': case 'max': { const xs = a.map(num); if (xs.some((x) => x === null)) return null; return fn === 'min' ? Math.min(...(xs as number[])) : Math.max(...(xs as number[])); }
    case 'length': return str(a[0]!).length;
    case 'upper': return cut(str(a[0]!).toLocaleUpperCase('fr'));
    case 'lower': return cut(str(a[0]!).toLocaleLowerCase('fr'));
    case 'concat': return cut(a.map(str).join(''));
    case 'contains': return str(a[0]!).toLocaleLowerCase('fr').includes(str(a[1]!).toLocaleLowerCase('fr'));
    case 'isEmpty': return a[0] === null || a[0] === '';
    case 'number': { if (typeof a[0] === 'number') return a[0]; if (typeof a[0] === 'boolean') return a[0] ? 1 : 0; return typeof a[0] === 'string' ? parseDecimal(a[0]) : null; }
    case 'text': return cut(str(a[0]!));
    case 'dateDiff': { const x = dayNumber(a[0]!); const y = dayNumber(a[1]!); return x === null || y === null ? null : x - y; }
    case 'year': { const m = typeof a[0] === 'string' ? DATE.exec(a[0]) : null; return m ? Number(m[1]) : null; }
    case 'month': { const m = typeof a[0] === 'string' ? DATE.exec(a[0]) : null; return m ? Number(m[2]) : null; }
    default: return null;
  }
}

/** Évalue une formule déjà analysée. `read(nom)` donne la valeur d'une colonne (null si absente ou inconnue). */
export function evaluate(ast: Node, read: (name: string) => Value): Value {
  const go = (n: Node): Value => {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'prop': return read(n.name);
      case 'un': { const v = go(n.a); if (n.op === '!') return v === null ? null : !(v === true); const x = num(v); return x === null ? null : -x; }
      case 'bin': {
        if (n.op === '&&') { const a = go(n.a); return a === true ? go(n.b) === true : false; }
        if (n.op === '||') { const a = go(n.a); return a === true ? true : go(n.b) === true; }
        return binary(n.op, go(n.a), go(n.b));
      }
      case 'call':
        // if() n'évalue que la branche choisie ; les autres fonctions évaluent tous leurs arguments.
        if (n.fn === 'if') return go(n.args[0]!) === true ? go(n.args[1]!) : go(n.args[2]!);
        return call(n.fn, n.args.map(go));
    }
  };
  const out = go(ast);
  return typeof out === 'number' && !Number.isFinite(out) ? null : out;
}
