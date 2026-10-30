import { describe, expect, it } from 'vitest';
import { docText, sanitizeDoc } from '../src/lib/content.js';
import { toMarkdown } from '../src/lib/markdown.js';

const doc = { type: 'doc', content: [{ type: 'plantuml', attrs: { code: '@startuml\nA -> B : salut zorglub\n@enduml', onclick: 'x()' } }] };

describe('diagrammes PlantUML', () => {
  it('conserve le code et retire les attributs inconnus', () => {
    const clean = sanitizeDoc(doc);
    expect(clean.content?.[0]?.attrs).toEqual({ code: '@startuml\nA -> B : salut zorglub\n@enduml' });
  });
  it('est indexé pour la recherche et exporté en Markdown', () => {
    const clean = sanitizeDoc(doc);
    expect(docText(clean)).toContain('zorglub');
    expect(toMarkdown('T', null, clean, () => null)).toContain('```plantuml');
  });
});

describe('export Markdown : cellules de tableau', () => {
  const table = (text: string, marks?: { type: string }[]) => ({
    type: 'doc',
    content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] }] }] }] }],
  });
  it('échappe le séparateur de colonnes sans casser les antislashs', async () => {
    const { toMarkdown } = await import('../src/lib/markdown.js');
    const md = (doc: object) => toMarkdown('t', '', doc as never, () => null);
    expect(md(table('a|b'))).toContain('| a\\|b |');
    expect(md(table('a\\|b'))).toContain('| a\\\\\\|b |'); // antislash littéral (échappé) puis barre échappée
    // Code en ligne finissant par un antislash : la barre suivante reste échappée une seule fois.
    expect(md(table('x\\|', [{ type: 'code' }]))).toContain('`x\\|`');
  });
});

describe('largeur des blocs redimensionnés', () => {
  const block = (type: string, width: unknown) => sanitizeDoc({ type: 'doc', content: [{ type, attrs: { code: 'graph TD', width } }] }).content?.[0]?.attrs;
  it('conserve une largeur valide et écarte le reste', () => {
    expect(block('mermaid', 480)).toMatchObject({ width: 480 });
    expect(block('mermaid', null)).toMatchObject({ width: null });
    expect(block('mermaid', 10)).not.toHaveProperty('width');
    expect(block('mermaid', '480px')).not.toHaveProperty('width');
    expect(block('plantuml', 99_999)).not.toHaveProperty('width');
  });
});

