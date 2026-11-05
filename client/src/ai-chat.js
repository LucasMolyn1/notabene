// Assistant conversationnel : panneau latéral à droite, avec historique des conversations.
// Texte de la personne et titres : textContent. Réponse du modèle : uniquement via renderAnswer (tout est échappé).
import { h, timeAgo, fullDate } from './util.js';
import { icon } from './icons.js';
import { api, streamChat } from './api.js';
import { session } from './session.js';
import { app } from './prefs.js';
import { store } from './store.js';
import { pagePath, parseRoute } from './urls.js';
import { confirmModal, toast } from './ui.js';
import { renderAnswer } from './ai-markdown.js';

const MAX_MESSAGE = 4000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DISCLAIMER = 'Les réponses viennent d’un modèle d’IA et peuvent être inexactes. Le contenu des pages que vous pouvez lire peut être envoyé au fournisseur choisi par votre administrateur. L’historique est gardé 90 jours (réglage de l’instance) et supprimable ici.';

// Messages lisibles pour les refus connus du serveur.
const ERRORS = {
  503: 'L’assistant n’est pas disponible : l’IA n’est pas configurée sur cette instance.',
  429: 'Trop de demandes en peu de temps. Patientez un instant avant de réessayer.',
  409: 'Cette conversation a atteint sa limite de messages. Commencez une nouvelle conversation.',
};

const launchers = new Set();
let panel = null; // construit à la première ouverture

const available = () => !!session.user && !app.embed && session.can('ai');
const openPageId = () => { const r = parseRoute(location.pathname); return r.kind === 'page' ? r.id : null; };
const toTs = (v) => (typeof v === 'number' ? v : Date.parse(v) || Date.now());
const narrow = () => window.matchMedia('(max-width: 640px)').matches;

function syncLaunchers() {
  const open = !!panel && !panel.el.hidden;
  for (const b of [...launchers]) {
    if (!b.isConnected) { launchers.delete(b); continue; }
    b.setAttribute('aria-expanded', String(open));
    b.classList.toggle('on', open);
  }
}

/** Bouton de la barre du haut ; null si la personne ne peut pas utiliser l'IA. */
export function assistantButton() {
  if (!available()) return null;
  const b = h('button', {
    class: 'icon-btn ai-chat-launcher', type: 'button', title: 'Assistant (Alt I)', 'aria-label': 'Assistant',
    'aria-controls': 'ai-chat', 'aria-expanded': 'false', onClick: () => toggleChat(),
  }, icon('sparkle'));
  launchers.add(b);
  queueMicrotask(syncLaunchers);
  return b;
}

export function toggleChat() {
  if (!available()) return;
  if (panel && !panel.el.hidden) panel.close();
  else openChat();
}

export function openChat() {
  if (!available()) return;
  panel ??= buildPanel();
  panel.open();
}

