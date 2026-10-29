// Page Paramètres : compte, fonctionnalités (IA, diagrammes, API, intégration) et administration.
import { h, initials, timeAgo, fullDate } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, setTheme } from './prefs.js';
import { colorFor } from './presence.js';
import { toast, confirmModal } from './ui.js';
import { openDrawio, openExcalidraw } from './diagrams.js';
import { beginView, setView, topbar } from './views.js';
import * as A from './actions.js';

const ROLE_LABELS = { admin: 'Administrateur', editor: 'Éditeur', reader: 'Lecteur' };
const REPO_URL = 'https://github.com/LucasMolyn1/notabene';

// ---- Composants ----------------------------------------------------------------

const card = (title, desc, ...body) => h('section', { class: 'set-card' },
  (title || desc) && h('header', { class: 'set-card-head' }, title && h('h3', null, title), desc && h('p', { class: 'muted' }, desc)),
  ...body);

const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));

const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
const status = (ok, onText = 'Actif', offText = 'Inactif') => pill(ok ? `● ${onText}` : `○ ${offText}`, ok ? 'ok' : 'off');

function copyable(value) {
  return h('span', { class: 'copyable' }, h('code', null, value),
    h('button', { class: 'mini-btn', title: 'Copier', onClick: () => navigator.clipboard.writeText(value).then(() => toast('Copié')) }, icon('copy', 14)));
}

function toggle(label, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch-input' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('strong', null, label), desc && h('small', null, desc)), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
}

const loadingEl = () => h('p', { class: 'muted' }, 'Chargement…');

// ---- Compte ---------------------------------------------------------------------

async function renderProfile(el) {
  const u = session.user;
  const perms = [['read', 'Lire les pages'], ['write', 'Créer et modifier des pages'], ['ai', 'Utiliser la recherche IA'], ['admin', 'Administrer l’instance']];
  const sessionsBox = h('div', null, loadingEl());
  el.replaceChildren(
    card(null, null, h('div', { class: 'profile' },
      h('span', { class: 'avatar xl static', style: { '--c': colorFor(u.id) } }, initials(u.name)),
      h('div', null,
        h('h2', null, u.name),
        h('p', { class: 'muted' }, u.email || 'Adresse e-mail non communiquée par le fournisseur'),
        h('div', { class: 'row' }, pill(ROLE_LABELS[u.role], 'accent'), pill(session.config.auth.oidc ? 'Connecté via Authentik (OIDC)' : 'Connexion de développement'))))),
    card('Permissions', 'Votre rôle est attribué par vos groupes Authentik et recalculé à chaque connexion.',
      h('ul', { class: 'perm-list' }, perms.map(([key, label]) => h('li', { class: session.can(key) ? 'ok' : 'off' }, session.can(key) ? '✓' : '✕', ' ', label)))),
    card('Sessions actives', 'Chaque navigateur connecté ouvre une session distincte, valable au maximum la durée configurée.', sessionsBox),
    card('Déconnexion', null, h('button', { class: 'btn btn-ghost', onClick: () => session.logout() }, icon('move', 15), 'Se déconnecter')));

  const sessions = await A.attempt(() => api.get('/sessions'));
  if (!sessions) return;
  sessionsBox.replaceChildren(
    h('div', { class: 'table' }, sessions.map((s) => h('div', { class: 'table-row' },
      h('span', { class: 'grow' }, h('strong', null, s.current ? 'Cette session' : `Session ${s.id}`), h('small', null, `Ouverte ${timeAgo(s.createdAt)} · active ${timeAgo(s.lastSeenAt)} · expire ${timeAgo(s.expiresAt)}`)),
      s.current && pill('Actuelle', 'ok')))),
    sessions.length > 1
      ? h('button', {
        class: 'btn btn-ghost btn-sm danger-text',
        onClick: async () => {
          if (!(await confirmModal({ title: 'Fermer les autres sessions ?', message: 'Les autres navigateurs devront se reconnecter.', confirm: 'Fermer', danger: true }))) return;
          const r = await A.attempt(() => api.del('/sessions/others'));
          if (r) { toast(`${r.closed} session(s) fermée(s)`); renderProfile(el); }
        },
      }, 'Déconnecter mes autres sessions')
      : h('p', { class: 'hint' }, 'Aucune autre session ouverte.'));
}

