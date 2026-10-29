import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { importMarkdown, markdownToDoc, parseFrontMatter } from '../src/lib/markdown-import.js';
import { seedDemo } from '../src/seed.js';

let db: DB;
let spaceId: string;
beforeEach(() => {
  db = openDb(':memory:');
  seedDemo(db);
  spaceId = (db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }).id;
});
afterEach(() => db.close());

const stats = () => ({ resolveLink: () => null, from: 'x', stats: { pages: 0, folders: 0, links: { resolved: 0, unresolved: 0 }, images: 0 } });
const pageByTitle = (t: string) => db.prepare('SELECT id, parent_id, content FROM pages WHERE title = ? AND space_id = ?').get(t, spaceId) as { id: string; parent_id: string | null; content: string };

describe('conversion Markdown', () => {
  it('lit l’en-tête YAML', () => {
    const { meta, body } = parseFrontMatter('---\ntitle: "Mon titre"\ntags: a, b\n---\n# Corps');
    expect(meta.title).toBe('Mon titre');
    expect(body).toBe('# Corps');
  });

  it('convertit titres, listes, tâches, tableaux, code et diagrammes', () => {
    const md = '# T1\n\n#### Profond\n\ntexte **gras** et `code` et [site](https://example.com)\n\n- a\n- b\n\n1. un\n2. deux\n\n- [x] fait\n- [ ] à faire\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n```plantuml\n@startuml\nA->B\n@enduml\n```\n\n---\n';
    const doc = markdownToDoc(md, stats());
    const types = doc.content!.map((n) => n.type);
    expect(types).toEqual(['heading', 'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'table', 'codeBlock', 'mermaid', 'plantuml', 'horizontalRule']);
    expect(doc.content![1]!.attrs).toEqual({ level: 3 });
    expect(JSON.stringify(doc)).toContain('"checked":true');
  });

  it('transforme les blockquotes Wiki.js et GitHub en callouts', () => {
    const doc = markdownToDoc('> Attention ici\n{.is-warning}\n\n> [!TIP]\n> Une astuce\n', stats());
    expect(doc.content!.map((n) => [n.type, n.attrs?.type])).toEqual([['callout', 'warning'], ['callout', 'success']]);
  });
});

describe('import dans un espace', () => {
  const files = [
    { path: 'en/home.md', content: '---\ntitle: Accueil\n---\nVoir [le guide](/en/guides/intro) et [absent](/en/nope).\n\n![logo](/uploads/logo.png)' },
    { path: 'en/guides/intro.md', content: '---\ntitle: Introduction\n---\n# Intro\n\nbonjour narval' },
    { path: 'en/guides/avance/deep.md', content: 'Contenu profond' },
  ];

  it('crée la hiérarchie, les dossiers manquants et résout les liens internes', () => {
    const r = importMarkdown(db, { spaceId, files, userId: null });
    expect(r).toMatchObject({ pages: 3, folders: 2, links: { resolved: 1, unresolved: 1 }, images: 1 });
    const guides = pageByTitle('Guides');
    const intro = pageByTitle('Introduction');
    expect(intro.parent_id).toBe(guides.id);
    expect(pageByTitle('Avance').parent_id).toBe(guides.id);
    expect(pageByTitle('Deep').parent_id).toBe(pageByTitle('Avance').id);
    expect(pageByTitle('Accueil').content).toContain(`"id":"${intro.id}"`);
    expect(pageByTitle('Accueil').content).toContain('[Image : logo]');
  });

  it('rend le contenu importé cherchable', () => {
    importMarkdown(db, { spaceId, files, userId: null });
    const hit = db.prepare("SELECT title FROM pages_fts WHERE pages_fts MATCH 'narval'").all();
    expect(hit.length).toBeGreaterThan(0);
  });

  it('refuse chemins dangereux, doublons et espace inconnu', () => {
    expect(() => importMarkdown(db, { spaceId, files: [{ path: '../etc/passwd.md', content: 'x' }], userId: null })).toThrow(/Chemin invalide/);
    expect(() => importMarkdown(db, { spaceId, files: [{ path: 'a.md', content: 'x' }, { path: 'A.md', content: 'y' }], userId: null })).toThrow(/double/);
    expect(() => importMarkdown(db, { spaceId: 'inconnu', files: [{ path: 'a.md', content: 'x' }], userId: null })).toThrow(/Espace/);
  });
});

describe('route d’import', () => {
  it('est réservée aux administrateurs', async () => {
    const app: FastifyInstance = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' }), db, clientDir: '/nonexistent' });
    const login = async (role: string) => {
      const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
      const cookies = { nb_session: r.cookies.find((c) => c.name === 'nb_session')!.value };
      const me = (await app.inject({ method: 'GET', url: '/api/v1/me', cookies })).json();
      return { cookies, headers: { 'x-csrf-token': me.csrf as string } };
    };
    const payload = { spaceId, files: [{ path: 'a.md', content: '# Salut' }] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/import/markdown', payload, ...(await login('editor')) })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/admin/import/markdown', payload, ...(await login('admin')) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pages).toBe(1);
    await app.close();
  });
});
