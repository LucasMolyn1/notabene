# Données personnelles (RGPD)

Ce document aide la personne ou l'organisation qui **déploie** Notabene à respecter le RGPD. Elle est le *responsable de traitement* : Notabene est l'outil, pas le responsable. Ce texte n'est pas un avis juridique ; faites-le relire par votre DPO ou un juriste.

## Données traitées

| Catégorie | Contenu | Où |
|---|---|---|
| Compte | nom, adresse e-mail, rôle, date de création et de dernière connexion ; pour un compte local : hash du mot de passe, secret TOTP chiffré | base SQLite |
| Contenu | pages, versions, commentaires, libellés, favoris, suivis, permissions ; l'auteur est rattaché par identifiant | base SQLite |
| Photo de profil (facultative) | une image réduite à 256 px, envoyée par la personne elle-même ; visible des personnes connectées ; métadonnées retirées par le navigateur ; supprimée avec le compte, ou par la personne, ou par un administrateur | base SQLite |
| Sessions et jetons | hash de l'identifiant de session, hash des jetons d'API, dates | base SQLite |
| Journal d'audit | action, date, identifiant de l'utilisateur, **adresse IP** | base SQLite |
| Notifications | type, page concernée, auteur, état de lecture ; l'e-mail ne contient que le titre, le nom et un lien | base SQLite, serveur SMTP |
| Journaux du serveur | selon votre proxy et `LOG_LEVEL` | votre infrastructure |
| Sauvegardes | copie de la base | votre stockage |

Cookies : uniquement techniques (session, liaison de la connexion SSO). Aucun traceur. Les préférences d'affichage restent dans le navigateur (`localStorage`).

## Durées de conservation

Des purges automatiques tournent toutes les heures. Les valeurs sont en jours, `0` désactive la purge.

| Donnée | Variable | Défaut |
|---|---|---|
| Pages à la corbeille (racines, avec leurs sous-pages) | `TRASH_RETENTION_DAYS` | 30 |
| Notifications **lues** | `NOTIFICATION_RETENTION_DAYS` | 90 |
| Adresses IP du journal d'audit (effacées, l'entrée reste) | `AUDIT_IP_RETENTION_DAYS` | 90 |
| Entrées du journal d'audit | `AUDIT_RETENTION_DAYS` | 365 |
| Sessions, jetons de connexion et de réinitialisation expirés | non réglable | à l'expiration |

Adaptez ces durées à votre finalité et documentez-les dans votre registre des traitements.

## Droits des personnes

| Droit | Comment l'exercer |
|---|---|
| Accès et portabilité | La personne télécharge ses données dans **Paramètres, Profil et sessions, Télécharger mes données** (JSON, sans aucun secret). Un administrateur peut produire la même copie depuis **Utilisateurs, Données**. |
| Effacement | Un administrateur utilise **Utilisateurs, Supprimer** (mot de passe demandé). Voir « Effacement » ci-dessous. |
| Rectification | Compte fédéré : à modifier chez le fournisseur d'identité, la correction est reprise à la connexion suivante. Compte local : nom et e-mail modifiables par un administrateur. |
| Limitation | **Utilisateurs, Désactiver** : le compte ne peut plus se connecter mais ses données restent. |
| Opposition | Les notifications par e-mail se règlent dans **Profil**. |

### Effacement

La suppression est une **anonymisation** : le compte et ce qui lui est propre disparaissent (sessions, jetons, favoris, suivis, notifications, permissions, préférences). Les pages, versions, commentaires et libellés restent, **sans nom d'auteur**, pour que le wiki reste cohérent. Les adresses IP et la cible des entrées du journal qui le concernent sont effacées. L'effacement lui-même est journalisé, sans l'identité de la personne.

- Un compte fédéré (SSO, LDAP) est **recréé** à sa prochaine connexion s'il reste autorisé par l'annuaire : retirez-le d'abord des groupes.
- Le texte d'un commentaire peut contenir des données personnelles écrites par la personne ; un administrateur peut le supprimer à part si la demande le justifie.
- **Sauvegardes** : une personne effacée reste présente dans les sauvegardes existantes jusqu'à leur rotation (`BACKUP_KEEP`, 14 par défaut). Indiquez ce délai dans votre politique ; en cas de restauration, rejouez les effacements demandés depuis la sauvegarde.

## Destinataires et sous-traitants possibles

- **Fournisseur d'identité** (Authentik, annuaire LDAP, SAML) : il fournit nom, e-mail et groupes.
- **Serveur SMTP** : reçoit l'adresse du destinataire et le titre de la page.
- **Fournisseur d'IA** (recherche IA) : reçoit la question et des **extraits des pages lisibles par la personne**. Avec un service externe (Anthropic, OpenAI, Mistral…), c'est un sous-traitant : contrat de sous-traitance et, hors UE, garanties de transfert. Un modèle local (`AI_ALLOW_PRIVATE=true`, Ollama) garde tout chez vous.
- **Webhooks** : reçoivent des identifiants de pages et d'utilisateurs, jamais le contenu.
- **Draw.io** (si activé) : à héberger vous-même, comme dans le `docker-compose.yml`.

## Sécurité et incidents

Les mesures techniques sont décrites dans [SECURITY.md](../SECURITY.md). En cas de violation de données personnelles, le responsable de traitement doit notifier l'autorité de contrôle (CNIL en France) **dans les 72 heures** si la violation présente un risque pour les personnes. Le journal d'audit et les sauvegardes aident à établir ce qui a été touché.

## Mention d'information (modèle)

> Les données de votre compte (nom, adresse e-mail, rôle) et vos contributions sont traitées par [organisation] pour [finalité : documentation interne], sur la base de [intérêt légitime / exécution du contrat]. Les adresses IP de connexion sont conservées 90 jours, le journal d'audit 365 jours. Vous pouvez accéder à vos données, les faire rectifier ou effacer en vous adressant à [contact]. Vous pouvez saisir la CNIL.

## Liste de contrôle pour le déploiement

- [ ] Inscrire Notabene au registre des traitements.
- [ ] Choisir les durées de conservation et les noter dans le registre.
- [ ] Informer les utilisateurs (mention ci-dessus).
- [ ] Si la recherche IA utilise un service externe : contrat de sous-traitance et transferts.
- [ ] Documenter la durée de rotation des sauvegardes (`BACKUP_KEEP`) et chiffrer les sauvegardes (`BACKUP_AGE_RECIPIENT`).
- [ ] Définir qui traite les demandes d'accès et d'effacement, et sous quel délai (un mois).
