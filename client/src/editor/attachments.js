// Pièces jointes dans l'éditeur : envoi (glisser-déposer, collage, menu « / ») et blocs fichier, vidéo et audio.
// Sécurité : un bloc ne porte que l'identifiant (forme fixe, revalidée ici), le nom, la taille et le type reconnu par le serveur.
// L'adresse est toujours reconstruite à partir de l'identifiant seul ; le nom n'est jamais inséré en HTML, seulement en texte.
// Vidéo et audio : lecteur du navigateur, `controls` et `preload="metadata"`, aucune lecture automatique.
import { Node, mergeAttributes } from '@tiptap/core';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { api, upload } from '../api.js';
import { icon } from '../icons.js';
import { makeResizable } from '../resize.js';
import { session } from '../session.js';
import { confirmModal, toast } from '../ui.js';
import { h } from '../util.js';

// ---- Identifiants, adresses, types ------------------------------------------

export const ATTACHMENT_ID = /^[A-Za-z0-9_-]{22}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,90}$/;
const SRC = /^\/api\/v3\/attachments\/([A-Za-z0-9_-]{22})$/;

export const validId = (v) => (typeof v === 'string' && ATTACHMENT_ID.test(v) ? v : null);
/** Identifiant d'une image enregistrée comme pièce jointe (adresse « /api/v3/attachments/<id> »), sinon null. */
export const idFromSrc = (src) => SRC.exec(String(src ?? ''))?.[1] ?? null;

/** Adresse d'une pièce jointe, construite avec l'identifiant seul ; sur une page partagée, par le lien public. */
export function attachmentUrl(id, shareToken = null) {
  const safe = validId(id);
  if (!safe) return null;
  return shareToken && SHARE_TOKEN.test(shareToken) ? `/api/v3/public/shares/${shareToken}/attachments/${safe}` : `/api/v3/attachments/${safe}`;
}

// Types que le serveur reconnaît sur les octets (server/src/lib/attachments.ts). Tout le reste est un fichier à télécharger.
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const VIDEO_MIMES = ['video/mp4', 'video/webm'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/ogg', 'audio/wav'];
const MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES, ...AUDIO_MIMES, 'application/pdf', 'application/zip', 'application/octet-stream'];
const mimeOf = (v) => (MIMES.includes(v) ? v : 'application/octet-stream');
const kindOf = (mime) => (IMAGE_MIMES.includes(mime) ? 'image' : VIDEO_MIMES.includes(mime) ? 'video' : AUDIO_MIMES.includes(mime) ? 'audio' : 'file');
const TYPE_LABEL = {
  'application/pdf': 'PDF', 'application/zip': 'Archive ZIP', 'video/mp4': 'Vidéo MP4', 'video/webm': 'Vidéo WebM',
  'audio/mpeg': 'Audio MP3', 'audio/ogg': 'Audio Ogg', 'audio/wav': 'Audio WAV',
};

// Nom affiché : borné, sans caractère de contrôle ni inversion de sens d'écriture (le serveur l'a déjà assaini à l'envoi).
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff]];
const unsafeChar = (c) => { const n = c.codePointAt(0); return UNSAFE_RANGES.some(([a, b]) => n >= a && n <= b); };
export const cleanName = (v) => [...String(v ?? '')].filter((c) => !unsafeChar(c)).join('').trim().slice(0, 200);
const displayName = (v) => cleanName(v) || 'fichier';
const sizeAttr = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };

