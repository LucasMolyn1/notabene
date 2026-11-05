// Export ZIP (lot 10 bis) : arborescence, droits page par page, fichiers joints et liens relatifs, noms assainis, plafonds.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { pathSegment } from '../src/lib/export-zip.js';
import { hashPassword } from '../src/lib/password.js';
import { createApiToken } from '../src/auth/tokens.js';

const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let filesDir: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docOf = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

async function boot(extra: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nb-zip-'));
  filesDir = join(dataDir, 'attachments');
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, visibility, created_at, updated_at) VALUES ('sp', 'Commun', 'public', 0, 0), ('prive', 'Privé', 'private', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit')").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'ed2', 'edit')").run();
}
afterEach(async () => { if (!app) return; await app.close(); db.close(); app = undefined as unknown as FastifyInstance; });

let pos = 0;
const page = (id: string, space: string, parent: string | null, title: string, content = docOf(para(`texte ${id}`)), kind = 'doc') =>
  db.prepare('INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at, position, kind) VALUES (?, ?, ?, ?, ?, \'\', 1, 1, ?, ?)').run(id, space, parent, title, content, pos++, kind);
function attach(id: string, pageId: string, name: string, data: Buffer, mime = 'image/png') {
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(filesDir, id), data, { mode: 0o600 });
  db.prepare('INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, 1)')
    .run(id, pageId, name, mime, data.length, createHash('sha256').update(data).digest('hex'));
}

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  return { nb_session: cookie };
}
const get = (cookies: Record<string, string> | undefined, url: string) => app.inject({ method: 'GET', url, cookies });
const unzip = (body: Buffer) => unzipSync(new Uint8Array(body));
const names = (z: Record<string, Uint8Array>) => Object.keys(z).sort();

const A1 = 'A'.repeat(21) + '1';
const A2 = 'B'.repeat(21) + '2';
const A3 = 'C'.repeat(21) + '3';

describe('noms de chemin', () => {
  it('assainit les titres : pas de séparateur, de « .. », de caractère de contrôle ni de nom réservé ; jamais vide', () => {
    expect(pathSegment('../../etc/passwd')).toBe('-..-etc-passwd');
    expect(pathSegment('..')).toBe('Sans titre');
    expect(pathSegment(' . ')).toBe('Sans titre');
    expect(pathSegment('')).toBe('Sans titre');
    expect(pathSegment('a\\b/c')).toBe('a-b-c');
    expect(pathSegment('x\u202Eyz\u0000')).toBe('xyz');
    expect(pathSegment('CON')).toBe('_CON');
    expect(pathSegment('nul.txt')).toBe('_nul.txt');
    expect(pathSegment('Rapport: "final" <v2>?')).toBe('Rapport_ _final_ _v2__');
    expect([...pathSegment('é'.repeat(500))]).toHaveLength(120);
  });
});

