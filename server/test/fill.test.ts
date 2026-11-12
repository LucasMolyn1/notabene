// Remplissage borné des pages filtrées après lecture (lib/fill.ts).
import { describe, expect, it } from 'vitest';
import { fillReadable } from '../src/lib/fill.js';

const source = (n: number) => Array.from({ length: n }, (_, i) => i);
const run = (data: number[], keep: (x: number) => boolean, want: number, batch: number, extra: { maxRounds?: number; maxRows?: number } = {}) => {
  const reads: number[] = [];
  const res = fillReadable<number, number>({
    want, batch, start: 0, ...extra,
    fetch: (from, n) => { reads.push(n); return data.slice(from ?? 0, (from ?? 0) + n); },
    keep: (rows) => rows.filter(keep),
    advance: (from, rows) => (from ?? 0) + rows.length,
  });
  return { ...res, reads };
};

describe('fillReadable', () => {
  it('remplit la page malgré les éléments écartés', () => {
    const r = run(source(100), (x) => x % 5 === 0, 6, 4);
    expect(r.items).toEqual([0, 5, 10, 15, 20, 25]);
    expect(r.more).toBe(true);
  });

  it('source épuisée : more à false, page éventuellement courte', () => {
    const r = run(source(10), (x) => x % 2 === 0, 50, 4);
    expect(r.items).toEqual([0, 2, 4, 6, 8]);
    expect(r.more).toBe(false);
    expect(r.scanned).toBe(10);
  });

  it('plafonds de tours et de lignes lues respectés ; la position rend la suite', () => {
    const rounds = run(source(1000), () => false, 5, 10, { maxRounds: 3 });
    expect(rounds.reads).toEqual([10, 10, 10]);
    expect(rounds).toMatchObject({ items: [], scanned: 30, more: true });
    const rows = run(source(1000), () => false, 5, 40, { maxRows: 100 });
    expect(rows.reads).toEqual([40, 40, 20]);
    expect(rows).toMatchObject({ items: [], scanned: 100, more: true });
  });

  it('ne rend jamais un élément écarté', () => {
    const r = run(source(300), (x) => x > 250, 10, 50);
    expect(r.items.every((x) => x > 250)).toBe(true);
  });
});
