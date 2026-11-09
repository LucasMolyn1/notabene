// Conversion d'un document Word (.docx) ou PDF en Markdown, dans un processus enfant isolé : le serveur le lance avec le modèle
// de permissions de Node (lecture seule de node_modules, ni écriture, ni réseau, ni processus), sans variable d'environnement, une
// mémoire plafonnée, une surveillance de sa taille et un délai maximal. Il reçoit les octets par le canal IPC et rend du Markdown
// et des images. Les bibliothèques (mammoth, pdfjs-dist) ne sont chargées qu'ici.
import { Buffer } from 'node:buffer';
import process from 'node:process';

const MAX_CHARS = 4_000_000; // texte rendu au plus
const MAX_DEPTH = 40; // profondeur d'imbrication HTML prise en compte
const MAX_TABLE_ROWS = 2000;
const MAX_COLS = 60;

// ---- Texte ---------------------------------------------------------------------------------------------------------------
const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' };
const decode = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, name) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }
  return ENTITIES[name.toLowerCase()] ?? m;
});
// Caractères qui auraient un sens en Markdown : protégés par une barre oblique inverse.
const esc = (s) => s.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/!(?=\[)/g, '\\!');
// Début de bloc qui ressemblerait à une liste, une citation ou un titre.
const safeStart = (s) => s.replace(/(^|\n)([ \t]*)([-+#>=]|\d+[.)])/g, '$1$2\\$3');
// eslint-disable-next-line no-control-regex
const squash = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t\r\n]+/g, ' ');

// ---- HTML produit par mammoth -> arbre -----------------------------------------------------------------------------------
const VOID = new Set(['br', 'img', 'hr']);
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<(\/?)([a-z][a-z0-9]*)([^<>]*?)(\/?)>|([^<]+)|</gi;
  for (let m; (m = re.exec(html));) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.kids.push(decode(m[5])); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { // balise fermante : remonte jusqu'à la balise ouvrante correspondante, si elle existe
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([a-z-]+)="([^"]*)"/gi)) attrs[a[1].toLowerCase()] = decode(a[2]);
    const node = { tag, attrs, kids: [] };
    top.kids.push(node);
    if (!VOID.has(tag) && !m[4] && stack.length < MAX_DEPTH) stack.push(node);
  }
  return root;
}

// ---- Arbre -> Markdown ------------------------------------------------------------------------------------------------------
const images = []; // { mime, data } ; l'adresse « docimg:N » renvoie à l'indice
const notes = new Set();

function inline(node) {
  if (typeof node === 'string') return esc(squash(node));
  switch (node.tag) {
    case 'br': return '  \n';
    case 'img': {
      const src = node.attrs.src ?? '';
      return /^docimg:\d+$/.test(src) ? `![${esc(squash(node.attrs.alt ?? ''))}](${src})` : '';
    }
    case 'strong': case 'b': return wrap('**', node);
    case 'em': case 'i': return wrap('*', node);
    case 'a': {
      const text = node.kids.map(inline).join('');
      const href = (node.attrs.href ?? '').trim();
      if (!text.trim()) return '';
      return /^(https?:\/\/|mailto:)[^\s()<>]+$/i.test(href) ? `[${text}](${href})` : text;
    }
    case 'ul': case 'ol': case 'table': case 'p': return node.kids.map(inline).join(' ');
    default: return node.kids.map(inline).join('');
  }
}
function wrap(mark, node) {
  const inner = node.kids.map(inline).join('');
  const t = inner.trim();
  if (!t) return inner;
  const lead = inner.slice(0, inner.indexOf(t));
  return `${lead}${mark}${t}${mark}${inner.slice(lead.length + t.length)}`;
}
const text1 = (nodes) => nodes.map(inline).join('').replace(/\s+/g, ' ').trim();

function list(node, indent) {
  const ordered = node.tag === 'ol';
  let n = 0;
  const out = [];
  for (const li of node.kids) {
    if (typeof li === 'string' || li.tag !== 'li') continue;
    n++;
    const bullet = ordered ? `${n}. ` : '- ';
    const nested = li.kids.filter((k) => typeof k !== 'string' && (k.tag === 'ul' || k.tag === 'ol'));
    const own = text1(li.kids.filter((k) => !nested.includes(k)));
    out.push(`${' '.repeat(indent)}${bullet}${own || '\u00a0'}`);
    for (const sub of nested) out.push(list(sub, indent + bullet.length));
  }
  return out.join('\n');
}

