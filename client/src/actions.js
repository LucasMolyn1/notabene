// Actions partagées entre la barre latérale, les vues et les raccourcis.
import { h, timeAgo, fullDate, download, slugify } from './util.js';
import { icon } from './icons.js';
import { api, request } from './api.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, setTheme, currentTheme } from './prefs.js';
import { toast, openModal, confirmModal, emojiPicker } from './ui.js';
import { openPalette } from './palette.js';
import { jsonToHTML } from './editor.js';

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

export function go(path) {
  if (location.hash.slice(1) === path) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = path;
}

export const currentPageId = () => location.hash.match(/^#\/p\/([^/?#]+)/)?.[1] || null;

export const search = () => openPalette({ onOpen: (p) => go(`/p/${p.id}`) });

export async function newPage(spaceId = prefs.space, parentId = null) {
  if (!session.can('write')) return null;
  const id = await attempt(() => store.createPage({ spaceId, parentId }));
  if (!id) return null;
  if (parentId) { prefs.expanded[parentId] = true; savePrefs(); }
  go(`/p/${id}`);
  return id;
}

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

export async function moveToSpace(id, spaceId) {
  const space = store.space(spaceId);
  await attempt(async () => {
    await store.movePage(id, null, undefined, spaceId);
    prefs.space = spaceId;
    savePrefs();
    toast(`Page déplacée vers ${space.icon} ${space.name}`);
  });
}

export function pickIcon(anchor, id) {
  emojiPicker(anchor, (emoji) => attempt(() => store.updatePage(id, { icon: emoji })));
}

export const pageUrl = (id, { embed = false } = {}) => `${location.origin}/${embed ? '?embed' : ''}#/p/${id}`;

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
  const area = h('textarea', { class: 'code-area', readonly: true, rows: 4 });
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
  const md = await attempt(() => request('GET', `/api/v1/pages/${id}/export?format=markdown`));
  if (md != null) download(`${slugify(page?.title)}.md`, md, 'text/markdown');
}