const NUM = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${NUM.format(v)} ${units[i]}`;
}

// Texte alternatif proposé pour une image : son nom sans extension (modifiable ensuite).
const altFromName = (name) => cleanName(name).replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_-]+/g, ' ').trim();

// ---- Suppression ------------------------------------------------------------

/** Supprime le fichier sur le serveur (après confirmation), puis le bloc qui le montre. */
export async function deleteAttachment(editor, getPos, id, name) {
  const ok = await confirmModal({
    title: 'Supprimer le fichier',
    message: `« ${displayName(name)} » sera supprimé définitivement : il ne pourra plus être téléchargé, même depuis l’historique de la page.`,
    confirm: 'Supprimer',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/attachments/${id}`);
  } catch (err) {
    // Déjà supprimé (par quelqu'un d'autre) : on retire quand même le bloc.
    if (err?.status !== 404) { toast(err?.status === 403 ? 'Vous ne pouvez pas supprimer ce fichier.' : 'Suppression impossible, réessayez.', { kind: 'error' }); return; }
  }
  const pos = typeof getPos === 'function' ? getPos() : null;
  const node = pos == null ? null : editor.state.doc.nodeAt(pos);
  const same = node && (validId(node.attrs.id) === id || idFromSrc(node.attrs.src) === id);
  if (same && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  toast('Fichier supprimé.');
}

// ---- Blocs ------------------------------------------------------------------

const idAttr = { default: null, parseHTML: (el) => validId(el.getAttribute('data-id')), renderHTML: (a) => ({ 'data-id': validId(a.id) || '' }) };
// Le nom vient du texte du lien (jamais d'un attribut HTML) ; il n'est pas rendu en attribut.
const nameAttr = { default: '', parseHTML: (el) => cleanName(el.textContent), rendered: false };

// Pied commun : nom (texte), taille, liens de téléchargement et de suppression.
/** @param {{ editor: any, getPos: any, id: string, name: string, url: string }} options */
function fileActions({ editor, getPos, id, name, url }) {
  const download = url && h('a', { class: 'btn btn-ghost btn-sm', href: url, download: '' }, icon('download', 14), ' Télécharger', h('span', { class: 'sr-only' }, ` ${displayName(name)}`));
  const remove = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => deleteAttachment(editor, getPos, id, name) },
    icon('trash', 14), ' Supprimer', h('span', { class: 'sr-only' }, ` ${displayName(name)}`));
  return { download, remove };
}

const stopEvent = (e) => !!/** @type {Element} */ (e.target).closest?.('a, button, video, audio, input');

export const FileBlock = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() { return { shareToken: null }; },
  addAttributes() {
    return {
      id: idAttr,
      name: nameAttr,
      size: { default: null, parseHTML: (el) => sizeAttr(el.getAttribute('data-size')), renderHTML: (a) => (a.size == null ? {} : { 'data-size': String(sizeAttr(a.size) ?? '') }) },
      mime: { default: 'application/octet-stream', parseHTML: (el) => mimeOf(el.getAttribute('data-mime')), renderHTML: (a) => ({ 'data-mime': mimeOf(a.mime) }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-attachment]', getAttrs: (el) => (validId(el.getAttribute('data-id')) ? null : false) }]; },
  // Rendu exporté (HTML, presse-papiers) : un simple lien, lisible partout.
  renderHTML({ node, HTMLAttributes }) {
    const url = attachmentUrl(node.attrs.id);
    return ['div', mergeAttributes(HTMLAttributes, { 'data-attachment': '', class: 'attachment' }), url ? ['a', { href: url }, displayName(node.attrs.name)] : 'Pièce jointe invalide'];
  },
  renderText({ node }) { return displayName(node.attrs.name); },

  addNodeView() {
    const { shareToken } = this.options;
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = h('div', { class: 'file-card', contenteditable: 'false', 'data-attachment': '' });
      const paint = () => {
        const { id, name, size, mime } = current.attrs;
        const url = attachmentUrl(id, shareToken);
        if (!url) { dom.replaceChildren(h('p', { class: 'muted' }, 'Pièce jointe invalide.')); return; }
        const { download, remove } = fileActions({ editor, getPos, id: validId(id), name, url });
        remove.hidden = !editor.isEditable;
        const meta = [formatSize(sizeAttr(size)), TYPE_LABEL[mimeOf(mime)]].filter(Boolean).join(' · ');
        dom.replaceChildren(
          h('span', { class: 'file-card-icon', 'aria-hidden': 'true' }, icon(mimeOf(mime) === 'application/pdf' ? 'pdf' : 'paperclip', 20)),
          h('span', { class: 'file-card-text' }, h('span', { class: 'file-card-name' }, displayName(name)), meta && h('span', { class: 'file-card-meta' }, meta)),
          h('span', { class: 'file-card-actions' }, download, remove));
      };
      const refresh = () => { const btn = dom.querySelector('.file-card-actions button'); if (btn) btn.hidden = !editor.isEditable; };
      paint();
      editor.on('update', refresh);
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
        stopEvent,
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => editor.off('update', refresh),
      };
    };
  },
});

