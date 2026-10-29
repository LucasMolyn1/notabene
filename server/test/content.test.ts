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
