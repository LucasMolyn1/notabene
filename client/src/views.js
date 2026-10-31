// Vues principales : page (éditeur), accueil d'espace, connexion, page introuvable.
import { h, timeAgo, fullDate, wordCount, debounce, modKey } from './util.js';
import { pagePath, spacePath } from './urls.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, app } from './prefs.js';
import { createEditor } from './editor.js';
import { connectCollab } from './collab.js';
import { presence, colorFor } from './presence.js';
import { avatarEl } from './avatar.js';
import { openMenu, openModal, toast, pageIcon } from './ui.js';
import { openPalette } from './palette.js';
import { forgotPasswordForm, ldapLoginForm, localLoginForm } from './local-auth.js';
import { bellButton, watchButton } from './notifications.js';
import { bindAnchors, commentsButton, openComments } from './comments.js';
import { openAssistant } from './assistant.js';
import { rememberMentionNames } from './editor/mention.js';
import { labelBar } from './labels.js';
import { api, listAll } from './api.js';
import { permissionsButton } from './permissions.js';
import * as A from './actions.js';

const main = () => document.getElementById('main');
let view = null;
let navSeq = 0;

export const notifyStore = (evt) => view?.onStore?.(evt);

function teardown() {
  const v = view;
  view = null;
  v?.destroy?.();
}

// Pour les vues définies hors de ce module (page Paramètres).
export function beginView() {
  teardown();
  ++navSeq;
  presence.setPage(null);
}
export function setView(v) { view = v; }

export function topbar(left, right = []) {
  return h('header', { class: 'topbar' },
    !app.embed && h('button', { class: 'icon-btn sb-open', title: `Barre latérale (${modKey}\\)`, onClick: A.toggleSidebar }, icon('panel')),
    left,
    h('div', { class: 'topbar-right' }, right, !app.embed && bellButton()));
}

function crumbsFor(page) {
  const space = store.space(page.spaceId);
  const parts = [
    space && h('a', { class: 'crumb', href: spacePath(space) }, h('span', { class: 'crumb-ico' }, pageIcon(space.icon || 'folder', 14)), space.name),
    ...store.ancestors(page.id).map((a) => h('a', { class: 'crumb', href: pagePath(a) }, a.icon && h('span', { class: 'crumb-ico' }, pageIcon(a.icon, 14)), a.title || 'Sans titre')),
    h('span', { class: 'crumb current' }, page.icon && h('span', { class: 'crumb-ico' }, pageIcon(page.icon, 14)), page.title || 'Sans titre'),
  ].filter(Boolean);
  return parts.flatMap((p, i) => (i ? [h('span', { class: 'crumb-sep' }, '/'), p] : [p]));
}


// Remplace l'adresse affichée par sa forme lisible, sans nouvelle entrée d'historique.
function tidyAddress(path) {
  if (location.pathname !== path) history.replaceState(null, '', path + (app.embed ? '?embed' : ''));
}

const narrow = () => window.matchMedia('(max-width: 640px)').matches;

function loading() {
  main().replaceChildren(topbar(h('nav', { class: 'crumbs' })), h('div', { class: 'scroller' }, h('div', { class: 'page-wrap' }, h('div', { class: 'skeleton' },
    h('div', { class: 'sk sk-title' }), h('div', { class: 'sk' }), h('div', { class: 'sk' }), h('div', { class: 'sk sk-short' })))));
}

// ---- Page -----------------------------------------------------------------

export async function showPage(id) {
  if (view?.kind === 'page' && view.id === id) return;
  teardown();
  const seq = ++navSeq;
  loading();
  let page;
  try {
    page = await store.fetchPage(id);
  } catch (err) {
    if (seq === navSeq) showMissing(id, err.status);
    return;
  }
  if (seq !== navSeq) return;
  mountPage(page);
}

