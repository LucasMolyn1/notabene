// Recherche dans les pièces jointes : le texte des PDF, documents Word (.docx) et fichiers texte est extrait en tâche de fond,
// une pièce jointe à la fois, puis indexé (attachments_fts). L'extraction d'un PDF ou d'un Word passe par le même processus
// enfant isolé que l'import de documents (doc-worker.js). Le texte extrait ne sort jamais tel quel de la base : seule la
// recherche le lit, et un résultat n'est montré qu'à une personne qui lit la page porteuse (comme pour le texte des pages).
import { readFileSync, statSync } from 'node:fs';
import type { DB } from '../db.js';
import { attachmentPath } from './attachments.js';
import { checkDocx, type DocLimits, runWorker } from './document-import.js';
import { HttpError } from './http.js';
import { ftsQuery } from './pages.js';

export const MAX_INDEXED_CHARS = 1_000_000; // texte gardé par pièce jointe
const MAX_TEXT_FILE = 5 * 1024 * 1024; // fichier texte lu au plus
const MAX_ATTEMPTS = 2;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|log|json|xml|yaml|yml|html?|ini|conf)$/i;
const MIN_INDEXED_CHARS = 50_000; // texte gardé au moins, quelle que soit la taille du fichier
const CHARS_PER_BYTE = 20; // au plus 20 caractères par octet de fichier : un fichier minuscule très compressé ne gonfle pas l'index

export interface IndexLimits extends DocLimits { maxBytes: number }

type Kind = 'pdf' | 'docx' | 'text';

/** Type d'extraction d'après le type reconnu sur les octets, le nom et le contenu ; null : rien à indexer. */
function kindOf(mime: string, name: string): Kind | null {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip') return /\.docx$/i.test(name) ? 'docx' : null;
  if (mime === 'application/octet-stream' && TEXT_EXT.test(name)) return 'text';
  return null;
}

/** Du Markdown du convertisseur au texte brut : l'index porte sur les mots, pas sur la syntaxe (titres, gras, liens, tableaux). */
const unprotect = (s: string) => s
  .replace(/!?\[([^\]]{0,500})\]\([^)\s]{0,2000}\)/g, '$1')
  .split('\n').map((l) => (l.includes('---') && /^[\s|:-]+$/.test(l) ? ' ' : l)).join('\n') // ligne de séparation d'un tableau
  .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  .replace(/^[ \t]*(?:[-+]|\d+\.)[ \t]+/gm, '')
  .replace(/(?<!\\)\*{1,2}/g, '')
  .replace(/(?<!\\)\|/g, ' ')
  .replace(/\\([\\`*_[\]<>|~!#>+\-=])/g, '$1');

/** Texte brut d'un fichier texte : UTF-8 strict, sans caractères de contrôle. */
function plainText(data: Buffer): string | null {
  try {
    // eslint-disable-next-line no-control-regex
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  } catch { return null; }
}

/**
 * Traite la prochaine pièce jointe en attente. Renvoie false quand il n'y en a plus.
 * Un fichier illisible, protégé, trop gros ou d'un type sans texte devient `none` ; une panne imprévue réessaie une fois
 * puis devient `failed` : la recherche par le nom du fichier reste possible, rien ne bloque la file.
 */
export async function indexNext(db: DB, dir: string, limits: IndexLimits): Promise<boolean> {
  const row = db.prepare(
    `SELECT t.attachment_id AS id, t.name, t.attempts, a.mime, a.size
     FROM attachment_text t JOIN attachments a ON a.id = t.attachment_id
     WHERE t.status = 'pending' ORDER BY t.seq LIMIT 1`,
  ).get() as { id: string; name: string; attempts: number; mime: string; size: number } | undefined;
  if (!row) return false;
  const finish = (status: 'done' | 'none' | 'failed', text = '') => {
    db.prepare('UPDATE attachment_text SET status = ?, text = ?, updated_at = ? WHERE attachment_id = ?').run(status, text, Date.now(), row.id);
  };
  try {
    if (row.size > limits.maxBytes) { finish('none'); return true; }
    // Type, nom et taille d'abord : un fichier sans intérêt n'est jamais lu.
    const kind = kindOf(row.mime, row.name);
    if (!kind || (kind === 'text' && row.size > MAX_TEXT_FILE)) { finish('none'); return true; }
    const path = attachmentPath(dir, row.id);
    if (statSync(path).size > limits.maxBytes) { finish('none'); return true; }
    const data = readFileSync(path);
    let text: string | null;
    if (kind === 'text') text = data.includes(0) ? null : plainText(data);
    else {
      if (kind === 'docx') checkDocx(data, limits);
      // maxImages à 0 : seules les paroles comptent, aucune image n'est lue.
      const out = await runWorker(kind, data, limits, 0);
      text = unprotect(out.markdown);
    }
    text = text?.replace(/\s+/g, ' ').trim().slice(0, Math.min(MAX_INDEXED_CHARS, Math.max(MIN_INDEXED_CHARS, row.size * CHARS_PER_BYTE))) ?? '';
    // Une pièce jointe supprimée entre-temps n'a plus de ligne : la mise à jour ne touche rien.
    finish(text ? 'done' : 'none', text);
  } catch (err) {
    if (err instanceof HttpError) { finish('none'); return true; } // illisible, protégé, archive refusée, trop long : définitif
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) finish('failed');
    else db.prepare('UPDATE attachment_text SET attempts = ?, updated_at = ? WHERE attachment_id = ?').run(attempts, Date.now(), row.id);
  }
  return true;
}

/** Vide la file, une pièce jointe à la fois. Les erreurs imprévues ne sortent pas. */
export async function indexAll(db: DB, dir: string, limits: IndexLimits, stop: () => boolean = () => false): Promise<number> {
  let n = 0;
  while (!stop()) {
    const more = await indexNext(db, dir, limits).catch(() => false);
    if (!more) break;
    n++;
    await new Promise((r) => setImmediate(r)); // rend la main au serveur entre deux fichiers
  }
  return n;
}

export interface AttachmentHit {
  id: string; spaceId: string; parentId: string | null; title: string; icon: string; updatedAt: number;
  attachmentId: string; attachmentName: string; snippet: string; rank: number;
}

/** Pages dont une pièce jointe contient les mots cherchés (nom ou texte). Les droits sont vérifiés par l'appelant, page par page. */
export function searchAttachments(db: DB, query: string, spaceIds: string[], limit = 100, label: string | null = null): AttachmentHit[] {
  const match = ftsQuery(query, 'AND');
  if (!match) return [];
  return db.prepare(
    `SELECT p.id, p.space_id AS spaceId, p.parent_id AS parentId, p.title, p.icon, p.updated_at AS updatedAt,
            t.attachment_id AS attachmentId, t.name AS attachmentName,
            snippet(attachments_fts, 1, char(2), char(3), '…', 20) AS snippet, bm25(attachments_fts, 4.0, 1.0) AS rank
     FROM attachments_fts
       JOIN attachment_text t ON t.seq = attachments_fts.rowid
       JOIN attachments a ON a.id = t.attachment_id
       JOIN pages p ON p.id = a.page_id
     WHERE attachments_fts MATCH ? AND p.deleted_at IS NULL AND p.space_id IN (SELECT value FROM json_each(?))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM page_labels l WHERE l.page_id = p.id AND l.name = ?))
     ORDER BY rank LIMIT ?`,
  ).all(match, JSON.stringify(spaceIds), label, label, limit) as AttachmentHit[];
}
