// Commentaires d'une page (v3) : fils, réponses, résolution, suppression, texte commenté (ancre) et mentions.
// Tout texte venant du serveur est affiché avec textContent (jamais en HTML).
import { h, timeAgo } from './util.js';
import { icon } from './icons.js';
import { api, listAll } from './api.js';
import { session } from './session.js';
import { toast, openModal, confirmModal } from './ui.js';
import { attachMentions } from './mentions-ui.js';

let open = null; // fenêtre ouverte : { pageId, refresh }
let watching = null; // ancres de la page affichée : { pageId, refresh }

// Rafraîchit la fenêtre ouverte et l'état des ancres quand un commentaire change sur la page (évènements temps réel).
export function onCommentEvent(evt) {
  if (open && evt?.pageId === open.pageId) open.refresh();
  if (watching && evt?.pageId === watching.pageId) watching.refresh();
}

/** Garde les surlignages du texte commenté à jour (fil ouvert, résolu, disparu) pour la page affichée. */
export function bindAnchors(pageId, getEditor) {
  if (!session.user) return { refresh() {}, destroy() {} };
  const refresh = async () => {
    try {
      const roots = (await listAll(`/pages/${pageId}/comments`)).filter((c) => !c.parentId && !c.deleted && c.anchored);
      getEditor()?.commands.setCommentStates(roots.filter((c) => !c.resolved).map((c) => c.id), roots.filter((c) => c.resolved).map((c) => c.id));
    } catch { /* la page reste lisible sans surlignage */ }
  };
  const handle = { pageId, refresh };
  watching = handle;
  refresh();
  return { refresh, destroy() { if (watching === handle) watching = null; } };
}

export function commentsButton(pageId, getEditor) {
  if (!session.user) return null;
  return h('button', { class: 'icon-btn', title: 'Commentaires', 'aria-label': 'Commentaires', onClick: () => openComments(pageId, { getEditor }) }, icon('comment'));
}

const anchorEl = (editor, id) => (editor && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? editor.view.dom.querySelector(`[data-comment-id="${id}"]`) : null);

// Retrouve la plage du texte commenté : à sa place d'origine si le texte n'a pas bougé, sinon sa première occurrence dans un même paragraphe.
function locate(editor, anchor) {
  const { doc } = editor.state;
  if (anchor.to <= doc.content.size && doc.textBetween(anchor.from, anchor.to, ' ') === anchor.text) return { from: anchor.from, to: anchor.to };
  let found = null;
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return !found;
    const at = node.textContent.indexOf(anchor.text);
    if (at >= 0) found = { from: pos + 1 + at, to: pos + 1 + at + anchor.text.length };
    return false;
  });
  return found;
}

// Contenu d'un commentaire : les « @Nom » des personnes mentionnées sont mis en forme, tout reste du texte.
function bodyNodes(c) {
  const tokens = (c.mentions || []).map((m) => `@${m.name}`).sort((a, b) => b.length - a.length);
  const out = [];
  let rest = c.body;
  while (rest) {
    let best = null;
    for (const t of tokens) {
      const at = rest.indexOf(t);
      if (at >= 0 && (!best || at < best.at)) best = { at, t };
    }
    if (!best) { out.push(rest); break; }
    if (best.at > 0) out.push(rest.slice(0, best.at));
    out.push(h('span', { class: 'mention' }, best.t));
    rest = rest.slice(best.at + best.t.length);
  }
  return out;
}

/**
 * @param {string} pageId
 * @param {{ getEditor?: () => any, anchor?: { from: number, to: number, text: string }, focus?: string }} [options]
 */
