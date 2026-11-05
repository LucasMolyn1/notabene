// Conversion des images base64 en pièces jointes (lot 10 bis) : aller-retour fidèle, idempotence, verrou, plafonds,
// co-édition, types vérifiés sur les octets, routes d'administration et commande en ligne.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createApiToken } from '../src/auth/tokens.js';
import { migrateImages, migrationLimits } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { attachmentsDir } from '../src/lib/attachments.js';
import {
  dryRun, markServerAlive, type MigrationContext, migrationStatus, recentlyCoEdited, runDetail, scanDoc, serverRunning, startConversion, startRevert,
} from '../src/lib/image-migration.js';
import { hashPassword } from '../src/lib/password.js';
import { oldDb } from './migrations.js';

const MB = 1024 * 1024;
const png = (n = 40) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), randomBytes(n)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), randomBytes(30)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const data = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;
const img = (src: string, alt = '') => ({ type: 'image', attrs: { src, alt, title: null, width: null } });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docOf = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

let db: DB;
let dataDir: string;
const LIMITS = { totalBytes: 100 * MB, userBytes: 50 * MB, fileBytes: 5 * MB };
const ctx = (over: Partial<MigrationContext> = {}): MigrationContext => ({
  db, filesDir: attachmentsDir(dataDir), limits: LIMITS, busy: () => false, source: 'cli', startedBy: null, batchSize: 2, ...over,
});
const content = (id: string) => (db.prepare('SELECT content FROM pages WHERE id = ?').get(id) as { content: string }).content;
const version = (id: string) => (db.prepare('SELECT version FROM pages WHERE id = ?').get(id) as { version: number }).version;
const versions = (id: string) => (db.prepare('SELECT content, created_by FROM page_versions WHERE page_id = ? ORDER BY id').all(id) as { content: string; created_by: string | null }[]);
const attachmentsOf = (id: string) => db.prepare('SELECT id, name, mime, size, sha256, uploader_id FROM attachments WHERE page_id = ? ORDER BY name').all(id) as { id: string; name: string; mime: string; size: number; sha256: string; uploader_id: string | null }[];

function seed() {
  dataDir = mkdtempSync(join(tmpdir(), 'nb-img-'));
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES ('ed1', 'local:ed1', 'Ed', 'editor', 0)").run();
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0)").run();
}
const page = (id: string, doc: string, createdBy: string | null = 'ed1') =>
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, created_by) VALUES (?, 'sp', ?, ?, '', 1, 1, ?)").run(id, `Titre ${id}`, doc, createdBy);

