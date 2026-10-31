// Actions partagées entre la barre latérale, les vues et les raccourcis.
import { h, timeAgo, fullDate, download, slugify } from './util.js';
import { icon } from './icons.js';
import { request } from './api.js';
import { store } from './store.js';
import { session } from './session.js';
import { askReauth } from './provider-settings.js';
import { prefs, savePrefs, setTheme, currentTheme, app } from './prefs.js';
import { canonicalPath, pagePathById, parseRoute } from './urls.js';
import { toast, openModal, confirmModal, pageIcon } from './ui.js';
import { iconPicker } from './emoji-picker.js';
import { openPalette } from './palette.js';
import { jsonToHTML } from './editor.js';
import { openTemplatePicker, saveAsTemplate } from './templates.js';
import { renderDiff } from './diff.js';

// Exécute une action réseau et affiche l'erreur éventuelle.
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err?.message || 'Une erreur est survenue', { kind: 'error' });
    return undefined;
  }
}

// ---- Navigation -----------------------------------------------------------

// Le routeur lit l'adresse (history API) : go() la change puis le prévient ; les clics sur les liens passent par ici (main.js).
export function go(path) {
  const target = canonicalPath(path) + (app.embed ? '?embed' : '');
  if (location.pathname + location.search !== target) history.pushState(null, '', target);
  window.dispatchEvent(new Event('navigate'));
}

export const currentPageId = () => { const r = parseRoute(location.pathname); return r.kind === 'page' ? r.id : null; };

export const search = () => openPalette({ onOpen: (p) => go(`/p/${p.id}`) });

export async function newPage(spaceId = prefs.space, parentId = null) {
  if (!session.can('write') || !store.canWriteIn(spaceId)) return null;
  const id = await attempt(() => store.createPage({ spaceId, parentId }));
  if (!id) return null;
  if (parentId) { prefs.expanded[parentId] = true; savePrefs(); }
  go(`/p/${id}`);
  return id;
}

export function newPageFromTemplate(spaceId = prefs.space, parentId = null) {
  if (!session.can('write') || !store.canWriteIn(spaceId)) return;
  openTemplatePicker(async (tpl) => {
    const id = await attempt(() => store.createPage({ spaceId, parentId, icon: tpl.icon, content: tpl.content }));
    if (!id) return;
    if (parentId) { prefs.expanded[parentId] = true; savePrefs(); }
    go(`/p/${id}`);
  }, { spaceId });
}

export { saveAsTemplate };

export function toggleSidebar() {
  if (window.innerWidth < 860) {
    document.body.classList.toggle('sb-mobile-open');
  } else {
    prefs.sidebar = !prefs.sidebar;
    savePrefs();
    document.body.classList.toggle('sb-collapsed', !prefs.sidebar);
  }
}

export const toggleTheme = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

// ---- Pages ----------------------------------------------------------------

export async function trash(id) {
  const page = store.page(id);
  if (!page) return;
  const openId = currentPageId();
  const affected = openId && (openId === id || store.isDescendant(openId, id));
  if (!(await attempt(() => store.trashPage(id).then(() => true)))) return;
  if (affected) go(page.parentId ? `/p/${page.parentId}` : `/s/${page.spaceId}`);
  toast(`« ${page.title || 'Sans titre'} » déplacée dans la corbeille`, {
    action: { label: 'Annuler', onClick: () => attempt(() => store.restorePage(id)) },
  });
}

export async function duplicate(id) {
  const copy = await attempt(() => store.duplicatePage(id));
  if (copy) go(`/p/${copy}`);
}

// Copie la page et ses sous-pages lisibles vers un autre espace ; l'original reste en place.
export async function copyToSpace(id, spaceId) {
  const space = store.space(spaceId);
  const result = await attempt(() => request('POST', `/api/v3/pages/${id}/copy`, { spaceId }));
  if (!result) return;
  toast(`Copiée vers ${space?.name ?? 'l’autre espace'} (${result.count} page${result.count > 1 ? 's' : ''}${result.skipped ? `, ${result.skipped} réservée${result.skipped > 1 ? 's' : ''} non copiée${result.skipped > 1 ? 's' : ''}` : ''}).`, {
    action: { label: 'Ouvrir', onClick: () => go(`/p/${result.page.id}`) },
  });
}

export async function moveToSpace(id, spaceId) {
  const space = store.space(spaceId);
  await attempt(async () => {
    await store.movePage(id, null, undefined, spaceId);
    prefs.space = spaceId;
    savePrefs();
    toast(`Page déplacée vers ${space.name}`);
  });
}

export function pickIcon(anchor, id) {
  iconPicker(anchor, (name) => attempt(() => store.updatePage(id, { icon: name })));
}

