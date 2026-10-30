// Nouveautés : la pastille s'allume quand la version du serveur diffère de la dernière version vue sur ce navigateur.
// Première visite : la version courante est enregistrée sans pastille (rien de « nouveau » pour un nouvel utilisateur).
const KEY = 'notabene:seen-version';
const listeners = new Set();

const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* navigation privée */ } };

export function initNews(version) {
  if (version && read() === null) write(version);
}

export const newsPending = (version) => !!version && read() !== null && read() !== version;

export function markNewsSeen(version) {
  if (!version || read() === version) return;
  write(version);
  listeners.forEach((fn) => fn());
}

export const onNewsChange = (fn) => { listeners.add(fn); };
export const notifyNewsChange = () => listeners.forEach((fn) => fn());
