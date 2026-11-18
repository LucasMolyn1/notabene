# Connexion avec Google

Google est un second fournisseur OpenID Connect, à côté du fournisseur principal (Authentik, variables `OIDC_*`, inchangées). Désactivé par défaut.

## 1. Client OAuth chez Google

Google Cloud Console, **API et services → Identifiants → Créer un identifiant → ID client OAuth** :

| Champ | Valeur |
| --- | --- |
| Type d'application | Application Web |
| URI de redirection autorisé | `https://wiki.example.com/auth/oidc/google/callback` |

Écran de consentement : portées `openid`, `email`, `profile` uniquement.

## 2. Configuration

Par l'environnement :

```env
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
# Domaines Google Workspace acceptés (claim hd), ou gmail.com. Obligatoire dès que le rôle n'est pas none.
GOOGLE_ALLOWED_DOMAINS=exemple.fr
# Rôle donné à chaque connexion : none (refus, défaut), reader ou editor. Jamais admin.
GOOGLE_DEFAULT_ROLE=reader
```

Ou depuis **Paramètres → Accès → Google** (section `google`), sauf avec `CONFIG_LOCKED=true`. Le secret est chiffré en base et jamais renvoyé.

## 3. Politique d'accès

- **Protocole** : Authorization Code + PKCE (S256), `state` et `nonce` à usage unique (10 minutes), tentative liée au navigateur (cookie) et au fournisseur qui l'a lancée : un retour présenté sur la route d'un autre fournisseur est refusé.
- **E-mail** : exigé, avec `email_verified` strictement vrai dans l'id_token signé. Sinon : refus (`auth_error=email_unverified`).
- **Domaines** : obligatoires dès que le rôle n'est pas `none` (refus au démarrage et dans les réglages), sans quoi n'importe quel compte Google au monde pourrait lire ou modifier le wiki. Lister `gmail.com` ouvre l'accès à tous les comptes Gmail : à réserver à un choix délibéré. Un compte Google Workspace est accepté si sa claim `hd` figure dans la liste. Une adresse gmail.com ou googlemail.com est acceptée si ce domaine figure dans la liste. Un compte Google grand public ouvert avec une adresse d'entreprise (sans `hd`) est refusé : l'adresse seule ne prouve pas l'appartenance à l'organisation.
- **Rôle** : `GOOGLE_DEFAULT_ROLE`, recalculé à chaque connexion (Google ne transmet pas de groupes). `none` refuse toute connexion ; `reader` et `editor` exigent une liste de domaines.
- **Création de compte** : même politique que le fournisseur principal. Le compte est créé à la première connexion autorisée (rôle différent de `none`), identifié par `google:<sub>`. **Jamais de rattachement par l'adresse e-mail** à un compte existant (local, principal, LDAP, SAML) : une même personne a un compte distinct par fournisseur. SCIM ne peut ni créer ni rattacher un compte `google:`.
- **Double authentification** : voir la section 4.
- **Compte désactivé** : aucune session.
- **Déconnexion** : Google n'a pas de déconnexion côté fournisseur ; l'id_token n'est pas conservé.
- **Confirmation d'une action sensible** : nouvelle connexion par `/auth/oidc/google/login?reauth=1`. Google refuse `prompt=login` : il reçoit `max_age=0` (nouvelle authentification demandée) et `prompt=select_account`. La tentative est marquée comme confirmation côté serveur (`login_states.reauth`). Au retour, l'id_token doit porter `auth_time`, daté de moins de 2 minutes (et pas dans le futur au-delà de 30 s d'écart d'horloge) : contrôlé par openid-client (`maxAge`) puis à nouveau par BeNote. `auth_time` absent ou trop ancien : confirmation refusée, aucune session (`auth_error=reauth_failed`, audit `auth.denied` avec `reason: reauth`). Si Google ne renvoie pas `auth_time` malgré `max_age`, la confirmation par Google est impossible.
- **Identifiants réservés** : un `sub` du fournisseur principal qui commence par `local:`, `ldap:`, `saml:`, `scim:`, `google:` ou `dev-` (sans tenir compte de la casse) est refusé (audit `reason: reserved_sub`) : il ne peut pas ouvrir un compte d'un autre fournisseur.

## 4. Limite : `OIDC_REQUIRE_MFA`

`OIDC_REQUIRE_MFA=true` (ou « Exiger la double authentification » dans la section OIDC des réglages) s'applique à **tous** les fournisseurs OIDC, Google compris. BeNote reconnaît la double authentification à la claim `amr` (RFC 8176) de l'id_token. **Google ne transmet pas cette claim**, même quand la validation en deux étapes est activée sur le compte ou imposée par l'administrateur Google Workspace.

Conséquence : avec `OIDC_REQUIRE_MFA=true`, **toute connexion Google est refusée** (`auth_error=mfa_required`, audit `auth.denied` avec `reason: mfa`). Ce n'est pas contournable côté BeNote : accepter Google dans ce cas reviendrait à admettre une connexion sans preuve de second facteur.

Pour utiliser Google avec une double authentification garantie : laisser `OIDC_REQUIRE_MFA=false` et imposer la validation en deux étapes dans la console d'administration Google Workspace (Sécurité → Validation en deux étapes → Appliquer), en restreignant `GOOGLE_ALLOWED_DOMAINS` à ce domaine. La garantie repose alors sur Google, pas sur BeNote, et ne couvre pas les comptes gmail.com.

## 5. Schéma de la base

Les colonnes `login_states.provider` et `login_states.reauth` sont ajoutées à l’ouverture de la base si elles manquent, après les migrations numérotées (`server/src/db.ts`, `ADDITIVE_COLUMNS`). Elles ne prennent aucun numéro de migration : l'ordre de fusion avec d'autres branches qui ajoutent des migrations n'a pas d'importance. Retour arrière : `ALTER TABLE login_states DROP COLUMN provider;` puis `DROP COLUMN reauth;`.
