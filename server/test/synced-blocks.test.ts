// Blocs synchronisés (lot 4 ter) : lecture d'une source avec les droits de sa page, 404 indiscernable, index des sources,
// structure, export, partage public, rendu SEO, recherche, duplication, modèles, versions et co-édition.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { EventEmitter } from 'node:events';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../src/app.js';
import { createApiToken } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { applyCollabSynced, CollabHub } from '../src/lib/collab.js';
import { EventBus } from '../src/lib/events.js';
import { type DocNode, docText, MAX_SYNCED_BLOCKS, sanitizeDoc } from '../src/lib/content.js';
import { hashPassword } from '../src/lib/password.js';
import { collabClonerFor } from '../src/lib/access.js';
import { updatePage } from '../src/lib/pages.js';
import { expandSyncedCopies, MAX_ANONYMOUS_SOURCE_CHARS, MAX_SYNCED_IDS_PER_PAGE, newBlockId, planCollabSynced, SYNCED_BLOCK_ID } from '../src/lib/synced-blocks.js';
import { segmentOf } from '../src/lib/slug.js';
import { jsonToYFragment, jsonToYNodes, yFragmentToJson } from '../src/lib/yjs-json.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', SEO_INDEX: 'true' };
const PASS = 'Sup3r-secret-pass';
const para = (t: string, marks?: object[]) => ({ type: 'paragraph', content: [{ type: 'text', text: t, ...(marks ? { marks } : {}) }] });
const doc = (...content: object[]) => ({ type: 'doc', content });
const source = (blockId: string, ...content: object[]) => ({ type: 'syncedSource', attrs: { blockId }, content });
const copy = (blockId: string) => ({ type: 'syncedCopy', attrs: { blockId } });

let app: FastifyInstance;
let db: DB;
const sessions = new Map<string, { cookies: Record<string, string>; headers: Record<string, string> }>();

async function boot() {
  const clientDir = mkdtempSync(join(tmpdir(), 'nb-synced-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><head><title>BeNote</title></head><body><main id="main"></main></body></html>');
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['out', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  const space = (id: string, visibility: 'private' | 'public') =>
    db.prepare('INSERT INTO spaces (id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, `Espace ${id}`, visibility);
  space('sp', 'private'); // ed1, ed2 (pas « out »)
  space('priv', 'private'); // ed1 seul
  space('pub', 'public'); // ed1 en écriture, lisible sans compte
  space('autre', 'private'); // ed1, ed2, out
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('sp', 'ed1', 'edit'), ('sp', 'ed2', 'edit'), ('priv', 'ed1', 'edit'), ('pub', 'ed1', 'edit'), ('autre', 'ed1', 'edit'), ('autre', 'ed2', 'edit'), ('autre', 'out', 'edit')").run();
}
beforeEach(async () => { sessions.clear(); await boot(); });
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  if (!sessions.has(id)) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    sessions.set(id, { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } });
  }
  return sessions.get(id)!;
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: { ...s?.headers, ...headers } });

