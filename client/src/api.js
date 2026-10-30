// Client HTTP de l'API : cookie de session same-origin + en-tête CSRF sur les écritures.
let csrf = null;
export const setCsrf = (token) => { csrf = token; };

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Seules les routes de l'application sont appelables : un identifiant tiré de l'URL de la page
// (par exemple « ../ ») ne peut pas détourner la requête vers un autre chemin.
const SAFE_URL = /^\/(api|auth)\/[A-Za-z0-9_\-./?=&%,:+]*$/;

export async function request(method, url, body, extraHeaders = {}) {
  if (!SAFE_URL.test(url) || url.includes('..') || url.includes('//')) throw new ApiError(400, 'Adresse de requête invalide', null);
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  // v3 : erreurs RFC 9457 (champ « detail ») ; les routes d'authentification gardent « message ».
  if (!res.ok) throw new ApiError(res.status, data?.detail || data?.message || `Erreur ${res.status}`, data);
  return data;
}

// Toute l'application parle à la v3 (la v1 est dépréciée).
const v3 = (path) => `/api/v3${path}`;

export const api = {
  get: (path) => request('GET', v3(path)),
  post: (path, body = {}) => request('POST', v3(path), body),
  patch: (path, body, headers) => request('PATCH', v3(path), body, headers),
  put: (path, body = {}) => request('PUT', v3(path), body),
  del: (path) => request('DELETE', v3(path)),
};

// Alias conservé pour les modules écrits avant la migration.
export const api3 = api;

// Parcourt une liste paginée par curseur (limite 200 par requête) et renvoie tous les éléments.
export async function listAll(path) {
  const items = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await api.get(`${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

// Flux d'événements temps réel (reconnexion automatique gérée par EventSource).
const EVENT_TYPES = ['page.created', 'page.updated', 'page.moved', 'page.trashed', 'page.restored', 'page.deleted', 'space.changed', 'presence', 'notification', 'page.permissions', 'page.labels', 'comment.created', 'comment.updated', 'comment.deleted'];

export function openEvents(onEvent) {
  const source = new EventSource(v3('/events'));
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      try { onEvent(type, JSON.parse(e.data)); } catch { /* message invalide ignoré */ }
    });
  }
  return () => source.close();
}

// Question à l'IA : réponse diffusée en SSE sur une requête POST.
export async function streamAsk(question, { onSources, onDelta, onError, onDone, signal }) {
  let res;
  try {
    res = await fetch(v3('/ai/ask'), {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ question }),
    });
  } catch {
    if (!signal?.aborted) onError?.('Connexion impossible');
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    onError?.(data.detail || data.message || `Erreur ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === 'sources') onSources?.(payload);
        else if (event === 'delta') onDelta?.(payload.text);
        else if (event === 'error') onError?.(payload.message);
        else if (event === 'done') onDone?.();
      }
    }
  } catch {
    if (!signal?.aborted) onError?.('Flux interrompu');
  }
}