export async function exportHTML(id) {
  const page = await attempt(() => store.fetchPage(id));
  if (!page) return;
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
</style></head><body><h1>${esc(page.icon || '')} ${esc(title)}</h1>
${jsonToHTML(page.content)}
</body></html>`;
  download(`${slugify(title)}.html`, html, 'text/html');
}

// ---- Historique -----------------------------------------------------------

export async function openHistory(id) {
  const versions = await attempt(() => store.versions(id));
  if (!versions) return;
  if (!versions.length) { toast('Aucune version enregistrée pour le moment.'); return; }
  let selected = 0;
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
    preview.replaceChildren(
      h('div', { class: 'hist-bar' },
        h('span', { class: 'muted' }, `${fullDate(v.createdAt)}${v.author ? ` · ${v.author}` : ''}`),
        canWrite && h('button', {
          class: 'btn btn-primary btn-sm',
          disabled: selected === 0,
          onClick: async () => {
            if (await attempt(() => store.restoreVersion(id, v.id))) { modal.close(); toast('Version restaurée'); }
          },
        }, icon('restore'), 'Restaurer')),
      h('div', { class: 'prose readonly' }, h('h1', null, v.title || 'Sans titre'), h('div', { html: jsonToHTML(v.content) })));
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
      body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, '🧹'), h('p', null, 'La corbeille est vide.')));
      return;
    }
    body.replaceChildren(...[
      ...items.map((p) => {
        const space = store.space(p.spaceId);
        return h('div', { class: 'trash-row' },
          h('span', { class: 'trash-icon' }, p.icon || '📄'),
          h('div', { class: 'trash-text' },
            h('strong', null, p.title || 'Sans titre'),
            h('small', null, `${space ? `${space.icon} ${space.name} · ` : ''}supprimée ${timeAgo(p.deletedAt)}`)),
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
  let emoji = space?.icon || '📁';
  const iconBtn = h('button', { class: 'emoji-field', type: 'button' }, emoji);
  iconBtn.addEventListener('click', () => emojiPicker(iconBtn, (e) => { emoji = e || '📁'; iconBtn.textContent = emoji; }, { allowRemove: false }));
  const name = h('input', { class: 'input', placeholder: 'Ex. Produit, Équipe design…', maxlength: '80' });
  name.value = space?.name || '';
  const desc = h('textarea', { class: 'input', rows: 3, placeholder: 'À quoi sert cet espace ?', maxlength: '1000' });
  desc.value = space?.description || '';
  const visibility = h('select', { class: 'input' },
    h('option', { value: 'private' }, '🔒 Privé : utilisateurs connectés uniquement'),
    h('option', { value: 'public' }, '🌍 Public : lisible sans connexion (portfolio)'));
  visibility.value = space?.visibility || 'private';

  const submit = async () => {
    const values = { name: name.value.trim() || 'Nouvel espace', icon: emoji, description: desc.value.trim(), visibility: visibility.value };
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
      h('label', { class: 'field' }, h('span', null, 'Visibilité'), visibility)),
    actions: [{ label: 'Annuler' }, { label: space ? 'Enregistrer' : 'Créer l’espace', primary: true, onClick: submit }],
  });
  setTimeout(() => name.focus(), 30);
}

export async function deleteSpace(space) {
  if (store.spaces.length <= 1) { toast('Il faut garder au moins un espace.'); return; }
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

// ---- Jetons d'API ----------------------------------------------------------

const SCOPE_LABELS = {
  read: ['Lecture', 'Lire les espaces, pages, versions et effectuer des recherches'],
  write: ['Écriture', 'Créer, modifier, déplacer et mettre à la corbeille des pages'],
  ai: ['IA', 'Poser des questions à la recherche IA'],
  admin: ['Administration', 'Gérer les espaces, les réglages et lire le journal d’audit'],
};
const ROLE_SCOPES = { reader: ['read', 'ai'], editor: ['read', 'write', 'ai'], admin: ['read', 'write', 'ai', 'admin'] };

export async function openTokens() {
  const body = h('div', { class: 'stack' });
  const allowed = ROLE_SCOPES[session.user.role] || ['read'];

  async function render(created = null) {
    const tokens = await attempt(() => api.get('/tokens'));
    if (!tokens) return;
    const name = h('input', { class: 'input', placeholder: 'Ex. CI GitHub, script de sauvegarde…', maxlength: '80' });
    const checks = allowed.map((s) => {
      const box = h('input', { type: 'checkbox', value: s });
      if (s === 'read') box.checked = true;
      return h('label', { class: 'check' }, box, h('span', null, h('strong', null, SCOPE_LABELS[s][0]), h('small', null, SCOPE_LABELS[s][1])));
    });
    const expiry = h('select', { class: 'input' },
      h('option', { value: '7' }, '7 jours'), h('option', { value: '30' }, '30 jours'),
      h('option', { value: '90' }, '90 jours'), h('option', { value: '365' }, '1 an'));
    expiry.value = '90';

    const create = async () => {
      const scopes = checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      if (!name.value.trim()) { toast('Donnez un nom au jeton', { kind: 'error' }); return; }
      if (!scopes.length) { toast('Choisissez au moins une portée', { kind: 'error' }); return; }
      const result = await attempt(() => api.post('/tokens', { name: name.value.trim(), scopes, expiresInDays: Number(expiry.value) }));
      if (result) render(result);
    };

    const revealed = created && h('div', { class: 'notice success stack' },
      h('strong', null, 'Copiez ce jeton maintenant : il ne sera plus jamais affiché.'),
      h('div', { class: 'row' },
        h('code', { class: 'token-value' }, created.token),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigator.clipboard.writeText(created.token).then(() => toast('Jeton copié')) }, icon('copy', 14), 'Copier')),
      h('pre', { class: 'code-sample' }, `curl -H "Authorization: Bearer ${created.token.slice(0, 10)}…" \\\n  ${location.origin}/api/v1/spaces`));

    body.replaceChildren(...[
      revealed,
      h('div', { class: 'token-form stack' },
        h('label', { class: 'field' }, h('span', null, 'Nom'), name),
        h('div', { class: 'field' }, h('span', null, 'Portées'), h('div', { class: 'checks' }, checks)),
        h('div', { class: 'row' },
          h('label', { class: 'field grow' }, h('span', null, 'Expiration'), expiry),
          h('button', { class: 'btn btn-primary', onClick: create }, icon('plus', 15), 'Créer le jeton'))),
      h('div', { class: 'section-label' }, 'Mes jetons'),
      tokens.length
        ? h('div', { class: 'token-list' }, tokens.map((t) => {
          const expired = t.expiresAt < Date.now();
          const state = t.revokedAt ? 'Révoqué' : expired ? 'Expiré' : `Expire ${timeAgo(t.expiresAt)}`;
          return h('div', { class: `token-row${t.revokedAt || expired ? ' inactive' : ''}` },
            h('div', { class: 'grow' },
              h('strong', null, t.name),
              h('small', null, `${t.prefix}… · ${t.scopes.join(', ')} · ${state}${t.lastUsedAt ? ` · utilisé ${timeAgo(t.lastUsedAt)}` : ' · jamais utilisé'}`)),
            !t.revokedAt && !expired && h('button', {
              class: 'btn btn-ghost btn-sm danger-text',
              onClick: async () => {
                if (await confirmModal({ title: 'Révoquer ce jeton ?', message: `« ${t.name} » cessera immédiatement de fonctionner.`, confirm: 'Révoquer', danger: true })) {
                  await attempt(() => api.del(`/tokens/${t.id}`));
                  render();
                }
              },
            }, 'Révoquer'));
        }))
        : h('p', { class: 'muted' }, 'Aucun jeton pour le moment.'),
      h('p', { class: 'hint' }, h('a', { href: '/api/docs', target: '_blank', rel: 'noopener' }, 'Documentation de l’API (OpenAPI) →'))].filter(Boolean));
  }

  openModal({ title: 'Jetons d’API', body, size: 'medium' });
  render();
}

// ---- Réglages IA (admin) ----------------------------------------------------

const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4o-mini', 'mistral-large-latest', 'llama3.1:8b'],
};

export async function openAiSettings() {
  const current = await attempt(() => api.get('/admin/ai'));
  if (!current) return;
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = current.enabled;
  const provider = h('select', { class: 'input' },
    h('option', { value: 'anthropic' }, 'Anthropic Claude'),
    h('option', { value: 'openai' }, 'Compatible OpenAI (OpenAI, Mistral, Ollama, LM Studio…)'));
  provider.value = current.provider;
  const baseUrl = h('input', { class: 'input', placeholder: 'https://api.openai.com/v1', value: current.baseUrl || '' });
  const model = h('input', { class: 'input', list: 'ai-models', value: current.model });
  const models = h('datalist', { id: 'ai-models' });
  const apiKey = h('input', {
    class: 'input', type: 'password', autocomplete: 'off',
    placeholder: current.hasKey ? `Clé enregistrée (${current.keyHint}) : laisser vide pour la conserver` : 'Collez la clé d’API',
  });
  const removeKey = h('input', { type: 'checkbox' });
  const result = h('div', { class: 'hint' });
  const baseField = h('label', { class: 'field' }, h('span', null, 'URL de base'), baseUrl,
    h('small', { class: 'hint' }, 'Pour Ollama : http://ollama:11434/v1 · LM Studio : http://hote:1234/v1'));

  const paint = () => {
    baseField.hidden = provider.value !== 'openai';
    models.replaceChildren(...MODEL_SUGGESTIONS[provider.value].map((m) => h('option', { value: m })));
  };
  provider.addEventListener('change', () => {
    paint();
    if (!MODEL_SUGGESTIONS[provider.value].includes(model.value)) model.value = MODEL_SUGGESTIONS[provider.value][0];
  });
  paint();

  const save = async () => {
    const payload = { enabled: enabled.checked, provider: provider.value, baseUrl: provider.value === 'openai' ? baseUrl.value.trim() : '', model: model.value.trim() };
    if (removeKey.checked) payload.apiKey = '';
    else if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
    const saved = await attempt(() => api.put('/admin/ai', payload));
    if (!saved) return false;
    apiKey.value = '';
    await session.load();
    toast('Réglages IA enregistrés');
    return undefined;
  };

  openModal({
    title: 'Recherche IA',
    size: 'medium',
    body: h('div', { class: 'stack' },
      h('label', { class: 'check' }, enabled, h('span', null, h('strong', null, 'Activer la recherche IA'), h('small', null, 'Les utilisateurs pourront interroger la documentation qu’ils ont le droit de lire.'))),
      h('label', { class: 'field' }, h('span', null, 'Fournisseur'), provider),
      baseField,
      h('label', { class: 'field' }, h('span', null, 'Modèle'), model, models),
      h('label', { class: 'field' }, h('span', null, 'Clé d’API'), apiKey,
        h('small', { class: 'hint' }, 'Chiffrée (AES-256-GCM) côté serveur et jamais renvoyée au navigateur. Optionnelle pour un modèle local.')),
      current.hasKey && h('label', { class: 'check' }, removeKey, h('span', null, 'Supprimer la clé enregistrée')),
      h('div', { class: 'notice info' }, 'Seuls des extraits des pages pertinentes sont envoyés au fournisseur, jamais l’ensemble du wiki. Avec un modèle local (Ollama), aucune donnée ne quitte votre infrastructure.'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-ghost btn-sm',
          onClick: async () => {
            if ((await save()) === false) return;
            result.textContent = 'Test en cours…';
            const r = await attempt(() => api.post('/admin/ai/test'));
            result.textContent = r?.ok ? `✅ Connexion réussie (« ${r.sample} »)` : `❌ ${r?.message || 'Échec'}`;
          },
        }, 'Enregistrer et tester'),
        result)),
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: save }],
  });
}
