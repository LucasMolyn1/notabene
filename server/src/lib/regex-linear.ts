// Expressions régulières des formules, sans retour arrière : un motif venu d'une formule n'est JAMAIS donné à RegExp.
// Le motif est compilé en un petit programme (construction de Thompson) puis simulé à la manière de Pike : toutes les branches
// avancent ensemble, caractère par caractère, et une même instruction n'est suivie qu'une fois par position. Le coût d'une
// recherche est donc borné par (longueur du texte) x (taille du programme), quel que soit le motif ((a+)+$, (a|a)*$...).
// Sémantique : celle de RegExp sans drapeau sur le sous-ensemble admis (premier match le plus à gauche, quantificateurs gloutons).
// Découpage UTF-16, comme RegExp sans le drapeau `u` : le texte est lu unité par unité. Un caractère hors du plan de base
// (emoji, certains idéogrammes) compte pour deux unités : `.` n'en prend que la moitié, une classe ne le reconnaît jamais en entier,
// et regexExtract ou regexReplace peuvent couper entre les deux moitiés. Les classes ne couvrent que 0 à 0xFFFF.
// Coût : chaque pas de simulation (et chaque recherche, coût fixe) est décompté d'un compteur ; la formule plafonne chaque appel
// et la lecture entière (formula.ts : MAX_REGEX_STEPS, READ_REGEX_STEPS).
// Admis : littéraux, `.`, classes [a-z] [^...], \d \w \s \D \W \S, échappements \n \r \t et des caractères spéciaux, ancres ^ $,
// alternative |, groupes () (sans capture), quantificateurs * + ?.
// Refusés : {n,m}, références arrière, (?...) (regard avant ou arrière, groupes nommés), quantificateurs paresseux ou doublés.

export class RegexError extends Error {}
/** Travail épuisé (pas de simulation) : l'appelant rend une valeur vide. */
export class RegexBudgetError extends Error {}

export const MAX_PATTERN = 100;
/** Instructions au plus dans un programme compilé (bornent le facteur m de O(n*m)) ; un motif littéral de 100 caractères en a 101. */
export const MAX_STATES = 120;

// Ensemble de caractères : intervalles [bas, haut] à plat, éventuellement complémenté.
interface CharSet { neg: boolean; ranges: number[] }
type Ast =
  | { k: 'empty' }
  | { k: 'set'; set: CharSet }
  | { k: 'cat'; items: Ast[] }
  | { k: 'alt'; items: Ast[] }
  | { k: 'rep'; q: '*' | '+' | '?'; a: Ast }
  | { k: 'bol' }
  | { k: 'eol' };

type Inst =
  | { op: 'set'; set: CharSet }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'bol' }
  | { op: 'eol' }
  | { op: 'match' };

interface Scratch { mark: Int32Array; gen: number; a: Int32Array[]; b: Int32Array[]; stack: Int32Array }
export interface Program { insts: Inst[]; scratch?: Scratch }

const MAX_CODE = 0xffff;
const DIGIT = [48, 57];
const WORD = [48, 57, 65, 90, 95, 95, 97, 122];
// Blancs de JavaScript (\s).
const SPACE = [9, 13, 32, 32, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff];
// `.` : tout sauf les fins de ligne.
const LINE_END = [10, 10, 13, 13, 0x2028, 0x2029];

/** Complément d'une liste d'intervalles triés et disjoints, dans [0, 0xFFFF]. */
function complement(ranges: number[]): number[] {
  const sorted = normalize(ranges);
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < sorted.length; i += 2) {
    if (sorted[i]! > next) out.push(next, sorted[i]! - 1);
    next = sorted[i + 1]! + 1;
  }
  if (next <= MAX_CODE) out.push(next, MAX_CODE);
  return out;
}