describe('analyse des images base64', () => {
  it('ne retient que les images raster reconnues sur les octets, sous la taille maximale', () => {
    const fake = data('image/png', HTML); // annoncé PNG, contenu HTML
    const doc = JSON.parse(docOf(img(data('image/png', png())), img(data('image/jpeg', JPEG)), img(data('image/svg+xml', SVG)), img(fake), img(data('image/png', png(2000)))));
    const scan = scanDoc(doc, 1000);
    expect([...scan.found.values()].map((f) => f.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(scan.reasons).toEqual({ svg: 1, unrecognized: 1, too_large: 1 });
  });
});

describe('conversion et retour arrière', () => {
  beforeEach(seed);
  afterEach(() => db.close());

  it('aller-retour : fichiers et lignes créés, versions gardées, contenu rétabli à l’octet près', async () => {
    const a = png();
    const original = docOf(para('avant'), img(data('image/png', a), 'un'), img(data('image/jpeg', JPEG), 'deux'), img(data('image/png', a), 'trois'), img(data('image/svg+xml', SVG), 'svg'));
    page('p1', original);
    page('p2', docOf(para('rien')));
    page('p3', docOf(img('https://exemple.fr/a.png')));
    const v0 = version('p1');

    const started = startConversion(ctx());
    const stats = await started.run();
    expect(stats).toMatchObject({ pages: 1, converted: 1, images: 2, bytes: a.length + JPEG.length, reasons: { svg: 1 } });

    const rows = attachmentsOf('p1');
    expect(rows.map((r) => [r.name, r.mime, r.size, r.uploader_id])).toEqual([['image-1.png', 'image/png', a.length, 'ed1'], ['image-2.jpg', 'image/jpeg', JPEG.length, 'ed1']]);
    for (const r of rows) {
      const file = join(attachmentsDir(dataDir), r.id);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(attachmentsDir(dataDir), rows[0]!.id)).equals(a)).toBe(true);
    const after = JSON.parse(content('p1'));
    const srcs = after.content.filter((n: { type: string }) => n.type === 'image').map((n: { attrs: { src: string } }) => n.attrs.src);
    expect(srcs.slice(0, 3)).toEqual([`/api/v3/attachments/${rows[0]!.id}`, `/api/v3/attachments/${rows[1]!.id}`, `/api/v3/attachments/${rows[0]!.id}`]);
    expect(srcs[3]).toMatch(/^data:image\/svg\+xml/); // SVG laissé en place
    expect(version('p1')).toBe(v0 + 1);
    // Historique : l'original puis le résultat, sans auteur.
    expect(versions('p1').map((v) => v.content)).toEqual([original, content('p1')]);
    expect(versions('p1').every((v) => v.created_by === null)).toBe(true);
    expect(content('p2')).toBe(docOf(para('rien')));

    const detail = runDetail(db, started.id);
    expect(detail.status).toBe('done');
    expect(detail.pages).toEqual([expect.objectContaining({ pageId: 'p1', status: 'converted', images: 2, reasons: ['svg'] })]);

    // Idempotence : une deuxième conversion ne trouve rien à faire (la page n'a plus qu'un SVG).
    const again = await startConversion(ctx()).run();
    expect(again).toMatchObject({ converted: 0, images: 0, skipped: 1, reasons: { svg: 1 } });
    expect(attachmentsOf('p1')).toHaveLength(2);

    const revert = startRevert(ctx(), started.id);
    const back = await revert.run();
    expect(back).toMatchObject({ reverted: 1, images: 3 });
    expect(content('p1')).toBe(original);
    expect(runDetail(db, revert.id).pages).toEqual([expect.objectContaining({ pageId: 'p1', status: 'reverted', reasons: [] })]);
    // Les fichiers restent (cités par l'historique) ; un second retour arrière ne fait rien.
    expect(attachmentsOf('p1')).toHaveLength(2);
    expect(await startRevert(ctx(), started.id).run()).toMatchObject({ pages: 0, reverted: 0 });
    expect(content('p1')).toBe(original);

    // Reconvertir après le retour arrière : de nouveau possible.
    expect(await startConversion(ctx()).run()).toMatchObject({ converted: 1, images: 2 });
  });

  it('base64 non canonique : chaîne d’origine gardée, retour à l’identique', async () => {
    const b = png(42); // 58 octets : base64 avec remplissage
    const canonical = b.toString('base64');
    const odd = `${canonical.replace(/=+$/, '')}`; // sans remplissage : décodable, mais pas la forme canonique
    expect(odd).not.toBe(canonical);
    const original = docOf(img(`data:image/png;base64,${odd}`));
    page('p1', original);
    const run = startConversion(ctx());
    await run.run();
    expect((db.prepare('SELECT raw FROM image_migration_items').get() as { raw: string | null }).raw).toBe(`data:image/png;base64,${odd}`);
    await startRevert(ctx(), run.id).run();
    expect(content('p1')).toBe(original);
  });

  it('page modifiée depuis la conversion : seules les images reviennent, signalé', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    const run = startConversion(ctx());
    await run.run();
    const converted = JSON.parse(content('p1'));
    converted.content.push(para('ajout après conversion'));
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(JSON.stringify(converted), 'p1');
    const rv = startRevert(ctx(), run.id);
    await rv.run();
    const now = JSON.parse(content('p1'));
    expect(now.content[0].attrs.src).toMatch(/^data:image\/png;base64,/);
    expect(now.content[1].content[0].text).toBe('ajout après conversion');
    expect(runDetail(db, rv.id).pages[0]).toMatchObject({ status: 'reverted', reasons: ['modified'] });
  });

  it('fichier absent ou altéré : la page n’est pas touchée par le retour arrière', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    page('p2', docOf(img(data('image/png', png()))));
    const run = startConversion(ctx());
    await run.run();
    const [a1] = attachmentsOf('p1');
    const [a2] = attachmentsOf('p2');
    unlinkSync(join(attachmentsDir(dataDir), a1!.id));
    writeFileSync(join(attachmentsDir(dataDir), a2!.id), png());
    const before = [content('p1'), content('p2')];
    const rv = startRevert(ctx(), run.id);
    expect(await rv.run()).toMatchObject({ reverted: 0, skipped: 2, reasons: { missing_file: 1, checksum: 1 } });
    expect([content('p1'), content('p2')]).toEqual(before);
  });

  it('co-édition en cours : page ignorée et signalée, reprise ensuite', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    const original = content('p1');
    const busy = new Set(['p1']);
    const run = startConversion(ctx({ busy: (id) => busy.has(id) }));
    expect(await run.run()).toMatchObject({ converted: 0, skipped: 1, reasons: { coedition: 1 } });
    expect(content('p1')).toBe(original);
    expect(runDetail(db, run.id).pages[0]).toMatchObject({ status: 'skipped', reasons: ['coedition'] });
    // Commande en ligne : un état de co-édition enregistré il y a peu compte comme une co-édition en cours.
    db.prepare("INSERT INTO page_ydocs (page_id, state, epoch, content_hash, updated_at) VALUES ('p1', x'00', 'e', 'h', ?)").run(Date.now());
    expect(recentlyCoEdited(db)('p1')).toBe(true);
    db.prepare('UPDATE page_ydocs SET updated_at = 0').run();
    expect(recentlyCoEdited(db)('p1')).toBe(false);
    expect(await startConversion(ctx()).run()).toMatchObject({ converted: 1 });
  });

  it('plafonds : instance pleine ou quota de l’auteur atteint, la page reste intacte', async () => {
    page('p1', docOf(img(data('image/png', png(5000)))));
    page('p2', docOf(img(data('image/png', png(100)))), null);
    const original = content('p1');
    const stats = await startConversion(ctx({ limits: { ...LIMITS, userBytes: 1000 } })).run();
    expect(stats).toMatchObject({ converted: 1, skipped: 1, reasons: { quota: 1 } });
    expect(content('p1')).toBe(original);
    expect(attachmentsOf('p2')[0]!.uploader_id).toBeNull(); // page sans auteur connu : fichier sans envoyeur
    expect(await startConversion(ctx({ limits: { ...LIMITS, totalBytes: 2000 } })).run()).toMatchObject({ converted: 0, reasons: { quota: 1 } });
    expect(content('p1')).toBe(original);
  });

  it('estimation : rien n’est écrit', async () => {
    page('p1', docOf(img(data('image/png', png())), img(data('image/svg+xml', SVG))));
    const before = content('p1');
    const r = await dryRun(ctx());
    expect(r).toMatchObject({ pages: 1, images: 1, reasons: { svg: 1 } });
    expect(r.skipped).toEqual([{ pageId: 'p1', title: 'Titre p1', hidden: false, reasons: ['svg'] }]);
    expect(content('p1')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM image_migration_runs').get()).toEqual({ n: 0 });
  });

  it('jamais deux exécutions en parallèle ; une exécution abandonnée est reprise', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    const first = startConversion(ctx());
    expect(() => startConversion(ctx())).toThrow(/déjà en cours/);
    expect(() => startRevert(ctx(), first.id)).toThrow(/déjà en cours/);
    // Le verrou tient aussi au niveau de la base (index unique partiel).
    expect(() => db.prepare("INSERT INTO image_migration_runs (id, kind, status, source, started_at, heartbeat_at) VALUES ('x', 'convert', 'running', 'cli', 0, 0)").run()).toThrow(/UNIQUE/);
    // Processus arrêté sans finir : au-delà de 5 minutes sans signe de vie, l'exécution est marquée interrompue.
    db.prepare('UPDATE image_migration_runs SET heartbeat_at = ? WHERE id = ?').run(Date.now() - 6 * 60_000, first.id);
    const second = startConversion(ctx());
    expect(migrationStatus(db).runs.find((r) => r.id === first.id)?.status).toBe('interrupted');
    expect(await second.run()).toMatchObject({ converted: 1 });
    expect(() => startRevert(ctx(), 'inconnu')).toThrow(/introuvable/);
  });

  it('titres des pages d’un espace personnel d’un autre compte jamais montrés', async () => {
    db.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES ('ed2', 'local:ed2', 'Ed2', 'editor', 0)").run();
    db.prepare("INSERT INTO spaces (id, name, kind, owner_id, created_at, updated_at) VALUES ('perso', 'Perso', 'personal', 'ed2', 0, 0)").run();
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at, created_by) VALUES ('intime', 'perso', 'Mon diagnostic', ?, '', 1, 1, 'ed2')")
      .run(docOf(img(data('image/svg+xml', SVG))));
    page('p1', docOf(img(data('image/svg+xml', SVG))));
    const r = await dryRun(ctx(), 'admin');
    expect(r.skipped).toEqual([
      { pageId: 'intime', title: null, hidden: true, reasons: ['svg'] },
      { pageId: 'p1', title: 'Titre p1', hidden: false, reasons: ['svg'] },
    ]);
    expect((await dryRun(ctx(), 'ed2')).skipped[0]).toMatchObject({ title: 'Mon diagnostic', hidden: false });
    expect((await dryRun(ctx(), null)).skipped[0]).toMatchObject({ title: null, hidden: true }); // commande en ligne
    const run = startConversion(ctx());
    await run.run();
    expect(runDetail(db, run.id, 'admin').pages.find((p) => p.pageId === 'intime')).toMatchObject({ title: null, hidden: true });
    expect(runDetail(db, run.id, 'ed2').pages.find((p) => p.pageId === 'intime')).toMatchObject({ title: 'Mon diagnostic' });
  });

  it('exécution déclarée abandonnée : elle s’arrête et n’écrase pas l’état de celle qui l’a remplacée', async () => {
    for (let i = 0; i < 4; i++) page(`p${i}`, docOf(img(data('image/png', png()))));
    let other: string | null = null;
    const first = startConversion(ctx({
      batchSize: 1,
      yieldBetweenBatches: async () => {
        if (other) return;
        db.prepare('UPDATE image_migration_runs SET heartbeat_at = 0 WHERE id = ?').run(first.id);
        other = startConversion(ctx()).id; // la marque interrompue et prend le verrou
      },
    }));
    await expect(first.run()).rejects.toThrow(/abandonnée/);
    const rows = migrationStatus(db).runs;
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ status: 'interrupted' });
    expect(rows.find((r) => r.id === other)).toMatchObject({ status: 'running' });
  });

  it('arrêt demandé : interrompue entre deux lots, relançable sans rien refaire', async () => {
    for (let i = 0; i < 5; i++) page(`p${i}`, docOf(img(data('image/png', png()))));
    let calls = 0;
    const run = startConversion(ctx({ batchSize: 2, shouldStop: () => calls++ >= 1 }));
    expect(await run.run()).toMatchObject({ converted: 2 });
    expect(runDetail(db, run.id).status).toBe('interrupted');
    expect(await startConversion(ctx()).run()).toMatchObject({ converted: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 5 });
    // Le retour arrière de la première exécution ne touche que ses pages.
    await startRevert(ctx(), run.id).run();
    expect(migrationStatus(db).pendingPages).toBe(2);
  });
});