// Vidéo ou audio : même structure, seul le lecteur change.
function mediaNode(kind) {
  const video = kind === 'video';
  return Node.create({
    name: kind,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addOptions() { return { shareToken: null }; },
    addAttributes() {
      return {
        id: idAttr,
        name: nameAttr,
        ...(video ? { width: { default: null, parseHTML: (el) => sizeAttr(el.getAttribute('data-width')), renderHTML: (a) => (sizeAttr(a.width) ? { 'data-width': String(sizeAttr(a.width)) } : {}) } } : {}),
      };
    },
    parseHTML() { return [{ tag: `div[data-${kind}]`, getAttrs: (el) => (validId(el.getAttribute('data-id')) ? null : false) }]; },
    renderHTML({ node, HTMLAttributes }) {
      const url = attachmentUrl(node.attrs.id);
      return ['div', mergeAttributes(HTMLAttributes, { [`data-${kind}`]: '' }), url ? ['a', { href: url }, displayName(node.attrs.name)] : 'Pièce jointe invalide'];
    },
    renderText({ node }) { return displayName(node.attrs.name); },

    addNodeView() {
      const { shareToken } = this.options;
      return ({ node, getPos, editor }) => {
        let current = node;
        const id = validId(node.attrs.id);
        const url = attachmentUrl(id, shareToken);
        const dom = h('figure', { class: `media-block media-${kind}`, contenteditable: 'false', [`data-${kind}`]: '' });
        if (!url) {
          dom.append(h('p', { class: 'muted' }, 'Pièce jointe invalide.'));
          return { dom, ignoreMutation: () => true };
        }
        const player = h(kind, { controls: true, preload: 'metadata', src: url, ...(video ? { playsinline: true } : {}) },
          h('a', { href: url, download: '' }, 'Télécharger le fichier'));
        const unavailable = h('p', { class: 'muted media-error', hidden: true }, video ? 'Vidéo indisponible ou format non pris en charge par ce navigateur.' : 'Son indisponible ou format non pris en charge par ce navigateur.');
        player.addEventListener('error', () => { unavailable.hidden = false; });
        const nameEl = h('span', { class: 'media-name' });
        const caption = h('figcaption', { class: 'media-caption' });
        dom.append(player, unavailable, caption);

        const paint = () => {
          const { name } = current.attrs;
          nameEl.textContent = `${video ? 'Vidéo' : 'Audio'} : ${displayName(name)}`;
          const { download, remove } = fileActions({ editor, getPos, id, name, url });
          remove.hidden = !editor.isEditable;
          caption.replaceChildren(icon(video ? 'video' : 'music', 14), nameEl, h('span', { class: 'media-actions' }, download, remove));
        };
        const commit = (width) => {
          const pos = typeof getPos === 'function' ? getPos() : null;
          if (pos == null) return;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width, height: null }));
        };
        const resizer = video ? makeResizable(dom, { editor, label: 'vidéo', commit }) : null;
        const refresh = () => {
          resizer?.apply(current.attrs.width);
          const btn = caption.querySelector('.media-actions button');
          if (btn) /** @type {HTMLElement} */ (btn).hidden = !editor.isEditable;
        };
        paint();
        refresh();
        editor.on('update', refresh);
        return {
          dom,
          update(updated) {
            if (updated.type !== current.type || validId(updated.attrs.id) !== id) return false;
            current = updated;
            paint();
            refresh();
            return true;
          },
          stopEvent: (e) => stopEvent(e) || !!/** @type {Element} */ (e.target).closest?.('.resize-handle'),
          ignoreMutation: () => true,
          selectNode: () => dom.classList.add('selected'),
          deselectNode: () => dom.classList.remove('selected'),
          destroy: () => { editor.off('update', refresh); player.removeAttribute('src'); },
        };
      };
    },
  });
}