function mountPage(page) {
  const id = page.id;
  prefs.space = page.spaceId;
  prefs.lastPage = id;
  for (const a of store.ancestors(id)) prefs.expanded[a.id] = true;
  savePrefs();
  presence.setPage(id);

  const canWrite = session.can('write') && store.canWriteIn(page.spaceId);
  const readOnly = () => app.embed || prefs.readOnly || !canWrite;
  // Co-édition : le contenu passe par Yjs ; la requête PATCH ne sert plus qu'au titre, à l'icône et à la largeur.
  const useCollab = !!session.config.collab && canWrite && !app.embed;
  let synced = !useCollab;
  let collab = null;
  let version = page.version;
  let dirty = false;
  let remoteChanged = false;

  const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Fil d’Ariane' });
  const presenceEl = h('div', { class: 'presence' });
  const saveEl = h('span', { class: 'save-state' });
  const starBtn = session.user && h('button', { class: 'icon-btn star-btn', 'aria-label': 'Ajouter aux favoris', 'aria-pressed': 'false', onClick: () => A.attempt(() => store.toggleFavorite(id)) }, icon('star'));
  // Sur téléphone, ces boutons quittent la barre (trop serrée) et passent dans le menu « … » (voir pageMenu).
  const watchBtn = watchButton(id);
  const permBtn = permissionsButton(id);
  const modeBtn = canWrite && h('button', { class: 'btn btn-ghost btn-sm mode-btn', onClick: toggleMode });
  const moreBtn = h('button', { class: 'icon-btn', title: 'Plus d’options', onClick: (e) => pageMenu(e.currentTarget) }, icon('more'));
  const histBtn = h('button', { class: 'icon-btn', title: 'Historique des versions', onClick: async () => { await flush(); A.openHistory(id); } }, icon('history'));
  for (const b of [watchBtn, permBtn, starBtn, histBtn]) b?.classList.add('tb-secondary');

  const iconBtn = h('button', { class: 'page-icon', title: 'Changer l’icône', onClick: (e) => !readOnly() && A.pickIcon(e.currentTarget, id) });
  const addIconBtn = h('button', { class: 'add-icon', onClick: (e) => A.pickIcon(e.currentTarget, id) }, icon('smile', 15), 'Ajouter une icône');
  const titleEl = h('textarea', { class: 'page-title', rows: 1, placeholder: 'Sans titre', spellcheck: 'false', 'aria-label': 'Titre de la page', maxlength: '300' });
  titleEl.value = page.title;
  const metaEl = h('div', { class: 'page-meta' });
  const labels = labelBar(id, { initial: page.labels ?? [], canWrite: canWrite && !app.embed });
  const editorHost = h('div', { class: 'editor-host' });
  const tocEl = h('aside', { class: 'toc', 'aria-label': 'Sommaire' });
  const article = h('article', { class: 'page' }, h('div', { class: 'page-head' }, iconBtn, addIconBtn), titleEl, labels.el, metaEl, editorHost);
  const wrap = h('div', { class: 'page-wrap' }, article, tocEl);
  const scroller = h('div', { class: 'scroller' }, wrap);

  main().replaceChildren(
    topbar(crumbsEl, app.embed ? [] : [presenceEl, saveEl, commentsButton(id, () => editor), watchBtn, permBtn, starBtn, modeBtn, histBtn, moreBtn]),
    scroller,
  );

  // -- Sauvegarde : une requête à la fois, avec la version de base pour détecter les conflits --
  let saveTimer = null;
  let inflight = null;
  let pending = {};

  function setSave(state, text) {
    saveEl.dataset.state = state;
    saveEl.replaceChildren(state === 'saved' ? h('span', null, icon('check', 14), 'Enregistré') : text || 'Enregistrement…');
    clearTimeout(saveTimer);
    if (state === 'saved') saveTimer = setTimeout(() => { saveEl.dataset.state = 'idle'; }, 1600);
  }

  async function pushPending(force = false) {
    if (inflight) { await inflight; }
    if (!Object.keys(pending).length) return;
    const patch = pending;
    pending = {};
    inflight = (async () => {
      try {
        // Écraser (« garder ma version ») : on s'appuie sur la version actuelle du serveur, connue par le conflit.
        const meta = await store.updatePage(id, { ...patch, ...(useCollab ? {} : { baseVersion: force ? serverVersion : version }) });
        version = meta.version;
        dirty = Object.keys(pending).length > 0;
        setSave('saved');
      } catch (err) {
        pending = { ...patch, ...pending };
        if (err.status === 412 || err.status === 409) handleConflict(err.data);
        else setSave('error', 'Échec de l’enregistrement');
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  }

  const scheduleSave = debounce(() => pushPending(), 600);
  async function flush() { scheduleSave.cancel(); await pushPending(); }

  function queue(patch) {
    Object.assign(pending, patch);
    dirty = true;
    setSave('saving');
    scheduleSave();
  }

  let serverVersion = page.version;
  function handleConflict(data) {
    if (Number.isInteger(data?.version)) serverVersion = data.version;
    setSave('error', 'Conflit');
    openModal({
      title: 'Modification concurrente',
      body: h('p', { class: 'muted' }, `${data?.updatedBy || 'Quelqu’un'} a modifié cette page pendant que vous écriviez. Que voulez-vous faire ?`),
      actions: [
        { label: 'Recharger sa version', onClick: () => { pending = {}; dirty = false; reloadFromServer(); } },
        { label: 'Garder ma version', primary: true, onClick: () => { pushPending(true); } },
      ],
    });
  }

  async function reloadFromServer() {
    const fresh = await A.attempt(() => store.fetchPage(id));
    if (!fresh || view?.id !== id) return;
    version = fresh.version;
    remoteChanged = false;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(fresh.content, { emitUpdate: false });
    if (editor.isFocused) {
      const max = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    }
    if (document.activeElement !== titleEl) { titleEl.value = fresh.title; autosize(); }
    refreshDerived();
    paintChrome();
  }

  // -- Éditeur --
  const reloadView = () => { if (view?.id !== id) return; teardown(); showPage(id); };
  if (useCollab) {
    editorHost.classList.add('syncing');
    collab = connectCollab(id, {
      onSynced: () => {
        synced = true;
        editorHost.classList.remove('syncing');
        editor.setEditable(!readOnly());
        setSave('saved');
        renderToc();
      },
      onStatus: (status) => { if (status === 'disconnected') setSave('error', 'Hors ligne : reconnexion…'); else if (status === 'connected' && synced) setSave('saved'); },
      onReload: reloadView,
      onGone: () => { if (view?.id === id) { teardown(); showMissing(id, 404); } },
    });
  }
  const editor = createEditor({
    element: editorHost,
    content: page.content,
    editable: !readOnly() && synced,
    collab: collab && { ydoc: collab.ydoc, provider: collab.provider, user: { name: session.user.name, color: colorFor(session.user.id) } },
    onChange: () => { if (!useCollab) queue({ content: editor.getJSON() }); presence.touch(); refreshDerived(); },
    context: {
      navigate: (path) => A.go(path),
      open: (pid) => A.go(`/p/${pid}`),
      createSubpage: async () => {
        await flush();
        const cid = await A.attempt(() => store.createPage({ spaceId: page.spaceId, parentId: id }));
        if (cid) { prefs.expanded[id] = true; savePrefs(); }
        return cid;
      },
      pickPage: (cb) => openPalette({ mode: 'pick', onPick: cb, exclude: id }),
      pageId: id,
      onComment: canWrite && !app.embed ? (selection) => openComments(id, { getEditor: () => editor, anchor: selection }) : null,
      onAssist: canWrite && session.permissions.ai && !app.embed ? (selection) => openAssistant(editor, { pageId: id, selection }) : null,
      onAnchorClick: (commentId) => openComments(id, { getEditor: () => editor, focus: commentId }),
    },
  });
  // Surlignage du texte commenté, et noms des personnes mentionnées dans la page.
  const anchors = bindAnchors(id, () => editor);
  if (session.user) api.get(`/pages/${id}/mentioned`).then((r) => rememberMentionNames(r.items)).catch(() => undefined);

  // -- Titre --
  const autosize = () => { titleEl.style.height = 'auto'; titleEl.style.height = `${titleEl.scrollHeight}px`; };
  titleEl.addEventListener('input', () => {
    if (titleEl.value.includes('\n')) titleEl.value = titleEl.value.replace(/\n/g, ' ');
    autosize();
    queue({ title: titleEl.value.trim() ? titleEl.value : '' });
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && titleEl.selectionStart === titleEl.value.length)) {
      e.preventDefault();
      editor.view.dom.focus(); // synchrone : TipTap 3 diffère focus() d'une frame
      editor.commands.focus('start');
    }
  });

  // -- Sommaire & méta --
  let headings = [];
  function renderToc() {
    headings = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && node.textContent.trim()) headings.push({ level: node.attrs.level, text: node.textContent, pos });
      return node.type.name !== 'heading';
    });
    tocEl.hidden = headings.length < 2;
    tocEl.replaceChildren(
      h('div', { class: 'toc-title' }, 'Sur cette page'),
      ...headings.map((hd) => h('button', {
        class: `toc-item l${hd.level}`,
        onClick: () => /** @type {HTMLElement | null} */ (editor.view.nodeDOM(hd.pos))?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      }, hd.text)));
    spyToc();
  }

  function spyToc() {
    if (tocEl.hidden) return;
    let cur = 0;
    headings.forEach((hd, i) => {
      const dom = /** @type {HTMLElement | null} */ (editor.view.nodeDOM(hd.pos));
      if (dom && dom.getBoundingClientRect().top < 140) cur = i;
    });
    tocEl.querySelectorAll('.toc-item').forEach((b, i) => b.classList.toggle('active', i === cur));
  }
  scroller.addEventListener('scroll', spyToc, { passive: true });

  // Pages qui renvoient vers celle-ci (liens de pages) : une ligne dans les informations de la page.
  let backlinks = [];
  const loadBacklinks = () => { if (session.user) api.get(`/pages/${id}/backlinks`).then((r) => { backlinks = r.items; renderMeta(); }).catch(() => undefined); };
  function showBacklinks(anchor) {
    openMenu(anchor, backlinks.map((b) => ({ label: b.title || 'Sans titre', icon: 'file', onClick: () => A.go(pagePath(b)) })));
  }

  function renderMeta() {
    const p = store.page(id) || page;
    const words = wordCount(editor.getText());
    metaEl.replaceChildren(...[
      h('span', { title: fullDate(p.updatedAt) }, `Modifiée ${timeAgo(p.updatedAt)}${p.updatedBy ? ` par ${p.updatedBy}` : ''}`),
      h('span', null, `${words} mot${words > 1 ? 's' : ''}`),
      h('span', null, `${Math.max(1, Math.round(words / 220))} min de lecture`),
      backlinks.length > 0 && h('button', { class: 'link-btn', type: 'button', onClick: (e) => showBacklinks(e.currentTarget) }, `${backlinks.length} page${backlinks.length > 1 ? 's' : ''} renvoie${backlinks.length > 1 ? 'nt' : ''} ici`),
      !canWrite && h('span', { class: 'badge-soft' }, 'Lecture seule'),
    ].filter(Boolean));
  }

  const refreshDerived = debounce(() => { renderToc(); renderMeta(); }, 200);

  function paintChrome() {
    const p = store.page(id) || page;
    crumbsEl.replaceChildren(...crumbsFor(p));
    if (starBtn) {
      starBtn.classList.toggle('on', !!p.favorite);
      starBtn.title = p.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris';
      starBtn.setAttribute('aria-label', starBtn.title);
      starBtn.setAttribute('aria-pressed', String(!!p.favorite));
    }
    iconBtn.replaceChildren(...(p.icon ? [pageIcon(p.icon, 40)] : []));
    iconBtn.hidden = !p.icon;
    addIconBtn.hidden = !!p.icon || readOnly();
    wrap.classList.toggle('full', !!p.fullWidth);
    titleEl.readOnly = readOnly();
    if (modeBtn) {
      modeBtn.replaceChildren(icon(prefs.readOnly ? 'pencil' : 'eye', 15), prefs.readOnly ? 'Éditer' : 'Lecture');
      modeBtn.title = prefs.readOnly ? 'Passer en mode édition' : 'Passer en mode lecture';
    }
    document.title = `${p.title || 'Sans titre'} · Notabene`;
    tidyAddress(pagePath(p)); // le titre a pu changer (renommage) : l'adresse le suit
  }

  function paintPresence() {
    const others = presence.peersOn(id);
    if (!others.length || !session.user) { presenceEl.replaceChildren(); presenceEl.hidden = true; return; }
    presenceEl.hidden = false;
    const now = Date.now();
    const avatar = (p, self) => avatarEl({ id: p.userId, name: p.name }, {
      cls: !self && now - p.editingAt < 5000 ? 'typing' : '',
      title: `${p.name}${self ? ' (vous)' : ''}${!self && now - p.editingAt < 5000 ? ' · écrit…' : ''}`,
    });
    presenceEl.replaceChildren(...others.map((p) => avatar(p, false)), avatar({ name: session.user.name, userId: session.user.id }, true));
  }

  function toggleMode() {
    prefs.readOnly = !prefs.readOnly;
    savePrefs();
    editor.setEditable(!readOnly() && synced);
    document.body.classList.toggle('reading', readOnly());
    paintChrome();
    renderMeta();
  }

  function pageMenu(anchor) {
    const p = store.page(id) || page;
    openMenu(anchor, [
      ...(narrow() ? [
        watchBtn && { label: watchBtn.getAttribute('aria-pressed') === 'true' ? 'Ne plus suivre la page' : 'Suivre la page', icon: 'bell', onClick: () => watchBtn.click() },
        starBtn && { label: starBtn.getAttribute('aria-pressed') === 'true' ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'star', onClick: () => starBtn.click() },
        { label: 'Historique des versions', icon: 'history', onClick: () => histBtn.click() },
        permBtn && { label: 'Permissions de la page', icon: 'lock', onClick: () => permBtn.click() },
        { sep: true },
      ] : []),
      canWrite && { label: 'Pleine largeur', icon: 'width', checked: !!p.fullWidth, onClick: () => A.attempt(() => store.updatePage(id, { fullWidth: !p.fullWidth })) },
      { label: 'Copier le lien', icon: 'link', onClick: () => A.copyLink(id) },
      { label: 'Intégrer (iframe)', icon: 'code', onClick: () => A.showEmbed(id) },
      { sep: true },
      { label: 'Exporter en Markdown', icon: 'download', onClick: async () => { await flush(); A.exportMarkdown(id); } },
      { label: 'Exporter en HTML', icon: 'download', onClick: async () => { await flush(); A.exportHTML(id); } },
      { label: 'Exporter en PDF', icon: 'pdf', onClick: async () => { await flush(); A.exportPDF(id); } },
      canWrite && { label: 'Dupliquer', icon: 'copy', onClick: async () => { await flush(); A.duplicate(id); } },
      canWrite && { label: 'Ajouter une sous-page', icon: 'plus', onClick: () => A.newPage(p.spaceId, id) },
      canWrite && { label: 'Ajouter une sous-page depuis un modèle', icon: 'layers', onClick: () => A.newPageFromTemplate(p.spaceId, id) },
      canWrite && { label: 'Enregistrer comme modèle', icon: 'copy', onClick: async () => { await flush(); A.saveAsTemplate(id); } },
      canWrite && { sep: true },
      canWrite && { label: 'Mettre à la corbeille', icon: 'trash', danger: true, onClick: () => A.trash(id) },
    ], { align: 'right' });
  }

  const offPresence = presence.onChange(paintPresence);
  const presenceTick = setInterval(paintPresence, 2000);
  const beforeUnload = (e) => { if (dirty) { pushPending(); e.preventDefault(); } };
  window.addEventListener('beforeunload', beforeUnload);

  document.body.classList.toggle('reading', readOnly());
  paintChrome();
  paintPresence();
  renderToc();
  renderMeta();
  loadBacklinks();
  requestAnimationFrame(autosize);
  if (!page.title && !readOnly()) titleEl.focus();

  view = {
    kind: 'page',
    id,
    onStore(evt) {
      const p = store.page(id);
      if (!p) {
        if (evt.type === 'remote' || evt.type === 'load') { teardown(); showMissing(id, 404); }
        return;
      }
      if (evt.type === 'remote') loadBacklinks();
      paintChrome();
      // Version restaurée localement, ou modification venue d'un autre onglet / utilisateur.
      if (!useCollab && (evt.source === 'restore' || (evt.type === 'remote' && evt.pageId === id && (evt.version ?? 0) > version))) {
        if (dirty) remoteChanged = true;
        else reloadFromServer();
      }
      renderMeta();
    },
    destroy() {
      if (dirty) { scheduleSave.cancel(); pushPending(); }
      clearInterval(presenceTick);
      clearTimeout(saveTimer);
      offPresence();
      refreshDerived.cancel();
      labels.destroy();
      anchors.destroy();
      window.removeEventListener('beforeunload', beforeUnload);
      editor.destroy();
      collab?.destroy();
      presence.setPage(null);
    },
  };
  void remoteChanged;
}

