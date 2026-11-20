// Valeurs par défaut de l'éditeur connues du serveur (lib/editor-defaults.ts) : forme canonique, et absence de dérive avec le schéma
// TipTap du client (mêmes extensions que baseExtensions dans client/src/editor.js).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { allowedAttrs, type DocNode } from '../src/lib/content.js';
import { canonicalDoc, EDITOR_MARK_DEFAULTS, EDITOR_NODE_DEFAULTS, sameEditorContent } from '../src/lib/editor-defaults.js';

const text = (t: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (t: string): DocNode => ({ type: 'paragraph', content: [text(t)] });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

describe('forme canonique du contenu', () => {
  const stored = doc(
    { type: 'heading', content: [text('Titre')] },
    { type: 'taskList', content: [{ type: 'taskItem', content: [para('Tâche')] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [para('Un')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('A')] }] }] },
    { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('ls')] },
  );
  // Ce que l'éditeur renvoie à l'ouverture : défauts ajoutés, paragraphe final vide, attribut nul.
  const opened = doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Titre')] },
    { type: 'taskList', attrs: { checklist: false }, content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Tâche')] }] },
    { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [para('Un')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para('A')] }] }] },
    { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('ls')] },
    { type: 'paragraph' },
  );

  it('ignore les valeurs par défaut, les nuls et le paragraphe vide final', () => {
    expect(sameEditorContent(stored, opened)).toBe(true);
    expect(canonicalDoc(opened)).toEqual(canonicalDoc(stored));
  });

  it('ignore l’ordre des marques et le découpage des textes', () => {
    const a = doc({ type: 'paragraph', content: [text('ab', [{ type: 'bold' }, { type: 'italic' }]), text('c')] });
    const b = doc({ type: 'paragraph', content: [text('a', [{ type: 'italic' }, { type: 'bold' }]), text('b', [{ type: 'bold' }, { type: 'italic' }]), text('c')] });
    expect(sameEditorContent(a, b)).toBe(true);
  });

  it('voit toute vraie modification', () => {
    const changes: DocNode[] = [
      doc({ type: 'heading', attrs: { level: 2 }, content: [text('Titre')] }, ...stored.content!.slice(1)),
      doc(stored.content![0]!, { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('Tâche')] }] }, ...stored.content!.slice(2)),
      doc(...stored.content!.slice(0, 4), { type: 'codeBlock', content: [text('ls')] }),
      doc(...stored.content!.slice(0, 4), { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('ls -l')] }),
      doc(...stored.content!, para('Suite')),
      doc(...stored.content!.slice(0, 3), { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [para('A')] }] }] }, stored.content![4]!),
      doc(...stored.content!.slice(0, 2), { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para('Un')] }] }, ...stored.content!.slice(3)),
      doc({ type: 'paragraph', content: [text('Titre')] }, ...stored.content!.slice(1)),
    ];
    for (const changed of changes) expect(sameEditorContent(stored, changed)).toBe(false);
    // Un paragraphe vide au milieu, ou un texte en gras, est une vraie modification.
    expect(sameEditorContent(doc(para('a'), para('b')), doc(para('a'), { type: 'paragraph' }, para('b')))).toBe(false);
    expect(sameEditorContent(doc(para('a')), doc({ type: 'paragraph', content: [text('a', [{ type: 'bold' }])] }))).toBe(false);
  });
});

