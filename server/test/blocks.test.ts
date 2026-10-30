import { describe, expect, it } from 'vitest';
import { COLORS, docText, sanitizeDoc, type DocNode } from '../src/lib/content.js';
import { toMarkdown } from '../src/lib/markdown.js';
import { renderHtml } from '../src/lib/render-html.js';

const t = (text: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });
const details = (summary: string, ...body: DocNode[]): DocNode => ({ type: 'details', content: [{ type: 'detailsSummary', content: [t(summary)] }, { type: 'detailsContent', content: body }] });
const columns = (...cols: DocNode[][]): DocNode => ({ type: 'columns', content: cols.map((c) => ({ type: 'column', content: c })) });
const bad = (d: DocNode) => expect(() => sanitizeDoc(d)).toThrow(/Structure invalide/);

describe('couleurs, surlignage et alignement', () => {
  it('ne gardent que les noms de la palette', () => {
    const out = sanitizeDoc(doc({ ...p(t('a', [{ type: 'textColor', attrs: { color: 'red' } }]), t('b', [{ type: 'highlight', attrs: { color: 'blue' } }]), t('c', [{ type: 'highlight' }])), attrs: { align: 'center' } }));
    const [a, b, c] = out.content![0]!.content!;
    expect(a!.marks).toEqual([{ type: 'textColor', attrs: { color: 'red' } }]);
    expect(b!.marks).toEqual([{ type: 'highlight', attrs: { color: 'blue' } }]);
    expect(c!.marks).toEqual([{ type: 'highlight' }]);
    expect(out.content![0]!.attrs).toEqual({ align: 'center' });
  });

  it('refusent toute valeur qui n’est pas un nom de la palette (aucun CSS, aucun script)', () => {
    for (const evil of ['red; background:url(http://x)', '#ff0000', 'rgb(1,2,3)', '"><script>', 'expression(alert(1))', 7, null, '']) {
      const out = sanitizeDoc(doc(p(t('x', [{ type: 'textColor', attrs: { color: evil } }, { type: 'highlight', attrs: { color: evil } }]))));
      const marks = out.content![0]!.content![0]!.marks ?? [];
      expect(marks.find((m) => m.type === 'textColor'), JSON.stringify(evil)).toBeUndefined();
      expect(marks.find((m) => m.type === 'highlight')?.attrs?.color ?? null, JSON.stringify(evil)).toBeNull(); // surlignage par défaut, jamais la valeur reçue
    }
    const aligned = sanitizeDoc(doc({ ...p(t('x')), attrs: { align: 'center; position:fixed' } }, { type: 'heading', attrs: { level: 2, align: '<b>' }, content: [t('h')] }));
    expect(aligned.content![0]!.attrs).toBeUndefined();
    expect(aligned.content![1]!.attrs).toEqual({ level: 2 });
    expect(COLORS).toContain('yellow');
  });
});

describe('bloc dépliable', () => {
  it('se conserve et se retrouve à la recherche', () => {
    const d = doc(details('Titre caché', p(t('contenu secret'))));
    const out = sanitizeDoc(d);
    expect(out.content![0]!.type).toBe('details');
    expect(docText(out)).toContain('Titre caché');
    expect(docText(out)).toContain('contenu secret');
  });

  it('refuse une structure incomplète, inversée ou hors de son parent', () => {
    bad(doc({ type: 'details', content: [{ type: 'detailsContent', content: [p(t('x'))] }] }));
    bad(doc({ type: 'details', content: [{ type: 'detailsContent', content: [p(t('x'))] }, { type: 'detailsSummary', content: [t('x')] }] }));
    bad(doc({ type: 'details' }));
    bad(doc({ type: 'detailsSummary', content: [t('orphelin')] }));
    bad(doc({ type: 'detailsContent', content: [p(t('orphelin'))] }));
    bad(doc({ type: 'details', content: [{ type: 'detailsSummary', content: [p(t('un bloc dans un titre'))] }, { type: 'detailsContent', content: [p(t('x'))] }] }));
    bad(doc({ type: 'details', content: [{ type: 'detailsSummary', content: [t('x')] }, { type: 'detailsContent', content: [] }] }));
  });

  it('peut contenir d’autres blocs et s’imbriquer', () => {
    expect(() => sanitizeDoc(doc(details('a', details('b', p(t('c'))), columns([p(t('1'))], [p(t('2'))]))))).not.toThrow();
  });
});

describe('colonnes', () => {
  it('acceptent de 2 à 4 colonnes', () => {
    for (const n of [2, 3, 4]) expect(() => sanitizeDoc(doc(columns(...Array.from({ length: n }, (_, i) => [p(t(`c${i}`))]))))).not.toThrow();
  });

  it('refusent 1 ou 5 colonnes, un enfant d’un autre type, une colonne vide ou orpheline', () => {
    bad(doc(columns([p(t('seule'))])));
    bad(doc(columns(...Array.from({ length: 5 }, () => [p(t('x'))]))));
    bad(doc({ type: 'columns', content: [{ type: 'column', content: [p(t('a'))] }, p(t('pas une colonne'))] }));
    bad(doc({ type: 'columns', content: [{ type: 'column', content: [p(t('a'))] }, { type: 'column', content: [] }] }));
    bad(doc({ type: 'column', content: [p(t('orpheline'))] }));
    bad(doc({ type: 'callout', attrs: { type: 'info' }, content: [{ type: 'column', content: [p(t('x'))] }] }));
  });
});

describe('formule', () => {
  it('garde le texte LaTeX (5 000 caractères au plus) et la largeur', () => {
    const out = sanitizeDoc(doc({ type: 'math', attrs: { code: 'E = mc^2', width: 400 } }));
    expect(out.content![0]!.attrs).toEqual({ code: 'E = mc^2', width: 400 });
    expect(sanitizeDoc(doc({ type: 'math', attrs: { code: 'x'.repeat(5001) } })).content![0]!.attrs).toBeUndefined();
    expect(docText(out)).toContain('E = mc^2');
  });
});

describe('exports', () => {
  const sample = doc(details('Titre <b>', p(t('dedans'))), columns([p(t('gauche'))], [p(t('droite'))]), { type: 'math', attrs: { code: 'a$$b <script>' } });

  it('Markdown : dépliable en <details>, colonnes à la suite, formule entre $$', () => {
    const md = toMarkdown('Page', '', sample, () => null);
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>Titre b</summary>');
    expect(md).toMatch(/gauche\n\ndroite/);
    expect(md).toContain('$$\na$ $b <script>\n$$');
  });

  it('HTML (pages publiques) : tout est échappé, la formule reste du texte', () => {
    const html = renderHtml(sample, () => null);
    expect(html).toContain('<details><summary>Titre &lt;b&gt;</summary>');
    expect(html).toContain('<div><div><p>gauche</p></div><div><p>droite</p></div></div>');
    expect(html).toContain('<pre><code>a$$b &lt;script&gt;</code></pre>');
    expect(html).not.toContain('<script>');
  });
});
