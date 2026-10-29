# Configurer Authentik pour Notabene

Exemple : Notabene sur `https://wiki.example.com`, Authentik sur `https://auth.example.com`.

## 1. Fournisseur OAuth2/OpenID

**Applications → Providers → Create → OAuth2/OpenID Provider**

| Champ | Valeur |
| --- | --- |
| Name | `Notabene` |
| Authorization flow | `default-provider-authorization-explicit-consent` (ou *implicit* pour éviter l’écran de consentement) |
| Client type | **Confidential** |
| Redirect URIs | `https://wiki.example.com/auth/callback` (mode **Strict**) |
| Signing key | un certificat (ex. `authentik Self-signed Certificate`) |
| Scopes | `openid`, `email`, `profile` (le scope `profile` d’Authentik fournit la claim `groups`) |
| Subject mode | `Based on the User's hashed ID` (recommandé) |

Notez le **Client ID** et le **Client Secret**.

## 2. Application

**Applications → Create** : nom `Notabene`, slug `notabene`, provider créé ci-dessus.

L’issuer OIDC est alors `https://auth.example.com/application/o/notabene/` (avec le `/` final).

## 3. Groupes et rôles

Créez les groupes puis ajoutez-y les utilisateurs :

| Groupe Authentik | Rôle Notabene |
| --- | --- |
| `notabene-admins` | admin |
| `notabene-editors` | éditeur |
| `notabene-readers` | lecteur |

Les noms se changent via `OIDC_ADMIN_GROUPS`, `OIDC_EDITOR_GROUPS`, `OIDC_READER_GROUPS` (listes séparées par des virgules). Avec `OIDC_DEFAULT_ROLE=none` (par défaut), un utilisateur hors de ces groupes est **refusé**. Le rôle est recalculé à chaque connexion.

Pour restreindre l’accès en amont, liez une *policy* ou les groupes à l’application (onglet **Policy / Group / User Bindings**).

## 4. Variables d’environnement

```env
PUBLIC_URL=https://wiki.example.com
OIDC_ISSUER=https://auth.example.com/application/o/notabene/
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…
```

## 5. Déconnexion

Notabene appelle l’`end_session_endpoint` d’Authentik avec `id_token_hint` et revient sur `PUBLIC_URL`. Si Authentik affiche une erreur de redirection, ajoutez `https://wiki.example.com/` aux redirect URIs autorisées.

## Dépannage

- **`auth_error=callback`** : vérifiez l’issuer (slash final), le secret et que le serveur Notabene peut joindre Authentik (DNS / réseau Docker). Les détails sont dans les logs du conteneur.
- **`auth_error=forbidden`** : l’utilisateur n’est dans aucun groupe autorisé.
- **Boucle de connexion derrière un proxy** : `TRUST_PROXY=true` et `PUBLIC_URL` en `https://` doivent correspondre à l’URL vue par le navigateur.
