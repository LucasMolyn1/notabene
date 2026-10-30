// Fonctions pures du client (client/src/diff.js), testées ici car le dépôt n'a qu'une suite de tests.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- module JavaScript du client, sans déclaration de types
import { MAX_BLOCKS, blocksOf, diffBlocks, diffWords } from '../../client/src/diff.js';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h2 = (text: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
const doc = (...content: object[]) => ({ type: 'doc', content });
const ops = (a: object, b: object) => (diffBlocks(blocksOf(a), blocksOf(b)) as { op: string; block: { text: string }; old?: { text: string } }[]).map((d) => `${d.op}:${d.block.text}${d.old ? `<-${d.old.text}` : ''}`);

describe('blocs d’un document', () => {
  it('prend les paragraphes, titres, code, diagrammes et formules, dans l’ordre, sans les blocs vides', () => {
    const blocks = blocksOf(doc(h2('Titre'), p(''), { type: 'bulletList', content: [{ type: 'listItem', content: [p('item')] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'a = 1' }] }, { type: 'math', attrs: { code: 'x^2' } },
      { type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Sommaire' }] }, { type: 'detailsContent', content: [p('dedans')] }] }));
    expect(blocks.map((b: { kind: string; text: string }) => `${b.kind}:${b.text}`)).toEqual(['h:Titre', 'p:item', 'code:a = 1', 'code:[math] x^2', 'p:Sommaire', 'p:dedans']);
  });
});

describe('différences entre versions', () => {
  it('reconnaît ajout, suppression et modification d’un bloc', () => {
    const a = doc(p('un'), p('deux'), p('trois'));
    const b = doc(p('un'), p('deux modifié'), p('trois'), p('quatre'));
    expect(ops(a, b)).toEqual(['same:un', 'chg:deux modifié<-deux', 'same:trois', 'add:quatre']);
    expect(ops(doc(p('un'), p('deux')), doc(p('un')))).toEqual(['same:un', 'del:deux']);
  });

  it('un document identique ne donne que des blocs inchangés', () => {
    const a = doc(h2('T'), p('x'));
    expect(ops(a, a).every((o) => o.startsWith('same:'))).toBe(true);
  });

  it('distingue un titre d’un paragraphe de même texte', () => {
    expect(ops(doc(p('Texte')), doc(h2('Texte')))).toEqual(['chg:Texte<-Texte']);
  });

  it('refuse les documents trop longs au lieu de bloquer le navigateur', () => {
    const long = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ kind: 'p', text: `b${i}` }));
    expect(diffBlocks(long, [])).toBeNull();
  });

  it('compare les mots d’un bloc modifié', () => {
    expect(diffWords('le chat dort', 'le chien dort').filter((w: { op: string }) => w.op !== 'same').map((w: { op: string; text: string }) => `${w.op}:${w.text}`)).toEqual(['del:chat', 'add:chien']);
    expect(diffWords('a b', 'a b').every((w: { op: string }) => w.op === 'same')).toBe(true);
  });
});
