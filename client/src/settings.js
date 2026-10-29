// Page Paramètres : compte, fonctionnalités (IA, diagrammes, API, intégration) et administration.
import { h, initials, timeAgo, fullDate, download } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { store } from './store.js';
import { session } from './session.js';
import { prefs, savePrefs, setTheme } from './prefs.js';
import { colorFor } from './presence.js';
import { toast, confirmModal, openModal } from './ui.js';
import { qrSvg } from './qr.js';
import { securityCard } from './local-auth.js';
import { embedOriginsCard, providerCard } from './provider-settings.js';
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
const status = (ok, onText = 'Actif', offText = 'Inactif') => pill(ok ? onText : offText, ok ? 'ok' : 'off');

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
  const security = session.config.auth.local ? await securityCard(card) : null;
  el.replaceChildren(...[
    card(null, null, h('div', { class: 'profile' },
      h('span', { class: 'avatar xl static', style: { '--c': colorFor(u.id) } }, initials(u.name)),
      h('div', null,
        h('h2', null, u.name),
        h('p', { class: 'muted' }, u.email || 'Adresse e-mail non communiquée par le fournisseur'),
        h('div', { class: 'row' }, pill(ROLE_LABELS[u.role], 'accent'), pill({ local: 'Compte local', ldap: 'Annuaire LDAP / AD', saml: 'SSO SAML', oidc: 'Connecté via Authentik (OIDC)', dev: 'Connexion de développement' }[session.provider] || 'Connecté'))))),
    card('Permissions', 'Votre rôle est attribué par vos groupes (fournisseur d’identité, annuaire) ou par un administrateur pour les comptes locaux.',
      h('ul', { class: 'perm-list' }, perms.map(([key, label]) => h('li', { class: session.can(key) ? 'ok' : 'off' }, icon(session.can(key) ? 'check' : 'x', 14), ' ', label)))),
    security,
    card('Sessions actives', 'Chaque navigateur connecté ouvre une session distincte, valable au maximum la durée configurée.', sessionsBox),
    card('Déconnexion', null, h('button', { class: 'btn btn-ghost', onClick: () => session.logout() }, icon('move', 15), 'Se déconnecter'))].filter(Boolean));

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
    card('Serveur MCP', 'Connectez un assistant IA (Claude, etc.) au wiki via le Model Context Protocol. Les droits sont ceux du jeton : une portée read suffit pour chercher et lire, write permet de créer des pages.', h('div', { class: 'stack' },
      kv([['Point d’accès', copyable(`${location.origin}/mcp`)], ['Transport', 'HTTP (POST, JSON-RPC 2.0), jeton Bearer obligatoire'], ['Outils', 'list_spaces, list_pages, search_pages, get_page, create_page']]),
      h('pre', { class: 'code-sample' }, `claude mcp add --transport http notabene ${location.origin}/mcp \\\n  --header "Authorization: Bearer nb_…"`))),
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
  session.can('ai') && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => A.search() }, icon('sparkle', 14), ' Essayer maintenant'));

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
            result.textContent = r?.ok ? `Connexion réussie (« ${r.sample} »)` : r?.message || 'Échec';
          },
        }, 'Enregistrer et tester'),
        result))),
    card('Confidentialité', null, h('div', { class: 'notice info' }, 'Pour chaque question, seuls des extraits des pages pertinentes et lisibles par l’utilisateur sont envoyés au fournisseur, jamais tout le wiki. Avec un modèle local (Ollama), aucune donnée ne quitte votre infrastructure.')),
    usage);
}

// ---- Diagrammes ------------------------------------------------------------------------

