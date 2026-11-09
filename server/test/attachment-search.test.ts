// Recherche dans les pièces jointes (lot 13) : extraction du texte (PDF, Word, texte) en tâche de fond, index distinct, résultats
// limités aux pages lisibles, suppression en cascade, nom de fichier cherchable dès l'envoi, migration qui rattrape l'existant.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { indexAll, indexNext, type IndexLimits } from '../src/lib/attachment-text.js';
import { AttachmentWriter, attachmentsDir } from '../src/lib/attachments.js';
import { loadConfig } from '../src/config.js';
import { type DB, MIGRATIONS, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { docx, pdf } from './doc-fixtures.js';
import { oldDb } from './migrations.js';

const PASS = 'Sup3r-secret-pass';
const MB = 1024 * 1024;
const LIMITS: IndexLimits = { maxBytes: 30 * MB, timeoutMs: 30_000, maxPages: 50, zipEntries: 1000, zipUncompressedBytes: 200 * MB, zipRatio: 100 };

let app: FastifyInstance;
let db: DB;
let dir: string;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nb-asearch-'));
  dir = attachmentsDir(dataDir);
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const id of ['ed1', 'ed2']) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, 'editor', Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('commun', 'Commun', 0, 0), ('prive', 'Privé', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('commun', 'everyone', 'edit')").run();
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('prive', 'ed2', 'edit')").run();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('p-commun', 'commun', 'Page commune', '{}', '', 0, 0), ('p-prive', 'prive', 'Page privée', '{}', '', 0, 0)").run();
});
afterEach(async () => { await app.close(); db.close(); });