// ---- Accueil d'un espace -------------------------------------------------

export function showSpace(spaceId) {
  teardown();
  ++navSeq;
  const space = store.space(spaceId);
  if (!space) { A.go('/'); return; }
  prefs.space = spaceId;
  savePrefs();
  presence.setPage(null);
  document.title = `${space.name} · Notabene`;
  tidyAddress(spacePath(space));
  const canWrite = session.can('write') && store.canWriteIn(spaceId);

  const scroller = h('div', { class: 'scroller' });
  function render() {
    const s = store.space(spaceId);
    if (!s) { A.go('/'); return; }
    const pages = store.pagesIn(spaceId);
    const recent = store.recent(spaceId, 9);
    const roots = store.children(spaceId, null);
    main().replaceChildren(
      topbar(h('nav', { class: 'crumbs' }, h('span', { class: 'crumb current' }, h('span', { class: 'crumb-ico' }, pageIcon(s.icon || 'folder', 14)), s.name)),
        app.embed || !canWrite ? [] : [h('button', { class: 'btn btn-ghost btn-sm', onClick: () => A.newPageFromTemplate(spaceId) }, icon('layers', 15), 'Depuis un modèle'), h('button', { class: 'btn btn-primary btn-sm', onClick: () => A.newPage(spaceId) }, icon('plus', 15), 'Nouvelle page')]),
      scroller);
    scroller.replaceChildren(h('div', { class: 'space-home' },
      h('div', { class: 'space-hero' },
        h('div', { class: 'space-hero-icon' }, pageIcon(s.icon, 32)),
        h('div', null,
          h('h1', null, s.name),
          s.description && h('p', { class: 'muted' }, s.description),
          h('div', { class: 'space-stats' },
            h('span', null, s.visibility === 'public' ? 'Public' : 'Privé'),
            h('span', null, `${pages.length} page${pages.length > 1 ? 's' : ''}`),
            h('span', null, `${roots.length} à la racine`),
            pages.length > 0 && h('span', null, `Activité ${timeAgo(Math.max(...pages.map((p) => p.updatedAt)))}`))),
        !app.embed && session.can('admin') && h('button', { class: 'icon-btn', title: 'Paramètres de l’espace', onClick: () => A.spaceForm(s) }, icon('settings'))),
      recent.length
        ? [
          h('h2', { class: 'section-title' }, 'Modifiées récemment'),
          h('div', { class: 'cards' }, recent.map((p) => {
            const parent = p.parentId && store.page(p.parentId);
            return h('a', { class: 'card', href: pagePath(p) },
              h('div', { class: 'card-icon' }, pageIcon(p.icon)),
              h('strong', { class: 'card-title' }, p.title || 'Sans titre'),
              h('p', { class: 'card-snippet' }, p.excerpt ? p.excerpt.slice(0, 120) + (p.excerpt.length > 120 ? '…' : '') : 'Page vide'),
              h('div', { class: 'card-foot' },
                h('span', null, timeAgo(p.updatedAt)),
                parent && h('span', { class: 'card-parent' }, `dans ${parent.title || 'Sans titre'}`)));
          })),
        ]
        : h('div', { class: 'empty' },
          h('div', { class: 'empty-emoji' }, icon('plus', 32)),
          h('p', null, 'Cet espace est encore vide.'),
          canWrite && !app.embed && h('button', { class: 'btn btn-primary', onClick: () => A.newPage(spaceId) }, 'Créer la première page'))));
  }
  render();
  view = { kind: 'space', id: spaceId, onStore: render };
}

