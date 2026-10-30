import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { jsonToYFragment, yFragmentToJson } from '../src/lib/yjs-json.js';

describe('conversion JSON <-> Yjs', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'un ' }, { type: 'text', text: 'gras', marks: [{ type: 'bold' }] }, { type: 'text', text: ' et ' },
        { type: 'text', text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'italic' }] },
        { type: 'pageLink', attrs: { id: 'abc' } }, { type: 'text', text: 'fin' },
      ] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph' }] }] },
      { type: 'mermaid', attrs: { code: 'flowchart LR\n A-->B' } },
    ],
  };
  it('est un aller-retour sans perte', () => {
    const y = new Y.Doc();
    jsonToYFragment(doc, y.getXmlFragment('default'));
    expect(yFragmentToJson(y.getXmlFragment('default'))).toEqual(doc);
  });
  it('survit à la synchronisation entre deux documents', () => {
    const a = new Y.Doc();
    jsonToYFragment(doc, a.getXmlFragment('default'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(yFragmentToJson(b.getXmlFragment('default'))).toEqual(doc);
  });
});

const env = { NODE_ENV: 'test',  PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DEV_LOGIN: 'true', SEED_DEMO: 'false' };
let app: FastifyInstance;
let db: DB;
let pageId: string;

beforeEach(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  await app.ready();
  pageId = (db.prepare("SELECT id FROM pages WHERE title = 'Bienvenue sur Notabene'").get() as { id: string }).id;
});
afterEach(async () => { await app.close(); db.close(); });

async function login(role: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { role } });
  const cookie = r.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookie, csrf: me.csrf as string };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('délai dépassé'); await wait(15); }
}

// Client minimal du protocole y-websocket.
async function connect(cookie: string, opts: { origin?: string; id?: string } = {}) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const state = { epoch: '', closed: null as number | null };
  const attach = (ws: WebSocket) => {
    ws.on('close', (code: number) => { state.closed = code; });
    ws.on('message', (data: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), 'remote');
      else if (type === 100) state.epoch = decoding.readVarString(dec);
    });
  };
  // onInit : les écouteurs sont posés avant l'ouverture, comme dans un navigateur.
  const ws = (await app.injectWS(`/collab/${opts.id ?? pageId}`, { headers: { cookie: `nb_session=${cookie}`, origin: opts.origin ?? 'http://localhost:3000' } }, { onInit: attach })) as unknown as WebSocket;
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
  const json = () => yFragmentToJson(doc.getXmlFragment('default'));
  return { ws, doc, awareness, state, json };
}

const textOf = (n: { text?: string; content?: unknown[] }): string => (n.text ?? '') + ((n.content ?? []) as { text?: string; content?: unknown[] }[]).map(textOf).join('');

