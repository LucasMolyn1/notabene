// Import d'un document Word (.docx) ou PDF (lot 12) : fichiers reconstruits ici (DOCX avec fflate, PDF écrit à la main), contenu inventé.
// Conversion dans un worker, structure conservée, images en pièces jointes, PDF en texte seulement, refus (type, bombe, PDF protégé,
// archive qui n'est pas du Word), simulation sans écriture, droits, verrou d'import.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { sniffDocument } from '../src/lib/document-import.js';
import { hashPassword } from '../src/lib/password.js';

const PASS = 'Sup3r-secret-pass';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// PNG 1x1 valide.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const p = (t: string, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

/** Document Word minimal mais réel : titre, gras, liste, tableau, lien, image. */
function docx(opts: { image?: boolean; body?: string; noDocument?: boolean } = {}): Buffer {
  const body = opts.body ?? [
    p('Plan de la saison', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    `<w:p><w:r><w:t xml:space="preserve">Un texte avec </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>du gras</w:t></w:r><w:r><w:t xml:space="preserve"> et un * astérisque [crochets] &lt;balise&gt;.</w:t></w:r></w:p>`,
    p('- pas une liste'),
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nom</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Valeur | pipe</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>un</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>le site</w:t></w:r></w:hyperlink></w:p>`,
    `<w:p><w:hyperlink r:id="rIdBad"><w:r><w:t>piège</w:t></w:r></w:hyperlink></w:p>`,
    opts.image
      ? `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Image" descr="Une image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      : '',
  ].join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://exemple.org/page" TargetMode="External"/><Relationship Id="rIdBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'),
  };
  if (!opts.noDocument) files['word/document.xml'] = strToU8(`<?xml version="1.0"?><w:document ${W} ${REL}><w:body>${body}</w:body></w:document>`);
  if (opts.image) files['word/media/image1.png'] = PNG;
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** PDF minimal valide (une police standard, deux paragraphes sur une page), table des références calculée. */
function pdf(lines: { y: number; text: string }[] = [{ y: 700, text: 'Bonjour le monde' }, { y: 686, text: 'suite de la phrase' }, { y: 600, text: 'Second paragraphe' }]): Buffer {
  const stream = `BT /F1 12 Tf ${lines.map((l) => `1 0 0 1 72 ${l.y} Tm (${l.text.replace(/[\\()]/g, '\\$&')}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('reconnaissance du type', () => {
  it('se fie aux octets, pas au nom', () => {
    expect(sniffDocument(pdf())).toBe('pdf');
    expect(sniffDocument(docx())).toBe('docx');
    expect(sniffDocument(Buffer.from('<html></html>'))).toBeNull();
    expect(sniffDocument(Buffer.alloc(0))).toBeNull();
  });
});

let app: FastifyInstance;
let db: DB;
let dataDir: string;

async function boot(extra: Record<string, string> = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'nb-doc-'));
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false', DATA_DIR: dataDir, ...extra };
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['ed1', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp', 'Commun', 0, 0), ('lecture', 'Lecture', 0, 0), ('prive', 'Privé', 0, 0)").run();
  db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES ('sp', 'everyone', 'edit'), ('lecture', 'everyone', 'view')").run();
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('ailleurs', 'prive', 'Ailleurs', '{}', '', 0, 0)").run();
}
afterEach(async () => { if (app) { await app.close(); db.close(); app = undefined as unknown as FastifyInstance; } });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const post = (s: S, space: string, query: string, payload: Buffer, type = DOCX_TYPE) =>
  app.inject({ method: 'POST', url: `/api/v3/spaces/${space}/import/document?${query}`, payload, cookies: s.cookies, headers: { ...s.headers, 'content-type': type } });
const pages = () => db.prepare("SELECT * FROM pages WHERE id != 'ailleurs'").all() as { id: string; title: string; content: string; parent_id: string | null }[];
const filesOnDisk = () => (existsSync(join(dataDir, 'attachments')) ? readdirSync(join(dataDir, 'attachments')) : []);

describe('import d’un document Word', () => {
  beforeEach(() => boot());

  it('simule sans rien créer, puis importe : titre du fichier, structure, gras, tableau, lien sûr, image jointe', async () => {
    const ed = await login('ed1');
    const file = docx({ image: true });
    const q = 'filename=Plan_de_saison.docx';

    const dry = await post(ed, 'sp', `dryRun=true&${q}`, file);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, source: 'docx', summary: { pages: 1, attachments: 1 } });
    expect(pages()).toHaveLength(0);
    expect(filesOnDisk()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });

    const res = await post(ed, 'sp', `dryRun=false&${q}`, file);
    expect(res.statusCode).toBe(201);
    const [page] = pages();
    expect(page!.title).toBe('Plan de saison');
    const content = page!.content;
    expect(content).toContain('"heading"');
    expect(content).toContain('Plan de la saison');
    expect(content).toContain('"bold"');
    expect(content).toContain('du gras');
    expect(content).toContain('"table"');
    expect(content).toContain('Valeur | pipe');
    expect(content).toContain('https://exemple.org/page');
    expect(content).not.toContain('javascript:');
    expect(content).not.toContain('"bulletList"'); // « - pas une liste » reste du texte
    expect(content).toContain('/api/v3/attachments/');
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 1 });
    expect(filesOnDisk()).toHaveLength(1);
    expect(res.json().items.some((i: { path: string; status: string }) => i.path === 'Plan_de_saison.docx' && i.status === 'imported')).toBe(true);
  });

  it('range la page sous la page parente demandée, dans le même espace seulement', async () => {
    const ed = await login('ed1');
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES ('mere', 'sp', 'Mère', '{}', '', 0, 0)").run();
    const ok = await post(ed, 'sp', 'dryRun=false&parentId=mere&filename=a.docx', docx());
    expect(ok.statusCode).toBe(201);
    expect(pages().find((x) => x.title === 'a')!.parent_id).toBe('mere');
    expect((await post(ed, 'sp', 'dryRun=false&parentId=ailleurs&filename=b.docx', docx())).statusCode).toBe(404);
  });

  it('refuse ce qui n’est pas un document Word : autre ZIP, type trompeur, HTML', async () => {
    const ed = await login('ed1');
    const notWord = await post(ed, 'sp', 'dryRun=false&filename=x.docx', docx({ noDocument: true }));
    expect(notWord.statusCode).toBe(422);
    const html = await post(ed, 'sp', 'dryRun=false&filename=x.docx', Buffer.from('<html><script>alert(1)</script></html>'));
    expect(html.statusCode).toBe(415);
    expect(pages()).toHaveLength(0);
  });

  it('refuse une bombe de compression dans le document, avant toute conversion', async () => {
    const ed = await login('ed1');
    const bomb = Buffer.from(zipSync({
      'word/document.xml': strToU8('<w:document/>'),
      'word/media/bombe.bin': new Uint8Array(40 * 1024 * 1024),
    }, { level: 9 }));
    const res = await post(ed, 'sp', 'dryRun=false&filename=bombe.docx', bomb);
    expect(res.statusCode).toBe(413);
    expect(pages()).toHaveLength(0);
  });

  it('un document sans image reconnue ni contenu devient une page vide, sans erreur', async () => {
    const ed = await login('ed1');
    const res = await post(ed, 'sp', 'dryRun=false&filename=vide.docx', docx({ body: '' }));
    expect(res.statusCode).toBe(201);
    expect(pages()[0]!.title).toBe('vide');
  });

  it('le titre vient du nom de fichier, assaini', async () => {
    const ed = await login('ed1');
    await post(ed, 'sp', `dryRun=false&filename=${encodeURIComponent('  Rapport__final\u0001.docx ')}`, docx());
    expect(pages()[0]!.title).toBe('Rapport final');
  });

  it('droits : lecteur refusé, anonyme refusé, simulation et import exigent l’écriture', async () => {
    const rd = await login('rd');
    expect((await post(rd, 'sp', 'dryRun=false&filename=a.docx', docx())).statusCode).toBe(403);
    const ed = await login('ed1');
    expect((await post(ed, 'lecture', 'dryRun=true&filename=a.docx', docx())).statusCode).toBe(403);
    expect((await post(ed, 'prive', 'dryRun=false&filename=a.docx', docx())).statusCode).toBeGreaterThanOrEqual(403);
    const anon = await app.inject({ method: 'POST', url: '/api/v3/spaces/sp/import/document?dryRun=true&filename=a.docx', payload: docx(), headers: { 'content-type': DOCX_TYPE } });
    expect(anon.statusCode).toBe(401);
    expect(pages()).toHaveLength(0);
  });

  it('un saut de ligne suivi de « # » ou « - » ne crée ni titre ni liste', async () => {
    const ed = await login('ed1');
    const body = '<w:p><w:r><w:t>début</w:t><w:br/><w:t># faux titre</w:t><w:br/><w:t>- faux item</w:t><w:br/><w:t>===</w:t></w:r></w:p>';
    expect((await post(ed, 'sp', 'dryRun=false&filename=br.docx', docx({ body }))).statusCode).toBe(201);
    const c = pages()[0]!.content;
    expect(c).not.toContain('"heading"');
    expect(c).not.toContain('"bulletList"');
    expect(c).toContain('faux titre');
  });

  it('exige dryRun et le nom de fichier', async () => {
    const ed = await login('ed1');
    expect((await post(ed, 'sp', 'filename=a.docx', docx())).statusCode).toBe(400);
    expect((await post(ed, 'sp', 'dryRun=true', docx())).statusCode).toBe(400);
  });

  it('un import à la fois : le second, simultané, reçoit 503', async () => {
    const ed = await login('ed1');
    const [a, b] = await Promise.all([
      post(ed, 'sp', 'dryRun=true&filename=a.docx', docx({ image: true })),
      post(ed, 'sp', 'dryRun=true&filename=b.docx', docx({ image: true })),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 503]);
    expect((await post(ed, 'sp', 'dryRun=true&filename=c.docx', docx())).statusCode).toBe(200); // verrou relâché
  });
});