export const pageUrl = (id, { embed = false } = {}) => `${location.origin}${pagePathById(id)}${embed ? '?embed' : ''}`;

export async function copyLink(id) {
  try {
    await navigator.clipboard.writeText(pageUrl(id));
    toast('Lien copié dans le presse-papiers');
  } catch {
    toast('Copie impossible dans ce contexte', { kind: 'error' });
  }
}

export function showEmbed(id) {
  const page = store.page(id);
  const isPublic = store.space(page?.spaceId)?.visibility === 'public';
  const code = `<iframe src="${pageUrl(id, { embed: true })}" width="100%" height="640" style="border:0;border-radius:12px" loading="lazy" title="Notabene"></iframe>`;
  const area = h('textarea', { class: 'code-area', readonly: true, rows: 4, 'aria-label': 'Code d’intégration à copier' });
  area.value = code;
  openModal({
    title: 'Intégrer cette page',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Collez ce code dans votre portfolio pour afficher la page en lecture seule, sans barre latérale.'),
      area,
      !isPublic && h('div', { class: 'notice warning' }, 'Cet espace est privé : les visiteurs non connectés ne verront pas la page. Rendez l’espace public pour l’intégrer.'),
      h('p', { class: 'hint' }, 'Le domaine du portfolio doit figurer dans EMBED_ALLOWED_ORIGINS côté serveur.')),
    actions: [
      { label: 'Fermer' },
      { label: 'Copier le code', primary: true, onClick: async () => { await navigator.clipboard.writeText(code).catch(() => {}); toast('Code copié'); } },
    ],
  });
}

export async function exportMarkdown(id) {
  const page = store.page(id);
  const md = await attempt(() => request('GET', `/api/v3/pages/${id}/export?format=markdown`));
  if (md != null) download(`${slugify(page?.title)}.md`, md, 'text/markdown');
}

