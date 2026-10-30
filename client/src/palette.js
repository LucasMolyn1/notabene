// Palette ⌘K : recherche plein texte (serveur) et onglet « Demander à l'IA ».
// Sert aussi à choisir une page à lier (mode « pick »).
import { h, esc, norm, debounce } from './util.js';
import { icon } from './icons.js';
import { pageIcon } from './ui.js';
import { store } from './store.js';
import { session } from './session.js';
import { streamAsk } from './api.js';

let current = null;

function highlightTitle(text, query) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return esc(text);
  const ntext = norm(text);
  const marks = new Array(text.length).fill(false);
  for (const t of terms) {
    let i = ntext.indexOf(t);
    while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = ntext.indexOf(t, i + t.length); }
  }
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
    out += esc(text[i]);
  }
  return open ? `${out}</mark>` : out;
}

// Le serveur balise les extraits avec \u0002…\u0003 : on échappe tout puis on pose <mark>.
// eslint-disable-next-line no-control-regex -- STX et ETX sont les balises posées par le serveur
const snippetHTML = (s) => esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');

function pathOf(page) {
  const space = store.space(page.spaceId);
  return [space ? space.name : '', ...store.ancestors(page.id).map((a) => a.title || 'Sans titre')]
    .filter(Boolean).join(' › ');
}