function renderDiagrams(el) {
  const drawio = session.config.drawioUrl;
  const tool = (ico, name, desc, state, cmd, tryIt) => h('div', { class: 'tool-card' },
    h('div', { class: 'tool-emoji' }, icon(ico, 20)),
    h('div', { class: 'grow' }, h('strong', null, name), h('p', { class: 'muted' }, desc),
      h('div', { class: 'row' }, state, h('code', null, cmd))),
    tryIt && h('button', { class: 'btn btn-ghost btn-sm', onClick: tryIt }, 'Essayer'));
  const scratch = (label) => () => toast(`${label} : brouillon non enregistré (insérez-le dans une page avec le menu /).`);
  el.replaceChildren(
    card('Outils disponibles', 'Insérez un diagramme dans n’importe quelle page avec le menu « / ».', h('div', { class: 'stack' },
      tool('diamond', 'Mermaid', 'Schémas décrits en texte : organigrammes, séquences, Gantt, classes… Rendu sécurisé (mode strict).', status(true, 'Intégré'), '/mermaid'),
      tool('code', 'PlantUML', 'Diagrammes UML (séquence, classes, composants…) décrits en texte. Moteur servi par votre serveur, rendu dans le navigateur ; les directives !include sont refusées.', status(true, 'Intégré'), '/plantuml'),
      tool('pencil', 'Excalidraw', 'Dessin à main levée, chargé à la demande. Polices servies par votre serveur.', status(true, 'Intégré'), '/excalidraw',
        () => openExcalidraw({ scene: '', svg: '' }, scratch('Excalidraw'))),
      tool('hexagon', 'Draw.io', drawio ? `Instance auto-hébergée : ${drawio}` : 'Nécessite le conteneur Draw.io et la variable DRAWIO_URL.',
        status(!!drawio, 'Configuré', 'Non configuré'), '/drawio', drawio && (() => openDrawio({ xml: '', svg: '' }, scratch('Draw.io')))))),
    card('Sécurité', null, h('p', { class: 'muted' }, 'Les dessins Excalidraw et Draw.io sont enregistrés en SVG et affichés comme images : aucun script ne peut s’exécuter dans la page. Les messages de Draw.io ne sont acceptés que depuis l’origine configurée.')));
}

// ---- Intégration portfolio ------------------------------------------------------------

async function renderEmbed(el) {
  const publicSpaces = store.spaces.filter((s) => s.visibility === 'public');
  const pages = store.recent(null, 500).filter((p) => publicSpaces.some((s) => s.id === p.spaceId));
  const select = h('select', { class: 'input' }, pages.map((p) => h('option', { value: p.id }, `${p.title || 'Sans titre'}`)));
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

  const cfgData = session.can('admin') ? await A.attempt(() => api.get('/admin/settings')) : null;

  el.replaceChildren(
    card('1. Espaces publics', 'Seuls les espaces publics sont visibles sans connexion, donc intégrables.', h('div', { class: 'table' },
      store.spaces.map((s) => h('div', { class: 'table-row' },
        h('span', { class: 'grow' }, icon(s.icon || 'folder', 16), ` ${s.name}`),
        s.visibility === 'public' ? pill('Public', 'ok') : pill('Privé', 'off'),
        session.can('admin') && h('button', {
          class: 'btn btn-ghost btn-sm',
          onClick: async () => {
            await A.attempt(() => store.updateSpace(s.id, { visibility: s.visibility === 'public' ? 'private' : 'public' }));
            renderEmbed(el);
          },
        }, s.visibility === 'public' ? 'Rendre privé' : 'Rendre public'))))),
    cfgData
      ? embedOriginsCard(cfgData, { card, refresh: () => renderEmbed(el) })
      : card('2. Sites autorisés', 'Origines autorisées à afficher Notabene en iframe.', h('p', { class: 'hint' }, 'Visible et modifiable par les administrateurs.')),
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
        h('span', { class: 'space-ico' }, icon(s.icon || 'folder', 18)),
        h('span', { class: 'grow' }, h('strong', null, s.name), h('small', null, `${store.pagesIn(s.id).length} pages · ${s.description || 'Sans description'}`)),
        s.visibility === 'public' ? pill('Public', 'ok') : pill('Privé', 'off'),
        h('button', { class: 'icon-btn', title: 'Modifier', onClick: () => A.spaceForm(s) }, icon('edit')),
        store.spaces.length > 1 && h('button', { class: 'icon-btn danger', title: 'Supprimer', onClick: () => A.deleteSpace(s) }, icon('trash'))))),
      h('button', { class: 'btn btn-primary btn-sm', onClick: () => A.spaceForm() }, icon('plus', 15), 'Nouvel espace')),
    card('Corbeille', 'Les pages supprimées restent restaurables jusqu’à leur suppression définitive.',
      h('button', { class: 'btn btn-ghost btn-sm', onClick: A.openTrash }, icon('trash', 14), 'Ouvrir la corbeille')));
}