// ---- Pages portant un libellé -----------------------------------------------

export async function showLabel(name) {
  teardown();
  const seq = ++navSeq;
  presence.setPage(null);
  document.title = `${name} · Notabene`;
  loading();
  let pages;
  try {
    pages = await listAll(`/pages?label=${encodeURIComponent(name)}`);
  } catch {
    if (seq === navSeq) showMissing(null, 500);
    return;
  }
  if (seq !== navSeq) return;
  pages.sort((a, b) => b.updatedAt - a.updatedAt);
  main().replaceChildren(
    topbar(h('nav', { class: 'crumbs' }, h('span', { class: 'crumb current' }, `Libellé « ${name} »`))),
    h('div', { class: 'scroller' }, h('div', { class: 'space-home' },
      h('div', { class: 'space-hero' }, h('div', null,
        h('h1', null, name),
        h('div', { class: 'space-stats' }, h('span', null, `${pages.length} page${pages.length > 1 ? 's' : ''}`)))),
      pages.length
        ? h('div', { class: 'cards' }, pages.map((p) => {
          const space = store.space(p.spaceId);
          return h('a', { class: 'card', href: pagePath(p) },
            h('div', { class: 'card-icon' }, pageIcon(p.icon)),
            h('strong', { class: 'card-title' }, p.title || 'Sans titre'),
            h('p', { class: 'card-snippet' }, p.excerpt ? p.excerpt.slice(0, 120) + (p.excerpt.length > 120 ? '…' : '') : 'Page vide'),
            h('div', { class: 'card-foot' }, h('span', null, timeAgo(p.updatedAt)), space && h('span', { class: 'card-parent' }, space.name)));
        }))
        : h('div', { class: 'empty' }, h('p', null, 'Aucune page ne porte ce libellé.'), h('a', { class: 'btn btn-ghost', href: '/' }, 'Retour à l’accueil')))));
  view = { kind: 'label', id: name };
}