/** Intervalles triés et fusionnés. */
function normalize(ranges: number[]): number[] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < ranges.length; i += 2) pairs.push([ranges[i]!, ranges[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [lo, hi] of pairs) {
    const n = out.length;
    if (n && lo <= out[n - 1]! + 1) out[n - 1] = Math.max(out[n - 1]!, hi);
    else out.push(lo, hi);
  }
  return out;
}

const inSet = (set: CharSet, c: number): boolean => {
  let hit = false;
  for (let i = 0; i < set.ranges.length; i += 2) if (c >= set.ranges[i]! && c <= set.ranges[i + 1]!) { hit = true; break; }
  return hit !== set.neg;
};

const SPECIAL = '\\^$.|?*+()[]{}/-';

// ---------- Analyse du motif ----------
function parse(src: string): Ast {
  let i = 0;
  const fail = (m: string): never => { throw new RegexError(`Motif : ${m} (position ${i + 1})`); };

  // Échappement après « \ » : intervalles du caractère ou de la classe désignée.
  function escape(inClass: boolean): { ranges: number[]; single: number | null } {
    const c = src[i];
    if (c === undefined) return fail('« \\ » final');
    i++;
    switch (c) {
      case 'd': return { ranges: DIGIT, single: null };
      case 'D': return { ranges: complement(DIGIT), single: null };
      case 'w': return { ranges: WORD, single: null };
      case 'W': return { ranges: complement(WORD), single: null };
      case 's': return { ranges: SPACE, single: null };
      case 'S': return { ranges: complement(SPACE), single: null };
      case 'n': return { ranges: [10, 10], single: 10 };
      case 'r': return { ranges: [13, 13], single: 13 };
      case 't': return { ranges: [9, 9], single: 9 };
      default:
        if (SPECIAL.includes(c) || (inClass && c === ']')) { const code = c.charCodeAt(0); return { ranges: [code, code], single: code }; }
        return fail(`échappement « \\${c} » non pris en charge`);
    }
  }

  function charClass(): CharSet {
    // `[` déjà lu.
    let neg = false;
    if (src[i] === '^') { neg = true; i++; }
    const ranges: number[] = [];
    let first = true;
    for (;;) {
      const c = src[i];
      if (c === undefined) return fail('classe « [ » non fermée');
      if (c === ']' && !first) { i++; break; }
      if (c === ']') return fail('classe vide');
      first = false;
      let lo: { ranges: number[]; single: number | null };
      if (c === '\\') { i++; lo = escape(true); } else { i++; const code = c.charCodeAt(0); lo = { ranges: [code, code], single: code }; }
      // Intervalle a-b (un « - » en dernier est littéral).
      if (src[i] === '-' && src[i + 1] !== undefined && src[i + 1] !== ']') {
        if (lo.single === null) return fail('intervalle avec une classe');
        i++;
        const d = src[i]!;
        let hi: { ranges: number[]; single: number | null };
        if (d === '\\') { i++; hi = escape(true); } else { i++; const code = d.charCodeAt(0); hi = { ranges: [code, code], single: code }; }
        if (hi.single === null) return fail('intervalle avec une classe');
        if (hi.single < lo.single) return fail('intervalle à l’envers');
        ranges.push(lo.single, hi.single);
      } else ranges.push(...lo.ranges);
    }
    return { neg, ranges: normalize(ranges) };
  }

  function alt(depth: number): Ast {
    if (depth > 50) return fail('trop de groupes imbriqués');
    const items = [cat(depth)];
    while (src[i] === '|') { i++; items.push(cat(depth)); }
    return items.length === 1 ? items[0]! : { k: 'alt', items };
  }

  function cat(depth: number): Ast {
    const items: Ast[] = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const c = src[i]!;
      let atom: Ast;
      if (c === '*' || c === '+' || c === '?') return fail('quantificateur sans rien à répéter');
      if (c === '{' || c === '}') return fail('les répétitions {n,m} ne sont pas prises en charge');
      i++;
      if (c === '(') {
        if (src[i] === '?') return fail('les groupes spéciaux (?...) ne sont pas pris en charge');
        atom = alt(depth + 1);
        if (src[i] !== ')') return fail('parenthèse fermante attendue');
        i++;
      } else if (c === '[') atom = { k: 'set', set: charClass() };
      else if (c === '.') atom = { k: 'set', set: { neg: true, ranges: LINE_END } };
      else if (c === '^') atom = { k: 'bol' };
      else if (c === '$') atom = { k: 'eol' };
      else if (c === '\\') {
        if (/[1-9]/.test(src[i] ?? '')) return fail('les références arrière ne sont pas prises en charge');
        const e = escape(false);
        atom = { k: 'set', set: { neg: false, ranges: normalize(e.ranges) } };
      } else { const code = c.charCodeAt(0); atom = { k: 'set', set: { neg: false, ranges: [code, code] } }; }
      const q = src[i];
      if (q === '*' || q === '+' || q === '?') {
        if (atom.k === 'bol' || atom.k === 'eol') return fail('une ancre ne se répète pas');
        i++;
        const after = src[i];
        if (after === '*' || after === '+' || after === '?') return fail('quantificateurs paresseux ou doublés non pris en charge');
        if (after === '{') return fail('les répétitions {n,m} ne sont pas prises en charge');
        atom = { k: 'rep', q, a: atom };
      }
      items.push(atom);
    }
    return items.length === 0 ? { k: 'empty' } : items.length === 1 ? items[0]! : { k: 'cat', items };
  }

  const ast = alt(0);
  if (i < src.length) fail(src[i] === ')' ? 'parenthèse fermante en trop' : 'symbole inattendu');
  return ast;
}