function renderAppearance(el) {
  const choice = (value, label, preview) => {
    const input = h('input', { type: 'radio', name: 'theme', value });
    input.checked = (prefs.theme ?? null) === value;
    input.addEventListener('change', () => { setTheme(value); toast('Thème appliqué'); });
    return h('label', { class: 'theme-choice' }, input, h('span', { class: `theme-preview ${preview}` }, h('i'), h('i'), h('i')), h('span', null, label));
  };
  el.replaceChildren(
    card('Thème', 'S’applique à ce navigateur.', h('div', { class: 'theme-grid' }, choice('light', 'Clair', 'light'), choice('dark', 'Sombre', 'dark'), choice(null, 'Système', 'system'))),
    card('Lecture et navigation', null,
      session.can('write') && toggle('Ouvrir les pages en mode lecture', 'Évite les modifications accidentelles ; le bouton « Éditer » reste disponible sur chaque page.', prefs.readOnly, (v) => { prefs.readOnly = v; savePrefs(); }),
      toggle('Barre latérale repliée', `Raccourci : ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} \\`, !prefs.sidebar, (v) => { prefs.sidebar = !v; savePrefs(); document.body.classList.toggle('sb-collapsed', v); })),
    card('Raccourcis clavier', null, kv([['⌘K / Ctrl K', 'Rechercher, puis Tab pour demander à l’IA'], ['⌥N / Alt N', 'Nouvelle page'], ['⌘\\ / Ctrl \\', 'Afficher ou masquer la barre latérale'], ['/', 'Menu d’insertion dans l’éditeur']])));
}

// ---- Jetons d'API -----------------------------------------------------------------

const SCOPE_LABELS = {
  read: ['Lecture', 'Lire les espaces, pages, versions et effectuer des recherches'],
  write: ['Écriture', 'Créer, modifier, déplacer et mettre à la corbeille des pages'],
  ai: ['IA', 'Poser des questions à la recherche IA'],
  admin: ['Administration', 'Gérer les espaces, les réglages et lire le journal d’audit'],
};
const ROLE_SCOPES = { reader: ['read', 'ai'], editor: ['read', 'write', 'ai'], admin: ['read', 'write', 'ai', 'admin'] };