describe('commande en ligne', () => {
  beforeEach(seed);
  afterEach(() => db.close());

  it('migrate-images : estimation, conversion, état, retour arrière', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    const original = content('p1');
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const opts = { dataDir, limits: migrationLimits({}), log };
    await migrateImages(db, ['--dry-run'], opts);
    expect(lines.join('\n')).toContain('1 page(s), 1 image(s)');
    expect(content('p1')).toBe(original);
    await migrateImages(db, [], opts);
    const runId = migrationStatus(db).runs[0]!.id;
    expect(lines.join('\n')).toContain(`migrate-images --revert ${runId}`);
    expect(content('p1')).not.toBe(original);
    await migrateImages(db, ['--status'], opts);
    expect(lines.join('\n')).toContain('Pages contenant encore des images base64 : 0');
    await migrateImages(db, ['--revert', runId], opts);
    expect(content('p1')).toBe(original);
    await expect(migrateImages(db, ['--revert', '../x'], opts)).rejects.toThrow(/Usage/);
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'cli.images%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['cli.images.migration.start', 'cli.images.migration.end', 'cli.images.migration.revert', 'cli.images.migration.end']);
  });

  it('conversion et retour arrière refusés pendant que le serveur tourne ; estimation et état permis', async () => {
    page('p1', docOf(img(data('image/png', png()))));
    const original = content('p1');
    markServerAlive(db, Date.now());
    const lines: string[] = [];
    const opts = { dataDir, limits: migrationLimits({}), log: (l: string) => lines.push(l) };
    await expect(migrateImages(db, [], opts)).rejects.toThrow(/serveur BeNote est en marche/);
    await expect(migrateImages(db, ['--revert', 'abc'], opts)).rejects.toThrow(/serveur BeNote est en marche/);
    expect(content('p1')).toBe(original);
    expect(await migrateImages(db, ['--dry-run'], opts)).toBe(0);
    expect(await migrateImages(db, ['--status'], opts)).toBe(0);
    // Signe de vie ancien (arrêt brutal) : la commande reprend la main.
    db.prepare('UPDATE server_presence SET seen_at = ?').run(Date.now() - 2 * 60_000);
    expect(serverRunning(db)).toBe(false);
    await migrateImages(db, [], opts);
    expect(content('p1')).not.toBe(original);
  });

  it('plafonds lus dans l’environnement, avec les mêmes valeurs par défaut que le serveur', () => {
    expect(migrationLimits({})).toEqual({ fileBytes: 25 * MB, totalBytes: 5120 * MB, userBytes: 1024 * MB });
    expect(migrationLimits({ ATTACHMENT_MAX_MB: '3' }).fileBytes).toBe(3 * MB);
    expect(() => migrationLimits({ ATTACHMENT_MAX_MB: '0' })).toThrow();
  });
});

