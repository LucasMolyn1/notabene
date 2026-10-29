// Conversion document ProseMirror (JSON) <-> Yjs, sans schéma, au format de y-prosemirror / @tiptap/y-tiptap :
// un nœud = Y.XmlElement (attributs = attrs), les suites de textes = un Y.XmlText dont les marques sont des attributs de formatage.
import * as Y from 'yjs';
import type { DocNode } from './content.js';

type Marks = NonNullable<DocNode['marks']>;

const marksToAttributes = (marks: Marks = []) => Object.fromEntries(marks.map((m) => [m.type, m.attrs ?? {}]));

function toYNode(node: DocNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(node.attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v as string);
  el.insert(0, toYChildren(node.content ?? []));
  return el;
}

function toYChildren(nodes: DocNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let run: DocNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = new Y.XmlText();
    text.applyDelta(run.map((n) => ({ insert: n.text ?? '', attributes: marksToAttributes(n.marks) })));
    out.push(text);
    run = [];
  };
  for (const n of nodes) {
    if (n.type === 'text') run.push(n);
    else { flush(); out.push(toYNode(n)); }
  }
  flush();
  return out;
}

export function jsonToYFragment(doc: DocNode, fragment: Y.XmlFragment) {
  fragment.insert(0, toYChildren(doc.content ?? []));
}

function fromYChildren(parent: Y.XmlFragment | Y.XmlElement): DocNode[] {
  const out: DocNode[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const d of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof d.insert !== 'string' || !d.insert) continue;
        const marks = Object.entries(d.attributes ?? {}).filter(([k]) => k !== 'ychange').map(([type, attrs]) => {
          const a = attrs && typeof attrs === 'object' && Object.keys(attrs).length ? (attrs as Record<string, unknown>) : undefined;
          return a ? { type, attrs: a } : { type };
        });
        out.push({ type: 'text', text: d.insert, ...(marks.length ? { marks } : {}) });
      }
    } else if (child instanceof Y.XmlElement) {
      const attrs = child.getAttributes() as Record<string, unknown>;
      const content = fromYChildren(child);
      out.push({ type: child.nodeName, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) });
    }
  }
  return out;
}

export function yFragmentToJson(fragment: Y.XmlFragment): DocNode {
  return { type: 'doc', content: fromYChildren(fragment) };
}
