// Import Notion (lot 11) : archive ZIP « Markdown & CSV » reconstruite ici avec fflate, même structure qu'un vrai export Notion
// (« Titre <id>.md », dossier « Titre/ » des sous-pages et fichiers, bases en « .csv » et « _all.csv »), contenu inventé.
// Défenses de l'archive (bombe, « .. », lien symbolique, ZIP imbriqué), hiérarchie, liens, pièces jointes, bases, droits, simulation, rapport.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type Zippable, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { notionName, parseCsv } from '../src/lib/notion-import.js';
import { unsafePath, ZipArchive } from '../src/lib/zip-read.js';
import { oldDb } from './migrations.js';

const PASS = 'Sup3r-secret-pass';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(40)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const ROOT_ID = '0123456789abcdef0123456789abcdef';
const STEP_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = 'Projet Été — Carnet';
// Émojis de tête des callouts de Notion (ampoule, panneau d'avertissement), écrits par leur code.
const BULB = String.fromCodePoint(0x1f4a1);
const WARN = String.fromCodePoint(0x26a0, 0xfe0f);
const enc = (s: string) => encodeURIComponent(s).replace(/'/g, '%27');
const LIM = { maxEntries: 1000, maxTotalBytes: 100 * 1024 * 1024, maxRatio: 100 };

/** Export synthétique, structure d'un vrai export Notion. */
function notionExport(): Record<string, Uint8Array> {
  const t = (s: string) => new TextEncoder().encode(s);
  return {
    [`${ROOT} ${ROOT_ID}.md`]: t([
      `# ${ROOT}`, '',
      `> ${BULB} **Idée** : un encadré à garder.`, '> ', '',
      `Voir [Étape 1](${enc(ROOT)}/${enc(`Étape 1 ${STEP_ID}`)}.md) et [la base](${enc(ROOT)}/${enc(`Tâches ${BASE_ID}`)}.csv).`, '',
      `Lien absolu [ici](https://www.notion.so/Etape-1-${STEP_ID}) et lien perdu [absent](${enc('Inexistant ffffffffffffffffffffffffffffffff')}.md).`, '',
      '| Colonne | Valeur |', '| --- | --- |', '| un | 1 |', '',
      '---', '',
      `[plan.pdf](${enc(ROOT)}/plan.pdf)`, '',
      `![photo.png](${enc(ROOT)}/photo.png)`, '',
      `![dessin.svg](${enc(ROOT)}/dessin.svg)`, '',
    ].join('\n')),
    [`${ROOT}/Étape 1 ${STEP_ID}.md`]: t(`# Étape 1\n\nRetour à [l’accueil](../${enc(`${ROOT} ${ROOT_ID}`)}.md).\n\n> ${WARN} Attention au départ.\n`),
    [`${ROOT}/Tâches ${BASE_ID}.csv`]: t('Nom,Statut\nAcheter des cordes,Fait\n'),
    [`${ROOT}/Tâches ${BASE_ID}_all.csv`]: t('\ufeffNom,Statut,Notes\nAcheter des cordes,Fait,"long, avec virgule"\nRéviser le plan,À faire,"sur\ndeux lignes"\n'),
    [`${ROOT}/Tâches/Acheter des cordes cccccccccccccccccccccccccccccccc.md`]: t('# Acheter des cordes\n\nStatut: Fait\nNotes: long, avec virgule\n\nCorps de la ligne.\n'),
    [`${ROOT}/Tâches/Réviser le plan dddddddddddddddddddddddddddddddd.md`]: t('# Réviser le plan\n\nStatut: À faire\n'),
    [`${ROOT}/plan.pdf`]: PDF,
    [`${ROOT}/photo.png`]: PNG,
    [`${ROOT}/dessin.svg`]: SVG,
    [`${ROOT}/orphelin.png`]: PNG,
    [`${ROOT}/ancienne ${'e'.repeat(32)}.html`]: t('<html><body><script>alert(1)</script></body></html>'),
  };
}
const zipOf = (files: Zippable) => Buffer.from(zipSync(files, { level: 6 }));

/** Retire le drapeau « nom en UTF-8 » (bit 11) des en-têtes, comme certains exports Notion. */
function clearUtf8Flag(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  let eocd = out.length - 22;
  while (out.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = out.readUInt32LE(eocd + 16);
  for (let n = 0; n < out.readUInt16LE(eocd + 10); n++) {
    out.writeUInt16LE(out.readUInt16LE(p + 8) & ~0x800, p + 8);
    const local = out.readUInt32LE(p + 42);
    out.writeUInt16LE(out.readUInt16LE(local + 6) & ~0x800, local + 6);
    p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
  }
  return out;
}
/** Réécrit la taille décompressée annoncée de la première entrée (archive qui ment). */
function lieAboutSize(buf: Buffer, size: number): Buffer {
  const out = Buffer.from(buf);
  let eocd = out.length - 22;
  while (out.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  out.writeUInt32LE(size, out.readUInt32LE(eocd + 16) + 24);
  return out;
}

describe('lecture sûre d’une archive', () => {
  it('refuse chemins absolus, « .. », caractères de contrôle et noms réservés', () => {
    for (const p of ['/etc/passwd', 'C:/Windows/x.md', '../x.md', 'a/../../x.md', 'a//b.md', './a.md', 'a/\u0000.md', 'a/\u202eexe.md', 'CON', 'dossier/nul.txt', 'lpt1.md']) expect(unsafePath(p)).not.toBeNull();
    for (const p of ['Page 0123.md', 'Dossier/Été — œuvre.md', 'a/b/c.png', 'console.md']) expect(unsafePath(p)).toBeNull();
  });

  it('écarte les entrées dangereuses avec leur motif, sans annuler les autres', () => {
    const zip = new ZipArchive(zipOf({
      'ok.md': new TextEncoder().encode('# Ok'),
      '../evade.md': new TextEncoder().encode('x'),
      '/absolu.md': new TextEncoder().encode('x'),
      'dossier\\..\\..\\windows.md': new TextEncoder().encode('x'),
      'lien.md': [new TextEncoder().encode('/etc/passwd'), { os: 3, attrs: 0o120777 * 65536 }],
      '__MACOSX/._ok.md': new TextEncoder().encode('x'),
      'aux.md': new TextEncoder().encode('x'),
    }), LIM);
    expect(zip.items.map((i) => i.path)).toEqual(['ok.md']);
    const reasons = Object.fromEntries(zip.skipped.map((s) => [s.path, s.reason]));
    expect(reasons['../evade.md']).toMatch(/\.\./);
    expect(reasons['/absolu.md']).toMatch(/absolu/);
    expect(reasons['dossier/../../windows.md']).toMatch(/\.\./);
    expect(reasons['lien.md']).toMatch(/lien symbolique/);
    expect(reasons['__MACOSX/._ok.md']).toMatch(/système/);
    expect(reasons['aux.md']).toMatch(/réservé/);
  });

  it('refuse une bombe ZIP (taux de compression) avant de décompresser', () => {
    const bomb = zipOf({ 'bombe.md': new Uint8Array(20 * 1024 * 1024) });
    expect(() => new ZipArchive(bomb, LIM)).toThrow(/taux de compression/);
  });

  it('refuse une archive trop grosse une fois décompressée, ou avec trop d’entrées', () => {
    const big = zipOf({ 'a.bin': randomBytes(3 * 1024 * 1024) });
    expect(() => new ZipArchive(big, { ...LIM, maxTotalBytes: 2 * 1024 * 1024 })).toThrow(/décompressée/);
    const many = zipOf(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.md`, new Uint8Array(1)])));
    expect(() => new ZipArchive(many, { ...LIM, maxEntries: 5 })).toThrow(/plus de 5 fichiers/);
  });

  it('ne décompresse jamais au-delà de la taille annoncée (archive qui ment)', () => {
    const liar = lieAboutSize(zipOf({ 'a.md': Buffer.alloc(200_000, 'a') }), 1000);
    const zip = new ZipArchive(liar, LIM);
    expect(() => zip.read('a.md')).toThrow(/plus gros que ce qu’annonce/);
  });

  it('détecte une entrée corrompue (somme de contrôle)', () => {
    const buf = zipOf({ 'a.md': [randomBytes(5000), { level: 0 }] });
    buf[60] = buf[60]! ^ 0xff;
    expect(() => new ZipArchive(buf, LIM).read('a.md')).toThrow(/somme de contrôle/);
  });

  it('refuse ce qui n’est pas une archive ZIP', () => {
    expect(() => new ZipArchive(Buffer.from('pas un zip du tout, vraiment pas'), LIM)).toThrow(/ZIP invalide/);
  });

  it('décode les noms en UTF-8 même sans le drapeau de l’en-tête', () => {
    const zip = new ZipArchive(clearUtf8Flag(zipOf({ 'Été — œuvre/Tâche 1.md': new Uint8Array(1) })), LIM);
    expect(zip.items[0]!.path).toBe('Été — œuvre/Tâche 1.md');
  });

  it('ouvre un niveau d’archive imbriquée (export Notion découpé), pas deux', () => {
    const inner2 = zipOf({ 'profond.md': new Uint8Array(1) });
    const part1 = zipOf({ 'A 11111111111111111111111111111111.md': new TextEncoder().encode('# A'), 'encore.zip': inner2 });
    const part2 = zipOf({ 'B 22222222222222222222222222222222.md': new TextEncoder().encode('# B') });
    const zip = new ZipArchive(zipOf({ 'Export-Part-1.zip': part1, 'Export-Part-2.zip': part2 }), LIM);
    expect(zip.items.map((i) => i.path).sort()).toEqual(['A 11111111111111111111111111111111.md', 'B 22222222222222222222222222222222.md']);
    expect(zip.skipped).toEqual([{ path: 'encore.zip', reason: expect.stringMatching(/plus d’un niveau/) }]);
    // Les plafonds valent pour l'ensemble, archives imbriquées comprises.
    expect(() => new ZipArchive(zipOf({ 'Export-Part-1.zip': part1, 'Export-Part-2.zip': part2 }), { ...LIM, maxEntries: 3 })).toThrow(/fichiers/);
  });
});

describe('migration v22', () => {
  it('ajoute la table des rapports à une base v21 contenant des données, sans rien modifier', () => {
    const file = oldDb(21);
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare("SELECT title FROM pages WHERE id = 'p1'").get()).toEqual({ title: 'Page' });
    up.prepare("INSERT INTO import_reports (id, user_id, space_id, source, dry_run, created_at, summary, items) VALUES ('r', 'u1', 's1', 'notion', 1, 0, '{}', '[]')").run();
    // Supprimé avec l'espace (et avec le compte).
    up.prepare("DELETE FROM spaces WHERE id = 's1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM import_reports').get()).toEqual({ n: 0 });
    up.close();
  });
});

describe('noms et CSV de Notion', () => {
  it('retire l’identifiant Notion du nom', () => {
    expect(notionName(`Dossier/Plan (4 phases) ${ROOT_ID}.md`)).toEqual({ stem: 'Plan (4 phases)', id: ROOT_ID });
    expect(notionName(`Suivi ${BASE_ID}_all.csv`)).toEqual({ stem: 'Suivi', id: BASE_ID });
    expect(notionName('Sans identifiant.md')).toEqual({ stem: 'Sans identifiant', id: null });
  });

  it('lit un CSV avec BOM, guillemets doublés, virgules et retours à la ligne', () => {
    expect(parseCsv('\ufeffa,b\r\n"x, y","il dit ""oui""\nfin"\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'il dit "oui"\nfin']]);
  });
});

// ---- Route -----------------------------------------------------------------------------------
let app: FastifyInstance;
let db: DB;
let dataDir: string;

async function boot(extra: Record<string, string> = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'nb-notion-'));
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['ed1', 'editor'], ['ed2', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0), ('lecture', 'Lecture', 0, 0), ('prive', 'Privé', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit'), ('lecture', 'everyone', 'view')").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'ed2', 'edit')").run();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('ailleurs', 'prive', 'Ailleurs', '{}', '', 0, 0), ('cible', 'sp', 'Cible', '{}', '', 0, 0)").run();
}
afterEach(async () => { if (app) { await app.close(); db.close(); app = undefined as unknown as FastifyInstance; } });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const post = (s: S, space: string, query: string, payload: Buffer | string, type = 'application/zip') =>
  app.inject({ method: 'POST', url: `/api/v3/spaces/${space}/import/notion?${query}`, payload, cookies: s.cookies, headers: { ...s.headers, 'content-type': type } });
const get = (s: S, url: string) => app.inject({ method: 'GET', url, cookies: s.cookies, headers: s.headers });
const pageCount = () => (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE id NOT IN ('ailleurs', 'cible')").get() as { n: number }).n;
const filesOnDisk = () => (existsSync(join(dataDir, 'attachments')) ? readdirSync(join(dataDir, 'attachments')) : []);
const byTitle = (t: string) => db.prepare('SELECT * FROM pages WHERE title = ?').get(t) as { id: string; parent_id: string | null; kind: string; content: string; space_id: string };

describe('route d’import Notion', () => {
  beforeEach(() => boot());

  it('simule sans rien créer, puis importe : hiérarchie, titres, liens, encadrés, tableaux, pièces jointes et base', async () => {
    const ed1 = await login('ed1');
    const archive = clearUtf8Flag(zipOf(notionExport()));

    const dry = await post(ed1, 'sp', 'dryRun=true', archive);
    expect(dry.statusCode).toBe(200);
    const d = dry.json();
    expect(d).toMatchObject({ dryRun: true, source: 'notion', spaceId: 'sp', summary: { pages: 4, bases: 1, attachments: 3, links: { resolved: 4, unresolved: 1 } } });
    expect(pageCount()).toBe(0);
    expect(filesOnDisk()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
    expect(d.items.every((i: { pageId?: string }) => i.pageId === undefined)).toBe(true);

    const res = await post(ed1, 'sp', 'dryRun=false&parentId=cible', archive);
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r.summary).toEqual(d.summary);

    // Hiérarchie et titres sans identifiant Notion.
    const root = byTitle(ROOT);
    const step = byTitle('Étape 1');
    const base = byTitle('Tâches');
    const row = byTitle('Acheter des cordes');
    expect(root.parent_id).toBe('cible');
    expect(step.parent_id).toBe(root.id);
    expect(base).toMatchObject({ parent_id: root.id, kind: 'base' });
    expect(row.parent_id).toBe(base.id);
    expect((db.prepare('SELECT title FROM pages').all() as { title: string }[]).some((p) => /[0-9a-f]{32}/.test(p.title))).toBe(false);

    // Liens internes réécrits vers les nouvelles pages (relatif, vers une base, absolu notion.so, retour « .. »).
    const rootDoc = root.content;
    expect(rootDoc).toContain(`{"type":"pageLink","attrs":{"id":"${step.id}"}}`);
    expect(rootDoc).toContain(`{"type":"pageLink","attrs":{"id":"${base.id}"}}`);
    expect(rootDoc.match(new RegExp(`"id":"${step.id}"`, 'g'))).toHaveLength(2);
    expect(rootDoc).not.toMatch(/\.md|notion\.so/);
    expect(step.content).toContain(`{"type":"pageLink","attrs":{"id":"${root.id}"}}`);
    expect(step.content).toContain('"type":"callout","attrs":{"type":"warning"}');
    const types = (JSON.parse(rootDoc) as { content: { type: string; attrs?: Record<string, unknown> }[] }).content;
    expect(types.map((n) => n.type)).toEqual(['callout', 'paragraph', 'paragraph', 'table', 'horizontalRule', 'attachment', 'image', 'attachment']);
    expect(types[0]!.attrs).toEqual({ type: 'info' });

    // Pièces jointes : type reconnu sur les octets, rattachées à la page, fichiers sur disque ; le SVG n'est pas une image affichée.
    const atts = db.prepare('SELECT id, page_id, name, mime, uploader_id FROM attachments ORDER BY name').all() as { id: string; page_id: string; name: string; mime: string; uploader_id: string }[];
    expect(atts.map((a) => [a.name, a.mime, a.page_id, a.uploader_id])).toEqual([
      ['dessin.svg', 'application/octet-stream', root.id, 'ed1'], ['photo.png', 'image/png', root.id, 'ed1'], ['plan.pdf', 'application/pdf', root.id, 'ed1'],
    ]);
    expect(filesOnDisk().sort()).toEqual(atts.map((a) => a.id).sort());
    const png = atts.find((a) => a.name === 'photo.png')!;
    expect(types[6]!.attrs).toMatchObject({ src: `/api/v3/attachments/${png.id}` });
    expect(types[5]!.attrs).toMatchObject({ name: 'plan.pdf', mime: 'application/pdf' });
    const dl = await get(ed1, `/api/v3/attachments/${png.id}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');

    // Base : colonnes de « _all.csv », lignes reliées à leur page ; propriétés de la page gardées une par ligne.
    const props = db.prepare('SELECT name, type FROM base_properties WHERE base_id = ? ORDER BY position').all(base.id);
    expect(props).toEqual([{ name: 'Nom', type: 'text' }, { name: 'Statut', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'Page', type: 'page_link' }]);
    const rows = (db.prepare('SELECT vals FROM base_rows WHERE base_id = ? ORDER BY position').all(base.id) as { vals: string }[]).map((x) => Object.values(JSON.parse(x.vals)));
    expect(rows[0]).toEqual(['Acheter des cordes', 'Fait', 'long, avec virgule', row.id]);
    expect(rows[1]).toEqual(['Réviser le plan', 'À faire', 'sur\ndeux lignes', byTitle('Réviser le plan').id]);
    expect(row.content).toContain('hardBreak');

    // Rapport fichier par fichier.
    const item = (p: string) => r.items.find((i: { path: string }) => i.path === p);
    expect(item(`${ROOT}/Tâches ${BASE_ID}.csv`)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/_all\.csv/) });
    expect(item(`${ROOT}/orphelin.png`)).toMatchObject({ status: 'skipped', reason: 'fichier cité par aucune page' });
    expect(item(`${ROOT}/ancienne ${'e'.repeat(32)}.html`)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/HTML/) });
    expect(item(`${ROOT} ${ROOT_ID}.md`)).toMatchObject({ status: 'imported', kind: 'page', title: ROOT, pageId: root.id, notes: expect.arrayContaining([expect.stringMatching(/absente/)]) });
    expect(item(`${ROOT}/photo.png`)).toMatchObject({ status: 'imported', kind: 'attachment', pageId: root.id });

    // Rapports consultables ensuite, par leur auteur seulement ; journal d'audit sans titre ni nom de fichier.
    const list = (await get(ed1, '/api/v3/imports')).json();
    expect(list.items.map((x: { id: string; dryRun: boolean }) => [x.id, x.dryRun])).toEqual([[r.id, false], [d.id, true]]);
    expect(list.items[0].items).toBeUndefined();
    const again = await get(ed1, `/api/v3/imports/${r.id}`);
    expect(again.json().items).toEqual(r.items);
    expect((await get(await login('ed2'), `/api/v3/imports/${r.id}`)).statusCode).toBe(404);
    const audits = db.prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'import.notion%' ORDER BY id").all() as { action: string; meta: string }[];
    expect(audits.map((a) => a.action)).toEqual(['import.notion.dry_run', 'import.notion']);
    expect(audits[1]!.meta).not.toMatch(/Carnet|Tâches|photo/);
  });

  it('applique les droits : écriture requise, espace en édition, parent modifiable dans le même espace', async () => {
    const archive = zipOf(notionExport());
    expect((await post(await login('rd'), 'sp', 'dryRun=true', archive)).statusCode).toBe(403);
    const ed1 = await login('ed1');
    expect((await post(ed1, 'lecture', 'dryRun=false', archive)).statusCode).toBe(403);
    const hidden = await post(ed1, 'prive', 'dryRun=false', archive);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain('Privé');
    expect((await post(ed1, 'sp', 'dryRun=false&parentId=ailleurs', archive)).statusCode).toBe(404);
    const ed2 = await login('ed2');
    expect((await post(ed2, 'sp', 'dryRun=false&parentId=ailleurs', archive)).statusCode).toBe(404);
    expect(pageCount()).toBe(0);
    // Rapport d'un espace devenu illisible : introuvable, même pour son auteur.
    const ok = (await post(ed2, 'prive', 'dryRun=true', archive)).json();
    db.prepare("DELETE FROM space_members WHERE space_id = 'prive'").run();
    expect((await get(ed2, `/api/v3/imports/${ok.id}`)).statusCode).toBe(404);
    expect((await get(ed2, '/api/v3/imports')).json().items).toEqual([]);
  });

  it('valide la requête : simulation explicite, archive attendue, archive invalide ou piégée refusée sans rien créer', async () => {
    const ed1 = await login('ed1');
    expect((await post(ed1, 'sp', '', zipOf(notionExport()))).statusCode).toBe(400);
    expect((await post(ed1, 'sp', 'dryRun=oui', zipOf(notionExport()))).statusCode).toBe(400);
    expect((await post(ed1, 'sp', 'dryRun=false', JSON.stringify({ a: 1 }), 'application/json')).statusCode).toBe(415);
    expect((await post(ed1, 'sp', 'dryRun=false', Buffer.from('nimporte quoi'))).statusCode).toBe(400);
    const bomb = await post(ed1, 'sp', 'dryRun=false', zipOf({ ...notionExport(), 'bombe.md': new Uint8Array(20 * 1024 * 1024) }));
    expect(bomb.statusCode).toBe(413);
    expect((await post(ed1, 'sp', 'dryRun=false', zipOf({ 'photo.png': PNG }))).statusCode).toBe(422);
    const liar = await post(ed1, 'sp', 'dryRun=false', lieAboutSize(zipOf({ 'a.md': Buffer.alloc(200_000, 'a') }), 1000));
    expect(liar.statusCode).toBe(413);
    expect(pageCount()).toBe(0);
    expect(filesOnDisk()).toEqual([]);
  });

  it('écarte une pièce jointe au-delà du quota sans annuler l’import des pages', async () => {
    await app.close();
    db.close();
    await boot({ ATTACHMENT_MAX_MB: '1' });
    const ed1 = await login('ed1');
    const files = notionExport();
    files[`${ROOT}/photo.png`] = Buffer.concat([PNG, randomBytes(1024 * 1024)]);
    const r = (await post(ed1, 'sp', 'dryRun=false', zipOf(files))).json();
    expect(r.items.find((i: { path: string }) => i.path === `${ROOT}/photo.png`)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/trop lourd/) });
    expect(r.summary.attachments).toBe(2);
    expect(byTitle(ROOT).content).toContain('[Image : photo.png]');
  });

  it('importe un export découpé en archives imbriquées, liens entre parties compris', async () => {
    const ed1 = await login('ed1');
    const t = (s: string) => new TextEncoder().encode(s);
    const part1 = zipOf({ [`A ${ROOT_ID}.md`]: t(`# A\n\nVers [B](B%20${STEP_ID}.md)`) });
    const part2 = zipOf({ [`B ${STEP_ID}.md`]: t('# B') });
    const r = (await post(ed1, 'sp', 'dryRun=false', zipOf({ 'Export-Part-1.zip': part1, 'Export-Part-2.zip': part2 }))).json();
    expect(r.summary).toMatchObject({ pages: 2, links: { resolved: 1, unresolved: 0 } });
    expect(byTitle('A').content).toContain(byTitle('B').id);
  });

  it('crée une page intermédiaire pour un dossier sans page et garde au plus 20 rapports', async () => {
    const ed1 = await login('ed1');
    const r = (await post(ed1, 'sp', 'dryRun=false', zipOf({ [`Export/Sous ${ROOT_ID}.md`]: new TextEncoder().encode('# Sous') }))).json();
    expect(r.summary.folders).toBe(1);
    expect(byTitle('Sous').parent_id).toBe(byTitle('Export').id);
    for (let i = 0; i < 21; i++) db.prepare("INSERT INTO import_reports (id, user_id, space_id, source, dry_run, created_at, summary, items) VALUES (?, 'ed1', 'sp', 'notion', 1, ?, '{}', '[]')").run(`old${i}`, i);
    await post(ed1, 'sp', 'dryRun=true', zipOf(notionExport()));
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_reports WHERE user_id = 'ed1'").get()).toEqual({ n: 20 });
  });

  it('inclut les rapports dans l’export des données personnelles', async () => {
    const ed1 = await login('ed1');
    const r = (await post(ed1, 'sp', 'dryRun=true', zipOf(notionExport()))).json();
    const data = (await get(ed1, '/api/v3/me/export')).json();
    expect(data.importReports).toEqual([{ id: r.id, spaceId: 'sp', source: 'notion', dryRun: true, createdAt: r.createdAt, summary: r.summary }]);
  });

  it('limite le débit', async () => {
    const ed1 = await login('ed1');
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await post(ed1, 'sp', 'dryRun=true', Buffer.from('x'))).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});