describe('co-édition en temps réel', () => {
  it('amorce la salle depuis la page et diffuse les modifications entre rédacteurs', async () => {
    const { cookie } = await login('editor');
    const a = await connect(cookie);
    const b = await connect(cookie);
    await until(() => textOf(a.json()).includes('Notabene est un') && textOf(b.json()).includes('Notabene est un'));
    expect(a.state.epoch).toBeTruthy();
    expect(a.state.epoch).toBe(b.state.epoch);

    const para = a.doc.getXmlFragment('default').toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph') as Y.XmlElement;
    (para.get(0) as Y.XmlText).insert(0, 'COLLAB ');
    await until(() => textOf(b.json()).includes('COLLAB Notabene'));
    a.ws.close(); b.ws.close();
    await until(() => (db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string }).content.includes('COLLAB Notabene'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_ydocs WHERE page_id = ?').get(pageId)).toEqual({ n: 1 });
  });

  it('reprend l’état persisté avec la même époque après fermeture de la salle', async () => {
    const { cookie } = await login('editor');
    const a = await connect(cookie);
    await until(() => a.state.epoch !== '' && textOf(a.json()).length > 10);
    const epoch = a.state.epoch;
    a.ws.close();
    await until(() => a.state.closed !== null);
    const b = await connect(cookie);
    await until(() => textOf(b.json()).length > 10);
    expect(b.state.epoch).toBe(epoch);
    b.ws.close();
  });

  it('assainit le contenu écrit par un client avant de le stocker', async () => {
    const { cookie } = await login('editor');
    const a = await connect(cookie);
    await until(() => textOf(a.json()).length > 10);
    const el = new Y.XmlElement('scriptEvil');
    el.setAttribute('onload', 'alert(1)');
    a.doc.getXmlFragment('default').insert(0, [el]);
    await wait(100);
    a.ws.close();
    await until(() => a.state.closed !== null);
    await wait(100);
    const saved = (db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string }).content;
    expect(saved).not.toContain('scriptEvil');
    expect(saved).not.toContain('alert(1)');
  });

  it('ferme les connexions quand le contenu change par l’API (rechargement)', async () => {
    const { cookie, csrf } = await login('editor');
    const a = await connect(cookie);
    await until(() => textOf(a.json()).length > 10);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v3/pages/${pageId}`, cookies: { nb_session: cookie },
      headers: { 'x-csrf-token': csrf, 'if-match': `"${(db.prepare('SELECT version FROM pages WHERE id = ?').get(pageId) as { version: number }).version}"` },
      payload: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Modifié par API' }] }] } },
    });
    expect(res.statusCode).toBe(200);
    await until(() => a.state.closed !== null);
    expect(a.state.closed).toBe(4409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_ydocs WHERE page_id = ?').get(pageId)).toEqual({ n: 0 });
    const b = await connect(cookie);
    await until(() => textOf(b.json()).includes('Modifié par API'));
    b.ws.close();
  });

  it('ne recharge pas quand seul le titre change', async () => {
    const { cookie, csrf } = await login('editor');
    const a = await connect(cookie);
    await until(() => textOf(a.json()).length > 10);
    await app.inject({ method: 'PATCH', url: `/api/v3/pages/${pageId}`, cookies: { nb_session: cookie }, headers: { 'x-csrf-token': csrf }, payload: { title: 'Nouveau titre' } });
    await wait(150);
    expect(a.state.closed).toBeNull();
    a.ws.close();
  });

  it('coupe une connexion ouverte quand la session ferme, que le compte est désactivé ou que la page devient restreinte', async () => {
    // Déconnexion
    const a = await login('editor');
    const wsA = await connect(a.cookie);
    await until(() => textOf(wsA.json()).length > 10);
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { nb_session: a.cookie }, headers: { 'x-csrf-token': a.csrf } });
    await until(() => wsA.state.closed !== null);
    expect(wsA.state.closed).toBe(4403);

    // Compte désactivé (ou rôle abaissé) puis revérification
    const b = await login('editor');
    const wsB = await connect(b.cookie);
    await until(() => textOf(wsB.json()).length > 10);
    db.prepare("UPDATE users SET disabled = 1 WHERE role = 'editor'").run();
    app.collab!.recheckAll();
    await until(() => wsB.state.closed !== null);
    expect(wsB.state.closed).toBe(4403);
    db.prepare("UPDATE users SET disabled = 0 WHERE role = 'editor'").run();

    // Page devenue restreinte à quelqu'un d'autre
    const c = await login('editor');
    const wsC = await connect(c.cookie);
    await until(() => textOf(wsC.json()).length > 10);
    await login('admin');
    const other = (db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: string }).id;
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, 'write')").run(pageId, other);
    app.collab!.recheckAll();
    await until(() => wsC.state.closed !== null);
    expect(wsC.state.closed).toBe(4403);
  });

  it('refuse sans session, pour un lecteur, depuis une autre origine et pour une page inconnue', async () => {
    const editor = await login('editor');
    const reader = await login('reader');
    await expect(connect('invalide')).rejects.toThrow();
    await expect(connect(reader.cookie)).rejects.toThrow();
    await expect(connect(editor.cookie, { origin: 'https://evil.example' })).rejects.toThrow();
    await expect(connect(editor.cookie, { id: 'inconnue' })).rejects.toThrow();
  });
});
