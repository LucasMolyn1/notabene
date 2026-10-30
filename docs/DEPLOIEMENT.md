# Déploiement en production

Guide pour faire tourner Notabene avec l'image publiée, derrière un reverse proxy TLS. Les versions et leurs changements sont dans le [CHANGELOG](../CHANGELOG.md) ; **lisez la section « Attention à la mise à jour » avant chaque montée de version**.

## L'image

Les images sont publiées sur GitHub Container Registry : `ghcr.io/lucasmolyn1/notabene`. Une image est créée à chaque tag `vX.Y.Z` (amd64 et arm64) avec une attestation de provenance (SLSA) et un SBOM.

- **Épinglez le tag ET le digest** : `ghcr.io/lucasmolyn1/notabene:3.0.0@sha256:…`. Un tag peut être déplacé, un digest non. N'utilisez pas `latest` en production.
- **Une image antérieure à la 3.0.0 ne convient pas à ce guide** : la 2.0.0 n'a ni comptes locaux, ni `create-admin`, ni sauvegardes chiffrées, ni import Markdown.
- Digest d'un tag : `docker buildx imagetools inspect ghcr.io/lucasmolyn1/notabene:3.0.0`.
- Vérifier la provenance : `gh attestation verify oci://ghcr.io/lucasmolyn1/notabene:3.0.0 --owner LucasMolyn1`.
- Version de l'instance en marche : **Paramètres, Instance** (ou `docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' <conteneur>`).

## Exemple minimal

```yaml
name: notabene
services:
  notabene:
    image: ghcr.io/lucasmolyn1/notabene:3.0.0@sha256:<digest>
    restart: unless-stopped
    env_file: .env
    environment: { DATA_DIR: /data, HOST: 0.0.0.0, PORT: 3000 }
    ports: ["127.0.0.1:3000:3000"]        # l'adresse du proxy, jamais 0.0.0.0 sans pare-feu
    volumes: ["/srv/appdata/notabene:/data"]
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
```

`.env` (permissions `600`) : `PUBLIC_URL=https://…`, `NODE_ENV=production`, `TRUST_PROXY=<nombre de proxys devant l'application>`, `ENCRYPTION_KEY` (`openssl rand -base64 32`), `AUTH_LOCAL=true`. `LOCAL_REQUIRE_MFA=true` (double authentification obligatoire) est conseillé pour une instance exposée ; laissez-le à `false` pour un essai, chaque personne pouvant activer le TOTP depuis son profil. Toutes les variables : `.env.example`.

**Conservez `ENCRYPTION_KEY` à part** (gestionnaire de mots de passe) : elle chiffre les secrets en base ; sans elle, une sauvegarde restaurée a des secrets illisibles.

## Dossier de données

Le conteneur tourne en utilisateur `node` (uid 1000). Un dossier monté depuis l'hôte doit lui appartenir :

```bash
mkdir -p /srv/appdata/notabene && chown 1000:1000 /srv/appdata/notabene && chmod 700 /srv/appdata/notabene
```

Dans un conteneur LXC non privilégié, le chown se fait dans le conteneur LXC (l'uid 1000 y est décalé automatiquement). Sans cela le serveur s'arrête au démarrage avec un message qui l'indique.

## Derrière un reverse proxy

- **TLS obligatoire** : `PUBLIC_URL` en `https://` (cookies `Secure`, préfixe `__Host-`, HSTS). Le nom doit être exactement celui que voient les navigateurs.
- **WebSocket** (co-édition) : le proxy doit laisser passer `Upgrade`. HAProxy : `timeout tunnel` d'au moins une heure pour la ressource concernée ; le serveur envoie un ping toutes les 30 s. Si les curseurs ne bougent pas, c'est ici.
- **Adresse IP des clients (`TRUST_PROXY`)** : indiquez le **nombre de proxys** entre Internet et l'application. Une seule étape (Traefik, Nginx, Caddy) : `TRUST_PROXY=1`. Cloudflare puis HAProxy : `TRUST_PROXY=2` (chaque proxy doit ajouter l'adresse de son interlocuteur à `X-Forwarded-For`, par exemple `option forwardfor` sur HAProxy). Vous pouvez aussi lister vos proxys : `TRUST_PROXY=10.0.0.5,192.168.1.0/24`. L'adresse du client est lue **en partant de la droite** : ce qu'un client ajoute lui-même à gauche est ignoré. `TRUST_PROXY=true` fait confiance à tous les sauts et laisse un client falsifier son adresse (journal d'audit, limitation de débit) : déconseillé. Pour vérifier, Paramètres, Instance affiche la valeur retenue ; une connexion de test apparaît dans le journal d'audit avec votre vraie adresse.
- **Santé** : `GET /healthz` renvoie `{"ok":true}` (HTTP 200) quand la base répond, 5xx sinon. N'utilisez pas `OPTIONS` pour la sonde.

## Premier démarrage

```bash
docker compose up -d
docker compose exec -T notabene node dist/server/cli.js create-admin admin@exemple.fr --name "Nom"
docker compose exec -T notabene node dist/server/backup.js keygen     # la clé privée age : hors du serveur
```

Le code d'installation affiché dans les journaux au premier démarrage est un secret temporaire : ne partagez pas la sortie de `docker logs` ; `create-admin` ci-dessus est l'alternative. Avec `LOCAL_REQUIRE_MFA=true`, l'administrateur active la double authentification à la première connexion. Mettez ensuite la clé **publique** dans `BACKUP_AGE_RECIPIENT` : en production, une sauvegarde non chiffrée est refusée. Voir [BACKUP.md](BACKUP.md) (minuterie, restauration à exercer une fois).

## Sondes de santé

Pour un répartiteur (HAProxy, etc.), utilisez `GET /healthz` (`{"ok":true}`, 503 si la base ne répond pas). `HEAD /` et `OPTIONS /` répondent aussi sans erreur. L'interface ne fonctionne que depuis l'adresse `PUBLIC_URL` (HTTPS) : l'ouvrir par une adresse IP en HTTP affiche un message explicatif.

## Mettre à jour

**Guide complet : [MISE-A-JOUR.md](MISE-A-JOUR.md)** (alerte dans l'application avec `UPDATE_CHECK=true`, sauvegarde, commandes, vérifications, retour arrière).


1. Lire le [CHANGELOG](../CHANGELOG.md) (section « Attention à la mise à jour »).
2. Prendre une sauvegarde et, si possible, un instantané de la machine.
3. Remplacer le tag et le digest dans le compose, puis `docker compose pull && docker compose up -d`.
4. Vérifier : `/healthz`, la version dans Paramètres, Instance, une connexion et l'ouverture d'une page.

Les migrations de base s'appliquent au démarrage et **ne reviennent pas en arrière** : un serveur plus ancien refuse de démarrer sur une base plus récente. Le retour arrière se fait en restaurant la sauvegarde (ou l'instantané) **et** en remettant l'ancienne image.
