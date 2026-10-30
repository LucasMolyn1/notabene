// Adresses lisibles : /p/titre-de-la-page-<identifiant> et /s/nom-de-l-espace-<identifiant>.
// Seul l'identifiant (les 12 derniers caractères) compte : le titre n'est qu'un décor, si bien qu'une page renommée
// reste joignable par ses anciennes adresses (l'interface corrige alors la barre d'adresse).
// Les anciennes adresses #/p/<identifiant> sont converties au chargement (voir upgradeLegacyHash).
import { store } from './store.js';

export const ID_LENGTH = 12;

// Même règle que server/src/lib/slug.ts : sans accents, minuscules, tirets, 60 caractères au plus.
export function slugOf(title) {
  return String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
}

const withSlug = (kind, id, title) => { const s = slugOf(title); return `/${kind}/${s ? `${s}-` : ''}${id}`; };
export const pagePath = (page) => withSlug('p', page.id, page.title);
export const spacePath = (space) => withSlug('s', space.id, space.name);
export const pagePathById = (id) => pagePath(store.page(id) || { id, title: '' });
export const spacePathById = (id) => spacePath(store.space(id) || { id, name: '' });

// Identifiant contenu dans un segment : les 12 derniers caractères, précédés d'un tiret ou de rien.
export function idFromSegment(seg) {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(seg) === false) return null;
  if (seg.length > ID_LENGTH && /^[a-z0-9-]*-[A-Za-z0-9_-]{12}$/.test(seg)) return seg.slice(-ID_LENGTH);
  return seg;
}

/** @returns {{ kind: 'page' | 'space' | 'settings' | 'root' | 'unknown', id?: string, section?: string }} */
export function parseRoute(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return { kind: 'root' };
  let m;
  if ((m = /^\/p\/([^/]+)$/.exec(path))) { const id = idFromSegment(m[1]); return id ? { kind: 'page', id } : { kind: 'unknown' }; }
  if ((m = /^\/s\/([^/]+)$/.exec(path))) { const id = idFromSegment(m[1]); return id ? { kind: 'space', id } : { kind: 'unknown' }; }
  if (path === '/settings') return { kind: 'settings' };
  if (path.startsWith('/settings/') && /^[a-z-]{1,40}$/.test(path.slice(10))) return { kind: 'settings', section: path.slice(10) };
  return { kind: 'unknown' };
}

// Adresse d'application (avec le titre quand on le connaît) pour un chemin interne quelconque (/p/<id>, /s/<id>, /settings…).
export function canonicalPath(path) {
  const r = parseRoute(path);
  if (r.kind === 'page') return pagePathById(r.id);
  if (r.kind === 'space') return spacePathById(r.id);
  return path;
}

// Ancien format : https://hote/#/p/<id> devient https://hote/p/<titre>-<id> (le jeton de réinitialisation #/reset/… reste dans le fragment).
export function upgradeLegacyHash() {
  const path = location.hash.slice(1);
  if (!path.startsWith('/') || ['unknown', 'root'].includes(parseRoute(path).kind)) return false;
  history.replaceState(null, '', path + location.search);
  return true;
}
