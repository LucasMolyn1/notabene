// Graphiques : filtres serveur identiques à ceux du client (client/src/base-model.js), calcul des groupes.
import { describe, expect, it } from 'vitest';
import { applyFilters, computeChart } from '../src/lib/base-chart.js';
import type { PresentedRow, Property, ViewConfig } from '../src/lib/bases.js';
// @ts-expect-error module JavaScript du client, sans déclarations de types
import { applyView } from '../../client/src/base-model.js';

const opt = (id: string, name: string, color = 'gray') => ({ id, name, color });
const prop = (id: string, type: Property['type'], extra: Partial<Property> = {}): Property => ({ id, name: id, type, options: [], position: 0, formula: null, config: {}, ...extra });
const props: Property[] = [
  prop('t', 'text'),
  prop('n', 'number'),
  prop('d', 'date'),
  prop('c', 'checkbox'),
  prop('s', 'select', { options: [opt('o1', 'Un'), opt('o2', 'Deux')] }),
  prop('st', 'status', { options: [opt('a', 'À faire'), opt('b', 'Fait', 'green')] }),
  prop('m', 'multi_select', { options: [opt('x', 'X'), opt('y', 'Y')] }),
  prop('p', 'person'),
  prop('pl', 'page_link'),
  prop('r', 'relation'),
  prop('f', 'formula', { formula: '1' }),
  prop('ru', 'rollup'),
];
const row = (id: string, values: Record<string, unknown>): PresentedRow => ({ id, position: 0, values, createdAt: 0, updatedAt: 0, parentId: null, blockedBy: [] });
const rows: PresentedRow[] = [
  row('1', { t: 'Élan', n: 5, d: '2026-01-02', c: true, s: 'o1', st: 'a', m: ['x', 'y'], p: { id: 'u1', name: 'Léa' }, pl: { id: 'g', title: 'Guide', icon: '' }, r: [{ id: 'z', title: 'Lié' }], f: 3, ru: 2 }),
  row('2', { t: 'elan vital', n: -1, d: '2025-12-31', s: 'o2', m: ['y'], f: 'texte', ru: 0 }),
  row('3', { t: 'Autre', n: 0, st: 'b', f: true }),
  row('4', {}),
  row('5', { t: '', n: 12.5, d: '2026-06-30', c: false, m: [], f: '12', pl: { id: 'h', title: '', icon: '' } }),
];
const OPS = ['contains', 'eq', 'neq', 'gt', 'lt', 'empty', 'notempty'] as const;
const VALUES: (string | number | boolean | null | undefined)[] = ['elan', 'Élan', 'ELAN VITAL', '', 'o1', 'a', 'x', 'y', 'Léa', 'guide', 'lié', 'Sans titre', 3, '3', '12', 0, -1, 5, '2026-01-01', '2026-01-02', true, false, null, undefined, 'oui', 'non'];

describe('filtres : mêmes résultats que le client', () => {
  it('chaque type, chaque opérateur, des valeurs variées', () => {
    let n = 0;
    for (const p of props) for (const op of OPS) for (const value of VALUES) {
      const f = { propertyId: p.id, op, ...(value === undefined ? {} : { value }) } as ViewConfig['filters'][number];
      const server = applyFilters(props, rows, [f]).map((r) => r.id);
      const client = (applyView(props, rows, { filters: [f], sort: [] }) as PresentedRow[]).map((r) => r.id);
      expect(server, `${p.type} ${op} ${JSON.stringify(value)}`).toEqual(client);
      n++;
    }
    expect(n).toBe(props.length * OPS.length * VALUES.length);
  });

  it('plusieurs filtres combinés (et) ; colonne inconnue ignorée', () => {
    const filters = [{ propertyId: 'n', op: 'gt', value: 0 }, { propertyId: 'inconnue', op: 'eq', value: 'x' }, { propertyId: 'm', op: 'contains', value: 'y' }] as ViewConfig['filters'];
    expect(applyFilters(props, rows, filters).map((r) => r.id)).toEqual((applyView(props, rows, { filters, sort: [] }) as PresentedRow[]).map((r) => r.id));
    expect(applyFilters(props, rows, filters).map((r) => r.id)).toEqual(['1']);
  });
});

describe('nouveaux types : sémantique serveur', () => {
  const p6: Property[] = [prop('u', 'url'), prop('e', 'email'), prop('id', 'unique_id'), prop('cb', 'created_by'), prop('ct', 'created_time'), prop('dr', 'date_range')];
  const r6 = [
    row('1', { u: 'https://exemple.fr/', e: 'a@b.fr', id: 'T-1', cb: { id: 'u1', name: 'Léa' }, ct: '2026-01-01', dr: { start: '2026-02-01', end: '2026-02-03' } }),
    row('2', { id: 'T-2', ct: '2026-03-01', dr: { start: '2026-01-15', end: null } }),
  ];
  const ids = (f: object) => applyFilters(p6, r6, [f as ViewConfig['filters'][number]]).map((r) => r.id);
  it('mêmes résultats que le client sur les nouveaux types', () => {
    const vals = ['exemple', 't-2', 'lea', '2026-02-01', '2026-01-15', '', null, 3];
    for (const p of p6) for (const op of OPS) for (const value of vals) {
      const f = { propertyId: p.id, op, value } as ViewConfig['filters'][number];
      const client = (applyView(p6, r6, { filters: [f], sort: [] }) as PresentedRow[]).map((r) => r.id);
      expect(ids(f), `${p.type} ${op} ${JSON.stringify(value)}`).toEqual(client);
    }
  });

  it('texte pour url, e-mail, ID unique, créé par ; date pour créé le ; plage sur son début', () => {
    expect(ids({ propertyId: 'u', op: 'contains', value: 'EXEMPLE' })).toEqual(['1']);
    expect(ids({ propertyId: 'e', op: 'empty' })).toEqual(['2']);
    expect(ids({ propertyId: 'id', op: 'eq', value: 't-2' })).toEqual(['2']);
    expect(ids({ propertyId: 'cb', op: 'contains', value: 'lea' })).toEqual(['1']);
    expect(ids({ propertyId: 'ct', op: 'gt', value: '2026-02-01' })).toEqual(['2']);
    expect(ids({ propertyId: 'dr', op: 'lt', value: '2026-02-01' })).toEqual(['2']);
    expect(ids({ propertyId: 'dr', op: 'eq', value: '2026-02-01' })).toEqual(['1']);
  });
});

describe('calcul des groupes', () => {
  const cfg = (c: Partial<ViewConfig>): ViewConfig => ({ type: 'chart', sort: [], filters: [], hidden: [], ...c });
  it('min et max, valeur absente, plafond de lignes', () => {
    const r = computeChart(props, rows, cfg({ groupBy: 'st', metric: 'max', valueId: 'n' }), 5000);
    expect(r.buckets).toEqual([
      { key: 'a', label: 'À faire', color: 'gray', value: 5, count: 1 },
      { key: 'b', label: 'Fait', color: 'green', value: 0, count: 1 },
      { key: '', label: 'Sans valeur', value: 12.5, count: 3 },
    ]);
    expect(computeChart(props, rows, cfg({ groupBy: 'st', metric: 'min', valueId: 'n' }), 5000).total).toBe(-1);
    // Formule non numérique : ignorée par le calcul (moyenne sur les seuls nombres).
    expect(computeChart(props, rows, cfg({ groupBy: 'c', metric: 'avg', valueId: 'f' }), 5000).total).toBe(3);
    const capped = computeChart(props, rows, cfg({ groupBy: 'st' }), 2);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(2);
  });
});