export function openComments(pageId, { getEditor = () => null, anchor = null, focus = null } = {}) {
  const canWrite = session.can('write');
  let pendingAnchor = anchor;
  const list = h('div', { class: 'stack comments' }, h('p', { class: 'muted' }, 'Chargement…'));
  const newBox = h('textarea', { class: 'input', rows: 3, maxlength: '5000', placeholder: 'Ajouter un commentaire… (@ pour mentionner)', 'aria-label': 'Nouveau commentaire' });
  const newMentions = canWrite ? attachMentions(newBox, pageId) : null;
  const quoteBox = h('div', { class: 'comment-pending' });
  const paintPending = () => {
    quoteBox.hidden = !pendingAnchor;
    quoteBox.replaceChildren(...(pendingAnchor ? [
      h('small', { class: 'muted' }, 'Commentaire sur ce texte :'),
      h('blockquote', { class: 'comment-quote' }, pendingAnchor.text),
      h('button', { class: 'link-btn', type: 'button', onClick: () => { pendingAnchor = null; paintPending(); } }, 'Commenter la page entière'),
    ] : []));
  };
  paintPending();

  const post = async (payload) => {
    try {
      return await api.post(`/pages/${pageId}/comments`, payload);
    } catch (err) { toast(err.message, { kind: 'error' }); return null; }
  };

  // Publie un commentaire ; s'il porte sur un texte, pose ensuite l'ancre sur ce texte dans la page.
  const send = async (body, mentions, parentId = null) => {
    if (!body.trim()) return false;
    const text = parentId ? null : pendingAnchor;
    const created = await post({ body, ...(mentions.length ? { mentions } : {}), ...(parentId ? { parentId } : {}), ...(text ? { anchorText: text.text } : {}) });
    if (!created) return false;
    if (text) {
      const editor = getEditor();
      const range = editor && locate(editor, text);
      if (range) editor.chain().setCommentAnchor(created.id, range.from, range.to).run();
      else toast('Le texte a changé : le commentaire est publié sans surlignage.');
      pendingAnchor = null;
      paintPending();
    }
    await refresh();
    watching?.refresh();
    return true;
  };

  const viewInPage = (c) => {
    const el = anchorEl(getEditor(), c.id);
    if (!el) return;
    m.close();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('anchor-flash');
    setTimeout(() => el.classList.remove('anchor-flash'), 1800);
  };

  const item = (c, isReply) => {
    const mine = c.author?.id === session.user.id;
    const body = c.deleted ? h('em', { class: 'muted' }, 'Commentaire supprimé') : h('p', { class: 'comment-body' }, ...bodyNodes(c));
    const editor = getEditor();
    const present = !c.anchored || !editor || !!anchorEl(editor, c.id);
    const quote = !isReply && !c.deleted && c.anchored && h('div', { class: 'comment-anchor-info' },
      h('blockquote', { class: 'comment-quote' }, c.anchorText),
      present
        ? h('button', { class: 'link-btn', type: 'button', onClick: () => viewInPage(c) }, 'Voir dans la page')
        : h('span', { class: 'pill off' }, 'Texte supprimé de la page'));
    const actions = c.deleted ? null : h('div', { class: 'row wrap' },
      !isReply && canWrite && h('button', { class: 'link-btn', onClick: () => reply(c) }, 'Répondre'),
      !isReply && canWrite && h('button', { class: 'link-btn', onClick: () => toggle(c) }, c.resolved ? 'Rouvrir' : 'Résoudre'),
      mine && h('button', { class: 'link-btn', onClick: () => edit(c) }, 'Modifier'),
      (mine || session.can('admin')) && h('button', { class: 'link-btn danger-text', onClick: () => remove(c) }, 'Supprimer'));
    return h('div', { class: `comment${isReply ? ' reply' : ''}${c.resolved ? ' resolved' : ''}${c.id === focus ? ' focused' : ''}`, id: `c-${c.id}` },
      h('div', { class: 'comment-head' }, h('strong', null, c.deleted ? '' : c.author?.name || 'Utilisateur supprimé'), h('small', { class: 'muted' }, ` ${timeAgo(c.createdAt)}`), c.resolved && !isReply && h('span', { class: 'pill ok' }, 'Résolu')),
      quote, body, actions);
  };

  const call = async (fn, done) => { try { await fn(); if (done) toast(done); await refresh(); watching?.refresh(); } catch (err) { toast(err.message, { kind: 'error' }); } };
  const toggle = (c) => call(() => api.patch(`/pages/${pageId}/comments/${c.id}`, { resolved: !c.resolved }));
  const remove = async (c) => {
    if (!(await confirmModal({ title: 'Supprimer ce commentaire ?', message: 'Le texte est effacé ; les réponses restent.', confirm: 'Supprimer', danger: true }))) return;
    await call(() => api.del(`/pages/${pageId}/comments/${c.id}`));
    if (c.anchored && canWrite) try { getEditor()?.commands.removeCommentAnchor(c.id); } catch { /* la page se met à jour au prochain rafraîchissement */ }
  };
  const edit = (c) => {
    const area = h('textarea', { class: 'input', rows: 4, maxlength: '5000', 'aria-label': 'Commentaire' });
    area.value = c.body;
    openModal({ title: 'Modifier le commentaire', body: area, actions: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: async () => { if (!area.value.trim()) return false; await call(() => api.patch(`/pages/${pageId}/comments/${c.id}`, { body: area.value }), 'Commentaire modifié'); return undefined; } }] });
  };
  const reply = (c) => {
    const area = h('textarea', { class: 'input', rows: 3, maxlength: '5000', placeholder: 'Votre réponse… (@ pour mentionner)', 'aria-label': 'Votre réponse' });
    const mentions = attachMentions(area, pageId);
    const dlg = openModal({ title: 'Répondre', body: area, actions: [{ label: 'Annuler' }, { label: 'Répondre', primary: true, onClick: async () => ((await send(area.value, mentions.ids(), c.id)) ? undefined : false) }] });
    dlg.el.addEventListener('close', mentions.destroy);
    setTimeout(() => area.focus(), 30);
  };

  async function refresh() {
    const all = await listAll(`/pages/${pageId}/comments`);
    const roots = all.filter((c) => !c.parentId);
    const replies = new Map();
    for (const c of all) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) || []), c]);
    // Un commentaire supprimé sans réponse n'a plus rien à montrer.
    const shown = roots.filter((r) => !r.deleted || replies.has(r.id));
    list.replaceChildren(...(shown.length
      ? shown.map((r) => h('div', { class: 'thread' }, item(r, false), ...(replies.get(r.id) || []).map((x) => item(x, true))))
      : [h('p', { class: 'muted' }, 'Aucun commentaire pour le moment.')]));
  }

  const m = openModal({
    title: 'Commentaires',
    size: 'wide',
    body: h('div', { class: 'stack' }, list, canWrite
      ? h('div', { class: 'stack' }, quoteBox, newBox, h('div', null, h('button', { class: 'btn btn-primary btn-sm', onClick: async () => { if (await send(newBox.value, newMentions.ids())) newBox.value = ''; } }, 'Commenter')))
      : h('p', { class: 'hint' }, 'Votre rôle ne permet pas de commenter.')),
    actions: [{ label: 'Fermer' }],
  });
  open = { pageId, refresh: () => refresh().catch(() => undefined) };
  m.el.addEventListener('close', () => { newMentions?.destroy(); if (open?.pageId === pageId) open = null; });
  refresh().then(() => {
    if (focus) { const el = document.getElementById(`c-${focus}`); el?.scrollIntoView({ block: 'center' }); }
    else if (pendingAnchor) newBox.focus();
  }).catch((err) => { list.textContent = err.message; });
}
