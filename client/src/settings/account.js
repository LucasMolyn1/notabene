// Paramètres du compte : profil, apparence, jetons, API et à propos.
import { h, timeAgo, download } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { session } from '../session.js';
import { prefs, savePrefs, setTheme } from '../prefs.js';
import { avatarEl, chooseAvatar, removeAvatar } from '../avatar.js';
import { toast, confirmModal } from '../ui.js';
import { askReauth } from '../provider-settings.js';
import { securityCard } from '../local-auth.js';
import { preferencesCard } from '../notifications.js';
import { markNewsSeen, notifyNewsChange } from '../news.js';
import * as A from '../actions.js';
import { ROLE_LABELS } from './access.js';
import { card, copyable, kv, loadingEl, pill, toggle } from './ui.js';

export const REPO_URL = 'https://github.com/LucasMolyn1/notabene';

export async function renderProfile(el) {
  const u = session.user;
  const perms = [['read', 'Lire les pages'], ['write', 'Créer et modifier des pages'], ['ai', 'Utiliser la recherche IA'], ['admin', 'Administrer l’instance']];
  const sessionsBox = h('div', null, loadingEl());
  const photo = avatarEl(u, { cls: 'xl static' });
  const repaint = () => renderProfile(el);
  const security = session.config.auth.local ? await securityCard(card) : null;
  const notifPrefs = await preferencesCard(card);
  el.replaceChildren(...[
    card(null, null, h('div', { class: 'profile' },
      photo,
      h('div', null,
        h('h2', null, u.name),
        h('p', { class: 'muted' }, u.email || 'Adresse e-mail non communiquée par le fournisseur'),
        h('div', { class: 'row' }, pill(ROLE_LABELS[u.role], 'accent'), pill({ local: 'Compte local', ldap: 'Annuaire LDAP / AD', saml: 'SSO SAML', oidc: 'Connecté via Authentik (OIDC)', dev: 'Connexion de développement' }[session.provider] || 'Connecté')),
        h('div', { class: 'row profile-photo-actions' },
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => chooseAvatar(repaint) }, session.avatars?.[u.id] ? 'Changer la photo' : 'Ajouter une photo'),
          session.avatars?.[u.id] && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => removeAvatar(repaint) }, 'Retirer la photo'))))),
    card('Permissions', 'Votre rôle est attribué par vos groupes (fournisseur d’identité, annuaire) ou par un administrateur pour les comptes locaux.',
      h('ul', { class: 'perm-list' }, perms.map(([key, label]) => h('li', { class: session.can(key) ? 'ok' : 'off' }, icon(session.can(key) ? 'check' : 'x', 14), ' ', label)))),
    security,
    notifPrefs,
    card('Mes données personnelles', 'Téléchargez une copie de vos données (profil, pages créées, commentaires, jetons, sessions, journal de vos actions). Aucun secret n’y figure.',
      h('button', {
        class: 'btn btn-ghost',
        onClick: async () => {
          const data = await A.attempt(() => api.get('/me/export'));
          if (data) download('mes-donnees-notabene.json', JSON.stringify(data, null, 2), 'application/json');
        },
      }, icon('download', 15), 'Télécharger mes données')),
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

export function renderAppearance(el) {
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

const SCOPE_LABELS = {
  read: ['Lecture', 'Lire les espaces, pages, versions et effectuer des recherches'],
  write: ['Écriture', 'Créer, modifier, déplacer et mettre à la corbeille des pages'],
  ai: ['IA', 'Poser des questions à la recherche IA'],
  admin: ['Administration', 'Gérer les espaces, les réglages et lire le journal d’audit'],
};

const ROLE_SCOPES = { reader: ['read', 'ai'], editor: ['read', 'write', 'ai'], admin: ['read', 'write', 'ai', 'admin'] };

export async function renderTokens(el, created = null) {
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
      h('pre', { class: 'code-sample', tabindex: '0' }, `curl -H "Authorization: Bearer $NOTABENE_TOKEN" \\\n  ${location.origin}/api/v3/spaces`)),
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

export function renderApi(el) {
  const base = `${location.origin}/api/v3`;
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
      h('pre', { class: 'code-sample', tabindex: '0' }, `claude mcp add --transport http notabene ${location.origin}/mcp \\\n  --header "Authorization: Bearer nb_…"`))),
    card('Exemples', null, h('pre', { class: 'code-sample', tabindex: '0' }, [
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
      ['GET', '/pages/:id/versions', 'read'], ['GET', '/search?q=', 'read'], ['POST', '/ai/ask', 'ai'], ['POST', '/ai/assist', 'ai'], ['GET', '/admin/audit', 'admin'],
    ].map(([m, path, scope]) => h('div', { class: 'table-row' }, h('code', { class: `method ${m.toLowerCase()}` }, m), h('code', { class: 'grow' }, path), pill(scope))))));
}