async function buildHTML(id) {
  const page = await attempt(() => store.fetchPage(id));
  if (!page) return null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const title = page.title || 'Sans titre';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.7 Inter,system-ui,sans-serif;color:#1f1f1d;max-width:760px;margin:48px auto;padding:0 20px}
h1{font-size:2.2em;line-height:1.2}pre{background:#f5f4f1;padding:14px 16px;border-radius:8px;overflow:auto}
code{font-family:"JetBrains Mono",monospace;font-size:.9em;background:#f5f4f1;padding:.1em .3em;border-radius:4px}pre code{background:none;padding:0}
blockquote{border-left:3px solid #ddd;margin:0;padding-left:16px;color:#5f5e5b}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #e3e3e0;padding:6px 10px;text-align:left}th{background:#f7f7f5}img{max-width:100%;border-radius:8px}
.callout{background:#f1f0ff;border-radius:8px;padding:12px 16px;margin:1em 0}.callout[data-type=warning]{background:#fff6e0}
.callout[data-type=success]{background:#e8f7ec}.callout[data-type=danger]{background:#fdecec}
ul[data-type=taskList]{list-style:none;padding-left:4px}mark{background:#fff3a3}a{color:#4636d8}
</style></head><body><h1>${esc(title)}</h1>
${jsonToHTML(page.content)}
</body></html>`;
  return { title, html };
}

export async function exportHTML(id) {
  const out = await buildHTML(id);
  if (out) download(`${slugify(out.title)}.html`, out.html, 'text/html');
}

// PDF via le moteur d'impression du navigateur : aucun rendu côté serveur, le contenu reste local.
export async function exportPDF(id) {
  const out = await buildHTML(id);
  if (!out) return;
  const frame = h('iframe', { title: 'Export PDF', sandbox: 'allow-same-origin allow-modals', style: { position: 'fixed', width: '0', height: '0', border: '0' } });
  frame.addEventListener('load', () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  });
  frame.srcdoc = out.html.replace('</style>', '@page{margin:18mm}body{margin:0;max-width:none}</style>');
  document.body.append(frame);
  toast('Choisissez « Enregistrer au format PDF » dans la fenêtre d’impression.');
}

// ---- Historique -----------------------------------------------------------

export async function openHistory(id) {
  const versions = await attempt(() => store.versions(id));
  if (!versions) return;
  if (!versions.length) { toast('Aucune version enregistrée pour le moment.'); return; }
  let selected = 0;
  let mode = 'preview'; // 'preview' : la version telle quelle ; 'diff' : ce qui a changé depuis, par rapport à la version actuelle
  let current = null;
  const list = h('div', { class: 'hist-list' });
  const preview = h('div', { class: 'hist-preview' });
  const canWrite = session.can('write');

  async function render() {
    list.replaceChildren(...versions.map((v, i) => h('button', {
      class: `hist-item${i === selected ? ' active' : ''}`,
      onClick: () => { selected = i; render(); },
    },
    h('strong', null, i === 0 ? 'Version actuelle' : timeAgo(v.createdAt)),
    h('small', null, fullDate(v.createdAt)),
    h('small', null, v.author || 'Import'))));
    preview.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
    const v = await attempt(() => store.version(id, versions[selected].id));
    if (!v) return;
    preview.replaceChildren(...[
      h('div', { class: 'hist-bar' },
        h('span', { class: 'muted' }, `${fullDate(v.createdAt)}${v.author ? ` · ${v.author}` : ''}`),
        canWrite && h('button', {
          class: 'btn btn-primary btn-sm',
          disabled: selected === 0,
          onClick: async () => {
            if (await attempt(() => store.restoreVersion(id, v.id))) { modal.close(); toast('Version restaurée'); }
          },
        }, icon('restore'), 'Restaurer')),
      selected !== 0 && h('div', { class: 'hist-modes', role: 'group', 'aria-label': 'Affichage' },
        ...[['preview', 'Aperçu'], ['diff', 'Différences avec la version actuelle']].map(([key, label]) => h('button', {
          class: `chip${mode === key ? ' active' : ''}`, type: 'button', 'aria-pressed': String(mode === key),
          onClick: () => { mode = key; render(); },
        }, label))),
      mode === 'diff' && selected !== 0
        ? await diffView(v)
        : h('div', { class: 'prose readonly' }, h('h1', null, v.title || 'Sans titre'), h('div', { html: jsonToHTML(v.content) })),
    ].filter(Boolean));
  }

  async function diffView(v) {
    current ||= await attempt(() => store.version(id, versions[0].id));
    if (!current) return h('p', { class: 'muted' }, 'Impossible de charger la version actuelle.');
    return h('div', { class: 'prose readonly' },
      v.title !== current.title && h('p', { class: 'muted' }, `Titre : « ${v.title || 'Sans titre'} » devenu « ${current.title || 'Sans titre'} ».`),
      renderDiff(v.content, current.content));
  }

  const modal = openModal({ title: 'Historique de la page', body: h('div', { class: 'hist' }, list, preview), size: 'wide' });
  render();
}

// ---- Corbeille ------------------------------------------------------------

export async function openTrash() {
  const body = h('div', { class: 'trash' });
  const isAdmin = session.can('admin');
  async function render() {
    const items = await attempt(() => store.trashed());
    if (!items) return;
    if (!items.length) {
      body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, icon('trash', 32)), h('p', null, 'La corbeille est vide.')));
      return;
    }
    body.replaceChildren(...[
      ...items.map((p) => {
        const space = store.space(p.spaceId);
        return h('div', { class: 'trash-row' },
          h('span', { class: 'trash-icon' }, pageIcon(p.icon)),
          h('div', { class: 'trash-text' },
            h('strong', null, p.title || 'Sans titre'),
            h('small', null, `${space ? `${space.name} · ` : ''}supprimée ${timeAgo(p.deletedAt)}`)),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: async () => { if ((await attempt(() => store.restorePage(p.id).then(() => true)))) { render(); toast('Page restaurée'); } },
          }, icon('restore'), 'Restaurer'),
          isAdmin && h('button', {
            class: 'icon-btn danger', title: 'Supprimer définitivement',
            onClick: async () => {
              if (await confirmModal({ title: 'Supprimer définitivement ?', message: `« ${p.title || 'Sans titre'} » et ses sous-pages seront effacées pour de bon.`, confirm: 'Supprimer', danger: true })) {
                await attempt(() => store.destroyPage(p.id));
                render();
              }
            },
          }, icon('trash')));
      }),
      isAdmin && h('div', { class: 'trash-foot' }, h('button', {
        class: 'btn btn-danger btn-sm',
        onClick: async () => {
          if (await confirmModal({ title: 'Vider la corbeille ?', message: 'Toutes les pages de la corbeille seront supprimées définitivement.', confirm: 'Vider', danger: true })) {
            await attempt(() => store.emptyTrash());
            render();
          }
        },
      }, 'Vider la corbeille'))].filter(Boolean));
  }
  openModal({ title: 'Corbeille', body });
  render();
}

// ---- Espaces --------------------------------------------------------------

export function spaceForm(space = null) {
  let spaceIcon = space?.icon || 'folder';
  const iconBtn = h('button', { class: 'emoji-field', type: 'button' }, icon('folder', 20));
  const paintBtn = () => { iconBtn.replaceChildren(pageIcon(spaceIcon, 20)); };
  iconBtn.addEventListener('click', () => iconPicker(iconBtn, (name) => { spaceIcon = name || 'folder'; paintBtn(); }, { allowRemove: false }));
  if (space?.icon) paintBtn();
  const name = h('input', { class: 'input', 'aria-label': 'Nom de l’espace', placeholder: 'Ex. Produit, Équipe design…', maxlength: '80' });
  name.value = space?.name || '';
  const desc = h('textarea', { class: 'input', 'aria-label': 'Description', rows: 3, placeholder: 'À quoi sert cet espace ?', maxlength: '1000' });
  desc.value = space?.description || '';
  const visibility = h('select', { class: 'input' },
    h('option', { value: 'private' }, 'Privé : utilisateurs connectés uniquement'),
    h('option', { value: 'public' }, 'Public : lisible sans connexion (portfolio)'));
  visibility.value = space?.visibility || 'private';
  // Seul un administrateur change la visibilité publique ; un gestionnaire d'espace règle le nom, l'icône et la description.
  const isAdmin = session.can('admin') && space?.kind !== 'personal'; // un espace personnel est toujours privé
  const sharing = h('input', { type: 'checkbox', 'aria-label': 'Autoriser le partage public par lien dans cet espace' });
  sharing.checked = space ? space.sharing !== false : true;
  const access = h('select', { class: 'input', 'aria-label': 'Qui y a accès au départ' },
    h('option', { value: 'admins' }, 'Les administrateurs seulement (j’ajoute ensuite des membres)'),
    h('option', { value: 'everyone' }, 'Tout le monde, en édition'));

  const submit = async () => {
    const values = { name: name.value.trim() || 'Nouvel espace', icon: spaceIcon, description: desc.value.trim(), ...(isAdmin ? { visibility: visibility.value, sharing: sharing.checked } : {}), ...(space ? {} : { access: access.value }) };
    if (space) return (await attempt(() => store.updateSpace(space.id, values).then(() => true))) ? undefined : false;
    const id = await attempt(() => store.createSpace(values));
    if (!id) return false;
    prefs.space = id;
    savePrefs();
    go(`/s/${id}`);
    return undefined;
  };

  openModal({
    title: space ? 'Paramètres de l’espace' : 'Nouvel espace',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Nom'), h('div', { class: 'row' }, iconBtn, name)),
      h('label', { class: 'field' }, h('span', null, 'Description'), desc),
      isAdmin && h('label', { class: 'field' }, h('span', null, 'Visibilité'), visibility),
      isAdmin && h('label', { class: 'check-row' }, sharing, h('span', null, 'Autoriser le partage public par lien', h('small', { class: 'hint' }, 'Décocher retire les liens publics existants de cet espace.'))),
      !space && h('label', { class: 'field' }, h('span', null, 'Accès au départ'), access)),
    actions: [{ label: 'Annuler' }, { label: space ? 'Enregistrer' : 'Créer l’espace', primary: true, onClick: submit }],
  });
  setTimeout(() => name.focus(), 30);
}

export async function createPersonalSpace() {
  const id = await attempt(() => store.createPersonalSpace());
  if (!id) return;
  prefs.space = id;
  savePrefs();
  go(`/s/${id}`);
}

export async function deletePersonalSpace(space) {
  const n = store.pagesIn(space.id).length;
  const ok = await confirmModal({
    title: 'Supprimer mon espace personnel ?',
    message: `L’espace et ses ${n} page${n > 1 ? 's' : ''} seront supprimés définitivement, sans corbeille. Copiez d’abord ce que vous voulez garder dans un autre espace.`,
    confirm: 'Supprimer mon espace',
    danger: true,
  });
  if (!ok) return;
  const reauth = await askReauth('supprimer définitivement mon espace personnel', { strict: true });
  if (!reauth || !(await attempt(() => store.deletePersonalSpace(reauth).then(() => true)))) return;
  prefs.space = store.spaces[0]?.id;
  savePrefs();
  go(prefs.space ? `/s/${prefs.space}` : '/');
}

export async function deleteSpace(space) {
  if (store.spaces.filter((s) => s.kind !== 'personal').length <= 1) { toast('Il faut garder au moins un espace.'); return; }
  const n = store.pagesIn(space.id).length;
  const ok = await confirmModal({
    title: `Supprimer « ${space.name} » ?`,
    message: `L’espace et ses ${n} page${n > 1 ? 's' : ''} seront supprimés définitivement.`,
    confirm: 'Supprimer l’espace',
    danger: true,
  });
  if (!ok || !(await attempt(() => store.deleteSpace(space.id).then(() => true)))) return;
  prefs.space = store.spaces[0]?.id;
  savePrefs();
  go(`/s/${prefs.space}`);
}
