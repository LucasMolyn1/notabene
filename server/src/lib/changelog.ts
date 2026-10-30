// Nouveautés : CHANGELOG.md (embarqué dans l'image) lu et structuré pour l'écran « À propos ».
// Le texte est rendu tel quel par le client (jamais en HTML) : on retire seulement la mise en forme Markdown.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Release {
  version: string;
  date: string;
  summary: string;
  sections: { title: string; items: string[] }[];
}

const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim().slice(0, 600);

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: Release['sections'][number] | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const head = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(raw);
    if (head) { release = { version: head[1]!, date: head[2]!, summary: '', sections: [] }; releases.push(release); section = null; continue; }
    if (/^## /.test(raw)) { release = null; section = null; continue; } // « Non publié » ou autre : ignoré
    if (!release) continue;
    const title = /^### (.+)$/.exec(raw);
    if (title) { section = { title: plain(title[1]!), items: [] }; release.sections.push(section); continue; }
    const item = /^- (.+)$/.exec(raw);
    if (item && section) { section.items.push(plain(item[1]!)); continue; }
    if (!section && raw.trim() && !release.summary) release.summary = plain(raw);
  }
  return releases;
}

let cache: Release[] | null = null;
export function loadChangelog(): Release[] {
  if (cache) return cache;
  const file = resolve(process.cwd(), 'CHANGELOG.md');
  cache = existsSync(file) ? parseChangelog(readFileSync(file, 'utf8')) : [];
  return cache;
}

// Compare deux versions « x.y.z » : négatif si a < b.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