function table(node) {
  const rows = [];
  let headerRows = 0;
  const collect = (n) => {
    for (const k of n.kids) {
      if (typeof k === 'string') continue;
      if (k.tag === 'tr') {
        if (rows.length >= MAX_TABLE_ROWS) { notes.add(`tableau tronqué à ${MAX_TABLE_ROWS} lignes`); return; }
        const cells = k.kids.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'));
        if (cells.length && cells.every((c) => c.tag === 'th') && rows.length === headerRows) headerRows++;
        rows.push(cells.slice(0, MAX_COLS).map((c) => text1(c.kids)));
      } else collect(k);
    }
  };
  collect(node);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!rows.length || !width) return '';
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function blocks(nodes) {
  const out = [];
  for (const node of nodes) {
    if (typeof node === 'string') { const t = squash(node).trim(); if (t) out.push(safeStart(esc(t))); continue; }
    const h = /^h([1-6])$/.exec(node.tag);
    if (h) { const t = text1(node.kids); if (t) out.push(`${'#'.repeat(Number(h[1]))} ${t}`); }
    else if (node.tag === 'ul' || node.tag === 'ol') out.push(list(node, 0));
    else if (node.tag === 'table') out.push(table(node));
    else if (node.tag === 'hr') out.push('---');
    else if (node.tag === 'p') { const t = node.kids.map(inline).join('').trim(); if (t) out.push(safeStart(t)); }
    else if (node.tag === 'img') { const t = inline(node); if (t) out.push(t); }
    else if (node.tag === '#root' || node.tag === 'div' || node.tag === 'body' || node.tag === 'section') out.push(...blocks(node.kids));
    else { const t = node.kids.map(inline).join('').trim(); if (t) out.push(safeStart(t)); }
  }
  return out.filter(Boolean);
}

// ---- DOCX --------------------------------------------------------------------------------------------------------------------
async function docx({ data, mammothPath, maxImages, maxImageBytes }) {
  const mammoth = (await import(mammothPath)).default;
  let skippedImages = 0;
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) }, {
    convertImage: mammoth.images.imgElement(async (img) => {
      if (images.length >= maxImages) { skippedImages++; return { src: '' }; }
      const bytes = await img.readAsBuffer();
      if (bytes.length > maxImageBytes) { skippedImages++; return { src: '' }; }
      images.push({ mime: img.contentType, data: new Uint8Array(bytes) });
      return { src: `docimg:${images.length - 1}`, alt: img.altText ?? '' };
    }),
    ignoreEmptyParagraphs: true,
  });
  if (skippedImages) notes.add(`${skippedImages} image(s) non reprise(s) (trop nombreuses ou trop lourdes)`);
  if (result.messages.some((m) => /unrecognised|unsupported/i.test(m.message))) notes.add('mise en forme non reconnue ignorée (styles, zones de texte, formes)');
  return blocks(parseHtml(result.value).kids).join('\n\n');
}

// ---- PDF : texte seulement ---------------------------------------------------------------------------------------------
async function pdf({ data, pdfjsUrl, maxPages }) {
  const pdfjs = await import(pdfjsUrl);
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, enableXfa: false,
    useWorkerFetch: false, verbosity: 0, stopAtErrors: false,
  });
  let doc;
  try { doc = await task.promise; } catch (err) {
    if (err && err.name === 'PasswordException') throw Object.assign(new Error('PDF protégé par un mot de passe'), { status: 422 });
    throw Object.assign(new Error('PDF illisible ou corrompu'), { status: 422 });
  }
  const total = doc.numPages;
  const pages = Math.min(total, maxPages);
  if (total > pages) notes.add(`${total - pages} page(s) au-delà de ${maxPages} non lue(s)`);
  const paragraphs = [];
  let size = 0;
  for (let p = 1; p <= pages && size < MAX_CHARS; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    let lastY = null;
    let lastH = 0;
    let para = [];
    const flushLine = () => { const t = squash(line).trim(); if (t) para.push(t); line = ''; };
    const flushPara = () => { flushLine(); if (para.length) { const t = para.join(' '); paragraphs.push(safeStart(esc(t))); size += t.length; para = []; } };
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform?.[5] ?? 0;
      const h = Math.abs(it.height || it.transform?.[3] || 10) || 10;
      if (lastY !== null && Math.abs(lastY - y) > 0.5 * h) {
        flushLine();
        if (Math.abs(lastY - y) > 1.9 * Math.max(h, lastH)) flushPara();
      }
      line += it.str;
      if (it.hasEOL) flushLine();
      lastY = y; lastH = h;
    }
    flushPara();
    page.cleanup();
  }
  await task.destroy();
  if (!paragraphs.length) notes.add('aucun texte trouvé : PDF d’images numérisées (la reconnaissance de caractères n’est pas prise en charge)');
  return paragraphs.join('\n\n');
}

async function main(job) {
  let reply;
  try {
    const markdown = (job.kind === 'docx' ? await docx(job) : await pdf(job)).slice(0, MAX_CHARS);
    if (markdown.length >= MAX_CHARS) notes.add('texte tronqué (document trop volumineux)');
    reply = { ok: true, markdown, images, notes: [...notes] };
  } catch (err) {
    reply = { ok: false, status: err && err.status ? err.status : 422, message: err && err.status ? err.message : 'Document illisible ou non pris en charge' };
  }
  process.send(reply, () => process.exit(0));
}
process.once('message', (job) => { void main(job); });