function buildPanel() {
  let opener = null;
  let conversation = null; // { id, title } de la conversation affichée
  let controller = null;
  let view = 'chat';

  const titleEl = h('h2', { id: 'ai-chat-title', class: 'ai-chat-title' }, 'Assistant');
  const historyBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Conversations récentes', 'aria-label': 'Conversations récentes', 'aria-pressed': 'false', onClick: () => showView(view === 'history' ? 'chat' : 'history') }, icon('history'));
  const newBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Nouvelle conversation', 'aria-label': 'Nouvelle conversation', onClick: () => newConversation() }, icon('plus'));
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Fermer (Échap)', 'aria-label': 'Fermer l’assistant', onClick: () => close() }, icon('x'));

  // -- Conversation --
  const log = h('div', { class: 'ai-chat-log', role: 'group', 'aria-label': 'Conversation', tabindex: '0' });
  // Pas de zone « live » : la réponse est réécrite à chaque morceau reçu et certains lecteurs d'écran la reliraient en boucle. L'état
  // (en cours, terminée, interrompue) est annoncé par le `role=status` ci-dessous, la réponse se lit ensuite dans le groupe.
  const input = h('textarea', {
    class: 'input ai-chat-input', id: 'ai-chat-input', rows: '3', maxlength: String(MAX_MESSAGE),
    placeholder: 'Posez une question sur la documentation…', 'aria-describedby': 'ai-chat-count ai-chat-keys',
  });
  const count = h('span', { class: 'ai-chat-count', id: 'ai-chat-count' });
  const ctxBox = h('input', { type: 'checkbox', id: 'ai-chat-ctx' });
  ctxBox.checked = true;
  const ctxName = h('span', { class: 'ai-chat-ctx-name' });
  const ctxRow = h('div', { class: 'ai-chat-ctx' }, ctxBox, h('label', { for: 'ai-chat-ctx' }, 'Utiliser la page ouverte comme contexte', ctxName));
  const sendBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Envoyer');
  const stopBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true, onClick: () => { controller?.abort(); input.focus(); } }, 'Arrêter');
  const status = h('p', { class: 'ai-chat-status', role: 'status' });
  const form = h('form', { class: 'ai-chat-form', 'aria-label': 'Nouveau message' },
    h('label', { class: 'sr-only', for: 'ai-chat-input' }, 'Votre message'),
    input,
    h('div', { class: 'ai-chat-row' }, h('span', { class: 'hint', id: 'ai-chat-keys' }, 'Entrée pour envoyer, Maj+Entrée pour aller à la ligne.'), count),
    ctxRow,
    h('div', { class: 'ai-chat-row' }, status, h('span', { class: 'ai-chat-actions' }, stopBtn, sendBtn)),
    h('p', { class: 'hint ai-chat-disclaimer' }, DISCLAIMER));
  const chatView = h('div', { class: 'ai-chat-view' }, log, form);

  // -- Historique --
  const historyList = h('ul', { class: 'ai-chat-history', 'aria-label': 'Conversations récentes' });
  const clearBtn = h('button', { class: 'btn btn-ghost btn-sm danger-text', type: 'button', onClick: () => clearAll() }, 'Tout supprimer');
  const historyView = h('div', { class: 'ai-chat-view ai-chat-history-view', hidden: true },
    h('div', { class: 'ai-chat-row' }, h('h3', { class: 'ai-chat-sub' }, 'Conversations récentes'), clearBtn),
    historyList,
    h('p', { class: 'hint ai-chat-disclaimer' }, DISCLAIMER));

  const el = h('section', { class: 'ai-chat', id: 'ai-chat', role: 'dialog', 'aria-labelledby': 'ai-chat-title', hidden: true },
    h('header', { class: 'ai-chat-head' }, icon('sparkle'), titleEl, h('span', { class: 'ai-chat-tools' }, historyBtn, newBtn, closeBtn)),
    chatView, historyView);
  document.body.append(el);

  const setCount = () => {
    const n = input.value.length;
    count.textContent = `${n} / ${MAX_MESSAGE}`;
    count.classList.toggle('full', n >= MAX_MESSAGE);
  };
  input.addEventListener('input', setCount);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); }
  });

  // Case de contexte : visible seulement quand une page est affichée, cochée par défaut à chaque nouvelle page.
  let ctxPage = null;
  function syncContext() {
    const id = openPageId();
    if (id !== ctxPage) { ctxPage = id; ctxBox.checked = !!id; }
    ctxRow.hidden = !id;
    const title = id ? store.page(id)?.title : '';
    ctxName.textContent = title ? ` (« ${title} »)` : '';
  }
  window.addEventListener('navigate', syncContext);
  window.addEventListener('popstate', syncContext);

  function setTitle() { titleEl.textContent = conversation?.title || 'Assistant'; }

  function showView(next) {
    view = next;
    chatView.hidden = next !== 'chat';
    historyView.hidden = next !== 'history';
    historyBtn.setAttribute('aria-pressed', String(next === 'history'));
    if (next === 'history') { loadHistory(); historyBtn.focus(); } else input.focus();
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    stopBtn.hidden = !busy;
    log.setAttribute('aria-busy', String(busy));
    if (!busy && document.activeElement === stopBtn) input.focus();
  }

  function emptyState() {
    log.replaceChildren(h('div', { class: 'ai-chat-empty' },
      h('p', null, 'Posez une question : l’assistant répond à partir des pages auxquelles vous avez accès et cite ses sources.')));
  }

  const numbered = (sources) => (Array.isArray(sources) ? sources : []).map((s, i) => ({ ...s, n: Number.isInteger(s.n) ? s.n : i + 1 }));

  function sourcesEl(sources) {
    const valid = sources.filter((s) => SAFE_ID.test(String(s.id)));
    if (!valid.length) return null;
    return h('nav', { class: 'ai-chat-sources', 'aria-label': 'Sources' },
      h('span', { class: 'ai-chat-sources-head' }, 'Sources'),
      h('ul', null, valid.map((s) => h('li', null, h('a', {
        class: 'ai-source', href: pagePath(s), onClick: () => { if (narrow()) close(false); },
      }, h('span', { class: 'cite', 'aria-hidden': 'true' }, String(s.n)), h('span', null, s.title || 'Sans titre'))))));
  }

  function userBubble(text) {
    return h('div', { class: 'ai-msg ai-msg-user' }, h('span', { class: 'sr-only' }, 'Vous : '), h('div', { class: 'ai-msg-text' }, text));
  }

  // Bulle de réponse : le corps n'est écrit qu'à partir de renderAnswer, qui échappe tout le texte du modèle.
  function answerBubble() {
    const body = h('div', { class: 'ai-msg-body prose' });
    const foot = h('div', { class: 'ai-msg-foot' });
    const bubble = h('div', { class: 'ai-msg ai-msg-assistant' }, h('span', { class: 'sr-only' }, 'Assistant : '), body, foot);
    return {
      bubble,
      // eslint-disable-next-line no-unsanitized/property -- renderAnswer échappe tout le texte avant de poser ses balises
      paint(text, sources) { body.innerHTML = renderAnswer(text, sources); },
      thinking() { body.replaceChildren(h('p', { class: 'ai-thinking' }, 'Recherche dans la documentation…')); },
      sources(sources) { foot.replaceChildren(...[sourcesEl(sources)].filter(Boolean)); },
      note(text) { foot.append(h('p', { class: 'hint' }, text)); },
      error(message, action) {
        bubble.append(h('div', { class: 'notice warning', role: 'alert' }, message, action ? [' ', action] : null));
      },
    };
  }

  // Arrêt du flux en cours quand on change de conversation : l'interface redevient disponible tout de suite.
  function stopStream() {
    if (!controller) return;
    controller.abort();
    controller = null;
    setBusy(false);
  }

  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  async function send() {
    const message = input.value.trim();
    if (!message || (controller && !controller.signal.aborted)) return;
    if (message.length > MAX_MESSAGE) { status.textContent = `Message trop long (${MAX_MESSAGE} caractères au plus).`; return; }
    if (log.querySelector('.ai-chat-empty')) log.replaceChildren();
    const pageId = !ctxRow.hidden && ctxBox.checked ? openPageId() : null;
    log.append(userBubble(message));
    const answer = answerBubble();
    answer.thinking();
    log.append(answer.bubble);
    scrollDown();
    input.value = '';
    setCount();
    status.textContent = 'Réponse en cours…';
    const own = new AbortController();
    controller = own;
    const { signal } = own;
    setBusy(true);
    let text = '';
    let sources = [];
    let failed = false;
    await streamChat({ message, ...(conversation?.id ? { conversationId: conversation.id } : {}), ...(pageId ? { pageId } : {}) }, {
      signal,
      onConversation: (c) => {
        if (c && SAFE_ID.test(String(c.id))) { conversation = { id: c.id, title: c.title || '' }; setTitle(); }
      },
      onSources: (s) => { sources = numbered(s); answer.sources(sources); },
      onDelta: (chunk) => { text += chunk; answer.paint(text, sources); scrollDown(); },
      onNotice: (m) => answer.note(m),
      onError: (m, code) => {
        failed = true;
        if (!text) answer.paint('', sources);
        const action = code === 409 ? h('button', { class: 'link-btn', type: 'button', onClick: () => newConversation() }, 'Nouvelle conversation') : null;
        answer.error(ERRORS[code] || m || 'Une erreur est survenue.', action);
        // Rien n'a été traité : le message revient dans la zone de saisie pour un nouvel essai.
        if (code && !input.value) { input.value = message; setCount(); }
      },
      onDone: () => { if (!text && !failed) answer.paint('Pas de réponse.', []); },
    });
    if (signal.aborted) {
      if (!text) answer.paint('', sources);
      answer.note('Réponse interrompue.');
    }
    if (controller !== own) return; // une autre conversation a pris la main entre-temps
    controller = null;
    status.textContent = failed ? 'Échec de l’envoi.' : signal.aborted ? 'Réponse interrompue.' : 'Réponse terminée.';
    setBusy(false);
    scrollDown();
  }

  function newConversation() {
    stopStream();
    conversation = null;
    setTitle();
    emptyState();
    status.textContent = '';
    showView('chat');
  }

  async function openConversation(id) {
    if (!SAFE_ID.test(String(id))) return;
    stopStream();
    let data;
    try {
      data = await api.get(`/ai/conversations/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(err?.status === 404 ? 'Cette conversation n’existe plus.' : err?.message || 'Conversation introuvable.', { kind: 'error' });
      loadHistory();
      return;
    }
    if (!SAFE_ID.test(String(data.id))) return;
    conversation = { id: data.id, title: data.title || '' };
    setTitle();
    log.replaceChildren();
    for (const m of data.messages || []) {
      if (m.role === 'user') log.append(userBubble(m.content));
      else {
        const a = answerBubble();
        const src = numbered(m.sources);
        a.paint(m.content || '', src);
        a.sources(src);
        log.append(a.bubble);
      }
    }
    if (!log.childElementCount) emptyState();
    status.textContent = '';
    showView('chat');
    scrollDown();
  }

  async function loadHistory() {
    historyList.replaceChildren(h('li', { class: 'muted' }, 'Chargement…'));
    let items;
    try {
      items = (await api.get('/ai/conversations?limit=50')).items || [];
    } catch (err) {
      historyList.replaceChildren(h('li', { class: 'notice warning', role: 'alert' }, ERRORS[err?.status] || err?.message || 'Impossible de charger l’historique.'));
      clearBtn.disabled = true;
      return;
    }
    clearBtn.disabled = !items.length;
    if (!items.length) { historyList.replaceChildren(h('li', { class: 'muted' }, 'Aucune conversation pour le moment.')); return; }
    historyList.replaceChildren(...items.filter((c) => SAFE_ID.test(String(c.id))).map((c) => {
      const title = c.title || 'Sans titre';
      const ts = toTs(c.updatedAt ?? c.createdAt);
      return h('li', { class: `ai-conv${conversation?.id === c.id ? ' current' : ''}` },
        h('button', { class: 'ai-conv-open', type: 'button', onClick: () => openConversation(c.id) },
          h('span', { class: 'ai-conv-title' }, title),
          h('small', { title: fullDate(ts) }, `${timeAgo(ts)} · ${c.messageCount ?? 0} message${(c.messageCount ?? 0) > 1 ? 's' : ''}`)),
        h('button', { class: 'icon-btn danger', type: 'button', title: 'Supprimer', 'aria-label': `Supprimer la conversation « ${title} »`, onClick: () => remove(c.id, title) }, icon('trash')));
    }));
  }

  async function remove(id, title) {
    const ok = await confirmModal({ title: 'Supprimer la conversation', message: `La conversation « ${title} » sera supprimée définitivement.`, confirm: 'Supprimer', danger: true });
    if (!ok) { historyBtn.focus(); return; }
    try {
      await api.del(`/ai/conversations/${encodeURIComponent(id)}`);
      toast('Conversation supprimée.');
      if (conversation?.id === id) { conversation = null; setTitle(); emptyState(); }
    } catch (err) {
      toast(err?.message || 'Suppression impossible.', { kind: 'error' });
    }
    await loadHistory();
    historyBtn.focus();
  }

  async function clearAll() {
    const ok = await confirmModal({ title: 'Supprimer tout l’historique', message: 'Toutes vos conversations avec l’assistant seront supprimées définitivement.', confirm: 'Tout supprimer', danger: true });
    if (!ok) { clearBtn.focus(); return; }
    try {
      const res = await api.del('/ai/conversations');
      const n = res?.deleted ?? 0;
      toast(n ? `${n} conversation${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''}.` : 'Aucune conversation à supprimer.');
      conversation = null;
      setTitle();
      emptyState();
    } catch (err) {
      toast(err?.message || 'Suppression impossible.', { kind: 'error' });
    }
    await loadHistory();
    historyBtn.focus();
  }

  function open() {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && !el.contains(active) ? active : null;
    syncContext();
    el.hidden = false;
    document.body.classList.add('ai-chat-open');
    // Plein écran sur téléphone : le reste de l'application devient inerte.
    if (narrow()) document.getElementById('app')?.setAttribute('inert', '');
    syncLaunchers();
    if (view === 'history') loadHistory();
    (view === 'chat' ? input : historyBtn).focus();
  }

  function close(restoreFocus = true) {
    el.hidden = true;
    document.body.classList.remove('ai-chat-open');
    document.getElementById('app')?.removeAttribute('inert');
    syncLaunchers();
    if (!restoreFocus) return;
    const back = opener?.isConnected ? opener : [...launchers].find((b) => b.isConnected);
    back?.focus();
  }

  // Redimensionnement fenêtre ouverte : le reste de l'application est inerte seulement en plein écran.
  window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
    if (el.hidden) return;
    const app = document.getElementById('app');
    if (narrow()) app?.setAttribute('inert', ''); else app?.removeAttribute('inert');
  });

  emptyState();
  setCount();
  return { el, open, close };
}
