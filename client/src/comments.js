// Commentaires d'une page (v3) : fils, réponses, résolution, suppression.
// Tout texte venant du serveur est affiché avec textContent (jamais en HTML).
import { h, timeAgo } from './util.js';
import { icon } from './icons.js';
import { api, listAll } from './api.js';
import { session } from './session.js';
import { toast, openModal, confirmModal } from './ui.js';

let open = null; // { pageId, refresh }

// Rafraîchit la fenêtre ouverte quand un commentaire change sur sa page (évènements temps réel).
export function onCommentEvent(evt) {
  if (open && evt?.pageId === open.pageId) open.refresh();
}

export function commentsButton(pageId) {
  if (!session.user) return null;
  return h('button', { class: 'icon-btn', title: 'Commentaires', 'aria-label': 'Commentaires', onClick: () => openComments(pageId) }, icon('comment'));
}

function openComments(pageId) {
  const canWrite = session.can('write');
  const list = h('div', { class: 'stack comments' }, h('p', { class: 'muted' }, 'Chargement…'));
  const newBox = h('textarea', { class: 'input', rows: 3, maxlength: '5000', placeholder: 'Ajouter un commentaire…', 'aria-label': 'Nouveau commentaire' });
  const send = async (body, parentId = null) => {
    if (!body.trim()) return false;
    try {
      await api.post(`/pages/${pageId}/comments`, { body, ...(parentId ? { parentId } : {}) });
      await refresh();
      return true;
    } catch (err) { toast(err.message, { kind: 'error' }); return false; }
  };

  const item = (c, isReply) => {
    const mine = c.author?.id === session.user.id;
    const body = c.deleted ? h('em', { class: 'muted' }, 'Commentaire supprimé') : h('p', { class: 'comment-body' }, c.body);
    const actions = c.deleted ? null : h('div', { class: 'row wrap' },
      !isReply && canWrite && h('button', { class: 'link-btn', onClick: () => reply(c) }, 'Répondre'),
      !isReply && canWrite && h('button', { class: 'link-btn', onClick: () => toggle(c) }, c.resolved ? 'Rouvrir' : 'Résoudre'),
      mine && h('button', { class: 'link-btn', onClick: () => edit(c) }, 'Modifier'),
      (mine || session.can('admin')) && h('button', { class: 'link-btn danger-text', onClick: () => remove(c) }, 'Supprimer'));
    return h('div', { class: `comment${isReply ? ' reply' : ''}${c.resolved ? ' resolved' : ''}`, id: `c-${c.id}` },
      h('div', { class: 'comment-head' }, h('strong', null, c.deleted ? '' : c.author?.name || 'Utilisateur supprimé'), h('small', { class: 'muted' }, ` ${timeAgo(c.createdAt)}`), c.resolved && !isReply && h('span', { class: 'pill ok' }, 'Résolu')),
      body, actions);
  };

  const call = async (fn, done) => { try { await fn(); if (done) toast(done); await refresh(); } catch (err) { toast(err.message, { kind: 'error' }); } };
  const toggle = (c) => call(() => api.patch(`/pages/${pageId}/comments/${c.id}`, { resolved: !c.resolved }));
  const remove = async (c) => { if (await confirmModal({ title: 'Supprimer ce commentaire ?', message: 'Le texte est effacé ; les réponses restent.', confirm: 'Supprimer', danger: true })) call(() => api.del(`/pages/${pageId}/comments/${c.id}`)); };
  const edit = (c) => {
    const area = h('textarea', { class: 'input', rows: 4, maxlength: '5000' });
    area.value = c.body;
    openModal({ title: 'Modifier le commentaire', body: area, actions: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: async () => { if (!area.value.trim()) return false; await call(() => api.patch(`/pages/${pageId}/comments/${c.id}`, { body: area.value }), 'Commentaire modifié'); return undefined; } }] });
  };
  const reply = (c) => {
    const area = h('textarea', { class: 'input', rows: 3, maxlength: '5000', placeholder: 'Votre réponse…' });
    openModal({ title: 'Répondre', body: area, actions: [{ label: 'Annuler' }, { label: 'Répondre', primary: true, onClick: async () => ((await send(area.value, c.id)) ? undefined : false) }] });
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
      ? h('div', { class: 'stack' }, newBox, h('div', null, h('button', { class: 'btn btn-primary btn-sm', onClick: async () => { if (await send(newBox.value)) newBox.value = ''; } }, 'Commenter')))
      : h('p', { class: 'hint' }, 'Votre rôle ne permet pas de commenter.')),
    actions: [{ label: 'Fermer' }],
  });
  open = { pageId, refresh: () => refresh().catch(() => undefined) };
  m.el.addEventListener('close', () => { if (open?.pageId === pageId) open = null; });
  refresh().catch((err) => { list.textContent = err.message; });
}