// ---- Connexion --------------------------------------------------------------

const AUTH_ERRORS = {
  forbidden: 'Votre compte n’appartient à aucun groupe autorisé. Demandez l’accès à un administrateur.',
  callback: 'La connexion a échoué. Réessayez.',
  access_denied: 'Connexion annulée.',
  mfa_required: 'Une double authentification est exigée : activez-la sur votre compte du fournisseur d’identité, puis reconnectez-vous.',
};

export function showLogin() {
  teardown();
  document.title = 'Connexion · Notabene';
  const error = new URLSearchParams(location.search).get('auth_error');
  const { oidc, devLogin, local, setupRequired, ldap, saml } = session.config.auth;
  main().replaceChildren(h('div', { class: 'login' }, h('div', { class: 'login-card' },
    h('div', { class: 'boot-logo' }),
    h('h1', null, 'Notabene'),
    h('p', { class: 'muted' }, 'Le wiki de votre équipe. Connectez-vous pour continuer.'),
    error && h('div', { class: 'notice warning' }, AUTH_ERRORS[error] || 'Connexion impossible.'),
    // Le fournisseur d'identité d'abord (un clic), puis les formulaires à mot de passe ; l'installation initiale passe avant tout.
    !setupRequired && oidc && h('a', { class: 'btn btn-primary btn-lg', href: session.loginUrl() }, icon('users', 16), 'Se connecter avec Authentik'),
    !setupRequired && saml && h('a', { class: oidc ? 'btn btn-ghost btn-lg' : 'btn btn-primary btn-lg', href: `/auth/saml/login?returnTo=${encodeURIComponent(location.pathname)}` }, icon('key', 16), 'Se connecter avec le SSO (SAML)'),
    !setupRequired && (oidc || saml) && (local || ldap) && h('p', { class: 'or' }, h('span', null, 'ou avec un mot de passe')),
    local && localLoginForm(setupRequired),
    local && !setupRequired && session.config.auth.mail && forgotPasswordForm(),
    local && ldap && h('p', { class: 'or' }, h('span', null, 'ou')),
    ldap && ldapLoginForm(),
    devLogin && h('div', { class: 'dev-login stack' },
      h('p', { class: 'hint' }, 'Mode développement : connexion sans fournisseur d’identité.'),
      h('div', { class: 'row center' }, ['admin', 'editor', 'reader'].map((role) =>
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => session.devLogin(role) }, { admin: 'Admin', editor: 'Éditeur', reader: 'Lecteur' }[role])))),
    !oidc && !devLogin && !local && !ldap && !saml && h('p', { class: 'notice warning' }, 'Aucun fournisseur d’identité n’est configuré.'))));
}

