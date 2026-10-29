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
| **API REST** | `/api/v1`, jetons personnels à portées (`read`, `write`, `ai`, `admin`) et expiration, documentation OpenAPI sur `/api/docs` |
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

### Comptes locaux (sans fournisseur d’identité)

`AUTH_LOCAL=true` active la connexion par e-mail et mot de passe, seule ou en complément d’OIDC. Au premier démarrage, sans administrateur local, le serveur affiche un **code d’installation** dans ses journaux ; il se saisit sur la page de connexion pour créer le compte administrateur. Ensuite, les administrateurs créent les comptes dans Paramètres > Utilisateurs.

- Mots de passe : 12 caractères minimum, hachés avec scrypt.
- Double authentification TOTP optionnelle (FreeOTP, Aegis, Google Authenticator…) avec 10 codes de secours à usage unique.
- Verrouillage de 15 minutes après 5 échecs, limitation de débit par adresse IP, sessions fermées lors d’un changement de mot de passe.
- Les rôles des comptes locaux se gèrent dans l’application ; ceux des comptes OIDC restent issus des groupes.

En développement, `DEV_LOGIN=true` permet de se connecter en admin, éditeur ou lecteur sans fournisseur d’identité. Le serveur **refuse de démarrer** si cette option est active en production.

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur (rechargement automatique) + Vite |
| `npm test` | Tests de sécurité et d’API (Vitest) |
| `npm run typecheck` | Vérification TypeScript du serveur |
| `npm run build` | Build de production (`dist/`) |
| `npm start` | Lance le build de production |

## Utiliser l’API

1. Menu utilisateur → **Jetons d’API** → choisissez les portées et la durée (le jeton n’est affiché qu’une fois).
2. Appelez l’API :

```bash
curl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v1/spaces
curl -H "Authorization: Bearer $NOTABENE_TOKEN" "https://wiki.example.com/api/v1/search?q=deploiement"
curl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v1/pages/<id>/export
```

Principales routes : `GET/POST /spaces`, `GET/POST /pages`, `GET/PATCH/DELETE /pages/:id`, `POST /pages/:id/move`, `GET /pages/:id/versions`, `GET /search`, `POST /ai/ask` (SSE). Le détail complet est sur **`/api/docs`**.

## Recherche IA

Un administrateur l’active dans **menu utilisateur → Recherche IA** :

- **Anthropic Claude** : collez une clé d’API (modèle par défaut `claude-opus-5-5`).
- **Compatible OpenAI** : renseignez l’URL de base (`http://ollama:11434/v1` pour un Ollama local) et le modèle.

La clé est chiffrée en base (AES-256-GCM) et n’est jamais renvoyée au navigateur. Pour chaque question, seuls des extraits des pages pertinentes **que l’utilisateur a le droit de lire** sont envoyés au modèle.

## Intégration dans un portfolio

1. Rendez un espace **public** (paramètres de l’espace).
2. Ajoutez le domaine du portfolio dans `EMBED_ALLOWED_ORIGINS`.
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
