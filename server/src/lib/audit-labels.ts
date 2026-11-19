// Présentation lisible du journal d'audit (liste et export réservés aux administrateurs) : libellé français de chaque action
// et cible résolue ({ type, id, title }). Les titres sont relus au moment de la lecture, par une requête groupée par type
// d'objet (jamais une requête par ligne). Rien de ceci n'est écrit dans `audit_log` ni envoyé au SIEM.
// Espace personnel : le titre d'une page (ou d'un modèle) qui s'y trouve n'est jamais montré (comme le détail des libellés).
import type { DB } from '../db.js';

export const AUDIT_LABELS: Record<string, string> = {
  // Connexion et comptes
  'auth.login': 'Connexion',
  'auth.logout': 'Déconnexion',
  'auth.denied': 'Accès refusé',
  'auth.local.failed': 'Échec de connexion (compte local)',
  'auth.ldap.failed': 'Échec de connexion (LDAP)',
  'auth.saml.failed': 'Échec de connexion (SAML)',
  'auth.reauth.failed': 'Échec de la ressaisie du mot de passe',
  'auth.local.forgot': 'Demande de réinitialisation du mot de passe',
  'auth.local.reset': 'Mot de passe réinitialisé',
  'auth.local.setup': 'Compte local activé',
  'auth.local.password': 'Mot de passe changé',
  'auth.mfa.enable': 'Double authentification activée',
  'auth.mfa.disable': 'Double authentification désactivée',
  'auth.sessions.revoke': 'Autres sessions fermées',
  'user.create': 'Compte créé',
  'user.update': 'Compte modifié',
  'user.erase': 'Compte effacé (anonymisé)',
  'user.export': 'Données personnelles exportées',
  'profile.avatar.set': 'Photo de profil changée',
  'profile.avatar.remove': 'Photo de profil retirée',
  // Jetons d'API
  'token.create': 'Jeton d’API créé',
  'token.revoke': 'Jeton d’API révoqué',
  'api.access': 'Accès à l’API par jeton (résumé)',
  // Groupes
  'group.create': 'Groupe créé',
  'group.update': 'Groupe modifié',
  'group.delete': 'Groupe supprimé',
  'group.member.add': 'Membre ajouté à un groupe',
  'group.member.remove': 'Membre retiré d’un groupe',
  // Espaces
  'space.create': 'Espace créé',
  'space.update': 'Espace modifié',
  'space.delete': 'Espace supprimé',
  'space.visibility': 'Visibilité d’un espace changée',
  'space.sharing': 'Partage public d’un espace réglé',
  'space.forms': 'Formulaires d’un espace réglés',
  'space.member.set': 'Droit sur un espace donné ou changé',
  'space.member.remove': 'Droit sur un espace retiré',
  'space.personal.create': 'Espace personnel créé',
  'space.personal.delete': 'Espace personnel supprimé',
  'space.personal.recover': 'Espace personnel récupéré',
  'space.export.zip': 'Espace exporté (ZIP)',
  'space.share.mail': 'Lien de partage d’un espace envoyé par e-mail',
  // Pages
  'page.create': 'Page créée',
  'page.update': 'Page modifiée',
  'page.move': 'Page déplacée',
  'page.duplicate': 'Page dupliquée',
  'page.copy': 'Page copiée',
  'page.trash': 'Page mise à la corbeille',
  'page.restore': 'Page restaurée',
  'page.destroy': 'Page supprimée définitivement',
  'page.version.restore': 'Version de page restaurée',
  'page.permissions': 'Permissions d’une page modifiées',
  'page.label.add': 'Libellé ajouté',
  'page.label.remove': 'Libellé retiré',
  'page.export': 'Page exportée',
  'page.export.zip': 'Page exportée (ZIP)',
  'trash.empty': 'Corbeille vidée',
  'trash.purge': 'Corbeille purgée automatiquement',
  'search': 'Recherche par jeton d’API',
  // Commentaires
  'comment.create': 'Commentaire ajouté',
  'comment.update': 'Commentaire modifié',
  'comment.delete': 'Commentaire supprimé',
  // Partages, vérifications, modèles
  'share.create': 'Lien de partage créé',
  'share.update': 'Lien de partage modifié',
  'share.regenerate': 'Lien de partage renouvelé',
  'share.revoke': 'Lien de partage révoqué',
  'verification.set': 'Vérification de page réglée',
  'verification.clear': 'Vérification de page retirée',
  'verification.verify': 'Page vérifiée',
  'template.create': 'Modèle créé',
  'template.rename': 'Modèle renommé',
  'template.delete': 'Modèle supprimé',
  // Pièces jointes
  'attachment.upload': 'Pièce jointe ajoutée',
  'attachment.delete': 'Pièce jointe supprimée',
  'attachment.unreferenced.purge': 'Pièces jointes inutilisées purgées',
  // Bases
  'base.create': 'Base créée',
  'base.export': 'Base exportée (CSV)',
  'base.settings': 'Réglages d’une base modifiés',
  'base.property.add': 'Colonne ajoutée',
  'base.property.remove': 'Colonne supprimée',
  'base.row.create': 'Ligne ajoutée',
  'base.row.update': 'Ligne modifiée',
  'base.rows.delete': 'Lignes supprimées',
  'base.template.add': 'Modèle de ligne ajouté',
  'base.template.update': 'Modèle de ligne modifié',
  'base.template.remove': 'Modèle de ligne supprimé',
  'base.ical.create': 'Flux iCalendar créé',
  'base.ical.rotate': 'Adresse du flux iCalendar changée',
  'base.ical.revoke': 'Flux iCalendar révoqué',
  'base.automation.create': 'Automatisation créée',
  'base.automation.update': 'Automatisation modifiée',
  'base.automation.delete': 'Automatisation supprimée',
  'base.automation.secret': 'Secret d’automatisation renouvelé',
  'base.automation.active': 'Automatisation réactivée',
  'base.automation.paused': 'Automatisation mise en pause',
  'base.automation.suspended': 'Automatisation suspendue',
  'base.automation.broken': 'Automatisation en erreur',
  'base.form.create': 'Formulaire créé',
  'base.form.update': 'Formulaire modifié',
  'base.form.delete': 'Formulaire supprimé',
  'base.form.link.create': 'Lien de formulaire créé',
  'base.form.link.rotate': 'Lien de formulaire renouvelé',
  'base.form.link.revoke': 'Lien de formulaire révoqué',
  // Import, IA
  'import.markdown': 'Import Markdown',
  'import.notion': 'Import Notion',
  'import.notion.dry_run': 'Import Notion simulé',
  'import.document': 'Import d’un document',
  'import.document.dry_run': 'Import d’un document simulé',
  'ai.ask': 'Question à la recherche IA',
  'ai.assist': 'Assistant de rédaction utilisé',
  'ai.chat': 'Message au chat IA',
  'ai.chat.delete': 'Conversation du chat IA supprimée',
  // Administration
  'settings.ai': 'Réglages de l’IA modifiés',
  'settings.sharing': 'Partage public de l’instance réglé',
  'settings.space_share_mail': 'Envoi des liens d’espace par e-mail réglé',
  'settings.forms': 'Formulaires de l’instance réglés',
  'settings.automations': 'Automatisations de l’instance réglées',
  'settings.test': 'Test d’une configuration réussi',
  'settings.test.failed': 'Test d’une configuration échoué',
  'settings.reset': 'Réglages remis par défaut',
  'webhook.create': 'Webhook créé',
  'webhook.update': 'Webhook modifié',
  'webhook.delete': 'Webhook supprimé',
  'backup.download': 'Sauvegarde téléchargée',
  'audit.export': 'Journal d’audit exporté',
  'audit.siem.test': 'Test d’envoi au SIEM',
  'audit.siem.stop': 'Arrêt de l’envoi au SIEM',
  'images.migration.start': 'Conversion des images lancée',
  'images.migration.revert': 'Conversion des images annulée',
  'images.migration.dryrun': 'Conversion des images simulée',
  'images.migration.end': 'Conversion des images terminée',
  'cli.admin.create': 'Administrateur créé (ligne de commande)',
  'cli.admin.reset': 'Administrateur réinitialisé (ligne de commande)',
  'cli.images.migration.start': 'Conversion des images lancée (ligne de commande)',
  'cli.images.migration.revert': 'Conversion des images annulée (ligne de commande)',
  'cli.images.migration.end': 'Conversion des images terminée (ligne de commande)',
  // SCIM
  'scim.settings': 'Réglages SCIM modifiés',
  'scim.token.create': 'Jeton SCIM créé',
  'scim.token.revoke': 'Jeton SCIM révoqué',
  'scim.auth.failed': 'Échec d’authentification SCIM',
  'scim.user.create': 'Compte créé par SCIM',
  'scim.user.update': 'Compte modifié par SCIM',
  'scim.user.deactivate': 'Compte désactivé par SCIM',
  'scim.user.delete': 'Compte supprimé par SCIM',
  'scim.group.create': 'Groupe créé par SCIM',
  'scim.group.update': 'Groupe modifié par SCIM',
  'scim.group.delete': 'Groupe supprimé par SCIM',
};