async function renderAuth(el) {
  el.replaceChildren(loadingEl());
  const [info, data] = await Promise.all([A.attempt(() => api.get('/admin/instance')), A.attempt(() => api.get('/admin/settings'))]);
  if (!info || !data) return;
  const refresh = () => renderAuth(el);
  const ctx = { card, copyable, refresh };
  el.replaceChildren(
    card('Méthodes de connexion', null, kv([
      ['Comptes locaux', status(session.config.auth.local, 'Activés', 'Désactivés')],
      ['Mode développement', session.config.auth.devLogin ? pill('DEV_LOGIN actif', 'warn') : pill('Désactivé', 'ok')],
      ['Durée de session', `${info.auth.sessionTtlHours} h (absolue)`],
    ]), data.locked
      ? h('div', { class: 'notice info' }, 'Configuration verrouillée (CONFIG_LOCKED) : les fournisseurs se règlent dans l’environnement du déploiement.')
      : h('p', { class: 'hint' }, 'Les fournisseurs se règlent ci-dessous. Chaque modification demande votre mot de passe, et la connexion doit être testée avant l’enregistrement. Les secrets sont chiffrés et jamais réaffichés. En cas d’erreur, le compte local et la commande create-admin --reset permettent de reprendre la main.')),
    providerCard('oidc', data, { ...ctx, kvRows: [['URI de redirection', data.redirectUris.oidc]] }),
    providerCard('ldap', data, ctx),
    providerCard('saml', data, { ...ctx, kvRows: [['URL de réponse (ACS)', data.redirectUris.samlAcs], ['Métadonnées du service', data.redirectUris.samlMetadata]] }),
    card('Documentation', null, h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/docs/AUTHENTIK.md`, target: '_blank', rel: 'noopener' }, 'Configurer Authentik ↗')));
}

async function renderMail(el) {
  el.replaceChildren(loadingEl());
  const data = await A.attempt(() => api.get('/admin/settings'));
  if (!data) return;
  el.replaceChildren(
    providerCard('smtp', data, { card, copyable, refresh: () => renderMail(el) }),
    card('Ce que l’e-mail permet', null, h('ul', { class: 'plain-list' },
      h('li', null, 'Mot de passe oublié : lien à usage unique, valable 30 minutes.'),
      h('li', null, 'Invitations : la personne choisit elle-même son mot de passe (lien valable 72 heures).'),
      h('li', null, 'Alertes de sécurité : verrouillage du compte, mot de passe modifié, double authentification activée ou désactivée.')),
    h('p', { class: 'hint' }, 'Sans SMTP, tout continue de fonctionner : un administrateur réinitialise les mots de passe depuis l’onglet Utilisateurs.')));
}

async function renderUsers(el) {
  el.replaceChildren(loadingEl());
  const users = await A.attempt(() => api.get('/admin/users'));
  if (!users) return;
  const local = session.config.auth.local;
  const refresh = () => renderUsers(el);
  const patch = async (u, body, done) => { if (await A.attempt(() => api.patch(`/admin/local-users/${u.id}`, body))) { toast(done); refresh(); } };

  const resetPassword = (u) => {
    const pwd = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '256' });
    openModal({
      title: `Nouveau mot de passe : ${u.name}`,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, '12 caractères minimum. Les sessions de la personne seront fermées.'), pwd),
      actions: [{ label: 'Annuler' }, { label: 'Réinitialiser', primary: true, onClick: async () => { if (!pwd.value) return false; await patch(u, { password: pwd.value }, 'Mot de passe réinitialisé'); return undefined; } }],
    });
    setTimeout(() => pwd.focus(), 30);
  };

  const row = (u) => h('div', { class: 'table-row' },
    h('span', { class: 'avatar static', style: { '--c': colorFor(u.id) } }, initials(u.name)),
    h('span', { class: 'grow' }, h('strong', null, u.name), h('small', null, `${u.email || 'sans e-mail'} · ${u.lastLoginAt ? `connecté ${timeAgo(u.lastLoginAt)}` : 'jamais connecté'}${u.tokens ? ` · ${u.tokens} jeton(s)` : ''}`)),
    u.local && u.mfa && pill('MFA', 'ok'),
    u.disabled && pill('Désactivé', 'off'),
    u.local && u.id !== session.user.id
      ? h('select', { class: 'input input-sm', 'aria-label': 'Rôle', onChange: (e) => patch(u, { role: e.target.value }, 'Rôle modifié') },
        Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value, selected: value === u.role }, label)))
      : pill(ROLE_LABELS[u.role] || u.role, u.role === 'admin' ? 'accent' : ''),
    u.local && u.id !== session.user.id && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => patch(u, { disabled: !u.disabled }, u.disabled ? 'Compte réactivé' : 'Compte désactivé') }, u.disabled ? 'Réactiver' : 'Désactiver'),
    u.local && u.mfa && h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => { if (await confirmModal({ title: 'Réinitialiser la double authentification ?', message: u.name, confirm: 'Réinitialiser', danger: true })) patch(u, { resetMfa: true }, 'MFA réinitialisée'); } }, 'Réinit. MFA'),
    u.local && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => resetPassword(u) }, 'Mot de passe'));

  const mail = h('input', { class: 'input', type: 'email', placeholder: 'E-mail', maxlength: '200', autocomplete: 'off' });
  const name = h('input', { class: 'input', placeholder: 'Nom', maxlength: '120', autocomplete: 'off' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe initial (12 car. min.)', maxlength: '256', autocomplete: 'new-password' });
  const mailOn = !!session.config.auth.mail;
  const invite = h('input', { type: 'checkbox' });
  invite.checked = mailOn;
  invite.addEventListener('change', () => { pass.hidden = invite.checked; });
  pass.hidden = mailOn;
  const roleSel = h('select', { class: 'input' }, Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value, selected: value === 'editor' }, label)));

  el.replaceChildren(...[
    card(`Utilisateurs (${users.length})`, local ? 'Comptes locaux (gérés ici) et comptes fédérés (rôles issus d’Authentik).' : 'Les comptes sont créés à la première connexion ; les rôles se gèrent dans Authentik.',
      h('div', { class: 'table' }, users.map(row))),
    local && card('Nouveau compte local', mailOn ? 'Par invitation, la personne choisit son mot de passe via un lien reçu par e-mail : vous ne le connaissez jamais.' : 'Communiquez le mot de passe initial par un canal sûr ; la personne peut ensuite le changer et activer la double authentification.', h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, mail, name, roleSel),
      mailOn && h('label', { class: 'field row' }, invite, h('span', null, 'Inviter par e-mail (lien valable 72 h)')),
      pass,
      h('div', null, h('button', {
        class: 'btn btn-primary btn-sm',
        onClick: async () => {
          if (await A.attempt(() => api.post('/admin/local-users', invite.checked ? { email: mail.value, name: name.value, role: roleSel.value, invite: true } : { email: mail.value, name: name.value, role: roleSel.value, password: pass.value }))) { toast(invite.checked ? 'Invitation envoyée' : 'Compte créé'); refresh(); }
        },
      }, icon('plus', 15), 'Créer le compte')))),
  ].filter(Boolean));
}

const AUDIT_LABELS = {
  'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'auth.local.failed': 'Échec de connexion', 'auth.ldap.failed': 'Échec de connexion LDAP', 'auth.saml.failed': 'Réponse SAML refusée', 'auth.local.setup': 'Installation initiale', 'auth.local.password': 'Mot de passe modifié', 'auth.mfa.enable': 'MFA activée', 'auth.mfa.disable': 'MFA désactivée', 'backup.download': 'Sauvegarde téléchargée', 'import.markdown': 'Import Markdown', 'user.create': 'Compte créé', 'user.update': 'Compte modifié', 'auth.denied': 'Accès refusé', 'auth.sessions.revoke': 'Sessions fermées',
  'auth.local.forgot': 'Réinitialisation demandée', 'auth.local.reset': 'Mot de passe réinitialisé', 'auth.reauth.failed': 'Échec de ressaisie', 'settings.test': 'Test de configuration', 'settings.test.failed': 'Test de configuration échoué', 'settings.reset': 'Retour à l’environnement', 'settings.embed': 'Sites autorisés modifiés', 'settings.oidc': 'OIDC modifié', 'settings.ldap': 'LDAP modifié', 'settings.saml': 'SAML modifié', 'settings.smtp': 'SMTP modifié', 'settings.smtp.test-mail': 'E-mail de test envoyé',
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

async function downloadBackup() {
  try {
    const res = await fetch('/api/v1/admin/backup', { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Erreur ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'notabene.db';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
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
    card('Sauvegarde', 'Télécharge une copie cohérente de la base (pages, comptes, réglages). Elle contient des secrets chiffrés : conservez-la comme un secret. Pour une sauvegarde automatique, voir docs/BACKUP.md.',
      h('button', { class: 'btn btn-primary btn-sm', onClick: downloadBackup }, icon('download', 14), 'Télécharger une sauvegarde')),
    card('Ressources', null, h('div', { class: 'row wrap' },
      h('a', { class: 'btn btn-ghost btn-sm', href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Dépôt GitHub ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/SECURITY.md`, target: '_blank', rel: 'noopener' }, 'Sécurité ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: '/api/docs', target: '_blank', rel: 'noopener' }, 'API ↗'))));
}

// ---- Outils ---------------------------------------------------------------------------

const CHARSETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?' };

// Tirage uniforme sans biais de modulo.
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

function generatePassword(length, sets) {
  const pools = sets.map((k) => CHARSETS[k]);
  const all = pools.join('');
  const chars = pools.map((p) => p[randomInt(p.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function renderTools(el) {
  const len = h('input', { class: 'input', type: 'number', min: '8', max: '128', value: '20' });
  const checks = Object.keys(CHARSETS).map((k) => {
    const box = h('input', { type: 'checkbox', checked: true, onChange: gen });
    return { k, box, node: h('label', { class: 'row' }, box, { lower: 'minuscules', upper: 'majuscules', digits: 'chiffres', symbols: 'symboles' }[k]) };
  });
  const out = h('code', { class: 'pw-out' });
  const entropy = h('small', { class: 'hint' });
  function gen() {
    const sets = checks.filter((c) => c.box.checked).map((c) => c.k);
    const n = Math.min(128, Math.max(8, Number(len.value) || 20));
    if (!sets.length) { out.textContent = ''; entropy.textContent = 'Sélectionnez au moins un jeu de caractères.'; return; }
    out.textContent = generatePassword(n, sets);
    entropy.textContent = `Entropie estimée : ${Math.round(n * Math.log2(sets.reduce((a, k) => a + CHARSETS[k].length, 0)))} bits`;
  }
  len.addEventListener('input', gen);

  const text = h('input', { class: 'input', placeholder: 'https://… ou texte', maxlength: '1000' });
  const qr = h('div', { class: 'qr-out' });
  const paintQr = () => {
    qr.replaceChildren();
    if (!text.value.trim()) return;
    try {
      const svg = qrSvg(text.value);
      qr.append(svg, h('button', { class: 'btn btn-ghost btn-sm', onClick: () => download('qrcode.svg', new XMLSerializer().serializeToString(svg), 'image/svg+xml') }, icon('download', 14), 'Télécharger (SVG)'));
    } catch {
      qr.append(h('p', { class: 'hint' }, 'Texte trop long pour un QR code.'));
    }
  }
  text.addEventListener('input', paintQr);

  el.replaceChildren(
    card('Générateur de mots de passe', 'Généré localement avec le générateur aléatoire sécurisé du navigateur ; rien n’est envoyé au serveur.', h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'Longueur'), len), ...checks.map((c) => c.node)),
      h('div', { class: 'row' }, out),
      entropy,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary btn-sm', onClick: gen }, icon('wand', 14), 'Générer'),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => out.textContent && navigator.clipboard.writeText(out.textContent).then(() => toast('Copié')) }, icon('copy', 14), 'Copier')))),
    card('Générateur de QR code', 'Le QR code est calculé dans votre navigateur.', h('div', { class: 'stack' }, text, qr)));
  gen();
}

// ---- Webhooks (admin) ------------------------------------------------------------------

async function renderWebhooks(el, created = null) {
  const data = await A.attempt(() => api.get('/admin/webhooks'));
  if (!data) return;
  const name = h('input', { class: 'input', placeholder: 'Nom (ex. Notification Discord)', maxlength: '80' });
  const url = h('input', { class: 'input', placeholder: 'https://…', maxlength: '500' });
  const boxes = data.events.map((ev) => ({ ev, box: h('input', { type: 'checkbox', checked: ev === 'page.created' || ev === 'page.updated' }) }));
  const refresh = (secret) => renderWebhooks(el, secret);

  const create = async () => {
    const events = boxes.filter((b) => b.box.checked).map((b) => b.ev);
    const made = await A.attempt(() => api.post('/admin/webhooks', { name: name.value.trim(), url: url.value.trim(), events }));
    if (made) refresh(made);
  };

  el.replaceChildren(...[
    created && h('div', { class: 'notice success stack' },
      h('strong', null, 'Webhook créé. Copiez le secret de signature maintenant : il ne sera plus affiché.'),
      h('div', { class: 'row' }, h('code', { class: 'token-value' }, created.secret),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigator.clipboard.writeText(created.secret).then(() => toast('Secret copié')) }, icon('copy', 14), 'Copier'))),
    card('Webhooks', 'Notifiez un service externe (Discord, n8n, CI…) quand une page change. Chaque envoi est signé (en-tête X-Notabene-Signature, HMAC-SHA256) et ne contient que des identifiants, jamais le contenu des pages.',
      data.items.length
        ? h('div', { class: 'table' }, data.items.map((w) => h('div', { class: 'table-row' },
          h('span', { class: 'grow' }, h('strong', null, w.name), h('small', null, `${w.url} · ${w.events.join(', ')}`)),
          w.enabled ? pill(w.lastStatus ? `HTTP ${w.lastStatus}` : 'Actif', w.failures ? 'warn' : 'ok') : pill('Désactivé', 'off'),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: async () => {
              const r = await A.attempt(() => api.post(`/admin/webhooks/${w.id}/test`));
              if (r) toast(r.ok ? `Test réussi (HTTP ${r.status})` : `Échec du test (${r.status || 'injoignable'})`, { kind: r.ok ? undefined : 'error' });
              refresh();
            },
          }, 'Tester'),
          !w.enabled && h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => { await A.attempt(() => api.patch(`/admin/webhooks/${w.id}`, { enabled: true })); refresh(); } }, 'Réactiver'),
          h('button', {
            class: 'icon-btn danger', title: 'Supprimer',
            onClick: async () => {
              if (await confirmModal({ title: 'Supprimer ce webhook ?', message: w.name, confirm: 'Supprimer', danger: true })) { await A.attempt(() => api.del(`/admin/webhooks/${w.id}`)); refresh(); }
            },
          }, icon('trash')))))
        : h('p', { class: 'muted' }, 'Aucun webhook configuré.')),
    card('Nouveau webhook', 'HTTPS obligatoire ; les adresses internes sont refusées (WEBHOOK_ALLOW_PRIVATE=true pour les autoriser en réseau local). Un webhook est désactivé après 10 échecs consécutifs.', h('div', { class: 'stack' },
      name, url,
      h('div', { class: 'row wrap' }, boxes.map((b) => h('label', { class: 'row' }, b.box, b.ev))),
      h('div', null, h('button', { class: 'btn btn-primary btn-sm', onClick: create }, icon('plus', 15), 'Créer le webhook'))))].filter(Boolean));
}

