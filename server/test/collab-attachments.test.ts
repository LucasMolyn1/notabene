// Pièces jointes et co-édition (lot 10) : une citation venue d'une autre page n'est copiée que si toutes les personnes qui ont modifié
// peuvent la lire ; l'état Yjs reçoit le même nettoyage ; un plafond dépassé retire la citation sans faire échouer l'enregistrement.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { newAttachmentId } from '../src/lib/attachments.js';
import { importMarkdown } from '../src/lib/markdown-import.js';
import { yFragmentToJson } from '../src/lib/yjs-json.js';
import { seedDemo } from '../src/seed.js';

let app: FastifyInstance;
let db: DB;
let pageId: string;
let filesDir: string;

async function boot(extra: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nb-collab-att-'));
  filesDir = join(dataDir, 'attachments');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  await app.ready();
  pageId = (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur BeNote'").get() as { id: string }).id;
}
beforeEach(() => { app = undefined as unknown as FastifyInstance; });
afterEach(async () => { if (app) { await app.close(); db.close(); } });

async function login(role: 'admin' | 'editor') {
  const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = r.cookies.find((c) => c.name === 'nb_session')!.value;
  const userId = (db.prepare('SELECT id FROM users WHERE sub = ?').get(`dev-${role}`) as { id: string }).id;
  return { cookie, userId };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('délai dépassé'); await wait(20); }
}

// Client minimal du protocole y-websocket (comme collab.test.ts).
async function connect(cookie: string) {
  const doc = new Y.Doc();
  const state = { closed: null as number | null, synced: false };
  const attach = (ws: WebSocket) => {
    ws.on('close', (code: number) => { state.closed = code; });
    ws.on('message', (data: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
      state.synced = true;
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    });
  };
  const ws = (await app.injectWS(`/collab/${pageId}`, { headers: { cookie: `nb_session=${cookie}`, origin: 'http://localhost:3000' } }, { onInit: attach })) as unknown as WebSocket;
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, 0);
  syncProtocol.writeSyncStep1(step1, doc);
  ws.send(encoding.toUint8Array(step1));
  await until(() => doc.getXmlFragment('default').length > 0);
  return { ws, doc, state, json: () => JSON.stringify(yFragmentToJson(doc.getXmlFragment('default'))) };
}

// Pièce jointe d'une autre page : ligne et fichier.
function foreign(page: string, size = 16): string {
  const id = newAttachmentId();
  const data = randomBytes(size);
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(filesDir, id), data, { mode: 0o600 });
  db.prepare("INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, ?, NULL, 'f.bin', 'application/octet-stream', ?, ?, 0)")
    .run(id, page, size, createHash('sha256').update(data).digest('hex'));
  return id;
}
function otherPage(restrictedTo?: string): string {
  const id = newAttachmentId().slice(0, 12);
  const space = (db.prepare('SELECT space_id FROM pages WHERE id = ?').get(pageId) as { space_id: string }).space_id;
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, 'Autre', '{\"type\":\"doc\",\"content\":[]}', '', 1, 1)").run(id, space);
  if (restrictedTo) db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, 'write')").run(id, restrictedTo);
  return id;
}
const paste = (doc: Y.Doc, id: string) => {
  const el = new Y.XmlElement('attachment');
  el.setAttribute('id', id);
  el.setAttribute('name', 'colle.bin');
  doc.getXmlFragment('default').insert(0, [el]);
};
const typeText = (doc: Y.Doc, text: string) => {
  const para = doc.getXmlFragment('default').toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph') as Y.XmlElement;
  (para.get(0) as Y.XmlText).insert(0, text);
};
const stored = () => (db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string }).content;
const yState = () => (db.prepare('SELECT state FROM page_ydocs WHERE page_id = ?').get(pageId) as { state: Buffer }).state.toString('latin1');

describe('co-édition et pièces jointes citées', () => {
  it('B colle une pièce jointe qu’il ne peut pas lire, A modifie : jamais copiée, retirée de la page et de l’état Yjs', async () => {
    await boot();
    const admin = await login('admin');
    const editor = await login('editor');
    const hidden = foreign(otherPage(admin.userId));
    const b = await connect(editor.cookie);
    const a = await connect(admin.cookie);
    paste(b.doc, hidden);
    await until(() => a.json().includes(hidden));
    typeText(a.doc, 'A ');
    await until(() => stored().includes('A '), 6000);
    expect(stored()).not.toContain(hidden);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE copied_from = ?').get(hidden)).toEqual({ n: 0 });
    await until(() => !a.json().includes(hidden) && !b.json().includes(hidden));
    await until(() => !yState().includes(hidden));
    const res = await app.inject({ method: 'GET', url: `/api/v3/attachments/${hidden}`, cookies: { nb_session: editor.cookie } });
    expect(res.statusCode).toBe(404);
    a.ws.close(); b.ws.close();
  });

  it('collée par une personne qui peut la lire : copiée, et l’état Yjs pointe vers la copie', async () => {
    await boot();
    const admin = await login('admin');
    const editor = await login('editor');
    const src = foreign(otherPage(admin.userId));
    const a = await connect(admin.cookie);
    paste(a.doc, src);
    await until(() => !!db.prepare('SELECT 1 FROM attachments WHERE copied_from = ?').get(src), 6000);
    const copy = (db.prepare('SELECT id, page_id FROM attachments WHERE copied_from = ?').get(src) as { id: string; page_id: string });
    expect(copy.page_id).toBe(pageId);
    await until(() => a.json().includes(copy.id) && !a.json().includes(src));
    // La copie appartient à la page : lisible par qui lit la page, l'original restant fermé.
    expect((await app.inject({ method: 'GET', url: `/api/v3/attachments/${copy.id}`, cookies: { nb_session: editor.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v3/attachments/${src}`, cookies: { nb_session: editor.cookie } })).statusCode).toBe(404);
    a.ws.close();
  });

  it('plafond de copie dépassé : la page s’enregistre quand même, les citations en trop sont retirées', async () => {
    await boot({ ATTACHMENT_COPY_MAX_MB: '1' });
    const admin = await login('admin');
    const other = otherPage();
    const first = foreign(other, 600 * 1024);
    const second = foreign(other, 600 * 1024);
    const a = await connect(admin.cookie);
    paste(a.doc, first);
    paste(a.doc, second);
    typeText(a.doc, 'ENREGISTRE ');
    await until(() => stored().includes('ENREGISTRE '), 6000);
    const copies = db.prepare('SELECT copied_from FROM attachments WHERE page_id = ?').all(pageId) as { copied_from: string }[];
    expect(copies).toHaveLength(1);
    const kept = copies[0]!.copied_from;
    const dropped = kept === first ? second : first;
    expect(stored()).not.toContain(dropped);
    await until(() => !a.json().includes(dropped));
    a.ws.close();
  });
});

describe('import Markdown', () => {
  it('une citation de pièce jointe dans un fichier importé n’est jamais conservée telle quelle', async () => {
    await boot();
    const admin = await login('admin');
    const src = foreign(otherPage(admin.userId));
    const space = (db.prepare('SELECT space_id FROM pages WHERE id = ?').get(pageId) as { space_id: string }).space_id;
    importMarkdown(db, { spaceId: space, userId: admin.userId, files: [{ path: 'note.md', content: `# Note\n\n![x](/api/v3/attachments/${src})\n` }] });
    const page = db.prepare("SELECT content FROM pages WHERE title = 'Note'").get() as { content: string };
    expect(page.content).not.toContain(src);
  });
});
