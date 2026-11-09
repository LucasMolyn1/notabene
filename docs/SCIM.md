# Provisionnement SCIM 2.0

Notabene expose un serveur SCIM 2.0 (RFC 7643 et RFC 7644) sous `https://wiki.example.com/scim/v2`. Le fournisseur d'identité y crée, met à jour et désactive les comptes, et y gère des groupes, sans attendre la première connexion de chaque personne.

La fonction est **désactivée par défaut**. Tant qu'elle l'est, toute adresse sous `/scim/v2` répond `404`.

## Ce que SCIM peut faire, et ce qu'il ne peut pas faire

| Ressource | Pris en charge | Règles |
|---|---|---|
| `Users` | `GET` (liste, filtre, pagination), `GET /:id`, `POST`, `PUT`, `PATCH`, `DELETE` | Rôle fixé par le réglage (lecteur ou rédacteur), **jamais administrateur** ; l'attribut `roles` est ignoré. Aucun mot de passe : un corps qui en contient un est refusé (`400`). `active: false` désactive le compte, ferme ses sessions et révoque ses jetons d'API. `DELETE` désactive aussi le compte et le détache de SCIM : **aucun contenu n'est supprimé** (l'effacement RGPD reste une action d'administrateur dans Notabene). |
| `Groups` | mêmes méthodes | Groupes **gérés par SCIM** seulement. Les groupes locaux, « Tout le monde » et les groupes liés à OIDC, LDAP ou SAML sont invisibles par SCIM. Un groupe géré par SCIM ne se renomme pas et son adhésion ne se modifie pas depuis Notabene (`409`), mais il s'attribue aux espaces et aux pages comme les autres ; un administrateur peut le supprimer. Les noms sont uniques sur tous les groupes. |
| Découverte | `ServiceProviderConfig`, `ResourceTypes`, `Schemas` | Protégées par le jeton, comme le reste. |

Non pris en charge : `Bulk`, tri, ETag, changement de mot de passe, `/Me`, filtres autres que `attribut eq valeur`.

Comptes administrateurs : ni listés ni accessibles par SCIM (`404`), y compris un compte créé par SCIM puis promu administrateur à sa connexion. SCIM ne peut donc ni désactiver ni modifier un administrateur, ni toucher au dernier d'entre eux.

Membres d'un groupe : seulement des comptes provisionnés par SCIM et non administrateurs ; un autre identifiant est refusé (`400`).

Suppression d'un groupe : il disparaît avec ses droits. Si des pages ne sont ouvertes qu'à lui, il est seulement détaché de SCIM et vidé : ces pages restent fermées (administrateurs seulement) au lieu de devenir lisibles par tous.

## Lien avec la connexion OIDC

Un compte créé par SCIM prend son `externalId` comme identifiant OIDC (`sub`). La personne retrouve donc ce compte à sa première connexion si le fournisseur envoie le même identifiant dans les deux cas. C'est le cas d'Authentik avec ses réglages par défaut (identifiant de l'utilisateur haché, `user.uid`).

- Un compte déjà créé par une connexion OIDC est rattaché à SCIM au premier `POST` qui porte son identifiant OIDC en `externalId`, sauf s'il est administrateur (`409`).
- Les `externalId` qui commencent par `local:`, `ldap:`, `saml:`, `scim:` ou `dev-` sont refusés : SCIM ne rattache jamais un compte local, LDAP ou SAML.
- Sans `externalId`, le compte est créé mais aucune connexion OIDC ne le retrouvera.
- L'`externalId` est immuable une fois défini : le changer ou le retirer est refusé (`400`, `mutability`) ; absent d'un `PUT`, il est conservé. L'identifiant OIDC d'un compte n'est jamais modifié par SCIM.
- SCIM ne réactive que les comptes qu'il a lui-même désactivés (`active: false` ou `DELETE`) : un compte rattaché alors qu'il était déjà désactivé le reste, quelle que soit la valeur de `active`.
- Un compte promu administrateur est retiré des groupes gérés par SCIM (à sa connexion, ou à la prochaine écriture SCIM sur le groupe).
- À la connexion OIDC, le rôle suit toujours les groupes du fournisseur (`OIDC_ADMIN_GROUPS`…), comme pour tout compte.

## Activer SCIM dans Notabene

API d'administration (session d'administrateur dans le navigateur, avec ressaisie du mot de passe) :