export const VideoBlock = mediaNode('video');
export const AudioBlock = mediaNode('audio');

// ---- Envoi ------------------------------------------------------------------

// Le serveur accepte trois envois simultanés par personne : au-delà, les fichiers attendent leur tour.
const MAX_PARALLEL = 3;
const MAX_FILES = 20;

// Position d'insertion suivie pendant l'envoi. En co-édition, une modification distante remplace tout le document
// ProseMirror : une position relative Yjs reste juste ; sans co-édition, on suit les transactions locales.
function trackPosition(editor, pos) {
  const ys = ySyncPluginKey.getState(editor.state);
  if (ys?.binding?.mapping && ys.type && ys.doc) {
    try {
      const rel = absolutePositionToRelativePosition(pos, ys.type, ys.binding.mapping);
      return { get: () => { try { return relativePositionToAbsolutePosition(ys.doc, ys.type, rel, ys.binding.mapping); } catch { return null; } }, stop: () => {} };
    } catch { /* repli ci-dessous */ }
  }
  let cur = pos;
  const onTr = ({ transaction }) => { cur = transaction.mapping.map(cur); };
  editor.on('transaction', onTr);
  return { get: () => cur, stop: () => editor.off('transaction', onTr) };
}

// Message clair pour chaque refus du serveur (le détail renvoyé est en français et ne contient rien d'interne).
function refusal(err) {
  const detail = err?.message;
  switch (err?.status) {
    case 413: return detail || 'Fichier trop lourd.';
    case 429: return detail && !/^Erreur/.test(detail) ? detail : 'Trop d’envois en peu de temps : réessayez dans un instant.';
    case 408: return detail || 'Envoi trop lent ou interrompu.';
    case 403: return 'Vous n’avez pas le droit d’ajouter un fichier à cette page.';
    case 409: return 'Cette page ne reçoit pas de fichier.';
    case 400: case 415: return detail || 'Envoi invalide.';
    case 0: return 'Connexion interrompue : le fichier est peut-être trop lourd, ou le réseau a coupé.';
    default: return detail || 'Envoi impossible.';
  }
}

// Panneau des envois en cours (hors du document : rien n'est partagé avec les autres personnes avant la fin de l'envoi).
let tray = null;
let live = null;
let seq = 0;
function trayEl() {
  if (tray?.isConnected) return tray;
  tray = h('section', { class: 'upload-tray', 'aria-label': 'Envois de fichiers' });
  live = h('p', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  tray.append(live);
  document.body.append(tray);
  return tray;
}
const announce = (text) => { trayEl(); live.textContent = text; };

/**
 * Envoie des fichiers en pièces jointes de la page, puis insère le bloc adapté à la position donnée.
 * @param {any} editor
 * @param {File[]} files
 * @param {{ pageId: string, pos?: number | null, expect?: 'image' | 'video' | 'audio' | 'file', signals: Set<AbortController> }} options
 */
export function uploadFiles(editor, files, { pageId, pos = null, expect = undefined, signals }) {
  const list = [...files].slice(0, MAX_FILES);
  if (files.length > MAX_FILES) toast(`Au plus ${MAX_FILES} fichiers à la fois : les suivants sont ignorés.`, { kind: 'error' });
  const max = Number(session.config?.attachmentMaxMb) || 0;
  const start = pos ?? editor.state.selection.to;
  const jobs = [];
  for (const file of list) {
    if (!file.size) { toast(`« ${displayName(file.name)} » est vide : rien n’est envoyé.`, { kind: 'error' }); continue; }
    if (max && file.size > max * 1024 * 1024) { toast(`« ${displayName(file.name)} » est trop lourd (${max} Mo au plus).`, { kind: 'error', timeout: 7000 }); continue; }
    jobs.push(() => sendOne(editor, file, { pageId, at: trackPosition(editor, start), expect, signals }));
  }
  let next = 0;
  const worker = async () => { while (next < jobs.length) await jobs[next++](); };
  return Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, jobs.length) }, worker));
}

