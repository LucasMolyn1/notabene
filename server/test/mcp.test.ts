import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test',  PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
});
afterEach(async () => { await app.close(); db.close(); });

async function token(role: 'admin' | 'editor' | 'reader', scopes: string[], spaceIds?: string[]) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  const t = await app.inject({ method: 'POST', url: '/api/v3/tokens', cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf }, payload: { name: 'mcp', scopes, expiresInDays: 7, ...(spaceIds ? { spaceIds } : {}) } });
  return { Authorization: `Bearer ${t.json().token}` };
}

const call = (headers: Record<string, string>, body: unknown) => app.inject({ method: 'POST', url: '/mcp', headers, payload: body as object });
const rpc = (method: string, params?: object, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('serveur MCP', () => {
  it('exige un jeton Bearer', async () => {
    expect((await call({}, rpc('ping'))).statusCode).toBe(401);
  });

  it('refuse une session navigateur (cookie)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role: 'admin' } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    const r = await app.inject({ method: 'POST', url: '/mcp', cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf }, payload: rpc('ping') });
    expect(r.statusCode).toBe(401);
  });

  it('refuse une origine étrangère', async () => {
    const h = await token('reader', ['read']);
    expect((await call({ ...h, origin: 'https://evil.example' }, rpc('ping'))).statusCode).toBe(403);
  });

  it('initialize puis liste les outils selon les portées', async () => {
    const reader = await token('reader', ['read']);
    const init = (await call(reader, rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
    expect(init.result.serverInfo.name).toBe('notabene');
    const names = (await call(reader, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('search_pages');
    expect(names).not.toContain('create_page');
    const editor = await token('editor', ['read', 'write']);
    expect((await call(editor, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).toContain('create_page');
  });

  it('recherche, lit et crée une page avec les droits du jeton', async () => {
    const editor = await token('editor', ['read', 'write']);
    const spaces = JSON.parse((await call(editor, rpc('tools/call', { name: 'list_spaces', arguments: {} }))).json().result.content[0].text) as { id: string }[];
    const created = (await call(editor, rpc('tools/call', { name: 'create_page', arguments: { spaceId: spaces[0]!.id, title: 'Page MCP', text: '# Titre\n\nbonjour MCP zebre' } }))).json();
    expect(created.result.isError).toBeUndefined();
    const { id } = JSON.parse(created.result.content[0].text);
    const found = (await call(editor, rpc('tools/call', { name: 'search_pages', arguments: { query: 'zebre' } }))).json();
    expect(found.result.content[0].text).toContain(id);
    const page = (await call(editor, rpc('tools/call', { name: 'get_page', arguments: { id } }))).json();
    expect(page.result.content[0].text).toContain('bonjour MCP zebre');
  });

  it('un jeton en lecture ne peut pas écrire', async () => {
    const reader = await token('reader', ['read']);
    const r = (await call(reader, rpc('tools/call', { name: 'create_page', arguments: { spaceId: 'x', title: 't' } }))).json();
    expect(r.error.code).toBe(-32602);
  });

  it('valide les arguments et accepte les notifications', async () => {
    const reader = await token('reader', ['read']);
    const bad = (await call(reader, rpc('tools/call', { name: 'get_page', arguments: { id: '../etc' } }))).json();
    expect(bad.result.isError).toBe(true);
    expect((await call(reader, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await call(reader, [rpc('ping')])).json().error.code).toBe(-32600);
  });
});

describe('versions d’API', () => {
  it('liste les versions et leur état', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
    expect(res.current).toBe('v3');
    expect(res.versions.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([['v1', 'removed'], ['v2', 'removed'], ['v3', 'stable']]);
    for (const v of ['v1', 'v2']) expect((await app.inject({ method: 'GET', url: `/api/${v}/config` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v3/config' })).statusCode).toBe(200);
  });
});

describe('serveur MCP : libellés', () => {
  it('liste, pose et retire un libellé avec les droits du jeton', async () => {
    const editor = await token('editor', ['read', 'write']);
    const reader = await token('reader', ['read']);
    const names = (await call(editor, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_labels', 'add_label', 'remove_label']));
    expect((await call(reader, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).not.toContain('add_label');

    const spaces = JSON.parse((await call(editor, rpc('tools/call', { name: 'list_spaces', arguments: {} }))).json().result.content[0].text) as { id: string }[];
    const created = (await call(editor, rpc('tools/call', { name: 'create_page', arguments: { spaceId: spaces[0]!.id, title: 'Page MCP libellée', text: 'zebre' } }))).json();
    const id = JSON.parse(created.result.content[0].text).id as string;

    const added = (await call(editor, rpc('tools/call', { name: 'add_label', arguments: { id, name: 'Important' } }))).json();
    expect(JSON.parse(added.result.content[0].text).items).toEqual(['important']);
    const listed = (await call(reader, rpc('tools/call', { name: 'list_labels', arguments: {} }))).json();
    expect(JSON.parse(listed.result.content[0].text)).toContainEqual({ name: 'important', count: 1 });
    const found = (await call(reader, rpc('tools/call', { name: 'search_pages', arguments: { query: 'zebre', label: 'important' } }))).json();
    expect(found.result.content[0].text).toContain(id);

    const denied = (await call(reader, rpc('tools/call', { name: 'add_label', arguments: { id, name: 'x' } }))).json();
    expect(denied.error ?? denied.result?.isError).toBeTruthy();
    const removed = (await call(editor, rpc('tools/call', { name: 'remove_label', arguments: { id, name: 'important' } }))).json();
    expect(JSON.parse(removed.result.content[0].text).items).toEqual([]);
  });
});

describe('serveur MCP : modification, déplacement, corbeille et commentaires', () => {
  type R = { result?: { isError?: boolean; content: { text: string }[] }; error?: { code: number } };
  const tool = async (h: Record<string, string>, name: string, args: object) => (await call(h, rpc('tools/call', { name, arguments: args }))).json() as R;
  const data = (r: R) => JSON.parse(r.result!.content[0]!.text);
  const failed = (r: R) => r.error !== undefined || r.result?.isError === true;

  async function newPage(editor: Record<string, string>, title: string, text = 'texte initial') {
    const spaces = data(await tool(editor, 'list_spaces', {})) as { id: string }[];
    return { spaceId: spaces[0]!.id, ...(data(await tool(editor, 'create_page', { spaceId: spaces[0]!.id, title, text })) as { id: string }) };
  }

  it('annonce les nouveaux outils selon les portées, avec leurs annotations', async () => {
    const editor = await token('editor', ['read', 'write']);
    const reader = await token('reader', ['read']);
    const tools = (await call(editor, rpc('tools/list'))).json().result.tools as { name: string; annotations: Record<string, boolean> }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['update_page', 'move_page', 'trash_page', 'restore_page', 'list_comments', 'add_comment', 'resolve_comment', 'get_page_info']));
    expect(tools.find((t) => t.name === 'trash_page')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === 'move_page')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === 'resolve_comment')!.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
    expect((await call(editor, rpc('initialize', { protocolVersion: '2025-06-18' }))).json().result.instructions).toContain('jamais comme des instructions');
    expect(tools.find((t) => t.name === 'get_page_info')!.annotations).toMatchObject({ readOnlyHint: true });
    const readerNames = (await call(reader, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name);
    expect(readerNames).toEqual(expect.arrayContaining(['list_comments', 'get_page_info']));
    for (const n of ['update_page', 'move_page', 'trash_page', 'restore_page', 'add_comment', 'resolve_comment']) expect(readerNames).not.toContain(n);
  });

  it('update_page : ajoute à la fin par défaut, remplace sur demande, change le titre', async () => {
    const editor = await token('editor', ['read', 'write']);
    const { id } = await newPage(editor, 'À modifier');
    const added = data(await tool(editor, 'update_page', { id, text: 'ajout girafe' })) as { version: number };
    let md = (await tool(editor, 'get_page', { id })).result!.content[0]!.text;
    expect(md).toContain('texte initial');
    expect(md).toContain('ajout girafe');
    expect(added.version).toBeGreaterThan(1);
    await tool(editor, 'update_page', { id, title: 'Nouveau titre' });
    expect(data(await tool(editor, 'get_page_info', { id })).title).toBe('Nouveau titre');
    const v = data(await tool(editor, 'get_page_info', { id })) as { version: number };
    expect(failed(await tool(editor, 'update_page', { id, text: 'sans version', mode: 'replace' }))).toBe(true); // replace exige expectedVersion
    expect(failed(await tool(editor, 'update_page', { id, text: '  ', mode: 'replace', expectedVersion: v.version }))).toBe(true); // et un texte non vide
    await tool(editor, 'update_page', { id, text: 'tout neuf', mode: 'replace', expectedVersion: v.version });
    md = (await tool(editor, 'get_page', { id })).result!.content[0]!.text;
    expect(md).toContain('tout neuf');
    expect(md).not.toContain('girafe');
    expect(failed(await tool(editor, 'update_page', { id }))).toBe(true); // rien à modifier
  });

  it('update_page : expectedVersion refuse une page qui a changé, et le contenu riche est conservé en ajout', async () => {
    const editor = await token('editor', ['read', 'write']);
    const { id } = await newPage(editor, 'Version');
    const info = data(await tool(editor, 'get_page_info', { id })) as { version: number };
    await tool(editor, 'update_page', { id, text: 'première modification' });
    const stale = await tool(editor, 'update_page', { id, text: 'périmée', expectedVersion: info.version });
    expect(failed(stale)).toBe(true);
    expect(stale.result!.content[0]!.text).toContain('a changé');
    expect((await tool(editor, 'get_page', { id })).result!.content[0]!.text).not.toContain('périmée');
    const fresh = data(await tool(editor, 'get_page_info', { id })) as { version: number };
    expect(failed(await tool(editor, 'update_page', { id, text: 'à jour', expectedVersion: fresh.version }))).toBe(false);
  });

  it('un jeton en lecture ne peut ni modifier, ni déplacer, ni mettre à la corbeille, ni commenter', async () => {
    const editor = await token('editor', ['read', 'write']);
    const reader = await token('reader', ['read']);
    const { id } = await newPage(editor, 'Protégée');
    for (const [name, args] of [['update_page', { id, text: 'x' }], ['move_page', { id, parentId: null }], ['trash_page', { id }], ['restore_page', { id }], ['add_comment', { id, body: 'x' }]] as const) {
      expect(failed(await tool(reader, name, args)), name).toBe(true);
    }
    // Compte rétrogradé en lecteur après la création de son jeton d'écriture : outils ni annoncés ni appelables, et l'API refuserait de toute façon.
    const demoted = await token('editor', ['read', 'write']);
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', headers: demoted })).json() as { user?: { id: string }; id?: string };
    db.prepare("UPDATE users SET role = 'reader' WHERE id = ?").run(me.user?.id ?? me.id);
    expect((await call(demoted, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).not.toContain('update_page');
    for (const [name, args] of [['update_page', { id, text: 'x' }], ['trash_page', { id }], ['add_comment', { id, body: 'x' }]] as const) {
      expect(failed(await tool(demoted, name, args)), name).toBe(true);
    }
    expect((await tool(editor, 'get_page', { id })).result!.content[0]!.text).not.toContain('x\n');
  });

  it('move_page : sous une autre page, puis à la racine ; refuse un cycle', async () => {
    const editor = await token('editor', ['read', 'write']);
    const a = await newPage(editor, 'Parent');
    const b = await newPage(editor, 'Enfant');
    expect(failed(await tool(editor, 'move_page', { id: b.id, parentId: a.id }))).toBe(false);
    expect(data(await tool(editor, 'get_page_info', { id: b.id })).parentId).toBe(a.id);
    expect(failed(await tool(editor, 'move_page', { id: a.id, parentId: b.id }))).toBe(true); // un parent ne devient pas l'enfant de son enfant
    expect(failed(await tool(editor, 'move_page', { id: b.id, parentId: null }))).toBe(false);
    expect(data(await tool(editor, 'get_page_info', { id: b.id })).parentId).toBeNull();
    expect(failed(await tool(editor, 'move_page', { id: b.id, parentId: '../x' }))).toBe(true);
  });

  it('trash_page puis restore_page : la page disparaît de la recherche puis revient', async () => {
    const editor = await token('editor', ['read', 'write']);
    const { id } = await newPage(editor, 'Éphémère', 'mot unique ornithorynque');
    expect((await tool(editor, 'search_pages', { query: 'ornithorynque' })).result!.content[0]!.text).toContain(id);
    expect(data(await tool(editor, 'trash_page', { id }))).toEqual({ id, trashed: true });
    expect((await tool(editor, 'search_pages', { query: 'ornithorynque' })).result!.content[0]!.text).not.toContain(id);
    expect(data(await tool(editor, 'restore_page', { id }))).toEqual({ id, restored: true });
    expect((await tool(editor, 'search_pages', { query: 'ornithorynque' })).result!.content[0]!.text).toContain(id);
  });

  it('commentaires : liste, ajoute, répond, résout et rouvre un fil', async () => {
    const editor = await token('editor', ['read', 'write']);
    const reader = await token('reader', ['read']);
    const { id } = await newPage(editor, 'Commentée');
    const first = data(await tool(editor, 'add_comment', { id, body: 'Premier commentaire', anchorText: 'texte' })) as { id: string };
    const reply = data(await tool(editor, 'add_comment', { id, body: 'Une réponse', parentId: first.id })) as { id: string; parentId: string };
    expect(reply.parentId).toBe(first.id);
    expect(failed(await tool(editor, 'add_comment', { id, body: 'réponse à une réponse', parentId: reply.id }))).toBe(true);
    const all = data(await tool(reader, 'list_comments', { id })) as { id: string; resolved: boolean }[]; // la lecture seule peut lister
    expect(all.map((c) => c.id)).toEqual([first.id, reply.id]);
    expect(failed(await tool(editor, 'resolve_comment', { id, commentId: reply.id }))).toBe(true); // seul un premier niveau se résout
    expect(data(await tool(editor, 'resolve_comment', { id, commentId: first.id })).resolved).toBe(true);
    expect((data(await tool(reader, 'list_comments', { id, resolved: true })) as unknown[]).length).toBe(2);
    expect((data(await tool(reader, 'list_comments', { id, resolved: false })) as unknown[]).length).toBe(0);
    expect(data(await tool(editor, 'resolve_comment', { id, commentId: first.id, resolved: false })).resolved).toBe(false);
  });

  it('arguments invalides : identifiants piégés, corps vide ou trop long', async () => {
    const editor = await token('editor', ['read', 'write']);
    const { id } = await newPage(editor, 'Validation');
    expect(failed(await tool(editor, 'add_comment', { id, body: '   ' }))).toBe(true);
    expect(failed(await tool(editor, 'add_comment', { id, body: 'x'.repeat(5001) }))).toBe(true);
    expect(failed(await tool(editor, 'update_page', { id: '../../etc', text: 'x' }))).toBe(true);
    expect(failed(await tool(editor, 'update_page', { id, text: 'x'.repeat(100_001) }))).toBe(true);
    expect(failed(await tool(editor, 'update_page', { id, text: 'x', mode: 'écraser' }))).toBe(true);
    expect(failed(await tool(editor, 'resolve_comment', { id, commentId: 'nexistepas' }))).toBe(true);
  });
});

describe('serveur MCP : bases', () => {
  type R = { result?: { isError?: boolean; content: { text: string }[] }; error?: { code: number } };
  const tool = async (h: Record<string, string>, name: string, args: object) => (await call(h, rpc('tools/call', { name, arguments: args }))).json() as R;
  const data = (r: R) => JSON.parse(r.result!.content[0]!.text);
  const failed = (r: R) => r.error !== undefined || r.result?.isError === true;
  const rest = async (h: Record<string, string>, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, headers: h });

  // Base de suivi dans un espace donné : colonnes Tâche (texte), Statut (option), Échéance (date), Points (nombre).
  async function newBase(admin: Record<string, string>, spaceId: string) {
    const created = (await rest(admin, 'POST', '/api/v3/bases', { spaceId, title: 'Suivi' })).json() as { page: { id: string } };
    const id = created.page.id;
    const add = async (b: object) => (await rest(admin, 'POST', `/api/v3/bases/${id}/properties`, b)).json() as { id: string };
    await add({ name: 'Tâche', type: 'text' });
    await add({ name: 'Statut', type: 'select', options: [{ name: 'À faire' }, { name: 'En cours' }, { name: 'Fait' }] });
    await add({ name: 'Échéance', type: 'date' });
    await add({ name: 'Points', type: 'number' });
    return id;
  }
  const privateSpace = () => {
    const id = `sp-${randomBytes(4).toString('hex')}`;
    db.prepare("INSERT INTO spaces (id, name, icon, description, visibility, position, created_at, updated_at) VALUES (?, 'Prive', '', '', 'private', 99, ?, ?)").run(id, Date.now(), Date.now());
    return id;
  };
  const publicSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'public'").get() as { id: string }).id;

  it('annonce les outils selon les portées', async () => {
    const reader = await token('reader', ['read']);
    const editor = await token('editor', ['read', 'write']);
    const readerNames = (await call(reader, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name);
    expect(readerNames).toEqual(expect.arrayContaining(['list_bases', 'get_base', 'query_rows']));
    for (const n of ['create_row', 'update_row']) expect(readerNames).not.toContain(n);
    expect((await call(editor, rpc('tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['create_row', 'update_row']));
  });

  it('liste, interroge (filtre, tri) et modifie des lignes par noms de colonnes et libellés d’options', async () => {
    const admin = await token('admin', ['read', 'write', 'admin']);
    const base = await newBase(admin, publicSpace());
    expect(data(await tool(admin, 'list_bases', {})).map((b: { id: string }) => b.id)).toContain(base);
    const info = data(await tool(admin, 'get_base', { id: base })) as { properties: { name: string; options?: string[] }[]; canWrite: boolean };
    expect(info.canWrite).toBe(true);
    expect(info.properties.find((p) => p.name === 'Statut')!.options).toEqual(['À faire', 'En cours', 'Fait']);

    const a = data(await tool(admin, 'create_row', { id: base, values: { Tâche: 'Villa Meunier', Statut: 'en cours', Échéance: '2026-12-01', Points: 3 } })) as { id: string; values: Record<string, unknown> };
    expect(a.values.Statut).toBe('En cours');
    await tool(admin, 'create_row', { id: base, values: { Tâche: 'Cabanon', Statut: 'À faire', Échéance: '2026-11-30', Points: 5 } });
    await tool(admin, 'create_row', { id: base, values: { Tâche: 'Garage', Statut: 'Fait', Points: 1 } });

    const q = async (args: object) => data(await tool(admin, 'query_rows', { id: base, ...args })) as { total: number; rows: { id: string; values: Record<string, unknown> }[] };
    expect((await q({})).total).toBe(3);
    expect((await q({ filters: [{ property: 'Statut', op: 'neq', value: 'Fait' }] })).total).toBe(2);
    expect((await q({ filters: [{ property: 'Échéance', op: 'lt', value: '2026-12-01' }] })).rows.map((r) => r.values.Tâche)).toEqual(['Cabanon']);
    expect((await q({ filters: [{ property: 'Échéance', op: 'empty' }] })).rows.map((r) => r.values.Tâche)).toEqual(['Garage']);
    expect((await q({ filters: [{ property: 'Points', op: 'gt', value: 2 }], sort: [{ property: 'Points', dir: 'desc' }] })).rows.map((r) => r.values.Tâche)).toEqual(['Cabanon', 'Villa Meunier']);
    expect((await q({ sort: [{ property: 'Échéance' }] })).rows.map((r) => r.values.Tâche)).toEqual(['Cabanon', 'Villa Meunier', 'Garage']); // vide à la fin
    expect((await q({ limit: 1 })).rows).toHaveLength(1);
    expect(failed(await tool(admin, 'query_rows', { id: base, filters: [{ property: 'Inconnue', op: 'empty' }] }))).toBe(true);

    const updated = data(await tool(admin, 'update_row', { id: base, rowId: a.id, values: { Statut: 'Fait', Points: null } })) as { values: Record<string, unknown> };
    expect(updated.values.Statut).toBe('Fait');
    expect(updated.values.Points).toBeUndefined(); // cellule effacée
    expect(updated.values.Tâche).toBe('Villa Meunier');
    expect(failed(await tool(admin, 'update_row', { id: base, rowId: a.id, values: {} }))).toBe(true);
  });

  it('un jeton en lecture ne peut ni créer ni modifier une ligne', async () => {
    const admin = await token('admin', ['read', 'write', 'admin']);
    const reader = await token('reader', ['read']);
    const base = await newBase(admin, publicSpace());
    const row = data(await tool(admin, 'create_row', { id: base, values: { Tâche: 'X' } })) as { id: string };
    expect((await tool(reader, 'create_row', { id: base, values: { Tâche: 'Y' } })).error?.code).toBe(-32602);
    expect((await tool(reader, 'update_row', { id: base, rowId: row.id, values: { Tâche: 'Z' } })).error?.code).toBe(-32602);
    expect((data(await tool(admin, 'query_rows', { id: base })) as { total: number }).total).toBe(1);
  });

  it('un jeton ne lit ni ne modifie une base d’un espace privé non autorisé', async () => {
    const admin = await token('admin', ['read', 'write', 'admin']);
    const editor = await token('editor', ['read', 'write']);
    const space = privateSpace();
    const base = await newBase(admin, space);
    const row = data(await tool(admin, 'create_row', { id: base, values: { Tâche: 'Secret' } })) as { id: string };
    expect(data(await tool(editor, 'list_bases', {})).map((b: { id: string }) => b.id)).not.toContain(base);
    for (const [name, args] of [['get_base', { id: base }], ['query_rows', { id: base }], ['create_row', { id: base, values: { Tâche: 'Intrus' } }], ['update_row', { id: base, rowId: row.id, values: { Tâche: 'Piraté' } }]] as const) {
      expect(failed(await tool(editor, name, args)), name).toBe(true);
    }
    const rows = data(await tool(admin, 'query_rows', { id: base })) as { rows: { values: Record<string, unknown> }[] };
    expect(rows.rows.map((r) => r.values.Tâche)).toEqual(['Secret']);
  });

  it('un jeton limité à d’autres espaces ne touche pas la base', async () => {
    const admin = await token('admin', ['read', 'write', 'admin']);
    const base = await newBase(admin, publicSpace());
    const other = privateSpace();
    const limited = await token('admin', ['read', 'write'], [other]);
    expect(failed(await tool(limited, 'get_base', { id: base }))).toBe(true);
    expect(failed(await tool(limited, 'create_row', { id: base, values: { Tâche: 'x' } }))).toBe(true);
  });
});