async function renderTokens(el, created = null) {
  el.replaceChildren(loadingEl());
  const tokens = await A.attempt(() => api.get('/tokens'));
  if (!tokens) return;
  const allowed = ROLE_SCOPES[session.user.role] || ['read'];
  const name = h('input', { class: 'input', placeholder: 'Ex. CI GitHub, script de sauvegarde…', maxlength: '80' });
  const checks = allowed.map((s) => {
    const box = h('input', { type: 'checkbox', value: s });
    box.checked = s === 'read';
    return h('label', { class: 'check' }, box, h('span', null, h('strong', null, SCOPE_LABELS[s][0]), h('small', null, SCOPE_LABELS[s][1])));
  });
  const expiry = h('select', { class: 'input' }, [['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours'], ['365', '1 an']].map(([v, l]) => h('option', { value: v }, l)));
  expiry.value = '90';

  const create = async () => {
    const scopes = checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
    if (!name.value.trim()) { toast('Donnez un nom au jeton', { kind: 'error' }); return; }
    if (!scopes.length) { toast('Choisissez au moins une portée', { kind: 'error' }); return; }
    const result = await A.attempt(() => api.post('/tokens', { name: name.value.trim(), scopes, expiresInDays: Number(expiry.value) }));
    if (result) renderTokens(el, result);
  };

  el.replaceChildren(...[
    created && h('div', { class: 'notice success stack' },
      h('strong', null, 'Copiez ce jeton maintenant : il ne sera plus jamais affiché.'),
      h('div', { class: 'row' },
        h('code', { class: 'token-value' }, created.token),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigator.clipboard.writeText(created.token).then(() => toast('Jeton copié')) }, icon('copy', 14), 'Copier')),
      h('pre', { class: 'code-sample' }, `curl -H "Authorization: Bearer $NOTABENE_TOKEN" \\\n  ${location.origin}/api/v1/spaces`)),
    card('Nouveau jeton', 'Les portées sont limitées par votre rôle. Un jeton ne peut jamais en créer un autre.',
      h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', null, 'Nom'), name),
        h('div', { class: 'field' }, h('span', null, 'Portées'), h('div', { class: 'checks' }, checks)),
        h('div', { class: 'row' },
          h('label', { class: 'field grow' }, h('span', null, 'Expiration'), expiry),
          h('button', { class: 'btn btn-primary', onClick: create }, icon('plus', 15), 'Créer le jeton')))),
    card('Mes jetons', null, tokens.length
      ? h('div', { class: 'table' }, tokens.map((t) => {
        const expired = t.expiresAt < Date.now();
        const state = t.revokedAt ? 'Révoqué' : expired ? 'Expiré' : `Expire ${timeAgo(t.expiresAt)}`;
        return h('div', { class: `table-row${t.revokedAt || expired ? ' inactive' : ''}` },
          h('span', { class: 'grow' },
            h('strong', null, t.name),
            h('small', null, `${t.prefix}… · ${t.scopes.join(', ')} · ${state} · ${t.lastUsedAt ? `utilisé ${timeAgo(t.lastUsedAt)}` : 'jamais utilisé'}`)),
          !t.revokedAt && !expired && h('button', {
            class: 'btn btn-ghost btn-sm danger-text',
            onClick: async () => {
              if (!(await confirmModal({ title: 'Révoquer ce jeton ?', message: `« ${t.name} » cessera immédiatement de fonctionner.`, confirm: 'Révoquer', danger: true }))) return;
              await A.attempt(() => api.del(`/tokens/${t.id}`));
              renderTokens(el);
            },
          }, 'Révoquer'));
      }))
      : h('p', { class: 'muted' }, 'Aucun jeton pour le moment.')),
  ].filter(Boolean));
}

// ---- API REST ----------------------------------------------------------------------

function renderApi(el) {
  const base = `${location.origin}/api/v1`;
  el.replaceChildren(
    card('Point d’accès', null, kv([
      ['URL de base', copyable(base)],
      ['Authentification', h('code', null, 'Authorization: Bearer nb_…')],
      ['Documentation', h('span', { class: 'row' },
        h('a', { class: 'btn btn-ghost btn-sm', href: '/api/docs', target: '_blank', rel: 'noopener' }, 'Swagger UI ↗'),
        h('a', { class: 'btn btn-ghost btn-sm', href: '/api/docs/json', target: '_blank', rel: 'noopener' }, 'OpenAPI JSON ↗'))],
    ]), h('button', { class: 'btn btn-primary btn-sm', onClick: () => A.go('/settings/tokens') }, icon('code', 14), 'Gérer mes jetons')),
    card('Exemples', null, h('pre', { class: 'code-sample' }, [
      'export NOTABENE_TOKEN="nb_…"',
      '',
      '# Lister les espaces',
      `curl -H "Authorization: Bearer $NOTABENE_TOKEN" ${base}/spaces`,
      '',
      '# Rechercher (insensible aux accents)',
      `curl -H "Authorization: Bearer $NOTABENE_TOKEN" "${base}/search?q=deploiement"`,
      '',
      '# Créer une page (portée write)',
      `curl -X POST -H "Authorization: Bearer $NOTABENE_TOKEN" -H "Content-Type: application/json" \\`,
      `  -d '{"spaceId":"<id>","title":"Créée par API"}' ${base}/pages`,
      '',
      '# Exporter une page en Markdown',
      `curl -H "Authorization: Bearer $NOTABENE_TOKEN" ${base}/pages/<id>/export`,
    ].join('\n'))),
    card('Routes principales', null, h('div', { class: 'table' }, [
      ['GET', '/spaces', 'read'], ['GET', '/pages', 'read'], ['GET', '/pages/:id', 'read'], ['POST', '/pages', 'write'],
      ['PATCH', '/pages/:id', 'write'], ['POST', '/pages/:id/move', 'write'], ['DELETE', '/pages/:id', 'write'],
      ['GET', '/pages/:id/versions', 'read'], ['GET', '/search?q=', 'read'], ['POST', '/ai/ask', 'ai'], ['GET', '/admin/audit', 'admin'],
    ].map(([m, path, scope]) => h('div', { class: 'table-row' }, h('code', { class: `method ${m.toLowerCase()}` }, m), h('code', { class: 'grow' }, path), pill(scope))))));
}