// ---------- Compilation (Thompson) ----------
function compile(ast: Ast): Inst[] {
  const out: Inst[] = [];
  const emit = (inst: Inst) => {
    if (out.length >= MAX_STATES) throw new RegexError(`Motif trop complexe (${MAX_STATES} états au plus)`);
    out.push(inst);
    return out.length - 1;
  };
  const gen = (n: Ast): void => {
    switch (n.k) {
      case 'empty': return;
      case 'set': emit({ op: 'set', set: n.set }); return;
      case 'bol': emit({ op: 'bol' }); return;
      case 'eol': emit({ op: 'eol' }); return;
      case 'cat': n.items.forEach(gen); return;
      case 'alt': {
        const jumps: number[] = [];
        n.items.forEach((item, k) => {
          if (k < n.items.length - 1) {
            const split = emit({ op: 'split', x: 0, y: 0 });
            (out[split] as { x: number }).x = split + 1;
            gen(item);
            jumps.push(emit({ op: 'jmp', x: 0 }));
            (out[split] as { y: number }).y = out.length;
          } else gen(item);
        });
        for (const j of jumps) (out[j] as { x: number }).x = out.length;
        return;
      }
      case 'rep': {
        if (n.q === '+') {
          const start = out.length;
          gen(n.a);
          emit({ op: 'split', x: start, y: out.length + 1 });
          return;
        }
        const split = emit({ op: 'split', x: 0, y: 0 });
        (out[split] as { x: number }).x = split + 1;
        gen(n.a);
        if (n.q === '*') emit({ op: 'jmp', x: split });
        (out[split] as { y: number }).y = out.length;
        return;
      }
    }
  };
  gen(ast);
  emit({ op: 'match' });
  return out;
}

/** Compile un motif ; lève RegexError s'il est trop long, mal formé ou hors du sous-ensemble admis. */
export function compileRegex(pattern: string): Program {
  if (typeof pattern !== 'string') throw new RegexError('Motif : texte attendu');
  if (pattern.length > MAX_PATTERN) throw new RegexError(`Motif trop long (${MAX_PATTERN} caractères au plus)`);
  return { insts: compile(parse(pattern)) };
}

/** Compteur de travail partagé par les recherches d'un appel : chaque pas de simulation coûte 1. */
export interface Steps { left: number }

/** Coût fixe d'une recherche, compté en pas (préparation, listes) : un remplacement fait une recherche par match. */
const SEARCH_COST = 16;

/**
 * Ajoute la fermeture de `pc` (sauts, alternatives, ancres) à la liste (`pcs`, `starts`, longueur `len`), dans l'ordre de priorité.
 * Une instruction déjà vue à cette position est ignorée : la pile ne dépasse donc jamais 2 m + 1 éléments. Rend la nouvelle longueur.
 */