const SETTINGS_SECTIONS: Record<string, string> = {
  embed: 'contenus intégrés', embeds: 'contenus intégrés', oidc: 'OIDC', ldap: 'LDAP', saml: 'SAML', smtp: 'e-mail (SMTP)', siem: 'envoi au SIEM',
};

// Libellé générique par famille, pour une action inconnue (jamais le code seul).
const FAMILY_LABELS: Record<string, string> = {
  auth: 'Action de connexion', user: 'Action sur un compte', profile: 'Action sur un profil', token: 'Action sur un jeton d’API',
  group: 'Action sur un groupe', space: 'Action sur un espace', page: 'Action sur une page', comment: 'Action sur un commentaire',
  share: 'Action sur un lien de partage', verification: 'Action de vérification', template: 'Action sur un modèle',
  attachment: 'Action sur une pièce jointe', base: 'Action sur une base', import: 'Import', ai: 'Action de l’IA',
  settings: 'Réglages modifiés', webhook: 'Action sur un webhook', images: 'Conversion des images', cli: 'Action en ligne de commande',
  scim: 'Action SCIM', trash: 'Action sur la corbeille', audit: 'Action sur le journal d’audit', backup: 'Sauvegarde', api: 'Accès à l’API',
};

export function auditLabel(action: string): string {
  const known = AUDIT_LABELS[action];
  if (known) return known;
  const section = /^settings\.([a-z]+)$/.exec(action)?.[1];
  if (section && SETTINGS_SECTIONS[section]) return `Réglages modifiés : ${SETTINGS_SECTIONS[section]}`;
  if (action.endsWith('.failed')) return `${FAMILY_LABELS[action.split('.')[0]!] ?? 'Action'} (échec)`;
  return FAMILY_LABELS[action.split('.')[0]!] ?? 'Action enregistrée';
}