// ---- Recherche IA ------------------------------------------------------------------

const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4o-mini', 'mistral-large-latest', 'llama3.1:8b'],
};

async function renderAi(el) {
  const usage = card('Utilisation', null, h('p', null, 'Ouvrez la recherche avec ', h('kbd', null, '⌘K'), ', puis appuyez sur ', h('kbd', null, 'Tab'),
    ' pour passer à l’onglet « Demander à l’IA ». Les réponses s’appuient uniquement sur les pages que vous pouvez lire et citent leurs sources.'),
  session.can('ai') && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => A.search() }, '✨ Essayer maintenant'));

  if (!session.can('admin')) {
    el.replaceChildren(card('État', null, kv([['Recherche IA', status(session.config.ai, 'Activée', 'Non configurée')]]),
      !session.config.ai && h('p', { class: 'hint' }, 'Un administrateur doit configurer un fournisseur.')), usage);
    return;
  }

  el.replaceChildren(loadingEl());
  const current = await A.attempt(() => api.get('/admin/ai'));
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
  const result = h('span', { class: 'hint' });
  const baseField = h('label', { class: 'field' }, h('span', null, 'URL de base'), baseUrl,
    h('small', { class: 'hint' }, 'Ollama : http://ollama:11434/v1 · LM Studio : http://hote:1234/v1'));

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
    const saved = await A.attempt(() => api.put('/admin/ai', payload));
    if (!saved) return false;
    await session.load();
    toast('Réglages IA enregistrés');
    renderAi(el);
    return true;
  };

  el.replaceChildren(
    card('Fournisseur', 'Réglage commun à toute l’instance.', h('div', { class: 'stack' },
      h('label', { class: 'check' }, enabled, h('span', null, h('strong', null, 'Activer la recherche IA'), h('small', null, 'Les utilisateurs pourront interroger la documentation qu’ils ont le droit de lire.'))),
      h('label', { class: 'field' }, h('span', null, 'Fournisseur'), provider),
      baseField,
      h('label', { class: 'field' }, h('span', null, 'Modèle'), model, models),
      h('label', { class: 'field' }, h('span', null, 'Clé d’API'), apiKey,
        h('small', { class: 'hint' }, 'Chiffrée (AES-256-GCM) côté serveur et jamais renvoyée au navigateur. Optionnelle pour un modèle local.')),
      current.hasKey && h('label', { class: 'check' }, removeKey, h('span', null, 'Supprimer la clé enregistrée')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onClick: save }, 'Enregistrer'),
        h('button', {
          class: 'btn btn-ghost',
          onClick: async () => {
            if (!(await save())) return;
            result.textContent = 'Test en cours…';
            const r = await A.attempt(() => api.post('/admin/ai/test'));
            result.textContent = r?.ok ? `✅ Connexion réussie (« ${r.sample} »)` : `❌ ${r?.message || 'Échec'}`;
          },
        }, 'Enregistrer et tester'),
        result))),
    card('Confidentialité', null, h('div', { class: 'notice info' }, 'Pour chaque question, seuls des extraits des pages pertinentes et lisibles par l’utilisateur sont envoyés au fournisseur, jamais tout le wiki. Avec un modèle local (Ollama), aucune donnée ne quitte votre infrastructure.')),
    usage);
}