describe('migration v22', () => {
  it('additive : une base v21 passe en v22 sans toucher aux données', () => {
    const file = oldDb(21);
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare("SELECT title FROM pages WHERE id = 'p1'").get()).toEqual({ title: 'Page' });
    expect(up.prepare('SELECT COUNT(*) AS n FROM image_migration_runs').get()).toEqual({ n: 0 });
    up.close();
    // Retour arrière documenté : les trois tables se suppriment sans rien laisser.
    const raw = new Database(file);
    raw.exec('DROP TABLE image_migration_items; DROP TABLE image_migration_pages; DROP TABLE image_migration_runs; DROP TABLE server_presence;');
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'image_migration%'").get()).toEqual({ n: 0 });
    raw.close();
  });
});

describe('routes d’administration', () => {
  let app: FastifyInstance;
  const PASS = 'Sup3r-secret-pass';
  afterEach(async () => { await app.close(); db.close(); });

  async function boot() {
    dataDir = mkdtempSync(join(tmpdir(), 'nb-img-api-'));
    const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir };
    db = openDb(':memory:');
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
    for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor']] as const) {
      db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, id, role, Date.now(), await hashPassword(PASS));
    }
    db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0)").run();
  }
  async function login(id: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
  }
  type S = Awaited<ReturnType<typeof login>>;
  const post = (s: S, payload: unknown) => app.inject({ method: 'POST', url: '/api/v3/admin/images/migration', cookies: s.cookies, headers: s.headers, payload });
  const status = (s: S) => app.inject({ method: 'GET', url: '/api/v3/admin/images/migration', cookies: s.cookies, headers: s.headers });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it('administrateur seul ; estimation, lancement en tâche de fond, détail, retour arrière, journal', async () => {
    await boot();
    page('p1', docOf(img(data('image/png', png()))), 'admin');
    const original = content('p1');
    const ed1 = await login('ed1');
    expect((await status(ed1)).statusCode).toBe(403);
    expect((await post(ed1, { action: 'convert' })).statusCode).toBe(403);
    const admin = await login('admin');

    const st = (await status(admin)).json();
    expect(st).toMatchObject({ pendingPages: 1, current: null, runs: [] });
    expect(st.labels.svg).toContain('SVG');
    expect((await post(admin, { action: 'dry-run' })).json()).toMatchObject({ pages: 1, images: 1 });
    expect((await post(admin, { action: 'revert' })).statusCode).toBe(400);
    expect((await post(admin, { action: 'convert', runId: 'x' })).statusCode).toBe(400);
    expect((await post(admin, { action: 'revert', runId: 'inconnu' })).statusCode).toBe(404);

    const res = await post(admin, { action: 'convert' });
    expect(res.statusCode).toBe(202);
    const run = res.json();
    expect(run).toMatchObject({ kind: 'convert', status: 'running', source: 'api', startedBy: 'admin' });
    await until(() => (db.prepare('SELECT status FROM image_migration_runs WHERE id = ?').get(run.id) as { status: string }).status !== 'running');
    const detail = (await app.inject({ method: 'GET', url: `/api/v3/admin/images/migration/runs/${run.id}`, cookies: admin.cookies })).json();
    expect(detail).toMatchObject({ status: 'done', stats: { converted: 1, images: 1 }, pages: [{ pageId: 'p1', title: 'Titre p1', status: 'converted' }] });
    expect(content('p1')).toContain('/api/v3/attachments/');

    const rv = await post(admin, { action: 'revert', runId: run.id });
    expect(rv.statusCode).toBe(202);
    await until(() => (db.prepare('SELECT status FROM image_migration_runs WHERE id = ?').get(rv.json().id) as { status: string }).status !== 'running');
    expect(content('p1')).toBe(original);
    const actions = (db.prepare("SELECT action, user_id FROM audit_log WHERE action LIKE 'images.%' ORDER BY id").all() as { action: string; user_id: string }[]);
    expect(actions.map((a) => a.action)).toEqual(['images.migration.dryrun', 'images.migration.start', 'images.migration.end', 'images.migration.revert', 'images.migration.end']);
    expect(actions.every((a) => a.user_id === 'admin')).toBe(true);
  });

  it('lancement réservé à la session web, refusé pendant une autre exécution ; page ouverte en co-édition ignorée', async () => {
    await boot();
    page('p1', docOf(img(data('image/png', png()))), 'admin');
    const token = createApiToken(db, 'admin', { name: 'adm', scopes: ['read', 'write', 'admin'], expiresInDays: 1 }).token;
    const bearer = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/v3/admin/images/migration', headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v3/admin/images/migration', headers: bearer, payload: { action: 'convert' } })).statusCode).toBe(403);
    const admin = await login('admin');
    db.prepare("INSERT INTO image_migration_runs (id, kind, status, source, started_at, heartbeat_at) VALUES ('cli1', 'convert', 'running', 'cli', ?, ?)").run(Date.now(), Date.now());
    const busy = await post(admin, { action: 'convert' });
    expect(busy.statusCode).toBe(409);
    db.prepare("UPDATE image_migration_runs SET status = 'done' WHERE id = 'cli1'").run();
    // Salle de co-édition ouverte sur la page : la conversion ne la touche pas.
    const hub = app.collab!;
    const original = content('p1');
    (hub as unknown as { isOpen: (id: string) => boolean }).isOpen = (id) => id === 'p1';
    const res = await post(admin, { action: 'convert' });
    await until(() => (db.prepare('SELECT status FROM image_migration_runs WHERE id = ?').get(res.json().id) as { status: string }).status !== 'running');
    expect(content('p1')).toBe(original);
    expect(runDetail(db, res.json().id).pages[0]).toMatchObject({ status: 'skipped', reasons: ['coedition'] });
  });

  it('au démarrage, une exécution du serveur restée « en cours » est marquée interrompue', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nb-img-api-'));
    db = openDb(':memory:');
    db.prepare("INSERT INTO image_migration_runs (id, kind, status, source, started_at, heartbeat_at) VALUES ('old', 'convert', 'running', 'api', 0, ?)").run(Date.now());
    const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir };
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
    expect(db.prepare("SELECT status FROM image_migration_runs WHERE id = 'old'").get()).toEqual({ status: 'interrupted' });
    expect(serverRunning(db)).toBe(true);
    await app.close();
    expect(serverRunning(db)).toBe(false);
    app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
    expect(existsSync(attachmentsDir(dataDir))).toBe(false);
  });
});