// Markdown minimal et sûr pour les réponses de l'IA : tout est échappé avant mise en forme.
function renderAnswer(text, sources) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2})\]/g, (m, n) => {
      const src = byN.get(Number(n));
      return src ? `<a class="cite" href="#/p/${src.id}" title="${esc(src.title)}">${n}</a>` : m;
    });
  const out = [];
  let list = null;
  for (const line of text.split('\n')) {
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      if (!list) { list = []; out.push(list); }
      list.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    list = null;
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) out.push(`<p><strong>${inline(head[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.map((b) => (Array.isArray(b) ? `<ul>${b.join('')}</ul>` : b)).join('');
}

/**
 * @param {{ mode?: 'search' | 'pick', onPick?: (page: any) => void, onOpen?: (page: any) => void, exclude?: string, tab?: 'search' | 'ai' }} [options]
 */
export function openPalette({ mode = 'search', onPick, onOpen, exclude, tab = 'search' } = {}) {
  current?.close();
  const aiAvailable = mode === 'search' && session.can('ai');
  let activeTab = aiAvailable ? tab : 'search';
  let results = [];
  let active = 0;
  let query = '';
  let requestSeq = 0;
  let askController = null;
  let spaceFilter = null; // null : tous les espaces
  const collapsed = new Set(); // espaces repliés dans les résultats

  const opener = /** @type {HTMLElement | null} */ (document.activeElement); // le focus y revient à la fermeture
  const input = h('input', {
    class: 'pal-input', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-label': 'Rechercher',
    'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'pal-list',
  });
  const list = h('div', { class: 'pal-list', role: 'listbox', id: 'pal-list', 'aria-label': 'Résultats' });
  // null (et non false) sans IA : `false?.querySelectorAll` lèverait une erreur et la palette ne s'ouvrirait pas correctement.
  const tabs = aiAvailable ? h('div', { class: 'pal-tabs' },
    h('button', { class: 'pal-tab', 'data-tab': 'search', onClick: () => switchTab('search') }, icon('search', 14), 'Rechercher'),
    h('button', { class: 'pal-tab', 'data-tab': 'ai', onClick: () => switchTab('ai') }, icon('sparkle', 14), 'Demander à l\'IA')) : null;
  const foot = h('div', { class: 'pal-foot' });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recherche' },
    h('div', { class: 'pal-head' }, icon('search', 18), input, h('kbd', null, 'Échap')),
    tabs,
    list,
    foot);
  const overlay = h('div', { class: 'overlay' }, box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);

  function switchTab(next) {
    if (activeTab !== next) input.value = '';
    activeTab = next;
    askController?.abort();
    tabs?.querySelectorAll('.pal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === next));
    input.placeholder = next === 'ai'
      ? 'Posez une question sur la documentation… (Entrée pour envoyer)'
      : mode === 'pick' ? 'Rechercher la page à lier…' : 'Rechercher dans toutes les pages…';
    foot.replaceChildren(...(next === 'ai'
      ? [h('span', null, h('kbd', null, '↵'), ' envoyer'), h('span', null, h('kbd', null, 'Tab'), ' recherche classique')]
      : [h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' naviguer'), h('span', null, h('kbd', null, '↵'), mode === 'pick' ? ' insérer' : ' ouvrir'),
        aiAvailable && h('span', null, h('kbd', null, 'Tab'), ' demander à l’IA')]).filter(Boolean));
    if (next === 'ai') renderAiIntro();
    else run();
    input.focus();
  }

  const runSearch = debounce(async (q, seq) => {
    try {
      const found = await store.search(q, spaceFilter);
      if (seq !== requestSeq) return;
      results = groupBySpace(found.filter((r) => r.id !== exclude).map((r) => ({ page: store.page(r.id) || r, snippet: r.snippet })));
    } catch {
      results = [];
    }
    active = 0;
    render();
  }, 180);

  function run() {
    query = input.value.trim();
    const seq = ++requestSeq;
    if (!query) {
      results = store.recent(null, 8).filter((p) => p.id !== exclude).map((page) => ({ page, snippet: '' }));
      active = 0;
      render();
      return;
    }
    runSearch(query, seq);
  }

  // Regroupe par espace (dans l'ordre du meilleur résultat de chacun) ; les pages d'un même espace restent classées par pertinence.
  function groupBySpace(items) {
    const order = [];
    for (const r of items) if (!order.includes(r.page.spaceId)) order.push(r.page.spaceId);
    return order.flatMap((id) => items.filter((r) => r.page.spaceId === id));
  }

  // Résultats navigables au clavier : ceux des espaces repliés sont exclus.
  const visible = () => results.filter((r) => !query || !collapsed.has(r.page.spaceId));

  function spaceFilters() {
    if (!query || store.spaces.length < 2) return null;
    const chip = (id, label) => h('button', {
      class: `chip${spaceFilter === id ? ' active' : ''}`, type: 'button', 'aria-pressed': String(spaceFilter === id),
      onClick: () => { spaceFilter = id; input.focus(); run(); },
    }, label);
    return h('div', { class: 'pal-spaces', role: 'group', 'aria-label': 'Limiter à un espace' },
      chip(null, 'Tous les espaces'), ...store.spaces.map((s) => chip(s.id, s.name)));
  }

  function render() {
    list.replaceChildren();
    const filters = spaceFilters();
    if (filters) list.append(filters);
    if (!results.length) {
      list.append(h('div', { class: 'pal-empty' }, query ? `Aucun résultat pour « ${query} »` : 'Aucune page pour le moment.'));
      return;
    }
    const shown = visible();
    list.append(h('div', { class: 'pal-section' }, query ? `${results.length} résultat${results.length > 1 ? 's' : ''}` : 'Modifiées récemment'));
    let lastSpace = null;
    results.forEach((r) => {
      const spaceId = r.page.spaceId;
      if (query && spaceId !== lastSpace) {
        lastSpace = spaceId;
        const open = !collapsed.has(spaceId);
        const count = results.filter((x) => x.page.spaceId === spaceId).length;
        list.append(h('button', {
          class: 'pal-group', type: 'button', 'aria-expanded': String(open),
          onClick: () => { if (open) collapsed.add(spaceId); else collapsed.delete(spaceId); active = 0; render(); },
        }, icon('chevron', 14), h('span', { class: 'grow' }, store.space(spaceId)?.name || 'Espace'), h('small', null, String(count))));
      }
      if (query && collapsed.has(spaceId)) return;
      const i = shown.indexOf(r);
      list.append(h('button', {
        class: `pal-item${i === active ? ' active' : ''}`,
        type: 'button',
        role: 'option',
        id: `pal-opt-${i}`,
        'aria-selected': String(i === active),
        tabindex: '-1',
        onMouseMove: () => { if (active !== i) { active = i; render(); } },
        onClick: () => choose(i),
      },
      h('span', { class: 'pal-icon' }, pageIcon(r.page.icon)),
      h('span', { class: 'pal-text' },
        h('span', { class: 'pal-title', html: highlightTitle(r.page.title || 'Sans titre', query) }),
        h('span', { class: 'pal-path' }, pathOf(r.page)),
        r.snippet ? h('span', { class: 'pal-snippet', html: snippetHTML(r.snippet) }) : null)));
    });
    list.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' });
    if (shown.length) input.setAttribute('aria-activedescendant', `pal-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function choose(i) {
    const r = visible()[i];
    if (!r) return;
    close();
    if (mode === 'pick') onPick?.(r.page);
    else onOpen?.(r.page);
  }

  function renderAiIntro() {
    list.replaceChildren(h('div', { class: 'ai-intro' },
      h('div', { class: 'ai-badge' }, icon('sparkle', 24)),
      h('p', null, 'Posez une question en langage naturel : l’IA répond à partir des pages auxquelles vous avez accès, en citant ses sources.'),
      h('div', { class: 'ai-examples' }, ['Comment se connecter avec Authentik ?', 'Comment créer un jeton d’API ?', 'Quels diagrammes sont disponibles ?']
        .map((q) => h('button', { class: 'chip', onClick: () => { input.value = q; ask(); } }, q)))));
  }

  function ask() {
    const question = input.value.trim();
    if (question.length < 3) return;
    askController?.abort();
    askController = new AbortController();
    let text = '';
    let sources = [];
    const answer = h('div', { class: 'ai-answer prose' }, h('p', { class: 'ai-thinking' }, 'Recherche dans la documentation…'));
    const sourceList = h('div', { class: 'ai-sources' });
    list.replaceChildren(h('div', { class: 'ai-question' }, question), answer, sourceList);
    // eslint-disable-next-line no-unsanitized/property -- renderAnswer échappe tout le texte avant de poser ses balises
    const paint = () => { answer.innerHTML = renderAnswer(text, sources); };
    streamAsk(question, {
      signal: askController.signal,
      onSources: (s) => {
        sources = s;
        sourceList.replaceChildren(...(s.length
          ? [h('div', { class: 'pal-section' }, 'Sources'), ...s.map((src) => h('a', { class: 'ai-source', href: `#/p/${src.id}`, onClick: () => close() },
            h('span', { class: 'cite' }, String(src.n)), h('span', null, src.title)))]
          : [h('p', { class: 'hint' }, 'Aucune page pertinente trouvée.')]));
      },
      onDelta: (chunk) => { text += chunk; paint(); },
      onError: (message) => answer.replaceChildren(h('div', { class: 'notice warning' }, message)),
      onDone: () => { if (!text) answer.replaceChildren(h('p', { class: 'muted' }, 'Pas de réponse.')); },
    });
  }

  function close() {
    askController?.abort();
    overlay.remove();
    current = null;
    if (opener?.isConnected) opener.focus();
  }

  input.addEventListener('input', () => { if (activeTab === 'search') run(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab' && aiAvailable) { e.preventDefault(); switchTab(activeTab === 'ai' ? 'search' : 'ai'); return; }
    if (activeTab === 'ai') {
      if (e.key === 'Enter') { e.preventDefault(); ask(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, visible().length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  });

  switchTab(activeTab);
  current = { close };
}
