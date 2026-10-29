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

export async function request(method, url, body) {
  const headers = {};
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
  if (!res.ok) throw new ApiError(res.status, data?.message || `Erreur ${res.status}`, data);
  return data;
}

const v1 = (path) => `/api/v1${path}`;

export const api = {
  get: (path) => request('GET', v1(path)),
  post: (path, body = {}) => request('POST', v1(path), body),
  patch: (path, body) => request('PATCH', v1(path), body),
  put: (path, body = {}) => request('PUT', v1(path), body),
  del: (path) => request('DELETE', v1(path)),
};

// Flux d'événements temps réel (reconnexion automatique gérée par EventSource).
const EVENT_TYPES = ['page.created', 'page.updated', 'page.moved', 'page.trashed', 'page.restored', 'page.deleted', 'space.changed', 'presence'];

export function openEvents(onEvent) {
  const source = new EventSource(v1('/events'));
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
    res = await fetch(v1('/ai/ask'), {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ question }),
    });
  } catch (err) {
    if (!signal?.aborted) onError?.('Connexion impossible');
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    onError?.(data.message || `Erreur ${res.status}`);
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