// ---- Introuvable ----------------------------------------------------------

export function showMissing(id, status = 404) {
  teardown();
  document.title = 'Page introuvable · Notabene';
  const anonymous = !session.user;
  main().replaceChildren(
    topbar(h('nav', { class: 'crumbs' })),
    h('div', { class: 'scroller' }, h('div', { class: 'empty big' },
      h('div', { class: 'empty-emoji' }, icon('search', 32)),
      h('h2', null, 'Page introuvable'),
      h('p', { class: 'muted' }, anonymous
        ? 'Cette page n’existe pas ou nécessite d’être connecté.'
        : status === 404 ? 'Elle a peut-être été supprimée ou déplacée dans la corbeille.' : 'Impossible de charger la page.'),
      h('div', { class: 'row center' },
        anonymous && (session.config.auth.oidc || session.config.auth.devLogin || session.config.auth.local || session.config.auth.ldap || session.config.auth.saml) && h('a', { class: 'btn btn-primary', href: session.config.auth.oidc ? session.loginUrl() : '/?login' }, 'Se connecter'),
        h('a', { class: 'btn btn-ghost', href: '/' }, 'Retour à l’accueil')))));
  view = { kind: 'missing', id };
}

export function toastAuthError() {
  const error = new URLSearchParams(location.search).get('auth_error');
  if (error && session.user) toast(AUTH_ERRORS[error] || 'Connexion impossible', { kind: 'error' });
}
