// Documents de test : un .docx réel (construit avec fflate) et un PDF minimal écrit à la main, contenu inventé.
import { strToU8, zipSync } from 'fflate';

// PNG 1x1 valide.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const p = (t: string, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

/** Document Word minimal mais réel : titre, gras, liste, tableau, lien, image. */
export function docx(opts: { image?: boolean; body?: string; noDocument?: boolean } = {}): Buffer {
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
export function pdf(lines: { y: number; text: string }[] = [{ y: 700, text: 'Bonjour le monde' }, { y: 686, text: 'suite de la phrase' }, { y: 600, text: 'Second paragraphe' }]): Buffer {
  const stream = `BT /F1 12 Tf ${lines.map((l) => `1 0 0 1 72 ${l.y} Tm (${l.text.replace(/[\\()]/g, '\\$&')}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