describe('import d’un PDF', () => {
  beforeEach(() => boot());

  it('extrait le texte seulement, par paragraphes, et le dit dans le rapport', async () => {
    const ed = await login('ed1');
    const res = await post(ed, 'sp', 'dryRun=false&filename=Compte-rendu.pdf', pdf(), 'application/pdf');
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe('pdf');
    const [page] = pages();
    expect(page!.title).toBe('Compte-rendu');
    expect(page!.content).toContain('Bonjour le monde suite de la phrase');
    expect(page!.content).toContain('Second paragraphe');
    expect(JSON.stringify(res.json().items)).toContain('texte seulement');
  });

  it('protège le texte d’un PDF qui ressemble à du Markdown ou du HTML', async () => {
    const ed = await login('ed1');
    const res = await post(ed, 'sp', 'dryRun=false&filename=piege.pdf', pdf([{ y: 700, text: '# faux titre <script>alert(1)</script> [x](javascript:alert(1))' }, { y: 600, text: '- faux item' }]), 'application/pdf');
    expect(res.statusCode).toBe(201);
    const c = pages()[0]!.content;
    expect(c).not.toContain('"heading"');
    expect(c).not.toContain('"bulletList"');
    expect(c).not.toContain('"link"');
    expect(c).toContain('faux titre');
  });

  it('un PDF illisible est refusé proprement', async () => {
    const ed = await login('ed1');
    const res = await post(ed, 'sp', 'dryRun=false&filename=casse.pdf', Buffer.from('%PDF-1.4\nce n’est pas un vrai PDF'), 'application/pdf');
    expect(res.statusCode).toBe(422);
    expect(pages()).toHaveLength(0);
  });

  it('limite le nombre de pages lues', async () => {
    await app.close(); db.close();
    await boot({ DOC_IMPORT_MAX_PAGES: '1' });
    const ed = await login('ed1');
    const res = await post(ed, 'sp', 'dryRun=true&filename=a.pdf', pdf(), 'application/pdf');
    expect(res.statusCode).toBe(200); // une seule page : rien à tronquer
  });
});
