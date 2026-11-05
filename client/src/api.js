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

/**
 * Envoi d'un fichier (multipart, un seul champ « file ») avec suivi de progression et annulation.
 * XMLHttpRequest plutôt que fetch : seul lui expose la progression de l'envoi.
 * @param {string} path chemin v3 (par exemple « /pages/<id>/attachments »)
 * @param {File} file
 * @param {{ onProgress?: (ratio: number) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export function upload(path, file, options = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  return sendBody(path, form, options);
}

/**
 * Envoi d'un corps brut (par exemple une archive ZIP en application/zip), avec progression et annulation.
 * @param {string} path chemin v3, paramètres de requête compris
 * @param {Blob} blob
 * @param {{ contentType: string, onProgress?: (ratio: number) => void, onSent?: () => void, signal?: AbortSignal }} options
 * @returns {Promise<any>}
 */
export function uploadRaw(path, blob, options) {
  return sendBody(path, blob, options);
}

/**
 * @param {string} path
 * @param {FormData | Blob} body
 * @param {{ contentType?: string, onProgress?: (ratio: number) => void, onSent?: () => void, signal?: AbortSignal }} options
 * @returns {Promise<any>}
 */
function sendBody(path, body, { contentType, onProgress, onSent, signal } = {}) {
  const url = v3(path);
  if (!SAFE_URL.test(url) || url.includes('..') || url.includes('//')) return Promise.reject(new ApiError(400, 'Adresse de requête invalide', null));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.open('POST', url);
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total); });
    xhr.upload.addEventListener('load', () => onSent?.());
    xhr.addEventListener('load', () => {
      done();
      let data;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.detail || data?.message || `Erreur ${xhr.status}`, data));
    });
    xhr.addEventListener('error', () => { done(); reject(new ApiError(0, 'Connexion interrompue', null)); });
    xhr.addEventListener('abort', () => { done(); reject(new ApiError(0, 'Envoi annulé', { aborted: true })); });
    if (signal?.aborted) { reject(new ApiError(0, 'Envoi annulé', { aborted: true })); return; }
    signal?.addEventListener('abort', abort);
    xhr.send(body);
  });
}

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
const EVENT_TYPES = ['page.created', 'page.updated', 'page.moved', 'page.trashed', 'page.restored', 'page.deleted', 'space.changed', 'presence', 'notification', 'page.permissions', 'page.labels', 'base.changed', 'comment.created', 'comment.updated', 'comment.deleted'];

export function openEvents(onEvent) {
  const source = new EventSource(v3('/events'));
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      try { onEvent(type, JSON.parse(e.data)); } catch { /* message invalide ignoré */ }
    });
  }
  return () => source.close();
}

// Réponse de l'IA diffusée en SSE sur une requête POST (questions, assistant de rédaction).
export const streamAsk = (question, handlers) => streamSse('/ai/ask', { question }, handlers);
export const streamAssist = (body, handlers) => streamSse('/ai/assist', body, handlers);

async function streamSse(path, body, { onSources, onDelta, onNotice, onError, onDone, signal }) {
  let res;
  try {
    res = await fetch(v3(path), {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(body),
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
        else if (event === 'notice') onNotice?.(payload.message);
        else if (event === 'error') onError?.(payload.message);
        else if (event === 'done') onDone?.();
      }
    }
  } catch {
    if (!signal?.aborted) onError?.('Flux interrompu');
  }
}