const writer = () => new AttachmentWriter(db, dir, 'ed2', { fileBytes: 25 * MB, totalBytes: 1024 * MB, userBytes: 1024 * MB });
const attach = (pageId: string, name: string, data: Buffer) => writer().store(pageId, name, data);
const state = (id: string) => db.prepare('SELECT status, text FROM attachment_text WHERE attachment_id = ?').get(id) as { status: string; text: string } | undefined;

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  return { nb_session: cookie };
}
const search = async (id: string, q: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v3/search?q=${encodeURIComponent(q)}`, cookies: await login(id) });
  expect(res.statusCode).toBe(200);
  return res.json().items as { id: string; title: string; attachment?: { id: string; name: string }; snippet?: string }[];
};

describe('recherche dans les pièces jointes', () => {
  it('trouve le texte d’un PDF, d’un document Word et d’un fichier texte, avec la pièce jointe concernée', async () => {
    const a = attach('p-commun', 'compte-rendu.pdf', pdf([{ y: 700, text: 'Le budget prévisionnel du chantier Zéphyr' }]));
    const b = attach('p-commun', 'note.docx', docx());
    const c = attach('p-commun', 'journal.txt', Buffer.from('Relevé des mesures : coefficient Quokka à vérifier.', 'utf8'));
    expect(await indexAll(db, dir, LIMITS)).toBe(3);
    expect([a.id, b.id, c.id].map((i) => state(i)!.status)).toEqual(['done', 'done', 'done']);

    const pdfHit = await search('ed1', 'zephyr'); // sans accent ni majuscule
    expect(pdfHit).toHaveLength(1);
    expect(pdfHit[0]).toMatchObject({ id: 'p-commun', attachment: { id: a.id, name: 'compte-rendu.pdf' } });
    expect(pdfHit[0]!.snippet).toContain('Zéphyr');
    expect((await search('ed1', 'saison'))[0]!.attachment).toMatchObject({ id: b.id }); // « Plan de la saison », titre du document Word
    expect((await search('ed1', 'quokka'))[0]!.attachment).toMatchObject({ id: c.id });
    expect(await search('ed1', 'inexistant')).toEqual([]);
  });

  it('le nom du fichier se cherche dès l’envoi, avant toute extraction', async () => {
    const a = attach('p-commun', 'organigramme-2026.pdf', pdf());
    expect(state(a.id)!.status).toBe('pending');
    expect((await search('ed1', 'organigramme'))[0]!.attachment).toMatchObject({ id: a.id });
  });

  it('ne montre jamais une pièce jointe d’une page qu’on ne lit pas, ni d’une page à la corbeille', async () => {
    attach('p-prive', 'secret.pdf', pdf([{ y: 700, text: 'Clause confidentielle Ostrogoth' }]));
    attach('p-commun', 'public.pdf', pdf([{ y: 700, text: 'Clause publique Ostrogoth' }]));
    await indexAll(db, dir, LIMITS);
    expect((await search('ed1', 'ostrogoth')).map((r) => r.id)).toEqual(['p-commun']); // ed1 ne lit pas l'espace privé
    expect((await search('ed2', 'ostrogoth')).map((r) => r.id).sort()).toEqual(['p-commun', 'p-prive']);
    db.prepare("UPDATE pages SET deleted_at = 1 WHERE id = 'p-commun'").run();
    expect(await search('ed1', 'ostrogoth')).toEqual([]);
  });

  it('page restreinte : la pièce jointe n’apparaît pas pour qui n’a pas le droit de lire la page', async () => {
    attach('p-commun', 'restreint.pdf', pdf([{ y: 700, text: 'Dossier Wapiti réservé' }]));
    await indexAll(db, dir, LIMITS);
    expect(await search('ed1', 'wapiti')).toHaveLength(1);
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('p-commun', 'ed2', 'write')").run();
    expect(await search('ed1', 'wapiti')).toEqual([]);
    expect(await search('ed2', 'wapiti')).toHaveLength(1);
  });

  it('supprimer la pièce jointe ou la page efface le texte et l’index', async () => {
    const a = attach('p-commun', 'a.pdf', pdf([{ y: 700, text: 'Mot rarissime Narval' }]));
    await indexAll(db, dir, LIMITS);
    expect(await search('ed1', 'narval')).toHaveLength(1);
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    expect(state(a.id)).toBeUndefined();
    expect(await search('ed1', 'narval')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attachments_fts WHERE attachments_fts MATCH 'narval'").get()).toEqual({ n: 0 });
  });

  it('un fichier sans texte exploitable ou illisible est marqué, sans bloquer la file', async () => {
    const png = attach('p-commun', 'photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
    const bin = attach('p-commun', 'données.bin', randomBytes(300));
    const zip = attach('p-commun', 'archive.docx', Buffer.from('PK\u0003\u0004pas vraiment un zip'));
    const plainZip = attach('p-commun', 'sauvegarde.zip', Buffer.from('PK\u0003\u0004autre archive'));
    expect(state(plainZip.id)).toBeUndefined();
    const bad = attach('p-commun', 'casse.pdf', Buffer.from('%PDF-1.4\nce n’est pas un vrai PDF'));
    const ok = attach('p-commun', 'ok.txt', Buffer.from('contenu Axolotl', 'utf8'));
    expect(state(png.id)).toBeUndefined(); // une image n'est pas mise en file
    await indexAll(db, dir, LIMITS);
    expect(state(bin.id)).toBeUndefined(); // ni PDF, ni Word, ni texte d'après le nom : jamais mis en file
    expect(state(zip.id)!.status).toBe('none');
    expect(state(bad.id)!.status).toBe('none');
    expect(state(ok.id)!.status).toBe('done');
    expect(await indexNext(db, dir, LIMITS)).toBe(false); // file vide
  });

  it('refuse d’extraire un fichier au-delà du plafond de taille', async () => {
    const a = attach('p-commun', 'gros.txt', Buffer.from('contenu Pangolin', 'utf8'));
    await indexAll(db, dir, { ...LIMITS, maxBytes: 5 });
    expect(state(a.id)!.status).toBe('none');
    expect(await search('ed1', 'pangolin')).toEqual([]);
  });

  it('le texte gardé est borné par la taille du fichier : un petit fichier ne gonfle pas l’index', async () => {
    const a = attach('p-commun', 'repetitif.txt', Buffer.from('mot '.repeat(200_000), 'utf8')); // 800 Ko
    const b = attach('p-commun', 'minuscule.txt', Buffer.from('abc '.repeat(100), 'utf8')); // 400 octets
    await indexAll(db, dir, LIMITS);
    expect(state(a.id)!.text.length).toBeLessThanOrEqual(1_000_000);
    expect(state(b.id)!.text.length).toBeLessThanOrEqual(50_000);
  });

  it('le texte extrait ne s’échappe pas : ni code ni HTML interprété, caractères de contrôle retirés', async () => {
    const b = attach('p-commun', 'mise-en-forme.docx', docx());
    const a = attach('p-commun', 'xss.txt', Buffer.from('avant <script>alert(1)</script>\u0001 après Tapir', 'utf8'));
    await indexAll(db, dir, LIMITS);
    expect(state(a.id)!.text).not.toContain('\u0001');
    expect(state(b.id)!.text).not.toMatch(/#|\*\*|\]\(|\| ---/); // aucune syntaxe Markdown du convertisseur
    expect(state(b.id)!.text).toContain('astérisque'); // le texte du document, caractères littéraux compris, reste intact
    const hit = (await search('ed1', 'tapir'))[0]!;
    expect(hit.attachment!.name).toBe('xss.txt');
    // Le texte brut n'est jamais renvoyé par l'API : seulement un extrait balisé par \u0002 et \u0003.
    expect(JSON.stringify(hit)).not.toContain('"text"');
  });
});

describe('migration v25', () => {
  it('met en file les pièces jointes existantes de pages (pas celles des modèles), puis les index suivent', () => {
    const file = oldDb(24, (d) => {
      const ins = d.prepare("INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES (?, 'p1', 'u1', ?, ?, 10, ?, 1)");
      ins.run('a1', 'a.pdf', 'application/pdf', 'a'.repeat(64));
      ins.run('a2', 'photo.png', 'image/png', 'b'.repeat(64));
    });
    const up = openDb(file);
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare('SELECT attachment_id AS id, status FROM attachment_text').all()).toEqual([{ id: 'a1', status: 'pending' }]);
    // Une nouvelle pièce jointe est mise en file par le déclencheur ; une image non.
    up.prepare("INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES ('a3', 'p1', 'u1', 'x.docx', 'application/zip', 10, ?, 2)").run('c'.repeat(64));
    up.prepare("INSERT INTO attachments (id, page_id, uploader_id, name, mime, size, sha256, created_at) VALUES ('a4', 'p1', 'u1', 'y.png', 'image/png', 10, ?, 2)").run('d'.repeat(64));
    expect((up.prepare('SELECT COUNT(*) AS n FROM attachment_text').get() as { n: number }).n).toBe(2);
    // Supprimée avec l'espace.
    up.prepare("DELETE FROM spaces WHERE id = 's1'").run();
    expect(up.prepare('SELECT COUNT(*) AS n FROM attachment_text').get()).toEqual({ n: 0 });
    up.close();
  });
});