// ---- Diagrammes ------------------------------------------------------------------------

function renderDiagrams(el) {
  const drawio = session.config.drawioUrl;
  const tool = (emoji, name, desc, state, cmd, tryIt) => h('div', { class: 'tool-card' },
    h('div', { class: 'tool-emoji' }, emoji),
    h('div', { class: 'grow' }, h('strong', null, name), h('p', { class: 'muted' }, desc),
      h('div', { class: 'row' }, state, h('code', null, cmd))),
    tryIt && h('button', { class: 'btn btn-ghost btn-sm', onClick: tryIt }, 'Essayer'));
  const scratch = (label) => () => toast(`${label} : brouillon non enregistré (insérez-le dans une page avec le menu /).`);
  el.replaceChildren(
    card('Outils disponibles', 'Insérez un diagramme dans n’importe quelle page avec le menu « / ».', h('div', { class: 'stack' },
      tool('◇', 'Mermaid', 'Schémas décrits en texte : organigrammes, séquences, Gantt, classes… Rendu sécurisé (mode strict).', status(true, 'Intégré'), '/mermaid'),
      tool('✏️', 'Excalidraw', 'Dessin à main levée, chargé à la demande. Polices servies par votre serveur.', status(true, 'Intégré'), '/excalidraw',
        () => openExcalidraw({ scene: '', svg: '' }, scratch('Excalidraw'))),
      tool('⬡', 'Draw.io', drawio ? `Instance auto-hébergée : ${drawio}` : 'Nécessite le conteneur Draw.io et la variable DRAWIO_URL.',
        status(!!drawio, 'Configuré', 'Non configuré'), '/drawio', drawio && (() => openDrawio({ xml: '', svg: '' }, scratch('Draw.io')))))),
    card('Sécurité', null, h('p', { class: 'muted' }, 'Les dessins Excalidraw et Draw.io sont enregistrés en SVG et affichés comme images : aucun script ne peut s’exécuter dans la page. Les messages de Draw.io ne sont acceptés que depuis l’origine configurée.')));
}

// ---- Intégration portfolio ------------------------------------------------------------