export async function renderAbout(el) {
  el.replaceChildren(loadingEl());
  const about = await A.attempt(() => api.get('/about'));
  if (!about) return;
  const update = session.can('admin') ? await A.attempt(() => api.get('/admin/update-check')) : null;
  if (update) { session.update = update; notifyNewsChange(); } // l'alerte de la barre latérale suit ce que l'écran affiche
  markNewsSeen(about.version);
  document.querySelectorAll('.set-nav-item .news-dot').forEach((d) => d.remove()); // la pastille du menu des réglages

  const DOCS = `${REPO_URL}/blob/main/docs/MISE-A-JOUR.md`;

  // Activer ou couper la vérification : le texte dit exactement ce qui part, et ce qui ne part pas.
  const setChecking = async (enabled) => {
    const reauth = await askReauth(enabled ? 'activer la vérification de mise à jour' : 'désactiver la vérification de mise à jour');
    if (!reauth) return;
    const status = await A.attempt(() => api.put('/admin/update-check/settings', { enabled, reauth }));
    if (!status) return;
    session.update = null;
    session.refreshUpdate();
    toast(enabled ? 'Vérification des mises à jour activée' : 'Vérification des mises à jour désactivée');
    renderAbout(el);
  };
  // « Vérifier maintenant » : relance la vérification sans attendre le cache de 12 h (pas de mot de passe : rien ne change).
  const checkNow = async (button) => {
    button.disabled = true;
    button.textContent = 'Vérification…';
    const fresh = await A.attempt(() => api.post('/admin/update-check/refresh'));
    if (!fresh) { button.disabled = false; button.textContent = 'Vérifier maintenant'; return; }
    session.update = fresh;
    notifyNewsChange();
    toast(fresh.error ? 'Vérification impossible pour le moment' : fresh.updateAvailable ? `La version ${fresh.latest.version} est disponible` : 'Notabene est à jour');
    renderAbout(el);
  };
  const checkButton = () => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: (e) => checkNow(e.currentTarget) }, 'Vérifier maintenant');
  // Mise à jour depuis l'interface : Notabene dépose une demande, le service de l'hôte décide et exécute (docs/MISE-A-JOUR.md).
  const applyUpdate = async () => {
    const target = update.latest.version;
    const ok = await confirmModal({
      title: `Mettre à jour vers la version ${target} ?`,
      message: 'Le service de l’hôte va sauvegarder la base, télécharger la nouvelle image et redémarrer Notabene : l’application sera indisponible une à deux minutes. Si la nouvelle version ne démarre pas, l’ancienne est remise en place. Avez-vous lu les nouveautés, surtout « Attention à la mise à jour » ?',
      confirm: 'Mettre à jour',
    });
    if (!ok) return;
    const reauth = await askReauth('lancer la mise à jour de l’instance', { strict: true });
    if (!reauth) return;
    if (!(await A.attempt(() => api.post('/admin/update/apply', { version: target, reauth })))) return;
    followUpdate(target);
  };
  const progress = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const followUpdate = (target) => {
    progress.textContent = 'Demande envoyée au service de l’hôte (jusqu’à 30 secondes avant le début)…';
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 15 * 60_000) { progress.textContent = 'Pas de réponse après 15 minutes : consultez le journal du service sur l’hôte (journalctl -u notabene-updater).'; return; }
      try {
        const s = await api.get('/admin/update-check');
        if (s.current === target) { toast(`Notabene est à jour (${target})`); location.reload(); return; }
        const u = s.updater;
        if (u?.state === 'failed') { progress.textContent = `Échec : ${u.message || 'voir le journal du service sur l’hôte'}`; return; }
        progress.textContent = u?.state === 'running' ? `${u.message || 'Mise à jour en cours…'}` : 'En attente du service de l’hôte…';
      } catch { progress.textContent = 'Redémarrage de Notabene en cours… la page se rechargera toute seule.'; }
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 5000);
  };
  const updaterPart = () => {
    const u = update.updater;
    if (!update.updateAvailable) return null;
    if (!u?.available) {
      return h('p', { class: 'hint' }, 'Pour mettre à jour depuis cette page, installez le service de mise à jour sur l’hôte. ', h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'Guide ↗'));
    }
    return h('div', { class: 'stack' },
      u.state === 'failed' && u.message ? h('div', { class: 'notice warning' }, `Dernière tentative : ${u.message}`) : null,
      h('div', null, h('button', { class: 'btn btn-primary', type: 'button', disabled: u.state === 'running', onClick: applyUpdate }, icon('sparkle', 14), `Mettre à jour vers la ${update.latest.version}`)),
      progress,
      h('p', { class: 'hint' }, 'Le service de l’hôte vérifie que cette version est bien la dernière publiée, sauvegarde la base, puis redémarre Notabene. Notabene lui-même n’a aucun accès à Docker.'));
  };

  const explanation = h('div', { class: 'stack' },
    h('p', null, h('strong', null, 'Ce n’est pas une mise à jour automatique. '), 'Notabene vous prévient seulement qu’une nouvelle version existe ; vous décidez si et quand l’installer.'),
    h('p', null, 'Si vous l’activez, le serveur de cette instance demande à GitHub (api.github.com) quelle est la dernière version publiée, au plus toutes les 12 heures et seulement quand un administrateur ouvre l’application.'),
    h('ul', { class: 'plain-list' },
      h('li', null, h('strong', null, 'GitHub voit : '), 'l’adresse IP publique de votre serveur, l’heure de la demande et le numéro de version de Notabene que vous utilisez.'),
      h('li', null, h('strong', null, 'GitHub ne reçoit pas : '), 'vos pages, vos utilisateurs, le nom ou l’adresse de votre instance, ni aucun identifiant.')),
    h('p', { class: 'hint' }, 'Désactivée, l’instance n’appelle personne. Dans ce cas, vous pouvez vous abonner aux releases du dépôt sur GitHub pour être prévenu par e-mail.'));

  const updateCard = update ? card('Mise à jour', null, !update.enabled
    ? h('div', { class: 'stack' },
      h('p', null, 'La vérification est désactivée : cette instance ne sait pas si une nouvelle version existe.'),
      explanation,
      update.locked
        ? h('p', { class: 'hint' }, 'Ce réglage est fixé par l’environnement du serveur (CONFIG_LOCKED, UPDATE_CHECK).')
        : h('div', null, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => setChecking(true) }, icon('sparkle', 14), 'Activer la vérification')),
      h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'Guide de mise à jour ↗'))
    : h('div', { class: 'stack' },
      update.error ? h('p', { class: 'hint' }, update.error)
        : update.updateAvailable
          ? h('div', { class: 'stack' },
            h('div', { class: 'notice info' }, h('strong', null, `La version ${update.latest.version} est disponible`), ` (vous utilisez la ${update.current}). Lisez ses nouveautés ci-dessous, surtout « Attention à la mise à jour », avant de l’installer.`),
            updaterPart(),
            h('p', { class: 'muted' }, 'À la main : sauvegardez la base, puis, dans le dossier du déploiement :'),
            h('pre', { class: 'code-sample', tabindex: '0' }, 'docker compose pull\ndocker compose up -d'),
            h('p', { class: 'hint' }, 'Si votre fichier compose épingle la version de l’image (NOTABENE_IMAGE), changez d’abord le numéro. ',
              h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'Guide de mise à jour ↗'), ' ',
              update.latest.url.startsWith('https://github.com/') && h('a', { href: update.latest.url, target: '_blank', rel: 'noopener' }, 'Notes sur GitHub ↗')))
          : h('p', null, pill('À jour', 'ok'), ' Vous utilisez la dernière version publiée.'),
      h('div', { class: 'row wrap' }, checkButton(),
        h('span', { class: 'hint' }, update.checkedAt ? `Dernière vérification : ${timeAgo(update.checkedAt)}` : 'Pas encore vérifié')),
      h('details', { class: 'hint' }, h('summary', null, 'Qu’est-ce qui est envoyé à GitHub ?'), explanation),
      !update.locked && h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => setChecking(false) }, 'Désactiver la vérification')))) : null;

  // Notes de la version à installer, lues dans sa release GitHub : on les lit avant de mettre à jour.
  const upcoming = update?.updateAvailable ? update.latest.notes : null;
  const release = (r) => h('section', { class: 'set-card release' },
    h('header', { class: 'set-card-head' },
      h('h3', null, `Version ${r.version} `, h('small', { class: 'muted' }, `· ${r.date}`), ' ', r.version === about.version ? pill('Installée', 'accent') : r.version === upcoming?.version ? pill('Disponible', 'warn') : null),
      r.summary && h('p', { class: 'muted' }, r.summary)),
    r.sections.map((s) => h('div', null, h('h4', null, s.title), h('ul', { class: 'plain-list' }, s.items.map((it) => h('li', null, it))))));

  el.replaceChildren(
    card('Notabene', null, kv([['Version', h('code', null, about.version)], ['Commit de l’image', about.commit ? h('code', null, about.commit) : null]])),
    updateCard,
    h('h3', { class: 'set-subtitle' }, 'Nouveautés'),
    ...(upcoming ? [release(upcoming)] : []),
    ...(about.releases.length ? about.releases.map(release) : [card(null, null, h('p', { class: 'muted' }, 'Aucune note de version disponible.'))]));
}
