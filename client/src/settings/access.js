// Administration des accès : espaces, authentification, e-mail, utilisateurs et journal d'audit.
import { h, timeAgo, fullDate, download } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { session } from '../session.js';
import { avatarEl } from '../avatar.js';
import { toast, confirmModal, openModal } from '../ui.js';
import { askReauth, providerCard } from '../provider-settings.js';
import * as A from '../actions.js';
import { REPO_URL } from './account.js';
import { card, copyable, kv, loadingEl, pill, status } from './ui.js';

export const ROLE_LABELS = { admin: 'Administrateur', editor: 'Éditeur', reader: 'Lecteur' };

export function renderSpaces(el) {
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

export async function renderAuth(el) {
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

export async function renderMail(el) {
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

export async function renderUsers(el) {
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

  // Droit d'accès : copie des données d'un compte, à remettre à la personne qui en fait la demande.
  const exportUser = async (u) => {
    const data = await A.attempt(() => api.get(`/admin/users/${u.id}/export`));
    if (data) download(`donnees-${u.id}.json`, JSON.stringify(data, null, 2), 'application/json');
  };
  // Droit à l'effacement : anonymisation (le contenu reste, sans auteur), après confirmation et mot de passe.
  const eraseUser = async (u) => {
    const sso = !u.local;
    const ok = await confirmModal({
      title: `Supprimer le compte de ${u.name} ?`,
      message: `Le compte, ses jetons, sessions, favoris, suivis et notifications seront supprimés. Ses pages, versions et commentaires restent, sans nom d’auteur. Ses adresses IP sont effacées du journal. Cette action est irréversible.${sso ? ' Compte fédéré : il sera recréé à sa prochaine connexion s’il reste autorisé par le fournisseur d’identité ; retirez-le d’abord des groupes.' : ''}`,
      confirm: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    const reauth = await askReauth('supprimer définitivement un compte', { strict: true });
    if (!reauth) return;
    if (await A.attempt(() => api.post(`/admin/users/${u.id}/erase`, { reauth }))) { toast('Compte supprimé'); refresh(); }
  };

  const row = (u) => h('div', { class: 'table-row wrap' },
    avatarEl(u, { cls: 'static' }),
    h('span', { class: 'grow' }, h('strong', null, u.name), h('small', null, `${u.email || 'sans e-mail'} · ${u.lastLoginAt ? `connecté ${timeAgo(u.lastLoginAt)}` : 'jamais connecté'}${u.tokens ? ` · ${u.tokens} jeton(s)` : ''}`)),
    h('span', { class: 'row-actions' },
      u.local && u.mfa && pill('MFA', 'ok'),
      u.disabled && pill('Désactivé', 'off'),
      u.local && u.id !== session.user.id
      ? h('select', { class: 'input input-sm', 'aria-label': 'Rôle', onChange: (e) => patch(u, { role: e.target.value }, 'Rôle modifié') },
        Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value, selected: value === u.role }, label)))
      : pill(ROLE_LABELS[u.role] || u.role, u.role === 'admin' ? 'accent' : ''),
      u.local && u.id !== session.user.id && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => patch(u, { disabled: !u.disabled }, u.disabled ? 'Compte réactivé' : 'Compte désactivé') }, u.disabled ? 'Réactiver' : 'Désactiver'),
      u.local && u.mfa && h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => { if (await confirmModal({ title: 'Réinitialiser la double authentification ?', message: u.name, confirm: 'Réinitialiser', danger: true })) patch(u, { resetMfa: true }, 'MFA réinitialisée'); } }, 'Réinit. MFA'),
      u.local && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => resetPassword(u) }, 'Mot de passe'),
      u.id !== session.user.id && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => exportUser(u) }, 'Données'),
      u.id !== session.user.id && h('button', { class: 'btn btn-ghost btn-sm danger-text', onClick: () => eraseUser(u) }, 'Supprimer')));

  const mail = h('input', { class: 'input', type: 'email', placeholder: 'E-mail', maxlength: '200', autocomplete: 'off' });
  const name = h('input', { class: 'input', placeholder: 'Nom', maxlength: '120', autocomplete: 'off' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe initial (12 car. min.)', maxlength: '256', autocomplete: 'new-password' });
  const mailOn = !!session.config.auth.mail;
  const invite = h('input', { type: 'checkbox' });
  invite.checked = mailOn;
  invite.addEventListener('change', () => { pass.hidden = invite.checked; });
  pass.hidden = mailOn;
  const roleSel = h('select', { class: 'input', 'aria-label': 'Rôle du nouveau compte' }, Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value, selected: value === 'editor' }, label)));

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
  'token.create': 'Jeton créé', 'token.revoke': 'Jeton révoqué', 'settings.ai': 'Réglages IA', 'ai.ask': 'Question IA', 'ai.assist': 'Assistant de rédaction',
  'space.create': 'Espace créé', 'space.delete': 'Espace supprimé', 'space.visibility': 'Visibilité modifiée',
  'page.destroy': 'Page supprimée définitivement', 'trash.empty': 'Corbeille vidée',
};

export async function renderAudit(el) {
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