async function renderEmbed(el) {
  const publicSpaces = store.spaces.filter((s) => s.visibility === 'public');
  const pages = store.recent(null, 500).filter((p) => publicSpaces.some((s) => s.id === p.spaceId));
  const select = h('select', { class: 'input' }, pages.map((p) => h('option', { value: p.id }, `${p.icon || '📄'} ${p.title || 'Sans titre'}`)));
  const height = h('input', { class: 'input', type: 'number', min: '200', max: '2000', value: '640' });
  const code = h('textarea', { class: 'code-area', readonly: true, rows: 4 });
  const open = h('a', { class: 'btn btn-ghost btn-sm', target: '_blank', rel: 'noopener' }, 'Aperçu ↗');
  const paint = () => {
    const id = select.value;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
    const url = A.pageUrl(id, { embed: true });
    const h$ = Number(height.value) || 640;
    code.value = `<iframe src="${url}" width="100%" height="${h$}" style="border:0;border-radius:12px" loading="lazy" title="Notabene"></iframe>`;
    open.href = url;
  };
  select.addEventListener('change', paint);
  height.addEventListener('input', paint);

  let origins = null;
  if (session.can('admin')) origins = (await A.attempt(() => api.get('/admin/instance')))?.integrations.embedAllowedOrigins ?? [];

  el.replaceChildren(
    card('1. Espaces publics', 'Seuls les espaces publics sont visibles sans connexion, donc intégrables.', h('div', { class: 'table' },
      store.spaces.map((s) => h('div', { class: 'table-row' },
        h('span', { class: 'grow' }, `${s.icon} ${s.name}`),
        s.visibility === 'public' ? pill('🌍 Public', 'ok') : pill('🔒 Privé', 'off'),
        session.can('admin') && h('button', {
          class: 'btn btn-ghost btn-sm',
          onClick: async () => {
            await A.attempt(() => store.updateSpace(s.id, { visibility: s.visibility === 'public' ? 'private' : 'public' }));
            renderEmbed(el);
          },
        }, s.visibility === 'public' ? 'Rendre privé' : 'Rendre public'))))),
    card('2. Sites autorisés', 'Origines autorisées à afficher Notabene en iframe (variable EMBED_ALLOWED_ORIGINS, en-tête CSP frame-ancestors).',
      origins === null
        ? h('p', { class: 'hint' }, 'Visible par les administrateurs.')
        : origins.length ? h('div', { class: 'row wrap' }, origins.map((o) => pill(o, 'accent'))) : h('div', { class: 'notice warning' }, 'Aucune origine autorisée : ajoutez le domaine de votre portfolio dans EMBED_ALLOWED_ORIGINS puis redémarrez le conteneur.')),
    card('3. Code d’intégration', 'Affiche la page en lecture seule, sans barre latérale.',
      pages.length
        ? h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, 'Page'), select), h('label', { class: 'field' }, h('span', null, 'Hauteur (px)'), height)),
          code,
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary btn-sm', onClick: () => navigator.clipboard.writeText(code.value).then(() => toast('Code copié')) }, icon('copy', 14), 'Copier le code'),
            open))
        : h('p', { class: 'muted' }, 'Aucune page publique pour le moment.')));
  if (pages.length) paint();
}

// ---- Administration --------------------------------------------------------------------

function renderSpaces(el) {
  el.replaceChildren(
    card('Espaces', 'Organisez le wiki par équipe ou par projet. La visibilité « public » rend un espace lisible sans connexion.',
      h('div', { class: 'table' }, store.spaces.map((s) => h('div', { class: 'table-row' },
        h('span', { class: 'space-ico' }, s.icon),
        h('span', { class: 'grow' }, h('strong', null, s.name), h('small', null, `${store.pagesIn(s.id).length} pages · ${s.description || 'Sans description'}`)),
        s.visibility === 'public' ? pill('🌍 Public', 'ok') : pill('🔒 Privé', 'off'),
        h('button', { class: 'icon-btn', title: 'Modifier', onClick: () => A.spaceForm(s) }, icon('edit')),
        store.spaces.length > 1 && h('button', { class: 'icon-btn danger', title: 'Supprimer', onClick: () => A.deleteSpace(s) }, icon('trash'))))),
      h('button', { class: 'btn btn-primary btn-sm', onClick: () => A.spaceForm() }, icon('plus', 15), 'Nouvel espace')),
    card('Corbeille', 'Les pages supprimées restent restaurables jusqu’à leur suppression définitive.',
      h('button', { class: 'btn btn-ghost btn-sm', onClick: A.openTrash }, icon('trash', 14), 'Ouvrir la corbeille')));
}

