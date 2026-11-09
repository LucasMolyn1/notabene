# Données personnelles (RGPD)

Ce document aide la personne ou l'organisation qui **déploie** BeNote à respecter le RGPD. Elle est le *responsable de traitement* : BeNote est l'outil, pas le responsable. Ce texte n'est pas un avis juridique ; faites-le relire par votre DPO ou un juriste.

## Données traitées

| Catégorie | Contenu | Où |
|---|---|---|
| Compte | nom, adresse e-mail, rôle, date de création et de dernière connexion ; pour un compte local : hash du mot de passe, secret TOTP chiffré | base SQLite |
| Contenu | pages, versions, commentaires (et personnes mentionnées), libellés, modèles, favoris, suivis, permissions, appartenance aux groupes et aux espaces (y compris celle recopiée du fournisseur d'identité à chaque connexion), espace personnel (lisible de son seul propriétaire), liens de partage public (jeton, auteur du lien) ; l'auteur est rattaché par identifiant | base SQLite |
| Pièces jointes | fichiers joints aux pages (contenu libre, qui peut contenir des données personnelles), nom d'origine, envoyeur (identifiant), date ; visibles de qui peut lire la page | fichiers dans `DATA_DIR/attachments`, inventaire en base |
| Texte des pièces jointes (recherche) | texte extrait des PDF, documents Word (.docx) et fichiers texte joints, pour la recherche ; copie dérivée du fichier, jamais servie telle quelle (seuls les extraits d'une recherche sont montrés, aux personnes qui lisent la page) | base de données (tables `attachment_text` et `attachments_fts`), effacé avec la pièce jointe ; désactivable par `ATTACHMENT_INDEX=false` |
| Photo de profil (facultative) | une image réduite à 256 px, envoyée par la personne elle-même ; visible des personnes connectées ; métadonnées retirées par le navigateur ; supprimée avec le compte, ou par la personne, ou par un administrateur | base SQLite |
| Rapports d'import (Notion) | chemins des fichiers de l'archive importée, titres, motifs d'écart, auteur, espace, date ; lisibles de leur seul auteur ; l'archive elle-même n'est pas conservée | base SQLite |
| Conversations du chat IA | titre (début du premier message), messages de la personne et réponses de l'assistant, pages citées en source, page d'origine, dates ; lisibles de leur seule propriétaire (ni les autres comptes ni les administrateurs ne les lisent dans l'interface ou l'API) | base SQLite (tables `ai_conversations` et `ai_messages`) |
| Vérification de page | personnes désignées comme vérificatrices d'une page, auteur et date de la dernière vérification, auteur de la configuration ; visibles (nom et identifiant seulement) de qui peut lire la page | base SQLite (tables `page_verifications` et `page_verifiers`) |
| Accusé de lecture | **suivi individuel** : sur une page où un accusé est demandé, date à laquelle chaque personne a cliqué « J'ai lu » et date de la page à cet instant, auteur et date de la demande. Accusé explicite uniquement : rien n'est enregistré à l'ouverture d'une page. Finalité : s'assurer qu'une consigne ou une procédure a été prise en compte. La liste des lecteurs (nom, date, page modifiée depuis) n'est visible que de la personne qui a demandé, de l'auteur de la page et des administrateurs ; les autres lecteurs voient seulement que l'accusé est demandé et leur propre accusé, ni nom ni nombre (aucun événement temps réel n'est diffusé à l'accusé de réception). Retirer la demande, qui efface tous les accusés, est réservé à ces mêmes personnes. Les journaux techniques du serveur (adresse IP, méthode et adresse de chaque requête) peuvent garder la trace d'une requête d'accusé, comme pour toute requête : ils ne sont pas le journal d'audit. Comptes désactivés et personnes qui ne lisent plus la page : non listés. Aucun accusé n'est inscrit au journal d'audit (seules la demande et son retrait, avec le nombre d'accusés effacés) | base SQLite (tables `page_read_requests` et `page_read_receipts`) |
| Sessions et jetons | hash de l'identifiant de session, hash des jetons d'API, dates | base SQLite |
| Journal d'audit | action, date, identifiant de l'utilisateur, **adresse IP**, cible et détails techniques (jamais de secret ni de contenu de page) | base SQLite ; copies éventuelles : export CSV ou JSON, SIEM, sortie standard (voir [AUDIT.md](AUDIT.md)) |
| Notifications | type, page concernée, auteur, état de lecture ; l'e-mail ne contient que le titre, le nom et un lien | base SQLite, serveur SMTP |
| Journaux du serveur | selon votre proxy et `LOG_LEVEL` | votre infrastructure |
| Sauvegardes | copie de la base et des pièces jointes | votre stockage |

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
| Rapports d'import (les 20 derniers par personne, supprimés avec le compte ou l'espace) | non réglable | 20 rapports |
| Accusés de lecture : pas de purge automatique ; ils restent tant que la demande existe. Retirer la demande (qui peut modifier la page) efface tous les accusés ; chaque personne peut retirer le sien ; supprimés avec la suppression définitive de la page (une page à la corbeille garde sa demande et ses accusés jusqu'à la purge) ou le compte | non réglable | sans limite |
| Conversations du chat IA sans activité (avec leurs messages ; 100 conversations au plus par personne, la plus ancienne supprimée au-delà) | `AI_CHAT_RETENTION_DAYS` (1 à 3650, pas de désactivation) | 90 |

Les durées effectives sont lisibles par un administrateur dans les paramètres (`GET /api/v3/admin/retention`). Adaptez-les à votre finalité et documentez-les dans votre registre des traitements.

## Droits des personnes

| Droit | Comment l'exercer |
|---|---|
| Accès et portabilité | La personne télécharge ses données dans **Paramètres, Profil et sessions, Télécharger mes données** (JSON, sans aucun secret). Un administrateur peut produire la même copie depuis **Utilisateurs, Données**. Les pièces jointes qu'elle a envoyées y sont listées ; l'archive ZIP (`/api/v3/me/export/archive`, ou `/api/v3/admin/users/<id>/export/archive` pour un administrateur) contient en plus leurs fichiers, sous `pieces-jointes/` (les fichiers déjà compressés y sont stockés tels quels ; 4 Go au plus par archive). Comme pour les pages, seules celles de pages qu'elle peut encore lire sont détaillées (le nombre total figure dans `contributions.attachmentsUploaded`). Les pages dont elle est vérificatrice et les vérifications qu'elle a faites figurent sous `verifierOf` et `verificationsPerformed` (pages encore lisibles seulement). Ses accusés de lecture et les demandes d'accusé qu'elle a faites figurent sous `readReceipts` et `readReceiptRequests` (pages encore lisibles seulement). Les conversations du chat IA figurent sous `aiConversations` (titre, dates, messages ; sources limitées aux pages encore lisibles). Dans la copie produite par un administrateur, elles sont réduites à leurs dates et à leur nombre de messages, car les messages peuvent reprendre des pages qu'il ne lit pas : la personne obtient le contenu par son propre export. |
| Effacement | Un administrateur utilise **Utilisateurs, Supprimer** (mot de passe demandé). Voir « Effacement » ci-dessous. La personne supprime elle-même ses conversations du chat IA, une par une ou toutes à la fois (`DELETE /api/v3/ai/conversations`). |
| Rectification | Compte fédéré : à modifier chez le fournisseur d'identité, la correction est reprise à la connexion suivante. Compte local : nom et e-mail modifiables par un administrateur. |
| Limitation | **Utilisateurs, Désactiver** : le compte ne peut plus se connecter mais ses données restent. |
| Opposition | Les notifications par e-mail se règlent dans **Profil**. |

### Effacement

La suppression est une **anonymisation** : le compte et ce qui lui est propre disparaissent (sessions, jetons, favoris, suivis, notifications, permissions, préférences, conversations du chat IA, désignations comme vérificateur de page, accusés de lecture). Les pages, versions, commentaires, libellés, modèles, vérifications de page et demandes d'accusé de lecture restent, **sans nom d'auteur**, pour que le wiki reste cohérent. Les adresses IP et la cible des entrées du journal qui le concernent sont effacées. L'effacement lui-même est journalisé, sans l'identité de la personne.

- **Pièces jointes** : les fichiers envoyés par la personne **restent rattachés à leur page**, comme le texte qu'elle a écrit, et l'envoyeur est retiré (affiché sans nom). Ils ne comptent plus dans aucun quota personnel. Le nom d'origine du fichier et son contenu sont conservés : si la demande porte sur un fichier précis (une photo, un document personnel), un rédacteur de la page ou un administrateur le supprime à part ; le fichier est alors effacé du disque.
- **Mentions** : une mention dans une page ne conserve que l'identifiant de la personne, jamais son nom, et une mention dans un commentaire est supprimée avec le compte. Le texte d'un commentaire est en revanche un texte libre : si quelqu'un y a tapé le nom de la personne, ce texte reste (comme tout texte écrit par un tiers) ; un administrateur peut supprimer le commentaire.
- Un compte fédéré (SSO, LDAP) est **recréé** à sa prochaine connexion s'il reste autorisé par l'annuaire : retirez-le d'abord des groupes.
- Le texte d'un commentaire peut contenir des données personnelles écrites par la personne ; un administrateur peut le supprimer à part si la demande le justifie.
- **Sauvegardes** : une personne effacée reste présente dans les sauvegardes existantes jusqu'à leur rotation (`BACKUP_KEEP`, 14 par défaut). Indiquez ce délai dans votre politique ; en cas de restauration, rejouez les effacements demandés depuis la sauvegarde.

- **Espace personnel** : l'effacement du compte ne supprime pas son espace personnel, qui devient orphelin (invisible de tous). Un administrateur doit ensuite le **supprimer** (Paramètres, Espaces, Espaces personnels) ou le **reprendre** s'il contient des documents à conserver. Sans cette étape, des données personnelles subsistent dans la base.
## Destinataires et sous-traitants possibles

- **Fournisseur d'identité** (Authentik, annuaire LDAP, SAML) : il fournit nom, e-mail et groupes.
- **Serveur SMTP** : reçoit l'adresse du destinataire et le titre de la page.
- **Fournisseur d'IA** (recherche IA, assistant de rédaction, chat), choisi par l'administrateur : reçoit la question et des **extraits des pages lisibles par la personne** ; pour le chat, aussi le **texte de la page ouverte** (8000 caractères au plus) et les **derniers messages de la conversation** (12 messages, 24 000 caractères au plus), à chaque envoi. BeNote ne maîtrise pas la conservation chez le fournisseur : reportez-vous à son contrat. Avec un service externe (Anthropic, OpenAI, Mistral…), c'est un sous-traitant : contrat de sous-traitance et, hors UE, garanties de transfert. Un modèle local (`AI_ALLOW_PRIVATE=true`, Ollama) garde tout chez vous.
- **Webhooks** : reçoivent des identifiants de pages et d'utilisateurs, jamais le contenu.
- **SIEM** (si configuré) et **collecteur de journaux** (`AUDIT_STDOUT=true`) : reçoivent les évènements du journal d'audit, dont l'**identifiant et le nom de l'utilisateur** et l'**adresse IP**, sans secret ni contenu de page. La conservation chez le destinataire relève de votre politique : alignez-la sur `AUDIT_RETENTION_DAYS` et `AUDIT_IP_RETENTION_DAYS` (l'effacement dans BeNote n'atteint pas les copies déjà transmises ni les fichiers exportés), et traitez un SIEM externe comme un sous-traitant.
- **Draw.io** (si activé) : à héberger vous-même, comme dans le `docker-compose.yml`.

## Sécurité et incidents

Les mesures techniques sont décrites dans [SECURITY.md](../SECURITY.md). En cas de violation de données personnelles, le responsable de traitement doit notifier l'autorité de contrôle (CNIL en France) **dans les 72 heures** si la violation présente un risque pour les personnes. Le journal d'audit et les sauvegardes aident à établir ce qui a été touché.

## Mention d'information (modèle)

> Les données de votre compte (nom, adresse e-mail, rôle) et vos contributions sont traitées par [organisation] pour [finalité : documentation interne], sur la base de [intérêt légitime / exécution du contrat]. Les adresses IP de connexion sont conservées 90 jours, le journal d'audit 365 jours. Vous pouvez accéder à vos données, les faire rectifier ou effacer en vous adressant à [contact]. Vous pouvez saisir la CNIL.

## Liste de contrôle pour le déploiement

- [ ] Inscrire BeNote au registre des traitements.
- [ ] Choisir les durées de conservation et les noter dans le registre.
- [ ] Informer les utilisateurs (mention ci-dessus).
- [ ] Si la recherche IA utilise un service externe : contrat de sous-traitance et transferts (le chat lui envoie aussi l'historique de la conversation).
- [ ] Choisir la conservation des conversations du chat IA (`AI_CHAT_RETENTION_DAYS`).
- [ ] Savoir qu'une conversation du chat IA reste lisible par son auteur, et son historique est renvoyé au fournisseur d'IA à chaque message, même si l'auteur a perdu depuis le droit de lire une page qu'elle citait : ce sont ses propres données, mais la réponse peut reprendre un contenu qu'il ne lit plus. Les pages citées en source, elles, ne s'affichent plus (relues avec les droits actuels). La personne peut supprimer la conversation à tout moment.
- [ ] Documenter la durée de rotation des sauvegardes (`BACKUP_KEEP`) et chiffrer les sauvegardes (`BACKUP_AGE_RECIPIENT`).
- [ ] Définir qui traite les demandes d'accès et d'effacement, et sous quel délai (un mois).
