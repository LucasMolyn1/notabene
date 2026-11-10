// Flux iCalendar en lecture d'une base, par adresse secrète (sans compte).
// Règles :
//  - le jeton (24 octets aléatoires, base64url) n'est jamais stocké : seule son empreinte SHA-256 l'est ; il n'est montré qu'une
//    fois, à la création ou à la rotation, et n'apparaît jamais dans les journaux (maskShareToken) ni dans l'audit ;
//  - rien n'est définitif : à chaque lecture on revérifie le partage public de l'instance et de l'espace, la base hors corbeille
//    et la restriction de la page, identique à celle de la création. Sinon le flux se tait (404 uniforme, sans raison) ;
//  - contenu minimal : par ligne datée, un identifiant stable, les dates et le titre. Ni personnes, ni statut, ni autre colonne,
//    ni lien vers l'application ;
//  - le flux n'est ni copié (copie de base), ni exporté, ni gardé dans une sauvegarde ; il disparaît avec la base (corbeille,
//    suppression) et quand le partage public de l'instance est coupé.
import type { DB } from '../db.js';
import { settingsOf } from './base-project.js';
import { calendarColumns, propertiesOf, viewsOf } from './bases.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { restrictionKey, sharingEnabled } from './shares.js';

/** Événements au plus dans un flux. */
export const MAX_ICAL_EVENTS = 2000;
/** Forme d'un jeton de flux : 24 octets en base64url. */
export const ICAL_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export interface IcalFeedRow { base_id: string; token_hash: string; restricted_key: string | null; created_by: string | null; created_at: number }

export const feedOf = (db: DB, baseId: string) => db.prepare('SELECT * FROM base_ical_feeds WHERE base_id = ?').get(baseId) as IcalFeedRow | undefined;

/** Crée le flux d'une base ou fait tourner son jeton (l'ancien cesse aussitôt de valoir). Rend le jeton en clair, une seule fois. */
export function createOrRotateFeed(db: DB, baseId: string, userId: string | null): { token: string; rotated: boolean } {
  return db.transaction(() => {
    const token = randomToken(24);
    const existing = feedOf(db, baseId);
    db.prepare(`INSERT INTO base_ical_feeds (base_id, token_hash, restricted_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(base_id) DO UPDATE SET token_hash = excluded.token_hash, restricted_key = excluded.restricted_key, created_by = excluded.created_by, created_at = excluded.created_at`)
      .run(baseId, sha256(token), restrictionKey(db, baseId), userId, Date.now());
    return { token, rotated: !!existing };
  })();
}

export const revokeFeed = (db: DB, baseId: string): boolean => db.prepare('DELETE FROM base_ical_feeds WHERE base_id = ?').run(baseId).changes > 0;

/** Base servie par le jeton, si le flux est encore valable. Sinon null (jamais de détail sur la raison). */
export function activeFeed(db: DB, token: string): { baseId: string } | null {
  if (!ICAL_TOKEN.test(token) || !sharingEnabled(db)) return null;
  const hash = sha256(token);
  const feed = db.prepare('SELECT * FROM base_ical_feeds WHERE token_hash = ?').get(hash) as IcalFeedRow | undefined;
  if (!feed || !safeEqual(feed.token_hash, hash)) return null;
  const base = db.prepare(
    `SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.id = ? AND p.deleted_at IS NULL AND p.kind = 'base' AND s.sharing_enabled = 1`,
  ).get(feed.base_id) as { id: string } | undefined;
  if (!base) return null;
  // Restriction changée (posée, retirée ou modifiée) depuis la création : le flux se tait jusqu'à une nouvelle création.
  if (restrictionKey(db, base.id) !== feed.restricted_key) return null;
  return { baseId: base.id };
}

// ---------- Rendu RFC 5545 ----------

const DAY = 86_400_000;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const icalDate = (s: string) => s.replace(/-/g, '');
const nextDay = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Texte RFC 5545 : antislash, point-virgule, virgule et retours à la ligne échappés ; autres caractères de contrôle retirés. */
export function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Pliage à 75 octets (UTF-8) par ligne, sans couper un caractère ; les lignes suivantes commencent par une espace. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    const max = out.length ? 74 : 75; // l'espace de continuation compte
    if (bytes + n > max) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l)).join('\r\n');
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * Calendrier d'une base : colonnes de date de la première vue calendrier, sinon celles des réglages. Une ligne sans début valide
 * n'apparaît pas ; une fin absente, invalide ou antérieure au début vaut le début. DTEND est exclusif (jour suivant la fin).
 */
export function renderCalendar(db: DB, baseId: string, domain: string): string {
  const props = propertiesOf(db, baseId);
  const view = viewsOf(db, baseId).find((v) => v.config.type === 'calendar');
  const { dateId, endId } = calendarColumns(props, settingsOf(db, baseId), view?.config);
  const titleId = props.find((p) => p.type === 'text')?.id ?? null;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Notabene//Calendrier//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (dateId) {
    // Les identifiants de colonnes sont générés par le serveur (base64url) : le chemin JSON est passé en paramètre, jamais concaténé au SQL.
    const path = (id: string | null) => (id ? `$."${id}"` : '$."-"');
    // Plage de dates : début et fin dans la même cellule.
    const range = props.find((p) => p.id === dateId)?.type === 'date_range';
    const startPath = range ? `${path(dateId)}.start` : path(dateId);
    const endPath = range ? `${path(dateId)}.end` : path(endId);
    const rows = db.prepare(
      `SELECT id, json_extract(vals, ?) AS start, json_extract(vals, ?) AS finish, json_extract(vals, ?) AS title
       FROM base_rows WHERE base_id = ? AND json_type(vals, ?) = 'text' ORDER BY position, created_at LIMIT ?`,
    ).all(startPath, endPath, path(titleId), baseId, startPath, MAX_ICAL_EVENTS) as { id: string; start: unknown; finish: unknown; title: unknown }[];
    const now = stamp();
    for (const r of rows) {
      if (!isDate(r.start)) continue;
      const end = isDate(r.finish) && r.finish >= r.start ? r.finish : r.start;
      const after = nextDay(end);
      if (!isDate(after)) continue; // fin au 31/12/9999 : hors du format de date
      const title = typeof r.title === 'string' && r.title.trim() ? r.title : 'Sans titre';
      lines.push(
        'BEGIN:VEVENT',
        `UID:${r.id}@${domain}`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${icalDate(r.start)}`,
        `DTEND;VALUE=DATE:${icalDate(after)}`,
        `SUMMARY:${escapeText(title)}`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