// ---- Import Markdown / Wiki.js (admin) -------------------------------------------------

function renderImport(el) {
  const NEW = '__new__';
  const spaceSel = h('select', { class: 'input' },
    store.spaces.map((s) => h('option', { value: s.id }, s.name)),
    h('option', { value: NEW }, 'Créer un nouvel espace…'));
  const newName = h('input', { class: 'input', placeholder: 'Nom du nouvel espace', maxlength: '80', hidden: true });
  spaceSel.addEventListener('change', () => { newName.hidden = spaceSel.value !== NEW; });
  const folder = h('input', { type: 'file', webkitdirectory: '', multiple: true, class: 'input' });
  const files = h('input', { type: 'file', multiple: true, accept: '.md,.markdown,text/markdown', class: 'input' });
  const summary = h('div', { class: 'stack' });
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, icon('upload', 15), 'Importer');

  go.addEventListener('click', async () => {
    const picked = [...folder.files, ...files.files].filter((f) => /\.(md|markdown)$/i.test(f.name));
    if (!picked.length) { toast('Sélectionnez un dossier ou des fichiers Markdown (.md).', { kind: 'error' }); return; }
    go.disabled = true;
    summary.replaceChildren(h('p', { class: 'muted' }, `Lecture de ${picked.length} fichier(s)…`));
    try {
      const payload = await Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text() })));
      let spaceId = spaceSel.value;
      if (spaceId === NEW) spaceId = await store.createSpace({ name: newName.value.trim() || 'Import', icon: 'folder', description: '', visibility: 'private' });
      const r = await api.post('/admin/import/markdown', { spaceId, files: payload });
      summary.replaceChildren(h('div', { class: 'notice success stack' },
        h('strong', null, 'Import terminé'),
        h('p', null, `${r.pages} page(s) et ${r.folders} dossier(s) créés. Liens internes : ${r.links.resolved} résolus, ${r.links.unresolved} introuvables (laissés en texte).`),
        r.images ? h('p', null, `${r.images} image(s) référencée(s) par chemin n’ont pas été importées (remplacées par « [Image : nom] »).`) : null,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => A.go(`/s/${spaceId}`) }, 'Ouvrir l’espace')));
    } catch (err) {
      summary.replaceChildren(h('div', { class: 'notice warning' }, err.message || 'Import impossible.'));
    } finally {
      go.disabled = false;
    }
  });

  el.replaceChildren(
    card('Importer du Markdown', 'Pour migrer depuis Wiki.js : activez le stockage « Local File System » ou « Git » (Administration > Stockage), lancez une synchronisation, puis sélectionnez ici le dossier obtenu. La hiérarchie, les titres (en-tête YAML), les tableaux, listes, blocs de code, diagrammes Mermaid / PlantUML, encadrés et liens internes sont conservés.', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Espace de destination'), spaceSel), newName,
      h('label', { class: 'field' }, h('span', null, 'Dossier (ses sous-dossiers sont lus)'), folder),
      h('label', { class: 'field' }, h('span', null, 'ou fichiers .md individuels'), files),
      go, summary)),
    card('Limites', null, h('ul', { class: 'perm-list' },
      h('li', null, '2000 fichiers, 1 Mo par fichier et 25 Mo au total par import.'),
      h('li', null, 'Les images référencées par chemin relatif ne sont pas importées ; seules les images en https ou intégrées (data) le sont.'),
      h('li', null, 'Le HTML brut est ignoré. Un import crée toujours de nouvelles pages : il ne remplace rien.'))));
}