export type TargetType = 'page' | 'space' | 'user' | 'group' | 'token' | 'template' | 'comment' | 'attachment' | 'conversation' | 'webhook' | 'settings' | 'import' | 'automation' | 'other';
export interface AuditTarget { type: TargetType; id: string; title: string | null }

// Type de la cible d'après la famille de l'action (la cible est toujours un identifiant ; voir docs/AUDIT.md).
function targetType(action: string): TargetType {
  if (action === 'api.access' || action.startsWith('token.')) return 'token';
  if (action.startsWith('space.') || action.startsWith('import.')) return 'space';
  if (/^(page|share|verification|base)\./.test(action) || action === 'ai.assist') return 'page';
  if (action.startsWith('comment.')) return 'comment';
  if (action.startsWith('template.')) return 'template';
  if (action.startsWith('attachment.')) return 'attachment';
  if (action.startsWith('group.') || action.startsWith('scim.group.')) return 'group';
  if (/^(user|profile|auth)\./.test(action) || action.startsWith('scim.user.') || action.startsWith('cli.admin.')) return 'user';
  if (action.startsWith('ai.chat')) return 'conversation';
  if (action.startsWith('webhook.')) return 'webhook';
  if (action.startsWith('settings.')) return 'settings';
  return 'other';
}

/**
 * Cibles résolues d'un lot de lignes : une requête par type d'objet présent dans le lot. Un objet disparu garde son
 * identifiant avec `title: null`. `auth.denied` vise souvent un identifiant externe (sujet OIDC, LDAP) : type `other`.
 */
export function resolveTargets(db: DB, rows: { action: string; target: string | null }[]): (AuditTarget | null)[] {
  const typed = rows.map((r) => (r.target ? { type: r.action === 'auth.denied' && !r.target.match(/^[A-Za-z0-9_-]{1,64}$/) ? 'other' as const : targetType(r.action), id: r.target } : null));
  const byType = new Map<TargetType, Set<string>>();
  for (const t of typed) if (t) (byType.get(t.type) ?? byType.set(t.type, new Set()).get(t.type)!).add(t.id);
  const titles = new Map<string, string | null>();
  const load = (type: TargetType, sql: string) => {
    const ids = byType.get(type);
    if (!ids?.size) return;
    for (const r of db.prepare(sql).all(JSON.stringify([...ids])) as { id: string; title: string | null }[]) titles.set(`${type}:${r.id}`, r.title);
  };
  const IN = 'IN (SELECT value FROM json_each(?))';
  load('page', `SELECT p.id, CASE WHEN s.kind = 'personal' THEN NULL ELSE p.title END AS title FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id ${IN}`);
  load('space', `SELECT id, name AS title FROM spaces WHERE id ${IN}`);
  load('user', `SELECT id, name AS title FROM users WHERE id ${IN}`);
  load('group', `SELECT id, name AS title FROM groups WHERE id ${IN}`);
  load('token', `SELECT id, name AS title FROM api_tokens WHERE id ${IN}`);
  load('template', `SELECT t.id, CASE WHEN s.kind = 'personal' THEN NULL ELSE t.name END AS title FROM page_templates t JOIN spaces s ON s.id = t.space_id WHERE t.id ${IN}`);
  // Commentaire : la cible affichée est la page commentée (le texte du commentaire ne sort jamais).
  load('comment', `SELECT c.id, CASE WHEN s.kind = 'personal' THEN NULL ELSE p.title END AS title FROM page_comments c JOIN pages p ON p.id = c.page_id JOIN spaces s ON s.id = p.space_id WHERE c.id ${IN}`);
  return typed.map((t) => {
    if (!t) return null;
    const key = `${t.type}:${t.id}`;
    const title = titles.get(key);
    return { type: t.type, id: t.id, title: typeof title === 'string' && title.trim() ? title : (title === '' && t.type === 'page' ? 'Sans titre' : null) };
  });
}