describe('export ZIP d’une page', () => {
  async function tree() {
    await boot();
    const data = `data:image/png;base64,${PNG.toString('base64')}`;
    const svg = `data:image/svg+xml;base64,${SVG.toString('base64')}`;
    page('racine', 'sp', null, 'Racine', docOf(
      para('début'),
      { type: 'image', attrs: { src: `/api/v3/attachments/${A1}`, alt: 'schéma' } },
      { type: 'image', attrs: { src: data, alt: 'collée' } },
      { type: 'image', attrs: { src: svg, alt: 'vecteur' } },
      { type: 'image', attrs: { src: `/api/v3/attachments/${A3}`, alt: 'volée' } },
      { type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: 'petit' } }] },
    ));
    page('enfant', 'sp', 'racine', 'Enfant', docOf({ type: 'attachment', attrs: { id: A2, name: 'notes.pdf', size: 12, mime: 'application/pdf' } }));
    page('petit', 'sp', 'enfant', 'Petit-enfant');
    page('ailleurs', 'prive', null, 'Ailleurs');
    // Sous-page restreinte (avec sa descendance) et sous-page à la corbeille : jamais dans l'archive de ed1.
    page('cache', 'sp', 'racine', 'Caché');
    page('sous-cache', 'sp', 'cache', 'Sous caché');
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('cache', 'ed2', 'write')").run();
    page('jete', 'sp', 'racine', 'Jeté');
    db.prepare("UPDATE pages SET deleted_at = 5, trash_root = 'jete' WHERE id = 'jete'").run();
    attach(A1, 'racine', 'schéma (v1).png', PNG);
    attach(A2, 'enfant', 'notes.pdf', Buffer.from('%PDF-1.7\n...'), 'application/pdf');
    attach(A3, 'ailleurs', 'secret.png', PNG);
  }

  it('Markdown avec sous-pages : dossiers, fichiers joints dans attachments/, liens relatifs, rien d’illisible', async () => {
    await tree();
    const ed1 = await login('ed1');
    const res = await get(ed1, '/api/v3/pages/racine/export/zip?subpages=true');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="Racine.zip"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const z = unzip(res.rawPayload);
    expect(names(z)).toEqual([
      'Racine.md', 'Racine/Enfant.md', 'Racine/Enfant/Petit-enfant.md', 'attachments/image-1.png', 'attachments/notes.pdf', 'attachments/schéma (v1).png',
    ].sort());
    const md = strFromU8(z['Racine.md']!);
    expect(md).toContain('![schéma](attachments/sch%C3%A9ma%20%28v1%29.png)');
    expect(md).toContain('![collée](attachments/image-1.png)');
    expect(md).toContain('_[Image : vecteur]_'); // SVG : jamais extrait
    expect(md).toContain(`![volée](/api/v3/attachments/${A3})`); // fichier d'un espace illisible : ni copié ni réécrit
    expect(md).toContain('[Petit-enfant](Racine/Enfant/Petit-enfant.md)');
    expect(strFromU8(z['Racine/Enfant.md']!)).toContain('[notes.pdf](../attachments/notes.pdf)');
    expect(Buffer.from(z['attachments/schéma (v1).png']!).equals(PNG)).toBe(true);
    expect(Buffer.from(z['attachments/image-1.png']!).equals(PNG)).toBe(true);
    const all = Object.keys(z).join('\n') + Object.values(z).map((b) => strFromU8(b)).join('\n');
    for (const hidden of ['Caché', 'Sous caché', 'Jeté', 'secret.png', 'Ailleurs']) expect(all).not.toContain(hidden);
    const row = db.prepare("SELECT user_id, meta FROM audit_log WHERE action = 'page.export.zip'").get() as { user_id: string; meta: string };
    expect(row.user_id).toBe('ed1');
    expect(JSON.parse(row.meta)).toMatchObject({ format: 'md', subpages: true, pages: 3, files: 2, images: 1, missing: 0 });
  });

  it('un lecteur autorisé de la sous-page restreinte la reçoit ; sans subpages, la page seule', async () => {
    await tree();
    const ed2 = await login('ed2');
    const z = unzip((await get(ed2, '/api/v3/pages/racine/export/zip?subpages=true')).rawPayload);
    expect(Object.keys(z)).toContain('Racine/Caché/Sous caché.md');
    const alone = unzip((await get(ed2, '/api/v3/pages/racine/export/zip')).rawPayload);
    expect(names(alone).filter((n) => !n.startsWith('attachments/'))).toEqual(['Racine.md']);
    expect(strFromU8(alone['Racine.md']!)).toContain('[Petit-enfant](/p/petit)'); // page hors archive : lien vers le wiki
  });

  it('HTML : document complet, CSP sans script, titre échappé, images en chemin relatif', async () => {
    await tree();
    db.prepare("UPDATE pages SET title = '<script>alert(1)</script>' WHERE id = 'enfant'").run();
    const ed1 = await login('ed1');
    const z = unzip((await get(ed1, '/api/v3/pages/racine/export/zip?subpages=true&format=html')).rawPayload);
    expect(Object.keys(z)).toContain('Racine/_script_alert(1)_-script_.html');
    const html = strFromU8(z['Racine.html']!);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<img src="attachments/image-1.png" alt="collée"');
    expect(html).toContain('<img src="attachments/sch%C3%A9ma%20(v1).png"');
    expect(html).not.toContain('data:image/svg');
    const child = strFromU8(z['Racine/_script_alert(1)_-script_.html']!);
    expect(child).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(child).not.toContain('<script>');
    expect(child).toContain('href="../attachments/notes.pdf"');
  });

  it('titres hostiles et doublons : noms sûrs et uniques, dossier et fichier jamais confondus', async () => {
    await boot();
    page('r', 'sp', null, '../../etc');
    for (const [id, t] of [['a', 'Doc'], ['b', 'doc'], ['c', 'Doc.md'], ['d', '..'], ['e', 'attachments'], ['f', '/abs\\olu'], ['g', 'CON']]) page(id, 'sp', 'r', t);
    page('a1', 'sp', 'a', 'Fille');
    page('c1', 'sp', 'c', 'Fille');
    const ed1 = await login('ed1');
    const z = unzip((await get(ed1, '/api/v3/pages/r/export/zip?subpages=true')).rawPayload);
    const n = names(z);
    expect(n).toEqual([
      // « doc » après « Doc » (même nom sans la casse) ; « Doc.md » ne peut ni s'appeler comme le fichier de « Doc » ni lui prendre son nom.
      '-..-etc.md', '-..-etc/-abs-olu.md', '-..-etc/doc (2).md', '-..-etc/Doc.md', '-..-etc/Doc.md (2).md', '-..-etc/Doc.md (2)/Fille.md', '-..-etc/Doc/Fille.md',
      '-..-etc/Sans titre.md', '-..-etc/_CON.md', '-..-etc/attachments.md',
    ].sort());
    for (const name of n) {
      expect(name.split('/').every((s) => s !== '' && s !== '.' && s !== '..')).toBe(true);
      expect(name).not.toMatch(/^\/|\\|:/);
    }
  });

  it('droits : sans compte 401, page illisible 404, jeton sans lecture 403', async () => {
    await tree();
    expect((await get(undefined, '/api/v3/pages/racine/export/zip')).statusCode).toBe(401);
    const ed1 = await login('ed1');
    expect((await get(ed1, '/api/v3/pages/cache/export/zip')).statusCode).toBe(404);
    expect((await get(ed1, '/api/v3/pages/ailleurs/export/zip')).statusCode).toBe(404);
    expect((await get(ed1, '/api/v3/pages/jete/export/zip')).statusCode).toBe(404);
    const token = createApiToken(db, 'ed1', { name: 't', scopes: ['ai'], expiresInDays: 1 }).token;
    expect((await app.inject({ method: 'GET', url: '/api/v3/pages/racine/export/zip', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    const reader = createApiToken(db, 'ed1', { name: 'r', scopes: ['read'], expiresInDays: 1 }).token;
    expect((await app.inject({ method: 'GET', url: '/api/v3/pages/racine/export/zip', headers: { authorization: `Bearer ${reader}` } })).statusCode).toBe(200);
    expect((await get(ed1, '/api/v3/pages/racine/export/zip?format=pdf')).statusCode).toBe(400);
  });

  it('fichier absent du disque : laissé hors de l’archive, lien d’origine conservé, compté', async () => {
    await tree();
    db.prepare('UPDATE attachments SET size = size + 1 WHERE id = ?').run(A1);
    const ed1 = await login('ed1');
    const z = unzip((await get(ed1, '/api/v3/pages/racine/export/zip')).rawPayload);
    expect(Object.keys(z)).not.toContain('attachments/schéma (v1).png');
    expect(strFromU8(z['Racine.md']!)).toContain(`/api/v3/attachments/${A1}`);
    expect(JSON.parse((db.prepare("SELECT meta FROM audit_log WHERE action = 'page.export.zip'").get() as { meta: string }).meta).missing).toBe(1);
  });
});

describe('plafonds et débit', () => {
  it('trop de pages : 413 avant toute écriture', async () => {
    await boot({ EXPORT_MAX_PAGES: '2' });
    page('r', 'sp', null, 'R');
    page('x', 'sp', 'r', 'X');
    page('y', 'sp', 'r', 'Y');
    const ed1 = await login('ed1');
    const res = await get(ed1, '/api/v3/pages/r/export/zip?subpages=true');
    expect(res.statusCode).toBe(413);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().detail).toContain('2 au plus');
    expect((await get(ed1, '/api/v3/pages/r/export/zip')).statusCode).toBe(200);
  });

  it('volume total dépassé : 413', async () => {
    await boot({ EXPORT_MAX_MB: '1' });
    const big = Buffer.concat([PNG, randomBytes(1024 * 1024)]);
    page('r', 'sp', null, 'R', docOf({ type: 'image', attrs: { src: `/api/v3/attachments/${A1}` } }));
    attach(A1, 'r', 'gros.png', big);
    const res = await get(await login('ed1'), '/api/v3/pages/r/export/zip');
    expect(res.statusCode).toBe(413);
    expect(res.json().detail).toContain('1 Mo au plus');
  });

  it('débit limité par personne', async () => {
    await boot();
    page('r', 'sp', null, 'R');
    const ed1 = await login('ed1');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await get(ed1, '/api/v3/spaces/sp/export/zip')).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});

describe('export ZIP d’un espace', () => {
  it('toutes les racines lisibles, bases en CSV, corbeille exclue ; espace invisible 404', async () => {
    await boot();
    page('un', 'sp', null, 'Un');
    page('deux', 'sp', null, 'Deux');
    page('base', 'sp', 'deux', 'Tableau', docOf(), 'base');
    page('jete', 'sp', null, 'Jeté');
    db.prepare("UPDATE pages SET deleted_at = 5, trash_root = 'jete' WHERE id = 'jete'").run();
    page('ailleurs', 'prive', null, 'Ailleurs');
    const ed1 = await login('ed1');
    const res = await get(ed1, '/api/v3/spaces/sp/export/zip?format=html');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Commun.zip"');
    expect(names(unzip(res.rawPayload))).toEqual(['Deux.html', 'Deux/Tableau.csv', 'Un.html']);
    expect((await get(ed1, '/api/v3/spaces/prive/export/zip')).statusCode).toBe(404);
    expect((await get(undefined, '/api/v3/spaces/sp/export/zip')).statusCode).toBe(401);
    expect(db.prepare("SELECT target FROM audit_log WHERE action = 'space.export.zip'").get()).toEqual({ target: 'sp' });
  });
});
