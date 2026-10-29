export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export function debounce(fn, ms) {
  let timer = null;
  let args = [];
  const d = (...a) => {
    args = a;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  d.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  d.cancel = () => { clearTimeout(timer); timer = null; };
  d.pending = () => timer !== null;
  return d;
}

// Mini hyperscript : h('div', { class: 'x', onClick }, ...enfants)
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), val);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === 'boolean') el.toggleAttribute(k, v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minuscule et sans accents : sert à la recherche insensible aux accents.
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

export function docText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return ' ';
  const sep = TEXT_BLOCKS.has(node.type) ? '' : ' ';
  const out = (node.content || []).map(docText).join(sep);
  return node.type === 'doc' ? out.replace(/\s+/g, ' ').trim() : out;
}

export const wordCount = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) || []).length;

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const UNITS = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2592000], ['year', 31536000]];

export function timeAgo(ts) {
  const s = (ts - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return 'à l’instant';
  let unit = 'minute';
  let value = s / 60;
  for (const [name, sec] of UNITS) if (abs >= sec) { unit = name; value = s / sec; }
  return rtf.format(Math.round(value), unit);
}

export const fullDate = (ts) => new Date(ts).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';

export function download(filename, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl ';

export const initials = (name) => String(name).split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] || '').join('').slice(0, 2).toUpperCase();