async function createPage(s: S, spaceId: string, title: string, content?: object, parentId?: string) {
  const res = await call(s, 'POST', '/api/v3/pages', { spaceId, title, ...(content ? { content } : {}), ...(parentId ? { parentId } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; content: DocNode };
}
async function setContent(s: S, id: string, content: object) {
  const etag = (await call(s, 'GET', `/api/v3/pages/${id}`)).headers.etag as string;
  return call(s, 'PATCH', `/api/v3/pages/${id}`, { content }, { 'if-match': etag });
}
// Page avec une source d'identifiant connu : créée vide, puis contenu enregistré (la création régénère les identifiants reçus).
async function pageWithSource(s: S, spaceId: string, title: string, blockId: string, text: string, parentId?: string) {
  const page = await createPage(s, spaceId, title, undefined, parentId);
  const res = await setContent(s, page.id, doc(para('avant'), source(blockId, para(text, [{ type: 'commentAnchor', attrs: { id: 'fil1' } }]))));
  expect(res.statusCode, res.body).toBe(200);
  return page.id;
}
const getBlock = (s: S | null, id: string, headers: Record<string, string> = {}) => call(s, 'GET', `/api/v3/synced-blocks/${id}`, undefined, headers);
const indexRow = (id: string) => db.prepare('SELECT * FROM synced_blocks WHERE block_id = ?').get(id) as
  { block_id: string; page_id: string | null; space_id: string | null; removed_at: number | null } | undefined;
const storedContent = (pageId: string) => (db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string }).content;

describe('identifiants', () => {
  it('newBlockId produit 128 bits au format strict ; les formats approchants sont refusés', () => {
    const ids = new Set(Array.from({ length: 200 }, newBlockId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(SYNCED_BLOCK_ID.test(id)).toBe(true);
    for (const bad of ['', 'court', 'A'.repeat(22).replace(/A$/, 'B'), 'A'.repeat(23), `${'A'.repeat(21)}=`, '../../etc/passwd/aaaaaA', crypto.randomUUID()]) {
      expect(SYNCED_BLOCK_ID.test(bad), bad).toBe(false);
    }
  });
});

describe('lecture GET /synced-blocks/:id', () => {
  it('lecteur de la page source : { id, content } sans titre, identifiant de page ni ancre de commentaire', async () => {
    const S1 = newBlockId();
    const pageId = await pageWithSource(await login('ed1'), 'sp', 'Titre très secret', S1, 'contenu partagé');
    const res = await getBlock(await login('ed2'), S1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: S1, content: [para('contenu partagé')] });
    expect(res.body).not.toContain(pageId);
    expect(res.body).not.toContain('Titre très secret');
    expect(res.body).not.toContain('fil1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('404 identique : inconnu, mal formé, espace illisible, page restreinte, corbeille, source retirée, jeton sans portée, anonyme', async () => {
    const ed1 = await login('ed1');
    const inSp = newBlockId();
    const inPriv = newBlockId();
    const restricted = newBlockId();
    const trashed = newBlockId();
    const removed = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', inSp, 'texte sp');
    await pageWithSource(ed1, 'priv', 'B', inPriv, 'texte privé');
    const r = await pageWithSource(ed1, 'sp', 'Restreinte', restricted, 'texte restreint');
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, 'ed1', 'write')").run(r);
    // Restriction héritée : une sous-page d'une page restreinte.
    const inherited = newBlockId();
    await pageWithSource(ed1, 'sp', 'Sous-page', inherited, 'texte hérité', r);
    const t = await pageWithSource(ed1, 'sp', 'Corbeille', trashed, 'texte corbeille');
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${t}`)).statusCode).toBe(204);
    const g = await pageWithSource(ed1, 'sp', 'Retirée', removed, 'texte retiré');
    expect((await setContent(ed1, g, doc(para('plus de source')))).statusCode).toBe(200);

    const ed2 = await login('ed2');
    const out = await login('out');
    // Corps comparés sans `instance`, qui ne fait que reprendre l'adresse demandée.
    const body = (res: { body: string }) => JSON.stringify({ ...JSON.parse(res.body), instance: undefined });
    const reference = await getBlock(ed2, newBlockId());
    expect(reference.statusCode).toBe(404);
    const { token } = createApiToken(db, 'ed1', { name: 'sans lecture', scopes: ['ai'], expiresInDays: 1 });
    const cases: [S | null, string, Record<string, string>?][] = [
      [ed2, 'pas-un-identifiant'],
      [ed2, 'A'.repeat(64)],
      [out, inSp], // espace non visible
      [ed2, inPriv], // espace non visible
      [ed2, restricted], // permission de page
      [ed2, inherited], // permission héritée
      [ed1, trashed], // corbeille, même pour l'auteur
      [ed1, removed], // source retirée de sa page
      [null, inSp, { authorization: `Bearer ${token}` }], // jeton sans portée « read »
      [null, inSp], // anonyme, espace privé
    ];
    for (const [who, id, headers] of cases) {
      const res = await getBlock(who, id, headers);
      expect(res.statusCode, id).toBe(404);
      expect(body(res), id).toBe(body(reference));
      expect(res.body).not.toMatch(/texte|Titre/);
    }
    // Contre-épreuves : les mêmes blocs restent lisibles par qui en a le droit.
    expect((await getBlock(ed1, restricted)).statusCode).toBe(200);
    expect((await getBlock(ed1, inherited)).statusCode).toBe(200);
    expect((await getBlock(ed1, inPriv)).statusCode).toBe(200);
    expect((await call(ed1, 'POST', `/api/v3/pages/${t}/restore`)).statusCode).toBe(200);
    expect((await getBlock(ed1, trashed)).statusCode).toBe(200);
    const { token: readToken } = createApiToken(db, 'ed1', { name: 'lecture', scopes: ['read'], expiresInDays: 1 });
    expect((await getBlock(null, inSp, { authorization: `Bearer ${readToken}` })).statusCode).toBe(200);
  });

  it('espace public : lisible sans compte, comme /pages/:id', async () => {
    const S1 = newBlockId();
    await pageWithSource(await login('ed1'), 'pub', 'Publique', S1, 'texte public');
    const res = await getBlock(null, S1);
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toEqual([para('texte public')]);
  });
});

describe('index des sources', () => {
  it('création, retrait (identifiant gardé réservé), retour de la source, déplacement vers un autre espace', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const pageId = await pageWithSource(ed1, 'sp', 'A', S1, 'texte');
    expect(indexRow(S1)).toMatchObject({ page_id: pageId, space_id: 'sp', removed_at: null });

    expect((await setContent(ed1, pageId, doc(para('sans source')))).statusCode).toBe(200);
    expect(indexRow(S1)).toMatchObject({ page_id: pageId });
    expect(indexRow(S1)!.removed_at).not.toBeNull();
    expect((await getBlock(ed1, S1)).statusCode).toBe(404);

    // Annulation : la source revient dans sa page.
    expect((await setContent(ed1, pageId, doc(source(S1, para('de retour'))))).statusCode).toBe(200);
    expect(indexRow(S1)!.removed_at).toBeNull();
    expect((await getBlock(ed1, S1)).json().content).toEqual([para('de retour')]);

    // Déplacement de la page (et de son sous-arbre) vers un autre espace : l'index suit.
    const childBlock = newBlockId();
    const child = await pageWithSource(ed1, 'sp', 'Enfant', childBlock, 'texte enfant', pageId);
    expect((await call(ed1, 'POST', `/api/v3/pages/${pageId}/move`, { parentId: null, spaceId: 'autre' })).statusCode).toBe(200);
    expect(indexRow(S1)).toMatchObject({ page_id: pageId, space_id: 'autre' });
    expect(indexRow(childBlock)).toMatchObject({ page_id: child, space_id: 'autre' });
    // Les droits suivent la page : « out » lit désormais l'espace de la source.
    expect((await getBlock(await login('out'), S1)).statusCode).toBe(200);
  });

  it('conflit : une autre page ne reprend jamais un identifiant (409 générique, pas 412), même retiré ou après suppression', async () => {
    const ed1 = await login('ed1');
    const ed2 = await login('ed2');
    const S1 = newBlockId();
    const a = await pageWithSource(ed1, 'sp', 'A', S1, 'officiel');
    const b = await createPage(ed2, 'autre', 'B');
    const before = storedContent(b.id);
    const res = await setContent(ed2, b.id, doc(source(S1, para('usurpation'))));
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(a);
    expect(storedContent(b.id)).toBe(before);
    expect(indexRow(S1)).toMatchObject({ page_id: a });
    expect((await getBlock(ed1, S1)).json().content).toEqual([para('officiel')]);

    // Deux fois le même identifiant dans une page : refusé aussi.
    const S2 = newBlockId();
    expect((await setContent(ed2, b.id, doc(source(S2, para('x')), source(S2, para('y'))))).statusCode).toBe(409);
    expect(indexRow(S2)).toBeUndefined();

    // Source retirée de A : l'identifiant reste à A.
    expect((await setContent(ed1, a, doc(para('vide')))).statusCode).toBe(200);
    expect((await setContent(ed2, b.id, doc(source(S1, para('usurpation'))))).statusCode).toBe(409);

    // A supprimée définitivement : l'identifiant reste réservé et ne désigne plus rien.
    const admin = await login('admin');
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('sp', 'admin', 'full')").run();
    expect((await call(ed1, 'DELETE', `/api/v3/pages/${a}`)).statusCode).toBe(204);
    expect((await call(admin, 'DELETE', `/api/v3/pages/${a}/permanent`)).statusCode).toBe(204);
    expect(indexRow(S1)).toMatchObject({ page_id: null });
    expect((await setContent(ed2, b.id, doc(source(S1, para('usurpation'))))).statusCode).toBe(409);
    expect((await getBlock(ed2, S1)).statusCode).toBe(404);
  });

  it('plafond d’identifiants par page (retirés compris) : jamais de purge, une nouvelle source est refusée au-delà', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const pageId = await pageWithSource(ed1, 'sp', 'A', S1, 'texte');
    const insert = db.prepare("INSERT INTO synced_blocks (block_id, page_id, space_id, created_at, updated_at, removed_at) VALUES (?, ?, 'sp', 0, 0, 1)");
    for (let i = 0; i < MAX_SYNCED_IDS_PER_PAGE - 2; i++) insert.run(newBlockId(), pageId);
    const [N1, N2] = [newBlockId(), newBlockId()];
    expect((await setContent(ed1, pageId, doc(source(S1, para('a')), source(N1, para('b')), source(N2, para('c'))))).statusCode).toBe(400);
    expect(indexRow(N1)).toBeUndefined();
    expect((await setContent(ed1, pageId, doc(source(S1, para('a')), source(N1, para('b'))))).statusCode).toBe(200);
    // Réutiliser les sources déjà indexées reste possible.
    expect((await setContent(ed1, pageId, doc(source(N1, para('b'))))).statusCode).toBe(200);
    expect((await setContent(ed1, pageId, doc(source(S1, para('a'))))).statusCode).toBe(200);
  });

  it('source dont le seul bloc est une pièce jointe illisible : la source vide n’est ni enregistrée ni indexée, la page reste utilisable', async () => {
    const ed1 = await login('ed1');
    const page = await createPage(ed1, 'sp', 'A');
    const S1 = newBlockId();
    const missing = `/api/v3/attachments/${'A'.repeat(22)}`;
    expect((await setContent(ed1, page.id, doc(para('avant'), source(S1, { type: 'image', attrs: { src: missing } }), source(newBlockId(), { type: 'attachment', attrs: { id: 'B'.repeat(22), name: 'x.pdf', size: 1, mime: 'application/pdf' } })))).statusCode).toBe(200);
    const stored = JSON.parse(storedContent(page.id)) as DocNode;
    expect(JSON.stringify(stored)).not.toContain('syncedSource');
    expect(indexRow(S1)).toBeUndefined();
    expect((await setContent(ed1, page.id, stored)).statusCode).toBe(200);
    expect((await call(ed1, 'POST', `/api/v3/pages/${page.id}/duplicate`)).statusCode).toBe(201);
    expect((await call(ed1, 'POST', '/api/v3/templates', { pageId: page.id })).statusCode).toBe(201);
  });

  it('création de page : les identifiants reçus sont toujours remplacés (aucune confiance dans le client)', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const a = await pageWithSource(ed1, 'sp', 'A', S1, 'officiel');
    const C1 = newBlockId();
    const created = await createPage(await login('ed2'), 'sp', 'Nouvelle', doc(source(S1, para('usurpation')), copy(C1)));
    const [src, cp] = created.content.content!;
    expect(src!.type).toBe('syncedSource');
    expect(src!.attrs!.blockId).not.toBe(S1);
    expect(SYNCED_BLOCK_ID.test(String(src!.attrs!.blockId))).toBe(true);
    expect(cp).toEqual(copy(C1));
    expect(indexRow(S1)).toMatchObject({ page_id: a });
    expect(indexRow(String(src!.attrs!.blockId))).toMatchObject({ page_id: created.id });
  });
});

describe('structure', () => {
  const S1 = newBlockId();
  const S2 = newBlockId();
  it('imbrications interdites, parents permis, identifiants mal formés, source vide, plafond par page', () => {
    const bad: [string, object][] = [
      ['source dans une source', doc(source(S1, source(S2, para('x'))))],
      ['copie dans une source', doc(source(S1, copy(S2)))],
      ['source profonde dans une source', doc(source(S1, { type: 'blockquote', content: [source(S2, para('x'))] }))],
      ['copie profonde dans une source', doc(source(S1, { type: 'callout', attrs: { type: 'info' }, content: [copy(S2)] }))],
      ['source dans un paragraphe', doc({ type: 'paragraph', content: [source(S1, para('x'))] })],
      ['copie dans une liste', doc({ type: 'bulletList', content: [copy(S1)] })],
      ['source vide', doc(source(S1))],
      ['source avec du texte nu', doc({ type: 'syncedSource', attrs: { blockId: S1 }, content: [{ type: 'text', text: 'x' }] })],
      ['source avec une ligne de tableau', doc(source(S1, { type: 'tableRow', content: [] }))],
      ['source sans identifiant', doc({ type: 'syncedSource', content: [para('x')] })],
      ['copie mal formée', doc({ type: 'syncedCopy', attrs: { blockId: 'abc' } })],
      ['copie sans identifiant', doc({ type: 'syncedCopy' })],
    ];
    for (const [label, d] of bad) expect(() => sanitizeDoc(d), label).toThrow();
    // Permis : dans une colonne, une cellule, un dépliable, une citation ; copie de la même page.
    expect(() => sanitizeDoc(doc(
      { type: 'columns', content: [{ type: 'column', content: [source(S1, para('a'))] }, { type: 'column', content: [copy(S2)] }] },
      { type: 'blockquote', content: [copy(S1)] },
    ))).not.toThrow();
    const many = Array.from({ length: MAX_SYNCED_BLOCKS }, () => copy(newBlockId()));
    expect(() => sanitizeDoc(doc(...many))).not.toThrow();
    expect(() => sanitizeDoc(doc(...many, source(newBlockId(), para('x'))))).toThrow(/au plus/);
  });

  it('une copie n’enregistre jamais de contenu ni d’attribut étranger ; son texte n’entre pas dans la page', () => {
    const clean = sanitizeDoc(doc({ type: 'syncedCopy', attrs: { blockId: S1, pageId: 'x', title: 'y' }, content: [para('contenu embarqué')] }));
    expect(clean.content).toEqual([copy(S1)]);
    expect(docText({ type: 'doc', content: [{ type: 'syncedCopy', attrs: { blockId: S1 }, content: [para('résolu')] }] })).toBe('');
    expect(docText(sanitizeDoc(doc(source(S1, para('texte source')))))).toBe('texte source');
  });

  it('refus par l’API : 400 et rien d’enregistré', async () => {
    const ed1 = await login('ed1');
    const page = await createPage(ed1, 'sp', 'A');
    const before = storedContent(page.id);
    expect((await setContent(ed1, page.id, doc(source(S1, copy(S2))))).statusCode).toBe(400);
    expect(storedContent(page.id)).toBe(before);
    expect(indexRow(S1)).toBeUndefined();
  });
});

describe('fuites : recherche, export, partage public, SEO', () => {
  async function setup() {
    const ed1 = await login('ed1');
    const secret = newBlockId();
    await pageWithSource(ed1, 'priv', 'Source privée', secret, 'motsecret confidentiel');
    const holder = await createPage(ed1, 'sp', 'Porteuse', doc(para('page porteuse'), copy(secret)));
    return { ed1, secret, holder: holder.id };
  }

  it('recherche : la source est trouvée avec SA page seulement, la copie n’ajoute rien', async () => {
    const { ed1, holder } = await setup();
    const hits = (await call(ed1, 'GET', '/api/v3/search?q=motsecret')).json().items as { id: string; title: string }[];
    expect(hits.map((h) => h.title)).toEqual(['Source privée']);
    expect(hits.some((h) => h.id === holder)).toBe(false);
    expect((await call(await login('ed2'), 'GET', '/api/v3/search?q=motsecret')).json().items).toEqual([]);
    expect((db.prepare('SELECT text FROM pages WHERE id = ?').get(holder) as { text: string }).text).not.toContain('motsecret');
    expect(storedContent(holder)).not.toContain('motsecret');
  });

  it('export Markdown et ZIP : copie résolue pour qui lit la source, bloc neutre sinon', async () => {
    const { ed1, holder } = await setup();
    const mine = await call(ed1, 'GET', `/api/v3/pages/${holder}/export`);
    expect(mine.body).toContain('motsecret confidentiel');
    const other = await call(await login('ed2'), 'GET', `/api/v3/pages/${holder}/export`);
    expect(other.statusCode).toBe(200);
    expect(other.body).not.toContain('motsecret');
    expect(other.body).toContain('Bloc synchronisé non disponible');
    // Export JSON : la copie reste une référence, jamais son contenu.
    expect((await call(ed1, 'GET', `/api/v3/pages/${holder}/export?format=json`)).body).not.toContain('motsecret');
    const zipText = async (s: S, format: string) => {
      const res = await call(s, 'GET', `/api/v3/pages/${holder}/export/zip?format=${format}`);
      expect(res.statusCode).toBe(200);
      return Object.values(unzipSync(new Uint8Array(res.rawPayload))).map((f) => strFromU8(f)).join('\n');
    };
    for (const format of ['html', 'md']) {
      const theirs = await zipText(await login('ed2'), format);
      expect(theirs).toContain('page porteuse');
      expect(theirs).not.toContain('motsecret');
      expect(theirs).toContain('Bloc synchronisé non disponible');
      expect(await zipText(ed1, format)).toContain('motsecret confidentiel');
    }
  });

  it('partage public : copie d’une source privée neutre ; source publiée par le partage résolue ; aucun identifiant de bloc', async () => {
    const { ed1, secret, holder } = await setup();
    const shared = newBlockId();
    await pageWithSource(ed1, 'sp', 'Sous-page partagée', shared, 'texte partagé', holder);
    const current = JSON.parse(storedContent(holder)) as DocNode;
    expect((await setContent(ed1, holder, { ...current, content: [...current.content!, copy(shared)] })).statusCode).toBe(200);
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(200);
    db.prepare("UPDATE spaces SET sharing_enabled = 1 WHERE id = 'sp'").run();
    const link = await call(ed1, 'PUT', `/api/v3/pages/${holder}/share`, { includeChildren: true });
    expect(link.statusCode, link.body).toBeLessThan(300);
    const token = (link.json() as { url: string }).url.split('/share/')[1]!;
    const res = await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('motsecret');
    expect(res.body).toContain('Contenu indisponible');
    expect(res.body).toContain('texte partagé');
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain(shared);
    expect(res.body).not.toMatch(/synced(Source|Copy)/);
    // Sans le sous-arbre, la source de la sous-page n'est plus publiée : copie neutre.
    expect((await call(ed1, 'PUT', `/api/v3/pages/${holder}/share`, { includeChildren: false })).statusCode).toBeLessThan(300);
    expect((await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}` })).body).not.toContain('texte partagé');
  });

  it('vue anonyme : volume de contenu source lu plafonné, chaque page lue une seule fois', async () => {
    const ed1 = await login('ed1');
    const [S1, S2] = [newBlockId(), newBlockId()];
    const a = await createPage(ed1, 'pub', 'Sources');
    expect((await setContent(ed1, a.id, doc(source(S1, para('premier')), source(S2, para('second'))))).statusCode).toBe(200);
    const holder = doc(copy(S1), copy(S2)) as DocNode;
    const size = storedContent(a.id).length;
    const all = expandSyncedCopies(db, holder, () => true, { maxSourceChars: size });
    expect(all.content!.map((n) => n.content?.length ?? 0)).toEqual([1, 1]); // même page : comptée une fois
    const none = expandSyncedCopies(db, holder, () => true, { maxSourceChars: size - 1 });
    expect(none.content!.every((n) => !n.content)).toBe(true);
  });

  it('partage public : une source trop volumineuse pour le plafond des vues anonymes reste neutre', async () => {
    const ed1 = await login('ed1');
    const big = newBlockId();
    const page = await createPage(ed1, 'pub', 'Grosse source');
    const svg = `data:image/svg+xml;base64,${'A'.repeat(2_600_000)}`;
    const drawing = { type: 'excalidraw', attrs: { scene: 'x'.repeat(2_900_000), svg } };
    expect((await setContent(ed1, page.id, doc(source(big, para('texte volumineux'), drawing)))).statusCode).toBe(200);
    expect(storedContent(page.id).length).toBeGreaterThan(MAX_ANONYMOUS_SOURCE_CHARS);
    const holder = await createPage(ed1, 'sp', 'Porteuse', doc(para('porteuse'), copy(big)));
    expect((await call(await login('admin'), 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(200);
    db.prepare("UPDATE spaces SET sharing_enabled = 1 WHERE id = 'sp'").run();
    const token = ((await call(ed1, 'PUT', `/api/v3/pages/${holder.id}/share`, {})).json() as { url: string }).url.split('/share/')[1]!;
    const res = await app.inject({ method: 'GET', url: `/api/v3/public/shares/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('texte volumineux');
    expect(res.body).toContain('Contenu indisponible');
    // Pour une personne connectée qui lit la source, la copie se lit normalement.
    expect((await getBlock(ed1, big)).statusCode).toBe(200);
  });

  it('rendu SEO d’une page publique : copie d’une source privée neutre, source publique résolue', async () => {
    const ed1 = await login('ed1');
    const secret = newBlockId();
    const open = newBlockId();
    await pageWithSource(ed1, 'priv', 'Source privée', secret, 'motsecret confidentiel');
    await pageWithSource(ed1, 'pub', 'Source publique', open, 'texte ouvert');
    const page = await createPage(ed1, 'pub', 'Vitrine', doc(para('vitrine'), copy(secret), copy(open)));
    const res = await app.inject({ method: 'GET', url: `/p/${segmentOf(page.id, 'Vitrine')}` });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('vitrine');
    expect(html).toContain('texte ouvert');
    expect(html).not.toContain('motsecret');
    expect(html).toContain('Bloc synchronisé non disponible');
  });
});

describe('copies de pages, modèles, versions', () => {
  it('duplication et copie vers un autre espace : sources renouvelées, copies inchangées, original intact', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const C1 = newBlockId();
    const a = await createPage(ed1, 'sp', 'A');
    expect((await setContent(ed1, a.id, doc(source(S1, para('original')), copy(C1)))).statusCode).toBe(200);
    for (const res of [
      await call(ed1, 'POST', `/api/v3/pages/${a.id}/duplicate`),
      await call(ed1, 'POST', `/api/v3/pages/${a.id}/copy`, { spaceId: 'autre' }),
    ]) {
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { id?: string; page?: { id: string } }).id ?? (res.json() as { page: { id: string } }).page.id;
      const content = JSON.parse(storedContent(id)) as DocNode;
      const newId = String(content.content![0]!.attrs!.blockId);
      expect(newId).not.toBe(S1);
      expect(content.content![1]).toEqual(copy(C1));
      expect(indexRow(newId)).toMatchObject({ page_id: id });
    }
    expect(indexRow(S1)).toMatchObject({ page_id: a.id, removed_at: null });
  });

  it('modèle : sources renouvelées, copies gardées en référence, aucune fuite d’une source restreinte', async () => {
    const ed1 = await login('ed1');
    const secret = newBlockId();
    await pageWithSource(ed1, 'priv', 'Source privée', secret, 'motsecret confidentiel');
    const S1 = newBlockId();
    const page = await createPage(ed1, 'sp', 'Modèle');
    expect((await setContent(ed1, page.id, doc(source(S1, para('texte du modèle')), copy(secret)))).statusCode).toBe(200);
    const saved = await call(ed1, 'POST', '/api/v3/templates', { pageId: page.id });
    expect(saved.statusCode, saved.body).toBe(201);
    const tpl = await call(await login('ed2'), 'GET', `/api/v3/templates/${(saved.json() as { id: string }).id}`);
    expect(tpl.body).not.toContain('motsecret');
    const content = (tpl.json() as { content: DocNode }).content;
    const tplSource = String(content.content![0]!.attrs!.blockId);
    expect(tplSource).not.toBe(S1);
    expect(indexRow(tplSource)).toBeUndefined();
    expect(content.content![1]).toEqual(copy(secret));
    // Deux pages créées depuis le modèle : chacune a sa propre source, aucun conflit.
    const ed2 = await login('ed2');
    const p1 = await createPage(ed2, 'sp', 'Depuis modèle 1', content);
    const p2 = await createPage(ed2, 'sp', 'Depuis modèle 2', content);
    expect(p1.content.content![0]!.attrs!.blockId).not.toBe(p2.content.content![0]!.attrs!.blockId);
    // La copie de la source restreinte reste illisible pour ed2.
    expect((await getBlock(ed2, secret)).statusCode).toBe(404);
  });

  it('restauration de version : la source revient ; un identifiant pris ailleurs est refusé sans casser l’index', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const a = await pageWithSource(ed1, 'sp', 'A', S1, 'version 1');
    // Version close (fenêtre de regroupement dépassée) : l'enregistrement suivant en ouvre une nouvelle.
    db.prepare('UPDATE page_versions SET session_start = 0 WHERE page_id = ?').run(a);
    const v1 = (await call(ed1, 'GET', `/api/v3/pages/${a}/versions`)).json()[0].id as number;
    expect((await setContent(ed1, a, doc(para('plus de source')))).statusCode).toBe(200);
    expect(indexRow(S1)!.removed_at).not.toBeNull();
    expect((await call(ed1, 'POST', `/api/v3/pages/${a}/versions/${v1}/restore`)).statusCode).toBe(200);
    expect(indexRow(S1)).toMatchObject({ page_id: a, removed_at: null });
    expect((await getBlock(ed1, S1)).json().content).toEqual([para('version 1')]);

    // Version d'une autre page qui contiendrait l'identifiant de A (écrite directement en base) : 409, rien ne bouge.
    const b = await createPage(ed1, 'sp', 'B');
    db.prepare('INSERT INTO page_versions (page_id, title, content, created_at, created_by, session_start) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.id, 'B', JSON.stringify(doc(source(S1, para('usurpation')))), Date.now(), 'ed1', 0);
    const forged = (db.prepare('SELECT id FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(b.id) as { id: number }).id;
    const before = storedContent(b.id);
    expect((await call(ed1, 'POST', `/api/v3/pages/${b.id}/versions/${forged}/restore`)).statusCode).toBe(409);
    expect(storedContent(b.id)).toBe(before);
    expect(indexRow(S1)).toMatchObject({ page_id: a });
    expect((await getBlock(ed1, S1)).json().content).toEqual([para('version 1')]);
  });
});

describe('co-édition : plan sur le JSON brut', () => {
  // Plan calculé sur le JSON brut de l'état Yjs, appliqué à l'état Yjs : les deux donnent le même document assaini.
  const roundTrip = (pageId: string, raw: object) => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    jsonToYFragment(raw as DocNode, fragment);
    const plan = planCollabSynced(db, pageId, yFragmentToJson(fragment));
    expect(applyCollabSynced(fragment, plan.actions)).toBe(true);
    const after = sanitizeDoc(yFragmentToJson(fragment));
    expect(after).toEqual(sanitizeDoc(plan.doc));
    // Plus rien à faire ensuite : pas de boucle.
    expect(planCollabSynced(db, pageId, yFragmentToJson(fragment)).actions.some(Boolean)).toBe(false);
    return { plan, after };
  };

  it('source collée depuis une autre page ou en double : nouvel identifiant ; proposition de la salle reprise', async () => {
    const ed1 = await login('ed1');
    const S1 = newBlockId();
    const S2 = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', S1, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    const pasted = doc(source(S1, para('collé')), source(S2, para('à moi')), source(S2, para('doublon')));
    const { plan, after } = roundTrip(b.id, pasted);
    expect(plan.renames.map((r) => [r.from, r.nth])).toEqual([[S1, 0], [S2, 1]]);
    const ids = after.content!.map((n) => n.attrs!.blockId);
    expect(ids[0]).not.toBe(S1);
    expect(ids[1]).toBe(S2);
    expect(new Set(ids).size).toBe(3);
    const again = planCollabSynced(db, b.id, pasted as DocNode, { reuse: (from, nth) => plan.renames.find((r) => r.from === from && r.nth === nth)?.to });
    expect(again.renames).toEqual(plan.renames);
    expect(again.fresh).toEqual([]);
    expect((await setContent(ed1, b.id, plan.doc)).statusCode).toBe(200);
    expect(indexRow(S1)!.page_id).not.toBe(b.id);
  });

  it('blocs cachés (copie, image, paragraphe > citation, source dans une source) : sortis ou retirés, jamais renommés à la place', async () => {
    const ed1 = await login('ed1');
    const X = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', X, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    const { plan, after } = roundTrip(b.id, doc(
      { type: 'syncedCopy', attrs: { blockId: newBlockId() }, content: [source(X, para('cachée copie'))] },
      { type: 'image', content: [source(X, para('cachée image'))] },
      { type: 'paragraph', content: [{ type: 'blockquote', content: [source(X, para('cachée paragraphe'))] }] },
      source(newBlockId(), para('extérieure'), source(X, para('imbriquée'))),
      source(X, para('réelle')),
    ));
    // Dans une copie (vidée) ou une image (parents sans blocs) : retirée avec son contenu ; ailleurs : sortie de son enveloppe.
    expect(plan.actions.map((a) => a?.kind ?? 'keep')).toEqual(['strip', 'remove', 'remove', 'unwrap', 'keep', 'unwrap', 'rename']);
    const sources = after.content!.filter((n) => n.type === 'syncedSource');
    expect(sources.map((n) => n.content![0]!.content![0]!.text)).toEqual(['extérieure', 'réelle']);
    expect(sources.every((n) => n.attrs!.blockId !== X)).toBe(true);
    expect(JSON.stringify(after)).toContain('imbriquée');
  });

  it('source dont aucun bloc ne survit à l’assainissement (image non sûre, intégration, pièce jointe, base au-delà de 20) : sortie de son enveloppe', async () => {
    const b = await createPage(await login('ed1'), 'sp', 'B');
    const bases = Array.from({ length: 20 }, (_, i) => ({ type: 'baseBlock', attrs: { id: `base${i}` } }));
    const { plan, after } = roundTrip(b.id, doc(
      source(newBlockId(), { type: 'image', attrs: { src: 'http://exemple.test/a.png' } }),
      source(newBlockId(), { type: 'embed', attrs: { url: 'javascript:alert(1)' } }, { type: 'attachment', attrs: { name: 'x' } }),
      ...bases,
      source(newBlockId(), { type: 'baseBlock', attrs: { id: 'base20' } }),
      source(newBlockId(), para('gardée')),
    ));
    expect(plan.actions.map((a) => a?.kind ?? 'keep')).toEqual(['unwrap', 'unwrap', 'unwrap', 'keep']);
    expect(after.content!.filter((n) => n.type === 'syncedSource')).toHaveLength(1);
  });

  it('blocs « base » d’une source retirée (sous des colonnes) non comptés : la source valide qui suit reste en place', async () => {
    const b = await createPage(await login('ed1'), 'sp', 'B');
    const bases = Array.from({ length: 20 }, (_, i) => ({ type: 'baseBlock', attrs: { id: `base${i}` } }));
    const { plan, after } = roundTrip(b.id, doc(
      { type: 'columns', content: [{ type: 'column', content: [para('a')] }, { type: 'column', content: [para('b')] }, source(newBlockId(), ...bases)] },
      source(newBlockId(), { type: 'baseBlock', attrs: { id: 'valide' } }),
    ));
    expect(plan.actions.map((a) => a?.kind ?? 'keep')).toEqual(['remove', 'keep']);
    expect(after.content!.filter((n) => n.type === 'syncedSource')).toHaveLength(1);
  });

  it('copie gardée qui porte un contenu dans l’état Yjs : vidée, comme le JSON qui l’ignore', async () => {
    const b = await createPage(await login('ed1'), 'sp', 'B');
    const C = newBlockId();
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    jsonToYFragment(doc({ type: 'syncedCopy', attrs: { blockId: C }, content: [para('embarqué'), source(newBlockId(), para('caché'))] }) as DocNode, fragment);
    const plan = planCollabSynced(db, b.id, yFragmentToJson(fragment));
    expect(plan.actions.map((a) => a?.kind ?? 'keep')).toEqual(['strip', 'remove']);
    expect(applyCollabSynced(fragment, plan.actions)).toBe(true);
    expect(yFragmentToJson(fragment)).toEqual(doc(copy(C)));
    expect(planCollabSynced(db, b.id, yFragmentToJson(fragment)).actions.some(Boolean)).toBe(false);
  });

  it('assainissement en co-édition : un bloc synchronisé invalide ne fait jamais échouer ; l’API, elle, refuse', () => {
    const bad = doc(
      source(newBlockId(), { type: 'image', attrs: { src: 'http://exemple.test/a.png' } }),
      { type: 'columns', content: [{ type: 'column', content: [para('a')] }, { type: 'column', content: [para('b')] }, source(newBlockId(), para('dans les colonnes'))] },
      source('mal-forme', para('identifiant invalide')),
      source(newBlockId(), para('extérieure'), source(newBlockId(), para('imbriquée')), copy(newBlockId())),
      { type: 'paragraph', content: [copy(newBlockId())] },
    );
    expect(() => sanitizeDoc(bad)).toThrow();
    const clean = sanitizeDoc(bad, { lenientSynced: true });
    const text = JSON.stringify(clean);
    expect(text).not.toContain('dans les colonnes'); // parent à structure imposée : retirée avec son contenu
    expect(text).toContain('identifiant invalide');
    expect(text).toContain('imbriquée');
    expect(clean.content!.filter((n) => n.type === 'syncedSource')).toHaveLength(1);
    expect(clean.content!.find((n) => n.type === 'columns')!.content).toHaveLength(2);
    expect(() => sanitizeDoc(clean)).not.toThrow();
  });

  it('source sous un parent à structure imposée (colonnes, dépliable) : retirée, pas sortie de son enveloppe', async () => {
    const b = await createPage(await login('ed1'), 'sp', 'B');
    const { plan, after } = roundTrip(b.id, doc(
      { type: 'columns', content: [{ type: 'column', content: [para('a')] }, { type: 'column', content: [para('b')] }, source(newBlockId(), para('colonnes'))] },
      { type: 'details', content: [{ type: 'detailsSummary', content: [source(newBlockId(), para('titre'))] }, { type: 'detailsContent', content: [para('corps')] }] },
    ));
    expect(plan.actions.map((a) => a?.kind)).toEqual(['remove', 'remove']);
    expect(JSON.stringify(after)).not.toMatch(/colonnes|titre/);
    expect(JSON.stringify(after)).toContain('corps');
  });

  it('élément Yjs nommé « text » contenant une source : ni le plan ni l’application n’y descendent', async () => {
    const ed1 = await login('ed1');
    const X = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', X, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const hidden = new Y.XmlElement('syncedSource');
    hidden.setAttribute('blockId', X);
    hidden.insert(0, [new Y.XmlElement('paragraph')]);
    const textEl = new Y.XmlElement('text');
    textEl.insert(0, [hidden]);
    fragment.insert(0, [textEl, ...jsonToYNodes([source(X, para('volée')) as DocNode])]);
    const plan = planCollabSynced(db, b.id, yFragmentToJson(fragment));
    expect(plan.actions.map((a) => a?.kind)).toEqual(['rename']);
    expect(applyCollabSynced(fragment, plan.actions)).toBe(true);
    expect(hidden.getAttribute('blockId')).toBe(X);
    const real = fragment.toArray()[1] as Y.XmlElement;
    expect(real.getAttribute('blockId')).not.toBe(X);
    expect(planCollabSynced(db, b.id, yFragmentToJson(fragment)).actions.some(Boolean)).toBe(false);
  });

  it('assainissement : un bloc synchronisé n’est accepté que si toute sa chaîne d’ancêtres est faite de conteneurs', () => {
    const X = newBlockId();
    expect(() => sanitizeDoc(doc({ type: 'paragraph', content: [{ type: 'blockquote', content: [source(X, para('x'))] }] }))).toThrow();
    expect(() => sanitizeDoc(doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'callout', attrs: { type: 'info' }, content: [copy(X)] }] }))).toThrow();
    expect(() => sanitizeDoc(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [source(X, para('x'))] }] }))).not.toThrow();
  });
});

describe('co-édition : salle réelle', () => {
  // WebSocket factice : la salle n'en utilise que l'état, l'envoi, la fermeture et les évènements. `seen` : document du participant,
  // tenu à jour avec ce que le serveur lui diffuse.
  class FakeWs extends EventEmitter {
    readyState = 1;
    readonly seen = new Y.Doc();
    onUpdate: (() => void) | null = null;
    send(msg: Uint8Array, cb?: (err?: Error) => void) {
      const decoder = decoding.createDecoder(msg);
      if (decoding.readVarUint(decoder) === 0) {
        syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), this.seen, 'serveur');
        this.onUpdate?.();
      }
      cb?.();
    }
    close() { this.readyState = 3; this.emit('close'); }
    ping() { this.emit('pong'); }
    terminate() { this.close(); }
  }
  const pushDoc = (ws: FakeWs, client: Y.Doc, before?: Uint8Array) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(client, before));
    ws.emit('message', Buffer.from(encoding.toUint8Array(enc)));
  };
  const pushState = (ws: FakeWs, content: object) => {
    const client = new Y.Doc();
    jsonToYFragment(content as DocNode, client.getXmlFragment('default'));
    pushDoc(ws, client);
  };
  const versionOf = (id: string) => (db.prepare('SELECT version FROM pages WHERE id = ?').get(id) as { version: number }).version;
  const rowsOf = (id: string) => (db.prepare('SELECT count(*) AS n FROM synced_blocks WHERE page_id = ?').get(id) as { n: number }).n;
  const storedState = (id: string) => {
    const row = db.prepare('SELECT state FROM page_ydocs WHERE page_id = ?').get(id) as { state: Buffer } | undefined;
    if (!row) return null;
    const y = new Y.Doc();
    Y.applyUpdate(y, new Uint8Array(row.state));
    return yFragmentToJson(y.getXmlFragment('default'));
  };
  const sourcesOf = (d: DocNode | null) => {
    const out: string[] = [];
    const walk = (n: DocNode) => { if (n.type === 'syncedSource') out.push(String(n.attrs?.blockId)); (n.content ?? []).forEach(walk); };
    if (d) walk(d);
    return out;
  };
  const reserve = (pageId: string, n: number, removed = true) => {
    const insert = db.prepare("INSERT INTO synced_blocks (block_id, page_id, space_id, created_at, updated_at, removed_at) VALUES (?, ?, 'sp', 0, 0, ?)");
    return Array.from({ length: n }, () => { const id = newBlockId(); insert.run(id, pageId, removed ? 1 : null); return id; });
  };
  let hub: CollabHub | null = null;
  let bus: EventBus | null = null;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    hub?.shutdown();
    hub = null;
    bus = null;
    warn.mockRestore();
    error.mockRestore();
    vi.useRealTimers();
  });
  // Salle démarrée une fois les pages créées par l'API (horloges simulées ensuite seulement).
  const join = (pageId: string, user = 'ed1') => {
    if (!hub) {
      vi.useFakeTimers();
      bus = new EventBus();
      hub = new CollabHub(db, bus, () => true, (editors, author) => collabClonerFor(db, loadConfig(env), editors, author));
    }
    const ws = new FakeWs();
    expect(hub.connect(ws as unknown as WebSocket, pageId, { id: user, name: `Nom ${user}` })).toBe(true);
    // Synchronisation initiale du participant (étape 1) : il reçoit l'état complet de la salle.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, 0);
    syncProtocol.writeSyncStep1(step1, ws.seen);
    ws.emit('message', Buffer.from(encoding.toUint8Array(step1)));
    return ws;
  };

  it('état forgé « copie contenant une source, puis source d’une autre page » : la bonne source est renommée et la boucle s’arrête', async () => {
    const ed1 = await login('ed1');
    const X = newBlockId();
    const Z = newBlockId();
    const a = await pageWithSource(ed1, 'sp', 'A', X, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    const ws = join(b.id);
    pushState(ws, doc({ type: 'syncedCopy', attrs: { blockId: newBlockId() }, content: [source(Z, para('cachée'))] }, source(X, para('usurpation'))));
    await vi.advanceTimersByTimeAsync(2_100);
    const saved = JSON.parse(storedContent(b.id)) as DocNode;
    const ids = sourcesOf(saved);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(X);
    expect(ids[0]).not.toBe(Z);
    expect(storedContent(b.id)).not.toContain('cachée');
    expect(indexRow(X)).toMatchObject({ page_id: a, removed_at: null });
    expect(indexRow(Z)).toBeUndefined();
    const version = versionOf(b.id);
    const rows = rowsOf(b.id);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(versionOf(b.id)).toBe(version);
    expect(rowsOf(b.id)).toBe(rows);
    expect(JSON.parse(storedContent(b.id))).toEqual(saved);
  });

  it('(a) 200 identifiants atteints + source dupliquée forgée : rien ne se perd, travail des autres conservé après fermeture', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    reserve(b.id, MAX_SYNCED_IDS_PER_PAGE - 1);
    const honest = join(b.id, 'ed1');
    const evil = join(b.id, 'ed2');
    pushState(honest, doc(para('travail important')));
    const D = newBlockId();
    pushState(evil, doc(source(D, para('premier')), source(D, para('second'))));
    await vi.advanceTimersByTimeAsync(2_100);
    hub!.shutdown();
    const content = storedContent(b.id);
    for (const t of ['travail important', 'premier', 'second']) expect(content).toContain(t);
    expect(sourcesOf(JSON.parse(content) as DocNode)).toEqual([D]); // le doublon, faute d'identifiant libre, est sorti
    expect(rowsOf(b.id)).toBe(MAX_SYNCED_IDS_PER_PAGE);
    expect(storedState(b.id)).not.toBeNull();
  });

  it('(b) deux ajouts concurrents à 19 blocs : aucune perte, la page reste enregistrable', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    const copies = Array.from({ length: MAX_SYNCED_BLOCKS - 1 }, () => copy(newBlockId()));
    expect((await setContent(ed1, b.id, doc(para('base'), ...copies))).statusCode).toBe(200);
    const w1 = join(b.id, 'ed1');
    const w2 = join(b.id, 'ed2');
    pushState(w1, doc(source(newBlockId(), para('ajout un'))));
    pushState(w2, doc(source(newBlockId(), para('ajout deux'))));
    await vi.advanceTimersByTimeAsync(2_100);
    const saved = JSON.parse(storedContent(b.id)) as DocNode;
    expect(JSON.stringify(saved)).toContain('ajout un');
    expect(JSON.stringify(saved)).toContain('ajout deux');
    expect(saved.content!.filter((n) => n.type.startsWith('synced'))).toHaveLength(MAX_SYNCED_BLOCKS);
    hub!.shutdown();
    vi.useRealTimers();
    expect((await setContent(ed1, b.id, saved)).statusCode).toBe(200);
  });

  it('(c) plafond de 20 renommages par minute : sources en trop sorties de leur enveloppe, état stocké à la fermeture', async () => {
    const ed1 = await login('ed1');
    const a = await createPage(ed1, 'sp', 'A');
    const b = await createPage(ed1, 'sp', 'B');
    const ws = join(b.id);
    pushState(ws, doc(...reserve(a.id, 15, false).map((id) => source(id, para('x')))));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(rowsOf(b.id)).toBe(15);
    // Deuxième lot depuis l'état enregistré : 15 nouvelles sources en conflit, 5 renommages permis encore cette minute.
    const client = new Y.Doc();
    Y.applyUpdate(client, new Uint8Array((db.prepare('SELECT state FROM page_ydocs WHERE page_id = ?').get(b.id) as { state: Buffer }).state));
    const fragment = client.getXmlFragment('default');
    const before = Y.encodeStateVector(client);
    client.transact(() => { fragment.delete(0, fragment.length); jsonToYFragment(doc(...reserve(a.id, 15, false).map((id, i) => source(id, para(`lot ${i}`)))) as DocNode, fragment); });
    pushDoc(ws, client, before);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hors règles'));
    const saved = storedContent(b.id);
    for (let i = 0; i < 15; i++) expect(saved).toContain(`lot ${i}`);
    expect(sourcesOf(JSON.parse(saved) as DocNode)).toHaveLength(5);
    expect(rowsOf(b.id)).toBe(20);
    const version = versionOf(b.id);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(versionOf(b.id)).toBe(version);
    hub!.shutdown();
    expect(sanitizeDoc(storedState(b.id))).toEqual(JSON.parse(saved));
  });

  it('enregistrement en échec : état Yjs stocké, nouvel essai programmé, rien de perdu à la fermeture ni à la réouverture', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    const before = storedContent(b.id);
    const ws = join(b.id, 'ed1');
    pushState(ws, doc(para('travail important')));
    pushState(join(b.id, 'ed2'), doc({ type: 'details', content: [para('structure invalide')] }));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(storedContent(b.id)).toBe(before);
    expect(JSON.stringify(storedState(b.id))).toContain('travail important');
    const failures = error.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(error.mock.calls.length).toBeGreaterThan(failures); // nouvel essai sans nouveau changement
    hub!.shutdown();
    expect(JSON.stringify(storedState(b.id))).toContain('travail important');
    // Salle fermée : plus aucun essai programmé sur elle.
    const afterClose = error.mock.calls.length;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(error.mock.calls.length).toBe(afterClose);
    // Réouverture : la salle repart de l'état stocké, le travail est là.
    const again = join(b.id);
    expect(JSON.stringify(yFragmentToJson(again.seen.getXmlFragment('default')))).toContain('travail important');
  });

  it('fermeture de toutes les salles (changement de droits) après un échec : l’état Yjs n’est pas abandonné', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    pushState(join(b.id, 'ed1'), doc(para('travail important')));
    pushState(join(b.id, 'ed2'), doc({ type: 'details', content: [para('structure invalide')] }));
    hub!.evictAll();
    expect(JSON.stringify(storedState(b.id))).toContain('travail important');
    expect(JSON.stringify(yFragmentToJson(join(b.id).seen.getXmlFragment('default')))).toContain('travail important');
  });

  it('source collée dont aucun bloc ne survit (image http) : la salle enregistre, et une modification par l’API ne fait rien perdre', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    const ws = join(b.id, 'ed1');
    pushState(join(b.id, 'ed2'), doc(source(newBlockId(), { type: 'image', attrs: { src: 'http://exemple.test/a.png' } })));
    pushState(ws, doc(para('travail important')));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(error).not.toHaveBeenCalled();
    expect(storedContent(b.id)).toContain('travail important');
    expect(sourcesOf(JSON.parse(storedContent(b.id)) as DocNode)).toEqual([]);
    // Plus aucune écriture ensuite : la salle est stable.
    const version = versionOf(b.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(versionOf(b.id)).toBe(version);
    // Événements d'API : titre modifié (la salle reste ouverte avec son état, la suite s'enregistre), puis contenu modifié à partir
    // de ce qui est enregistré (la salle est fermée et son état abandonné, mais tout le travail est déjà dans la page).
    updatePage(db, b.id, { title: 'Renommée' }, 'ed1');
    bus!.publish({ type: 'page.updated', spaceId: 'sp', pageId: b.id });
    pushState(ws, doc(para('suite du travail')));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(storedContent(b.id)).toContain('suite du travail');
    const current = JSON.parse(storedContent(b.id)) as DocNode;
    updatePage(db, b.id, { content: { ...current, content: [...current.content!, para('ajout API')] } }, 'ed1');
    bus!.publish({ type: 'page.updated', spaceId: 'sp', pageId: b.id });
    for (const t of ['travail important', 'suite du travail', 'ajout API']) expect(storedContent(b.id)).toContain(t);
  });

  it('source dont la pièce jointe est retirée par le copieur : ni enregistrée vide ni indexée, puis retirée de l’état Yjs', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    const S1 = newBlockId();
    const observer = join(b.id, 'ed2');
    pushState(join(b.id, 'ed1'), doc(para('travail'), source(S1, { type: 'image', attrs: { src: `/api/v3/attachments/${'A'.repeat(22)}` } })));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(storedContent(b.id)).toContain('travail');
    expect(storedContent(b.id)).not.toContain('syncedSource');
    expect(indexRow(S1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(sourcesOf(yFragmentToJson(observer.seen.getXmlFragment('default')))).toEqual([]);
    const version = versionOf(b.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(versionOf(b.id)).toBe(version);
    expect(error).not.toHaveBeenCalled();
  });

  it('contenu modifié ailleurs pendant des modifications non enregistrées : elles sont gardées dans l’historique', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    pushState(join(b.id, 'ed1'), doc(para('travail important')));
    pushState(join(b.id, 'ed2'), doc({ type: 'details', content: [para('structure invalide')] }));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(storedContent(b.id)).not.toContain('travail important'); // enregistrement en échec
    updatePage(db, b.id, { content: doc(para('modifiée par l’API')) }, 'ed1');
    bus!.publish({ type: 'page.updated', spaceId: 'sp', pageId: b.id });
    expect(hub!.isOpen(b.id)).toBe(false);
    expect(storedContent(b.id)).toContain('modifiée par l’API');
    const last = db.prepare('SELECT content FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(b.id) as { content: string };
    expect(last.content).toContain('travail important');
    expect(last.content).not.toContain('structure invalide');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gardées dans l'));
  });

  it('salle fermée pendant un enregistrement qui applique un plan : ensuite, aucune écriture ni écrasement par un état périmé', async () => {
    const ed1 = await login('ed1');
    const X = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', X, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    pushState(join(b.id), doc(source(X, para('collée'))));
    hub!.shutdown(); // enregistrement à la fermeture : renommage appliqué dans l'état Yjs
    expect(sourcesOf(JSON.parse(storedContent(b.id)) as DocNode)).toHaveLength(1);
    const stamp = () => JSON.stringify([versionOf(b.id), db.prepare('SELECT updated_at, state FROM page_ydocs WHERE page_id = ?').get(b.id)]);
    const before = stamp();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stamp()).toBe(before);
  });

  it('échecs répétés : nouvel essai espacé (30 s, 60 s, 120 s…) et état stocké seulement s’il a changé', async () => {
    const ed1 = await login('ed1');
    const b = await createPage(ed1, 'sp', 'B');
    const observer = join(b.id, 'ed1');
    pushState(join(b.id, 'ed2'), doc({ type: 'details', content: [para('structure invalide')] }));
    await vi.advanceTimersByTimeAsync(2_100);
    const failures = () => error.mock.calls.filter((c: unknown[]) => String(c[0]).includes('échec de la sauvegarde')).length;
    const storedAt = () => (db.prepare('SELECT updated_at FROM page_ydocs WHERE page_id = ?').get(b.id) as { updated_at: number }).updated_at;
    expect(failures()).toBe(1);
    const stored = storedAt();
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      // Pas plus tôt que prévu, puis exactement un essai à l'échéance (pas de dérive : chaque tour avance de `delay`).
      const n = failures();
      await vi.advanceTimersByTimeAsync(delay - 1_500);
      expect(failures(), String(delay)).toBe(n);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(failures(), String(delay)).toBe(n + 1);
    }
    expect(storedAt()).toBe(stored);
    // Réparation (le dépliable invalide est supprimé) : succès, puis un nouvel échec repart d'un délai de 30 s.
    const fragment = observer.seen.getXmlFragment('default');
    const before = Y.encodeStateVector(observer.seen);
    const index = fragment.toArray().findIndex((n) => n instanceof Y.XmlElement && n.nodeName === 'details');
    observer.seen.transact(() => fragment.delete(index, 1));
    pushDoc(observer, observer.seen, before);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(storedContent(b.id)).not.toContain('structure invalide');
    pushState(join(b.id, 'ed2'), doc({ type: 'details', content: [para('de nouveau invalide')] }));
    await vi.advanceTimersByTimeAsync(2_100);
    const n = failures();
    await vi.advanceTimersByTimeAsync(30_500);
    expect(failures()).toBe(n + 1);
  });

  it('(d) un identifiant tiré par le serveur n’est diffusé qu’une fois inscrit dans l’index ; jamais si l’enregistrement échoue', async () => {
    const ed1 = await login('ed1');
    const X = newBlockId();
    await pageWithSource(ed1, 'sp', 'A', X, 'officiel');
    const b = await createPage(ed1, 'sp', 'B');
    const c = await createPage(ed1, 'sp', 'C');
    const writer = join(b.id, 'ed1');
    const observer = join(b.id, 'ed2');
    const leaks: string[] = [];
    observer.onUpdate = () => {
      for (const id of sourcesOf(yFragmentToJson(observer.seen.getXmlFragment('default')))) {
        if (id !== X && indexRow(id)?.page_id !== b.id) leaks.push(id);
      }
    };
    // Échec : conflit à renommer, mais structure invalide ailleurs : aucun identifiant ne sort, aucune réservation.
    pushState(writer, doc(source(X, para('collé')), { type: 'details', content: [para('invalide')] }));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(rowsOf(b.id)).toBe(0);
    expect(sourcesOf(yFragmentToJson(observer.seen.getXmlFragment('default')))).toEqual([X]);
    // Réussite : le nouvel identifiant n'arrive chez l'observateur qu'une fois dans l'index.
    const w2 = join(c.id, 'ed1');
    const o2 = join(c.id, 'ed2');
    o2.onUpdate = () => {
      for (const id of sourcesOf(yFragmentToJson(o2.seen.getXmlFragment('default')))) {
        if (id !== X && indexRow(id)?.page_id !== c.id) leaks.push(id);
      }
    };
    pushState(w2, doc(source(X, para('collé'))));
    await vi.advanceTimersByTimeAsync(2_100);
    const renamed = sourcesOf(yFragmentToJson(o2.seen.getXmlFragment('default')));
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).not.toBe(X);
    expect(indexRow(renamed[0]!)).toMatchObject({ page_id: c.id });
    expect(leaks).toEqual([]);
  });
});