async function sendOne(editor, file, { pageId, at, expect, signals }) {
  const name = displayName(file.name);
  const nameId = `upload-name-${++seq}`;
  const ctrl = new AbortController();
  signals.add(ctrl);
  const bar = h('progress', { max: '100', value: '0', 'aria-labelledby': nameId });
  const pct = h('span', { class: 'upload-pct', 'aria-hidden': 'true' }, '0 %');
  const cancel = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-describedby': nameId, onClick: () => ctrl.abort() }, 'Annuler');
  const item = h('div', { class: 'upload-item' },
    h('span', { class: 'upload-name', id: nameId }, `Envoi de ${name}`), h('span', { class: 'upload-row' }, bar, pct, cancel));
  trayEl().append(item);
  announce(`Envoi de ${name} commencé.`);
  let step = 0;
  try {
    const res = await upload(`/pages/${pageId}/attachments`, file, {
      signal: ctrl.signal,
      onProgress: (ratio) => {
        const p = Math.min(100, Math.round(ratio * 100));
        bar.value = p;
        pct.textContent = `${p} %`;
        // Annonce par paliers de 25 % : assez pour suivre, sans bavarder.
        if (Math.floor(p / 25) > step) { step = Math.floor(p / 25); if (p < 100) announce(`Envoi de ${name} : ${p} %.`); }
      },
    });
    const id = validId(res?.id);
    if (!id) throw new Error('réponse invalide');
    if (editor.isDestroyed) return;
    const node = nodeFor(res, id);
    // Le type retenu est celui reconnu par le serveur sur les octets, pas l'extension : on le dit si cela change le bloc.
    if (expect && expect !== 'file' && kindOf(mimeOf(res.mime)) !== expect) {
      const what = { image: 'une image (PNG, JPEG, GIF ou WebP)', video: 'une vidéo MP4 ou WebM', audio: 'un fichier audio (MP3, Ogg ou WAV)' }[expect];
      toast(`« ${name} » n’est pas reconnu comme ${what} : il est joint tel quel.`, { timeout: 6000 });
    }
    insertAt(editor, at.get(), node);
    announce(`${name} envoyé.`);
  } catch (err) {
    if (err?.data?.aborted) { announce(`Envoi de ${name} annulé.`); return; }
    if (editor.isDestroyed) return;
    const msg = `Envoi de « ${name} » refusé : ${refusal(err)}`;
    announce(msg);
    toast(msg, { kind: 'error', timeout: 8000 });
  } finally {
    at.stop();
    signals.delete(ctrl);
    item.remove();
    if (tray && !tray.querySelector('.upload-item')) setTimeout(() => { if (tray && !tray.querySelector('.upload-item')) { tray.remove(); tray = null; } }, 4000);
  }
}

function nodeFor(res, id) {
  const mime = mimeOf(res.mime);
  const name = cleanName(res.name);
  switch (kindOf(mime)) {
    case 'image': return { type: 'image', attrs: { src: `/api/v3/attachments/${id}`, alt: altFromName(name) || null } };
    case 'video': return { type: 'video', attrs: { id, name } };
    case 'audio': return { type: 'audio', attrs: { id, name } };
    default: return { type: 'attachment', attrs: { id, name, size: sizeAttr(res.size), mime } };
  }
}

function insertAt(editor, pos, node) {
  const size = editor.state.doc.content.size;
  const at = pos == null || pos < 0 || pos > size ? editor.state.selection.to : pos;
  if (!editor.chain().insertContentAt(at, node).run()) editor.chain().insertContentAt(editor.state.doc.content.size, node).run();
}
