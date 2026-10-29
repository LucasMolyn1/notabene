# Notabene

Wiki collaboratif **auto-hébergé**, inspiré de [Docmost](https://docmost.com) : espaces, pages imbriquées, éditeur riche, diagrammes, recherche par IA et API REST. Conçu *secure by design* et déployable autant de fois que nécessaire à partir de ce dépôt.

## Fonctionnalités

| Domaine | Ce qui est inclus |
| --- | --- |
| **Authentification** | OIDC (Authentik ou tout fournisseur conforme) : Authorization Code + PKCE, state et nonce à usage unique, rôles dérivés des groupes, déconnexion côté fournisseur |
| **Rôles** | `admin` (espaces, réglages, audit, suppression définitive), `editor` (écriture), `reader` (lecture) ; espaces **publics** lisibles sans connexion |
| **Éditeur** | TipTap 3 : menu `/`, raccourcis Markdown, callouts, tableaux, tâches, images, mentions de pages, sommaire automatique |
| **Diagrammes** | **Mermaid** (texte, rendu en direct), **Excalidraw** (dessin), **Draw.io** (instance auto-hébergée) |
| **Recherche** | Plein texte SQLite FTS5 insensible aux accents (`⌘K`) |
| **IA** | Onglet « Demander à l’IA » dans `⌘K` : réponses sourcées à partir des pages lisibles par l’utilisateur ; **Claude** ou tout endpoint **compatible OpenAI** (OpenAI, Mistral, Ollama, LM Studio…) |
| **API REST** | `/api/v3`, jetons personnels à portées (`read`, `write`, `ai`, `admin`) et expiration, documentation OpenAPI sur `/api/docs` |
| **Collaboration** | Mise à jour en temps réel (SSE), présence des lecteurs, détection des modifications concurrentes, historique des versions |
| **Organisation** | Glisser-déposer, favoris, corbeille, export Markdown / HTML, intégration iframe pour un portfolio |

## Démarrage rapide (Docker)

```bash
git clone https://github.com/LucasMolyn1/notabene.git wiki-equipe
cd wiki-equipe
./scripts/setup.sh          # génère .env (secrets aléatoires, URL, OIDC…)
docker compose up -d --build
```

L’application écoute sur `127.0.0.1:3000` et Draw.io sur `127.0.0.1:8081` : placez un reverse proxy TLS devant (Traefik, Caddy, Nginx Proxy Manager…).

**Plusieurs déploiements** : un clone du dépôt par instance, chacun avec son `.env` (nom `COMPOSE_PROJECT_NAME` et ports différents). Les images publiées par la CI sur GHCR (`ghcr.io/lucasmolyn1/notabene`) peuvent remplacer le build local via `NOTABENE_IMAGE`.

Configuration d’Authentik : voir [docs/AUTHENTIK.md](docs/AUTHENTIK.md).

## Développement local

Prérequis : Node.js 22.

```bash
npm install
cp .env.development.example .env       # puis renseignez ENCRYPTION_KEY (openssl rand -base64 32)
npm run dev                            # API sur :3000, interface sur http://localhost:5173
```

### Co-édition en temps réel

Les rédacteurs qui ouvrent la même page voient les modifications et les curseurs des autres en direct (Yjs via WebSocket, `/collab/:id`). Le serveur conserve l’état de co-édition en base et recopie le contenu dans la page (JSON assaini) toutes les 2 secondes : recherche, export, historique des versions et API REST fonctionnent comme avant. Une modification du contenu par l’API ou une restauration de version recharge automatiquement les éditeurs ouverts.

- Réservé aux sessions navigateur avec le rôle rédacteur ; les lecteurs et l’intégration en iframe restent en lecture seule.
- L’origine de la requête doit être `PUBLIC_URL` (protection contre le détournement de WebSocket).
- Derrière un reverse proxy, activez le transfert WebSocket (`Upgrade` / `Connection`) pour le chemin `/collab/`. Nginx : `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
- `COLLAB_ENABLED=false` désactive la fonction : l’édition revient à l’enregistrement classique avec détection de conflit.

### Comptes locaux (sans fournisseur d’identité)

`AUTH_LOCAL=true` active la connexion par e-mail et mot de passe, seule ou en complément d’OIDC. Au premier démarrage, sans administrateur local, le serveur affiche un **code d’installation** dans ses journaux ; il se saisit sur la page de connexion pour créer le compte administrateur. Ensuite, les administrateurs créent les comptes dans Paramètres > Utilisateurs.

Sans chercher le code dans les journaux, on peut aussi créer l'administrateur en ligne de commande (mot de passe saisi sans écho) :

```bash
docker compose exec -it notabene node dist/server/cli.js create-admin admin@exemple.fr --name "Admin"
```

Pour récupérer l'accès (mot de passe perdu, MFA bloquée), ajoutez `--reset` : le mot de passe est remplacé, le compte repasse administrateur et déverrouillé, la MFA est retirée et les sessions sont fermées. Pour l'automatisation, le mot de passe peut être lu sur l'entrée standard ou dans `NOTABENE_ADMIN_PASSWORD`.

- Mots de passe : 12 caractères minimum, hachés avec scrypt.
- Double authentification TOTP optionnelle (FreeOTP, Aegis, Google Authenticator…) avec 10 codes de secours à usage unique.
- Verrouillage de 15 minutes après 5 échecs, limitation de débit par adresse IP, sessions fermées lors d’un changement de mot de passe.
- `LOCAL_REQUIRE_MFA=true` impose la double authentification : un compte local sans TOTP ne voit qu’un écran d’activation, l’API (jetons compris) lui répond 403 jusqu’à l’activation.
- `OIDC_REQUIRE_MFA=true` refuse les connexions OIDC dont l’ID token ne contient pas de valeur `amr` prouvant un second facteur (`mfa`, `otp`, `hwk`…). Le fournisseur doit émettre ce claim ; la méthode la plus fiable reste d’exiger la MFA dans le flux d’authentification d’Authentik lui-même.
- Les rôles des comptes locaux se gèrent dans l’application ; ceux des comptes OIDC restent issus des groupes.

### LDAP / Active Directory

`LDAP_URL` active la connexion par identifiant d’annuaire. Notabene cherche l’utilisateur avec un compte de service, puis vérifie son mot de passe par une liaison (bind) avec son propre DN : aucun mot de passe d’annuaire n’est stocké.

```env
LDAP_URL=ldaps://ad.example.org
LDAP_BIND_DN=CN=svc-notabene,OU=Services,DC=example,DC=org
LDAP_BIND_PASSWORD=…
LDAP_BASE_DN=DC=example,DC=org
LDAP_USER_FILTER=(|(sAMAccountName={username})(mail={username}))   # défaut
LDAP_ADMIN_GROUPS=wiki-admins                  # CN ou DN complet, comparés à memberOf
LDAP_EDITOR_GROUPS=wiki-editors
LDAP_TLS_CA_FILE=/data/ca.pem                  # si l’AC est interne (à monter dans le conteneur)
```

`ldaps://` ou `LDAP_STARTTLS=true` est obligatoire en production. Les mots de passe vides sont refusés (liaison anonyme), l’identifiant est échappé dans le filtre (RFC 4515) et le rôle est recalculé à chaque connexion d’après les groupes. Pour Active Directory, `memberOf` ne liste que les groupes directs.

### SAML 2.0

`SAML_ENTRY_POINT` active le SSO SAML (initié par Notabene uniquement).

```env
SAML_ENTRY_POINT=https://idp.example.org/saml/sso
SAML_IDP_CERT_FILE=/data/idp-cert.pem          # ou SAML_IDP_CERT (PEM, \n pour les retours à la ligne)
SAML_ADMIN_GROUPS=wiki-admins
SAML_GROUPS_ATTRIBUTE=groups                   # nom de l’attribut portant les groupes
```

Déclarez chez le fournisseur : ACS `PUBLIC_URL/auth/saml/callback`, entity ID `PUBLIC_URL/auth/saml/metadata` (les métadonnées XML sont servies à cette adresse). L’**assertion doit être signée** ; l’audience, `InResponseTo`, les dates et le rejeu sont contrôlés. Un SSO initié par le fournisseur est refusé volontairement.

En développement, `DEV_LOGIN=true` permet de se connecter en admin, éditeur ou lecteur sans fournisseur d’identité. Le serveur **refuse de démarrer** si cette option est active en production.

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur (rechargement automatique) + Vite |
| `npm test` | Tests de sécurité et d’API (Vitest) |
| `npm run typecheck` | Vérification TypeScript du serveur |
| `npm run build` | Build de production (`dist/`) |
| `npm start` | Lance le build de production |

## Configuration depuis l’interface

Les fournisseurs d’identité (OIDC/Authentik, LDAP, SAML), le serveur d’e-mail (SMTP) et les sites autorisés à intégrer le wiki se règlent dans **Paramètres** (administrateurs), sans redémarrage.

- **Modèle hybride** : l’environnement (`.env`) fournit les valeurs de départ et l’amorçage (`PUBLIC_URL`, `ENCRYPTION_KEY`, `DATA_DIR`…). Un réglage enregistré dans l’interface remplace celui de l’environnement, section par section ; « Revenir au .env » annule.
- **Garde-fous** : ressaisie du mot de passe (et du code MFA) à chaque test et enregistrement ; test de connexion réussi obligatoire avant d’enregistrer un fournisseur ; si l’adresse du serveur change, le secret doit être ressaisi (il ne part jamais vers une nouvelle cible sans votre accord) ; les secrets sont chiffrés avec `ENCRYPTION_KEY` et jamais réaffichés ; chaque action est dans le journal d’audit ; les règles de production restent appliquées (LDAP en clair interdit, HTTPS exigé).
- **Récupération** : en cas d’erreur de configuration, le compte local (`AUTH_LOCAL=true`) et `create-admin --reset` permettent de reprendre la main ; `Revenir au .env` restaure la configuration d’origine.
- **Verrouillage** : `CONFIG_LOCKED=true` fige tout dans l’environnement ; les réglages enregistrés en base sont ignorés et l’interface passe en lecture seule.
- **E-mail** : avec SMTP (TLS obligatoire), « mot de passe oublié » (lien à usage unique de 30 minutes, réponse identique que le compte existe ou non), invitations (lien de 72 h, l’administrateur ne connaît jamais le mot de passe) et alertes de sécurité (verrouillage, mot de passe modifié, MFA activée ou désactivée). Sans SMTP, rien ne change : un administrateur réinitialise les mots de passe.

## Sessions et documentation de l’API

- Une session dure au plus `SESSION_TTL_HOURS` (12 h) et se ferme après `SESSION_IDLE_MINUTES` (120 min) sans activité.
- La documentation interactive `/api/docs` décrit toute la surface de l'API : elle est réservée aux utilisateurs connectés par défaut (`API_DOCS=auth`). `API_DOCS=public` l'ouvre, `API_DOCS=off` la désactive.

## Utiliser l’API

1. Menu utilisateur → **Jetons d’API** → choisissez les portées et la durée (le jeton n’est affiché qu’une fois).
2. Appelez l’API :

```bash
curl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v3/spaces
curl -H "Authorization: Bearer $NOTABENE_TOKEN" "https://wiki.example.com/api/v3/search?q=deploiement"
curl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v3/pages/<id>/export
```

**Versions** : utilisez `/api/v3` (courante) ou `/api/v2`. `/api/v3` est dépréciée (fin le 1er mai 2027) mais reste servie ; le client web et le serveur MCP l'utilisent encore. Les versions et leur état sont sur `GET /api/versions`. La v2 apporte la pagination par curseur, `ETag`/`If-Match` et les erreurs RFC 9457 ; la v3 ajoute les commentaires et les permissions par page (voir `docs/API-VERSIONING.md`).

Principales routes : `GET/POST /spaces`, `GET/POST /pages`, `GET/PATCH/DELETE /pages/:id`, `POST /pages/:id/move`, `GET /pages/:id/versions`, `GET /search`, `POST /ai/ask` (SSE). Le détail complet est sur **`/api/docs`**.

## Recherche IA

Un administrateur l’active dans **menu utilisateur → Recherche IA** :

- **Anthropic Claude** : collez une clé d’API (modèle par défaut `claude-opus-5-5`).
- **Compatible OpenAI** : renseignez l’URL de base (`http://ollama:11434/v1` pour un Ollama local) et le modèle.

La clé est chiffrée en base (AES-256-GCM) et n’est jamais renvoyée au navigateur. Pour chaque question, seuls des extraits des pages pertinentes **que l’utilisateur a le droit de lire** sont envoyés au modèle.

## Intégration dans un portfolio

1. Rendez un espace **public** (paramètres de l’espace).
2. Ajoutez le domaine du portfolio dans Paramètres > Intégration portfolio (ou `EMBED_ALLOWED_ORIGINS`).
3. Menu `⋯` d’une page → **Intégrer (iframe)** et collez le code obtenu.

## Architecture

```
client/             Interface (JavaScript, Vite) : éditeur TipTap, diagrammes, palette ⌘K
server/src/
  app.ts            Fastify : en-têtes de sécurité, CSRF, rate limiting, OpenAPI
  config.ts         Configuration validée (refus des configurations dangereuses)
  auth/             OIDC, sessions, jetons d'API, modèle de permissions
  routes/           API REST v1, SSE, IA
  lib/              Pages, validation du contenu, chiffrement, audit, export Markdown
  ai/               RAG, fournisseurs LLM (SDK Anthropic, compatible OpenAI)
server/test/        Tests de sécurité (CSRF, portées, XSS, conflits…)
```

Sécurité : voir [SECURITY.md](SECURITY.md).

## Licence

MIT. Inspiré de Docmost (AGPL-3.0), sans reprise de son code.
