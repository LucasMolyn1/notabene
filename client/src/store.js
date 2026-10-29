// Cache local de l'arborescence (métadonnées des pages et espaces), alimenté par l'API.
// Les lectures sont synchrones sur le cache ; les écritures passent par l'API puis
// mettent le cache à jour. Les contenus de pages sont chargés à la demande.
import { api } from './api.js';

const listeners = new Set();
const state = { spaces: [], pages: new Map() };

const emit = (evt) => { for (const fn of [...listeners]) fn(evt); };
const byPosition = (a, b) => (a.position - b.position) || (a.createdAt - b.createdAt);
const all = () => [...state.pages.values()];
const setMeta = (meta) => {
  const { content: _content, ...rest } = meta;
  state.pages.set(meta.id, { ...state.pages.get(meta.id), ...rest });
};

let refreshTimer = null;

export const store = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async load() {
    const [spaces, pages] = await Promise.all([api.get('/spaces'), api.get('/pages')]);
    state.spaces = spaces;
    state.pages = new Map(pages.map((p) => [p.id, p]));
    emit({ type: 'load' });
  },

  // Rechargement groupé après des événements distants.
  scheduleRefresh(evt) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        await store.load();
        emit({ ...evt, event: evt?.type, type: 'remote' });
      } catch { /* réseau : on réessaiera au prochain événement */ }
    }, 250);
  },

  // ---- Lecture (cache) --------------------------------------------------
  get spaces() { return state.spaces; },
  space: (id) => state.spaces.find((s) => s.id === id) || null,
  page: (id) => state.pages.get(id) || null,
  pagesIn: (spaceId) => all().filter((p) => p.spaceId === spaceId),
  children: (spaceId, parentId = null) => all().filter((p) => p.spaceId === spaceId && (p.parentId || null) === parentId).sort(byPosition),

  ancestors(id) {
    const out = [];
    const seen = new Set();
    let p = state.pages.get(id);
    while (p?.parentId && !seen.has(p.parentId)) {
      seen.add(p.parentId);
      p = state.pages.get(p.parentId);
      if (p) out.unshift(p);
    }
    return out;
  },

  descendants(id) {
    const out = [];
    const walk = (pid) => { for (const p of all()) if (p.parentId === pid) { out.push(p); walk(p.id); } };
    walk(id);
    return out;
  },

  isDescendant: (id, ancestorId) => store.ancestors(id).some((a) => a.id === ancestorId),
  favorites: () => all().filter((p) => p.favorite).sort((a, b) => a.title.localeCompare(b.title)),
  recent: (spaceId = null, limit = 8) => all().filter((p) => !spaceId || p.spaceId === spaceId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),

  // ---- Pages ------------------------------------------------------------
  async fetchPage(id) {
    const page = await api.get(`/pages/${id}`);
    setMeta(page);
    return page;
  },

  async createPage({ spaceId, parentId = null, title = '', icon = '', content, afterId } = {}) {
    const page = await api.post('/pages', { spaceId, parentId, title, icon, ...(content ? { content } : {}), ...(afterId ? { afterId } : {}) });
    setMeta(page);
    emit({ type: 'page', id: page.id, source: 'create' });
    return page.id;
  },

  async updatePage(id, patch) {
    const meta = await api.patch(`/pages/${id}`, patch);
    setMeta(meta);
    emit({ type: 'page', id, source: 'local' });
    return meta;
  },

  async movePage(id, parentId, index, spaceId) {
    const page = state.pages.get(id);
    if (!page) return;
    // Mise à jour optimiste, annulée par un rechargement en cas d'erreur.
    const target = spaceId || page.spaceId;
    const siblings = store.children(target, parentId).filter((p) => p.id !== id);
    siblings.splice(Math.min(index ?? siblings.length, siblings.length), 0, page);
    siblings.forEach((p, i) => { p.position = i; });
    page.parentId = parentId;
    if (spaceId && spaceId !== page.spaceId) for (const p of [page, ...store.descendants(id)]) p.spaceId = spaceId;
    emit({ type: 'move', id });
    try {
      setMeta(await api.post(`/pages/${id}/move`, { parentId, index, ...(spaceId ? { spaceId } : {}) }));
    } catch (err) {
      await store.load();
      throw err;
    }
  },

  async duplicatePage(id) {
    const meta = await api.post(`/pages/${id}/duplicate`);
    await store.load();
    return meta.id;
  },

  async trashPage(id) {
    await api.del(`/pages/${id}`);
    for (const p of [state.pages.get(id), ...store.descendants(id)]) if (p) state.pages.delete(p.id);
    emit({ type: 'trash', id });
  },

  async restorePage(id) {
    await api.post(`/pages/${id}/restore`);
    await store.load();
  },

  trashed: () => api.get('/trash'),
  destroyPage: (id) => api.del(`/pages/${id}/permanent`),
  emptyTrash: () => api.del('/trash'),

  async toggleFavorite(id) {
    const page = state.pages.get(id);
    if (!page) return;
    await (page.favorite ? api.del(`/pages/${id}/favorite`) : api.put(`/pages/${id}/favorite`));
    page.favorite = !page.favorite;
    emit({ type: 'page', id, source: 'meta' });
  },

  versions: (id) => api.get(`/pages/${id}/versions`),
  version: (id, versionId) => api.get(`/pages/${id}/versions/${versionId}`),
  async restoreVersion(id, versionId) {
    const meta = await api.post(`/pages/${id}/versions/${versionId}/restore`);
    setMeta(meta);
    emit({ type: 'page', id, source: 'restore' });
    return meta;
  },

  search: (q) => api.get(`/search?q=${encodeURIComponent(q)}&limit=20`),

  // ---- Espaces ----------------------------------------------------------
  async createSpace(input) {
    const space = await api.post('/spaces', input);
    state.spaces.push(space);
    emit({ type: 'space', id: space.id });
    return space.id;
  },

  async updateSpace(id, patch) {
    const space = await api.patch(`/spaces/${id}`, patch);
    state.spaces = state.spaces.map((s) => (s.id === id ? space : s));
    emit({ type: 'space', id });
  },

  async deleteSpace(id) {
    await api.del(`/spaces/${id}`);
    await store.load();
  },
};
