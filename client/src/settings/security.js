// Section « Sécurité » : synthèse en lecture seule qui renvoie vers les sections où chaque point se règle.
// Aucun réglage ici. Données : la session déjà chargée, plus au plus deux lectures légères en parallèle
// (statut de la double authentification d'un compte local, durées de session pour un administrateur).
import { h } from '../util.js';
import { icon } from '../icons.js';
import { api, request } from '../api.js';
import { session } from '../session.js';
import { card, pill } from './ui.js';

const PROVIDERS = { oidc: 'votre fournisseur d’identité (OIDC)', saml: 'votre fournisseur SSO (SAML)', ldap: 'l’annuaire de l’entreprise (LDAP)' };

const go = (href, text) => h('a', { class: 'btn btn-ghost btn-sm', href }, text, icon('chevron', 14));

/** Une ligne de la synthèse : intitulé, état (texte ou pastille), explication et lien vers la section concernée. */
const item = (title, state, desc, link) => h('li', { class: 'sec-item' },
  h('div', { class: 'sec-item-text' },
    h('strong', null, title, state ? ' ' : null, state),
    desc && h('small', null, desc)),
  link);

export async function renderSecurity(el) {
  const admin = session.can('admin');
  const local = session.provider === 'local';
  el.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
  const [mfa, retention] = await Promise.all([
    local ? request('GET', '/auth/local/me').catch(() => null) : null,
    admin ? api.get('/admin/retention').catch(() => null) : null,
  ]);
  if (!el.isConnected) return;

  const mfaState = local
    ? (mfa ? (mfa.mfa ? pill('Activée', 'ok') : pill('Désactivée', 'warn')) : pill('État inconnu', 'off'))
    : pill('Gérée ailleurs', 'off');
  const mfaDesc = local
    ? (mfa?.mfa ? `Second facteur actif. Codes de secours restants : ${mfa.recoveryLeft}.` : 'Ajoutez un code à usage unique à votre mot de passe : une application d’authentification suffit.')
    : `Votre connexion passe par ${PROVIDERS[session.provider] || 'un fournisseur externe'} : la double authentification s’y règle.`;

  const mine = card('Votre compte', 'Ce qui protège votre propre accès.',
    h('ul', { class: 'sec-list' },
      item('Double authentification', mfaState, mfaDesc, local ? go('/settings/profile', 'Gérer') : null),
      item('Sessions actives', null, 'Chaque navigateur connecté ouvre une session. Fermez celles que vous ne reconnaissez pas.', go('/settings/profile', 'Voir mes sessions')),
      item('Jetons d’API', null, 'Accès des scripts et des outils à votre place : limitez leurs portées, leurs espaces et leur durée.', go('/settings/tokens', 'Gérer mes jetons')),
      session.can('write') && !admin && item('Pages partagées', null, 'Liens publics qui donnent accès à une page sans compte.', go('/settings/shares', 'Voir les partages'))));

  if (!admin) {
    el.replaceChildren(mine, h('p', { class: 'hint' }, 'Les réglages de sécurité de l’instance (authentification, journal, conservation) sont réservés aux administrateurs.'));
    return;
  }

  const sessionRow = retention?.fixed?.find((r) => r.label === 'Sessions');
  const keep = Array.isArray(retention?.items) ? retention.items : null;
  const instance = card('Instance', 'Réglages communs à tous les comptes. Cette page les résume ; chacun se modifie dans sa section.',
    h('ul', { class: 'sec-list' },
      item('Durée de session', sessionRow ? h('span', { class: 'sec-value' }, sessionRow.value) : null,
        h('span', null, 'Lecture seule : se règle par les variables d’environnement ', h('code', null, 'SESSION_TTL_HOURS'), ' (durée maximale) et ', h('code', null, 'SESSION_IDLE_MINUTES'), ' (inactivité), puis redémarrage.'),
        null),
      item('Authentification', null, 'Connexion locale, OIDC, LDAP ou SAML, et double authentification obligatoire pour les comptes locaux (LOCAL_REQUIRE_MFA).', go('/settings/auth', 'Ouvrir')),
      item('Journal d’audit', null, 'Qui a fait quoi, et sur quoi : connexions, jetons, partages, réglages.', go('/settings/audit', 'Consulter')),
      item('Envoi vers un SIEM', null, 'Copie du journal vers votre collecteur (HTTPS).', go('/settings/siem', 'Configurer')),
      item('Conservation des données', keep ? h('span', { class: 'sec-value' }, `${keep.filter((r) => r.purged).length} purge${keep.filter((r) => r.purged).length > 1 ? 's' : ''} automatique${keep.filter((r) => r.purged).length > 1 ? 's' : ''}`) : null,
        'Durées après lesquelles journaux, versions et corbeille sont purgés.', go('/settings/retention', 'Voir les durées')),
      item('Partages publics', null, 'Toutes les pages ouvertes par un lien public, avec leur date d’expiration.', go('/settings/shares', 'Voir les partages')),
      item('Utilisateurs', null, 'Comptes, rôles et désactivation.', go('/settings/users', 'Gérer'))));
  el.replaceChildren(mine, instance);
}