function addThread(sc: Scratch, insts: Inst[], steps: Steps, pc: number, pos: number, n: number, start: number, pcs: Int32Array, starts: Int32Array, len: number): number {
  const { mark, stack } = sc;
  const gen = sc.gen;
  let sp = 0;
  stack[sp++] = pc;
  while (sp) {
    if (--steps.left < 0) throw new RegexBudgetError();
    const p = stack[--sp]!;
    if (mark[p] === gen) continue;
    mark[p] = gen;
    const inst = insts[p]!;
    switch (inst.op) {
      case 'jmp': stack[sp++] = inst.x; break;
      case 'split': stack[sp++] = inst.y; stack[sp++] = inst.x; break;
      case 'bol': if (pos === 0) stack[sp++] = p + 1; break;
      case 'eol': if (pos === n) stack[sp++] = p + 1; break;
      default: pcs[len] = p; starts[len] = start; len++;
    }
  }
  return len;
}

/**
 * Premier match (le plus à gauche, glouton) qui commence à `from` ou après. Rend [début, fin[ ou null. Lève RegexBudgetError
 * si `steps` est épuisé.
 */
export function regexSearch(prog: Program, text: string, from: number, steps: Steps): { start: number; end: number } | null {
  if ((steps.left -= SEARCH_COST) < 0) throw new RegexBudgetError();
  const insts = prog.insts;
  const m = insts.length;
  const n = text.length;
  // Mémoire de travail allouée une fois par programme et réutilisée (JavaScript ne s'interrompt pas au milieu d'une recherche).
  const sc = prog.scratch ??= { mark: new Int32Array(m), gen: 0, a: [new Int32Array(m), new Int32Array(m)], b: [new Int32Array(m), new Int32Array(m)], stack: new Int32Array(m * 2 + 2) };
  if (sc.gen > 0x3fffffff) { sc.mark.fill(0); sc.gen = 0; }
  let cur = sc.a;
  let next = sc.b;
  let matched: { start: number; end: number } | null = null;
  sc.gen++;
  let clen = addThread(sc, insts, steps, 0, from, n, from, cur[0]!, cur[1]!, 0);
  for (let i = from; ; i++) {
    sc.gen++;
    const c = i < n ? text.charCodeAt(i) : -1;
    const cpcs = cur[0]!;
    const cstarts = cur[1]!;
    let nlen = 0;
    for (let t = 0; t < clen; t++) {
      if (--steps.left < 0) throw new RegexBudgetError();
      const inst = insts[cpcs[t]!]!;
      if (inst.op === 'match') { matched = { start: cstarts[t]!, end: i }; break; } // les branches moins prioritaires sont coupées
      if (inst.op === 'set' && c >= 0 && inSet(inst.set, c)) nlen = addThread(sc, insts, steps, cpcs[t]! + 1, i + 1, n, cstarts[t]!, next[0]!, next[1]!, nlen);
    }
    if (i >= n) break;
    if (!matched) nlen = addThread(sc, insts, steps, 0, i + 1, n, i + 1, next[0]!, next[1]!, nlen);
    [cur, next] = [next, cur];
    clen = nlen;
    if (!clen && matched) break;
  }
  return matched;
}

export const regexTest = (prog: Program, text: string, steps: Steps) => regexSearch(prog, text, 0, steps) !== null;

/** Texte du premier match, ou null. */
export function regexExtract(prog: Program, text: string, steps: Steps): string | null {
  const m = regexSearch(prog, text, 0, steps);
  return m ? text.slice(m.start, m.end) : null;
}

/** Remplace chaque match par `repl`, pris LITTÉRALEMENT (aucun $1, $&...). Mêmes positions que String.replace avec /g. */
export function regexReplace(prog: Program, text: string, repl: string, steps: Steps, maxLength = Infinity): string {
  let out = '';
  let last = 0;
  let pos = 0;
  while (pos <= text.length) {
    const m = regexSearch(prog, text, pos, steps);
    if (!m) break;
    out += text.slice(last, m.start) + repl;
    if (out.length > maxLength) return out.slice(0, maxLength);
    last = m.end;
    pos = m.end === m.start ? m.end + 1 : m.end;
  }
  return out + text.slice(last);
}