| Route | Rôle |
|---|---|
| `GET /api/v3/admin/scim` | état, rôle attribué, adresse du service, jetons (sans secret), nombre de comptes et de groupes gérés |
| `PUT /api/v3/admin/scim/settings` | `{ enabled, defaultRole: "reader" \| "editor", reauth }` |
| `POST /api/v3/admin/scim/tokens` | `{ name, expiresInDays (1 à 730, 365 par défaut), reauth }` : renvoie le jeton **une seule fois** |
| `DELETE /api/v3/admin/scim/tokens/:id` | révoque un jeton |

Variables d'environnement (valeurs de départ, seules prises en compte avec `CONFIG_LOCKED=true`) : `SCIM_ENABLED` (`false`), `SCIM_DEFAULT_ROLE` (`reader`), `SCIM_RATE_LIMIT_PER_MINUTE` (`600` requêtes par minute et par adresse IP).

## Jeton

- Format `nbscim_…`, propre à SCIM : il n'ouvre aucune autre route de Notabene. À l'inverse, ni une session ni un jeton d'API, même de portée admin, n'ouvrent `/scim`.
- Seule son empreinte SHA-256 est conservée ; il est comparé à temps constant.
- Dix jetons actifs au plus, chacun nommé, à durée limitée, révocable. Pour changer de jeton sans coupure : créer le nouveau, le saisir chez le fournisseur, puis révoquer l'ancien.

## Configurer Authentik

Exemple : Notabene sur `https://wiki.example.com`.

1. Dans Notabene, activer SCIM et créer un jeton (rôle conseillé : lecteur).
2. Dans Authentik, **Applications → Providers → Create → SCIM Provider** :

   | Champ | Valeur |
   |---|---|
   | Name | `Notabene SCIM` |
   | URL | `https://wiki.example.com/scim/v2` |
   | Token | le jeton `nbscim_…` |
   | User filtering | limiter aux groupes à provisionner (par exemple `notabene-users`) |
   | Attribute mapping | `authentik default SCIM Mapping: User` et `authentik default SCIM Mapping: Group` |

3. Ouvrir l'application Notabene existante (celle du fournisseur OIDC, voir `docs/AUTHENTIK.md`) et choisir ce fournisseur SCIM en **Backchannel provider**.
4. Garder le *Subject mode* du fournisseur OIDC sur `Based on the User's hashed ID` : c'est ce qui fait correspondre l'`externalId` SCIM à l'identifiant OIDC.
5. Lancer la synchronisation depuis la page du fournisseur SCIM et vérifier son état. Les opérations apparaissent dans le journal d'audit de Notabene.

Exclure les administrateurs du provisionnement : un compte administrateur existant n'est jamais rattaché (`409`), et un administrateur provisionné sous un autre identifiant deviendrait un second compte, non administrateur. Les administrateurs se gèrent par les groupes OIDC (`OIDC_ADMIN_GROUPS`) ou dans Notabene.

Autres fournisseurs : les formats de `PATCH` d'Entra ID (opérations en majuscules, booléens en chaîne, ajout sans chemin, retrait de membres par liste) sont acceptés. Désactiver toute synchronisation de mot de passe : elle serait refusée.

## Journal d'audit

Chaque opération est journalisée avec l'acteur « SCIM » (aucun compte) et l'identifiant du jeton utilisé (`meta.via = "scim"`, `meta.client`), sans nom d'utilisateur, adresse ni autre valeur reçue : `scim.user.create`, `scim.user.update`, `scim.user.deactivate`, `scim.user.delete`, `scim.group.create`, `scim.group.update`, `scim.group.delete`. Un jeton refusé donne `scim.auth.failed` (au plus une entrée par minute et par adresse IP). L'administration donne `scim.settings`, `scim.token.create`, `scim.token.revoke`. Voir `docs/AUDIT.md`.

## Erreurs

Format SCIM (`application/scim+json`) : `{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "scimType": "uniqueness", "detail": "…" }`. Les messages ne reprennent jamais une valeur reçue. Corps limité à 1 Mo.