async function renderAuth(el) {
  el.replaceChildren(loadingEl());
  const info = await A.attempt(() => api.get('/admin/instance'));
  if (!info) return;
  const a = info.auth;
  const groups = (list) => (list.length ? h('span', { class: 'row wrap' }, list.map((g) => h('code', null, g))) : h('span', { class: 'muted' }, 'aucun'));
  el.replaceChildren(
    card('Fournisseur d’identité', null, kv([
      ['Mode', a.mode === 'oidc' ? status(true, 'OIDC (Authentik)') : pill('Développement : DEV_LOGIN', 'warn')],
      ['Issuer', a.issuer ? copyable(a.issuer) : null],
      ['Client ID', a.clientId ? h('code', null, a.clientId) : null],
      ['Redirect URI', copyable(a.redirectUri)],
      ['Scopes', h('code', null, a.scopes)],
      ['Durée de session', `${a.sessionTtlHours} h (absolue)`],
    ]), h('p', { class: 'hint' }, 'Le secret client n’est jamais affiché. Ces valeurs se modifient dans le fichier .env du déploiement.')),
    card('Groupes → rôles', 'Le rôle est recalculé à chaque connexion à partir de la claim « groups ».', kv([
      ['Administrateur', groups(a.groups.admin)],
      ['Éditeur', groups(a.groups.editor)],
      ['Lecteur', groups(a.groups.reader)],
      ['Hors groupes', a.defaultRole === 'none' ? pill('Accès refusé', 'ok') : pill('Lecteur', 'warn')],
    ])),
    card('Documentation', null, h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/docs/AUTHENTIK.md`, target: '_blank', rel: 'noopener' }, 'Configurer Authentik ↗')));
}

async function renderUsers(el) {
  el.replaceChildren(loadingEl());
  const users = await A.attempt(() => api.get('/admin/users'));
  if (!users) return;
  el.replaceChildren(card(`Utilisateurs (${users.length})`, 'Les comptes sont créés à la première connexion ; les rôles se gèrent dans Authentik.',
    h('div', { class: 'table' }, users.map((u) => h('div', { class: 'table-row' },
      h('span', { class: 'avatar static', style: { '--c': colorFor(u.id) } }, initials(u.name)),
      h('span', { class: 'grow' }, h('strong', null, u.name), h('small', null, `${u.email || 'sans e-mail'} · ${u.lastLoginAt ? `connecté ${timeAgo(u.lastLoginAt)}` : 'jamais connecté'}${u.tokens ? ` · ${u.tokens} jeton(s)` : ''}`)),
      pill(ROLE_LABELS[u.role] || u.role, u.role === 'admin' ? 'accent' : ''))))));
}

const AUDIT_LABELS = {
  'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'auth.denied': 'Accès refusé', 'auth.sessions.revoke': 'Sessions fermées',
  'token.create': 'Jeton créé', 'token.revoke': 'Jeton révoqué', 'settings.ai': 'Réglages IA', 'ai.ask': 'Question IA',
  'space.create': 'Espace créé', 'space.delete': 'Espace supprimé', 'space.visibility': 'Visibilité modifiée',
  'page.destroy': 'Page supprimée définitivement', 'trash.empty': 'Corbeille vidée',
};

async function renderAudit(el) {
  el.replaceChildren(loadingEl());
  const rows = await A.attempt(() => api.get('/admin/audit?limit=200'));
  if (!rows) return;
  el.replaceChildren(card('Journal d’audit', 'Actions sensibles : jamais de contenu de page ni de secret.',
    rows.length
      ? h('div', { class: 'table audit' }, rows.map((r) => h('div', { class: 'table-row' },
        h('span', { class: 'audit-time', title: fullDate(r.at) }, timeAgo(r.at)),
        h('span', { class: 'grow' }, h('strong', null, AUDIT_LABELS[r.action] || r.action), h('small', null, [r.user || 'Système', r.ip, r.meta && r.meta.slice(0, 120)].filter(Boolean).join(' · '))))))
      : h('p', { class: 'muted' }, 'Aucune entrée.')));
}

async function renderInstance(el) {
  el.replaceChildren(loadingEl());
  const info = await A.attempt(() => api.get('/admin/instance'));
  if (!info) return;
  const s = info.stats;
  const stat = (n, label) => h('div', { class: 'stat' }, h('strong', null, String(n)), h('span', null, label));
  el.replaceChildren(
    card(null, null, h('div', { class: 'stats' },
      stat(s.spaces, 'espaces'), stat(s.publicSpaces, 'publics'), stat(s.pages, 'pages'), stat(s.versions, 'versions'),
      stat(s.users, 'utilisateurs'), stat(s.activeSessions, 'sessions'), stat(s.activeTokens, 'jetons actifs'), stat(s.trashed, 'à la corbeille'))),
    card('Instance', null, kv([
      ['Version', h('code', null, info.version)],
      ['URL publique', copyable(info.publicUrl)],
      ['Environnement', info.environment === 'production' ? pill('production', 'ok') : pill(info.environment, 'warn')],
      ['Reverse proxy', info.integrations.trustProxy ? 'Oui (TRUST_PROXY)' : 'Non'],
      ['Recherche IA', status(session.config.ai, 'Configurée', 'Non configurée')],
      ['Draw.io', status(!!info.integrations.drawioUrl, 'Configuré', 'Non configuré')],
    ])),
    card('Ressources', null, h('div', { class: 'row wrap' },
      h('a', { class: 'btn btn-ghost btn-sm', href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Dépôt GitHub ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/SECURITY.md`, target: '_blank', rel: 'noopener' }, 'Sécurité ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: '/api/docs', target: '_blank', rel: 'noopener' }, 'API ↗'))));
}

// ---- Page -----------------------------------------------------------------------------

const SECTIONS = [
  { group: 'Compte', id: 'profile', label: 'Profil et sessions', emoji: '👤', render: renderProfile },
  { group: 'Compte', id: 'appearance', label: 'Apparence', emoji: '🎨', render: renderAppearance },
  { group: 'Compte', id: 'tokens', label: 'Jetons d’API', emoji: '🔑', render: renderTokens },
  { group: 'Fonctionnalités', id: 'ai', label: 'Recherche IA', emoji: '✨', render: renderAi },
  { group: 'Fonctionnalités', id: 'diagrams', label: 'Diagrammes', emoji: '📐', render: renderDiagrams },
  { group: 'Fonctionnalités', id: 'api', label: 'API REST', emoji: '🔌', render: renderApi },
  { group: 'Fonctionnalités', id: 'embed', label: 'Intégration portfolio', emoji: '🖼️', render: renderEmbed },
  { group: 'Administration', id: 'spaces', label: 'Espaces', emoji: '🗂️', admin: true, render: renderSpaces },
  { group: 'Administration', id: 'auth', label: 'Authentification', emoji: '🛡️', admin: true, render: renderAuth },
  { group: 'Administration', id: 'users', label: 'Utilisateurs', emoji: '👥', admin: true, render: renderUsers },
  { group: 'Administration', id: 'audit', label: 'Journal d’audit', emoji: '📜', admin: true, render: renderAudit },
  { group: 'Administration', id: 'instance', label: 'Instance', emoji: '🖥️', admin: true, render: renderInstance },
];

export function showSettings(sectionId) {
  beginView();
  const sections = SECTIONS.filter((s) => !s.admin || session.can('admin'));
  const section = sections.find((s) => s.id === sectionId) || sections[0];
  document.title = `${section.label} · Paramètres · Notabene`;

  let group = null;
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Sections des paramètres' });
  for (const s of sections) {
    if (s.group !== group) { group = s.group; nav.append(h('div', { class: 'set-nav-group' }, group)); }
    nav.append(h('a', { class: `set-nav-item${s.id === section.id ? ' active' : ''}`, href: `#/settings/${s.id}` }, h('span', null, s.emoji), s.label));
  }
  const content = h('div', { class: 'set-content' });
  document.getElementById('main').replaceChildren(
    topbar(h('nav', { class: 'crumbs' },
      h('a', { class: 'crumb', href: '#/settings' }, h('span', { class: 'crumb-ico' }, '⚙️'), 'Paramètres'),
      h('span', { class: 'crumb-sep' }, '/'),
      h('span', { class: 'crumb current' }, section.label))),
    h('div', { class: 'scroller' }, h('div', { class: 'settings' },
      nav,
      h('div', { class: 'set-main' }, h('h1', null, `${section.emoji} ${section.label}`), content))));
  section.render(content);
  // Les sections qui affichent des espaces se rafraîchissent quand ils changent.
  setView({ kind: 'settings', id: section.id, onStore: (evt) => { if (['spaces', 'embed'].includes(section.id) && evt.type !== 'page') section.render(content); } });
}
