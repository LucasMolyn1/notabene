// Conversion d'un document TipTap (JSON) en Markdown GFM (export API).
import type { DocNode } from './content.js';

const WRAP: Record<string, [string, string]> = {
  bold: ['**', '**'], italic: ['_', '_'], strike: ['~~', '~~'], code: ['`', '`'], underline: ['<u>', '</u>'], highlight: ['==', '=='],
};
const ALERT: Record<string, string> = { info: 'NOTE', warning: 'WARNING', success: 'TIP', danger: 'CAUTION' };

type TitleOf = (id: string) => string | null;
/** Nom d'une personne mentionnée, ou null si la personne n'a pas à être nommée (« @utilisateur »). */
export type MentionName = (id: string) => string | null;

export function toMarkdown(title: string, icon: string, doc: DocNode, titleOf: TitleOf, mentionName: MentionName = () => null): string {
  const inline = (nodes: DocNode[] = []): string => nodes.map((n) => {
    if (n.type === 'hardBreak') return '  \n';
    if (n.type === 'mention') return `@${(mentionName(String(n.attrs?.id)) ?? 'utilisateur').replace(/[\r\n]+/g, ' ').replace(/([\\*_`~[\]])/g, '\\$1')}`;
    if (n.type === 'pageLink') return `[${titleOf(String(n.attrs?.id)) ?? 'Sans titre'}](/p/${n.attrs?.id})`;
    if (n.type !== 'text') return '';
    const marks = n.marks ?? [];
    let t = n.text ?? '';
    if (!marks.some((m) => m.type === 'code')) t = t.replace(/([\\*_`~[\]])/g, '\\$1');
    for (const m of marks) if (WRAP[m.type]) t = WRAP[m.type][0] + t + WRAP[m.type][1];
    const link = marks.find((m) => m.type === 'link');
    return link ? `[${t}](${String(link.attrs?.href)})` : t;
  }).join('');

  const quote = (s: string) => s.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

  const list = (node: DocNode, marker: (item: DocNode, i: number) => string) => (node.content ?? []).map((item, i) => {
    const m = marker(item, i);
    const pad = ' '.repeat(m.length);
    return m + blocks(item.content, '\n').split('\n').map((l, j) => (j === 0 || !l ? l : pad + l)).join('\n');
  }).join('\n');

  const block = (node: DocNode): string => {
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'paragraph': return inline(node.content);
      case 'heading': return `${'#'.repeat(Number(a.level) || 1)} ${inline(node.content)}`;
      case 'blockquote': return quote(blocks(node.content));
      case 'callout': return quote(`[!${ALERT[String(a.type)] ?? 'NOTE'}]\n${blocks(node.content)}`);
      case 'codeBlock': return `\`\`\`${a.language ?? ''}\n${(node.content ?? []).map((t) => t.text).join('')}\n\`\`\``;
      case 'plantuml': return `\`\`\`plantuml\n${a.code ?? ''}\n\`\`\``;
      case 'mermaid': return `\`\`\`mermaid\n${a.code ?? ''}\n\`\`\``;
      case 'math': return `$$\n${String(a.code ?? '').replace(/\$\$/g, '$ $')}\n$$`;
      case 'details': {
        const [summary, body] = node.content ?? [];
        return `<details>\n<summary>${inline(summary?.content).replace(/[<>]/g, '')}</summary>\n\n${blocks(body?.content)}\n\n</details>`;
      }
      case 'columns': return blocks((node.content ?? []).flatMap((c) => c.content ?? []));
      case 'excalidraw': return '_[Dessin Excalidraw]_';
      case 'drawio': return '_[Diagramme Draw.io]_';
      case 'horizontalRule': return '---';
      case 'image': return String(a.src).startsWith('data:') ? `_[Image : ${a.alt ?? ''}]_` : `![${a.alt ?? ''}](${a.src})`;
      case 'bulletList': return list(node, () => '- ');
      case 'orderedList': return list(node, (_, i) => `${(Number(a.start) || 1) + i}. `);
      case 'taskList': return list(node, (item) => `- [${item.attrs?.checked ? 'x' : ' '}] `);
      case 'table': {
        const rows = (node.content ?? []).map((r) => (r.content ?? []).map((c) =>
          (c.content ?? []).map((b) => inline(b.content)).join(' ').replace(/(\\*)\|/g, (_m, bs: string) => (bs.length % 2 ? `${bs}|` : `${bs}\\|`)).replace(/\n/g, ' ')));
        if (!rows.length) return '';
        const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
        return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
      }
      default: return blocks(node.content);
    }
  };

  const blocks = (nodes: DocNode[] = [], sep = '\n\n'): string => nodes.map(block).filter((s) => s !== '').join(sep);

  return `# ${icon ? `${icon} ` : ''}${title || 'Sans titre'}\n\n${blocks(doc.content)}\n`;
}