// ---- Page -----------------------------------------------------------------------------

const SECTIONS = [
  { group: 'Compte', id: 'profile', label: 'Profil et sessions', ico: 'users', render: renderProfile },
  { group: 'Compte', id: 'appearance', label: 'Apparence', ico: 'sun', render: renderAppearance },
  { group: 'Compte', id: 'tokens', label: 'Jetons d’API', ico: 'key', render: renderTokens },
  { group: 'Fonctionnalités', id: 'ai', label: 'Recherche IA', ico: 'sparkle', render: renderAi },
  { group: 'Fonctionnalités', id: 'diagrams', label: 'Diagrammes', ico: 'diamond', render: renderDiagrams },
  { group: 'Fonctionnalités', id: 'tools', label: 'Outils', ico: 'qrcode', render: renderTools },
  { group: 'Fonctionnalités', id: 'api', label: 'API REST', ico: 'code', render: renderApi },
  { group: 'Fonctionnalités', id: 'embed', label: 'Intégration portfolio', ico: 'globe', render: renderEmbed },
  { group: 'Administration', id: 'spaces', label: 'Espaces', ico: 'folder', admin: true, render: renderSpaces },
  { group: 'Administration', id: 'auth', label: 'Authentification', ico: 'shield', admin: true, render: renderAuth },
  { group: 'Administration', id: 'mail', label: 'E-mail', ico: 'mail', admin: true, render: renderMail },
  { group: 'Administration', id: 'webhooks', label: 'Webhooks', ico: 'webhook', admin: true, render: renderWebhooks },
  { group: 'Administration', id: 'import', label: 'Import', ico: 'upload', admin: true, render: renderImport },
  { group: 'Administration', id: 'users', label: 'Utilisateurs', ico: 'users', admin: true, render: renderUsers },
  { group: 'Administration', id: 'audit', label: 'Journal d’audit', ico: 'file', admin: true, render: renderAudit },
  { group: 'Administration', id: 'instance', label: 'Instance', ico: 'settings', admin: true, render: renderInstance },
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
    nav.append(h('a', { class: `set-nav-item${s.id === section.id ? ' active' : ''}`, href: `#/settings/${s.id}` }, h('span', null, icon(s.ico, 16)), s.label));
  }
  const content = h('div', { class: 'set-content' });
  document.getElementById('main').replaceChildren(
    topbar(h('nav', { class: 'crumbs' },
      h('a', { class: 'crumb', href: '#/settings' }, h('span', { class: 'crumb-ico' }, icon('settings', 14)), 'Paramètres'),
      h('span', { class: 'crumb-sep' }, '/'),
      h('span', { class: 'crumb current' }, section.label))),
    h('div', { class: 'scroller' }, h('div', { class: 'settings' },
      nav,
      h('div', { class: 'set-main' }, h('h1', null, icon(section.ico, 24), ` ${section.label}`), content))));
  section.render(content);
  // Les sections qui affichent des espaces se rafraîchissent quand ils changent.
  setView({ kind: 'settings', id: section.id, onStore: (evt) => { if (['spaces', 'embed'].includes(section.id) && evt.type !== 'page') section.render(content); } });
}
