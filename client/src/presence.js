// Présence : signale au serveur la page consultée et reçoit la liste des présents (SSE).
import { api } from './api.js';
import { uid } from './util.js';

const COLORS = ['#c74c0a', '#278439', '#1971c2', '#c2255c', '#7048e8', '#0b7f92', '#b35c00', '#50820b'];
const tabId = uid() + uid();
const listeners = new Set();
let peers = [];
let pageId = null;
let enabled = false;
let lastEdit = 0;
let timer = null;

export const colorFor = (id) => COLORS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];

function send(editing = false) {
  if (!enabled) return;
  api.post('/presence', { tabId, pageId, editing }).catch(() => {});
}

export const presence = {
  enable(userId) {
    enabled = true;
    this.ownKey = `${userId}:${tabId}`;
    clearInterval(timer);
    timer = setInterval(() => send(), 15_000);
    window.addEventListener('pagehide', () => { pageId = null; send(); });
  },
  setPage(id) {
    if (pageId === id) return;
    pageId = id;
    send();
  },
  touch() {
    const now = Date.now();
    if (now - lastEdit > 3000) { lastEdit = now; send(true); }
  },
  receive(list) {
    peers = Array.isArray(list) ? list : [];
    for (const fn of listeners) fn();
  },
  peersOn(id) {
    return peers.filter((p) => p.pageId === id && p.key !== this.ownKey);
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