// Schéma de l'éditeur du client, construit sans navigateur. Les extensions sans valeur par défaut non nulle et qui exigent un DOM
// au chargement (bloc « base ») sont remplacées par une déclaration minimale ; l'extension TaskList est étendue dans editor.js même
// (attribut `checklist`), vérifiée sur le source.
async function clientSchema() {
  vi.stubGlobal('location', new URL('http://localhost/'));
  const { getSchema, Node } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { TaskList, TaskItem } = await import('@tiptap/extension-list');
  const { Table, TableRow, TableCell, TableHeader } = await import('@tiptap/extension-table');
  const blocks = await import('../../client/src/editor/blocks.js');
  const { CodeBlockEditor } = await import('../../client/src/editor/code-block.js');
  const { ResizableImage } = await import('../../client/src/editor/image.js');
  const { AudioBlock, FileBlock, VideoBlock } = await import('../../client/src/editor/attachments.js');
  const { CommentAnchor } = await import('../../client/src/editor/comment-anchor.js');
  const { Embed } = await import('../../client/src/editor/embed.js');
  const { Mention } = await import('../../client/src/editor/mention.js');
  const { Callout, PageLink } = await import('../../client/src/editor/nodes.js');
  const { SyncedCopy, SyncedSource } = await import('../../client/src/editor/synced.js');
  const { DrawIo, Excalidraw, MathBlock, Mermaid, PlantUml } = await import('../../client/src/diagrams.js');
  // Bloc « workflow » : pris dans client/src/workflow/index.js dès que le client l'a livré (le nœud TipTap dont le nom est « workflow »).
  const workflowUrl = new URL('../../client/src/workflow/index.js', import.meta.url);
  const workflowNodes = existsSync(workflowUrl)
    ? Object.values(await import(workflowUrl.href) as Record<string, unknown>).filter((e) => (e as { name?: string })?.name === 'workflow')
    : [];
  vi.unstubAllGlobals();
  const source = readFileSync(new URL('../../client/src/editor.js', import.meta.url), 'utf8');
  expect(source).toMatch(/checklist: \{\s*default: false,/);
  const BaseBlock = Node.create({ name: 'baseBlock', group: 'block', atom: true, addAttributes: () => ({ id: { default: null }, view: { default: null } }) });
  return getSchema([
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
    CodeBlockEditor, blocks.ColoredHighlight, blocks.TextColor, blocks.TextAlign, blocks.Details, blocks.DetailsSummary, blocks.DetailsContent,
    blocks.Columns, blocks.Column,
    TaskList.extend({ addAttributes() { return { ...this.parent?.(), checklist: { default: false } }; } }),
    TaskItem.configure({ nested: true }), ResizableImage, FileBlock, VideoBlock, AudioBlock,
    Table, TableRow, TableHeader, TableCell, Callout, PageLink, Mention, CommentAnchor, Embed, BaseBlock,
    Mermaid, MathBlock, PlantUml, Excalidraw, DrawIo, SyncedSource, SyncedCopy, ...(workflowNodes as never[]),
  ]);
}

describe('dérive entre le serveur et le schéma de l’éditeur', () => {
  it('les valeurs par défaut non nulles du serveur sont exactement celles du client', async () => {
    const schema = await clientSchema();
    const { nodes, marks } = allowedAttrs();
    const expected = (specs: Record<string, { default?: unknown }> | undefined, keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const d = specs?.[k]?.default;
        if (d !== null && d !== undefined) out[k] = d;
      }
      return out;
    };
    const hasWorkflow = !!schema.nodes.workflow;
    for (const [type, keys] of Object.entries(nodes)) {
      if (type === 'workflow' && !hasWorkflow) continue; // le client n'a pas encore livré le bloc : la dérive sera vérifiée dès son arrivée
      expect(schema.nodes[type], `nœud « ${type} » absent du schéma du client`).toBeDefined();
      expect(EDITOR_NODE_DEFAULTS[type] ?? {}, `défauts de « ${type} »`).toEqual(expected(schema.nodes[type]!.spec.attrs as never, keys));
    }
    for (const [type, keys] of Object.entries(marks)) {
      expect(schema.marks[type], `marque « ${type} » absente du schéma du client`).toBeDefined();
      expect(EDITOR_MARK_DEFAULTS[type] ?? {}, `défauts de la marque « ${type} »`).toEqual(expected(schema.marks[type]!.spec.attrs as never, keys));
    }
    // Aucune valeur par défaut pour un type ou un attribut que l'assainissement ne garde pas.
    for (const [type, attrs] of Object.entries(EDITOR_NODE_DEFAULTS)) for (const k of Object.keys(attrs)) expect(nodes[type]).toContain(k);
    for (const [type, attrs] of Object.entries(EDITOR_MARK_DEFAULTS)) for (const k of Object.keys(attrs)) expect(marks[type]).toContain(k);
  });
});
