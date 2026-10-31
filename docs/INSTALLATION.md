# Installer Notabene sur une machine vierge

Guide pas à pas, de la machine neuve à un wiki joignable en HTTPS. Il suppose que vous savez ouvrir un terminal en SSH, rien de plus. Pour un simple essai sur un poste, voir [ESSAI.md](ESSAI.md) ; pour l'exploitation (proxy, mises à jour, sauvegardes), voir [DEPLOIEMENT.md](DEPLOIEMENT.md), [MISE-A-JOUR.md](MISE-A-JOUR.md) et [BACKUP.md](BACKUP.md).

## 1. Ce qu'il faut

| Élément | Minimum | Conseillé |
|---|---|---|
| Processeur | 1 cœur, **amd64 ou arm64** | 2 cœurs |
| Mémoire | 1 Go | 2 Go (le conteneur est plafonné à 512 Mo) |
| Disque | 5 Go | 20 Go (images Docker, base, pièces jointes, sauvegardes) |
| Réseau | sortie Internet (téléchargement des images) | un nom de domaine qui pointe vers la machine |
| Logiciels | Docker Engine et le plugin Compose | idem, plus un reverse proxy TLS |

Rien d'autre à installer : ni Node.js, ni base de données, ni compilateur. L'application et sa base SQLite sont dans l'image Docker ; seul le dossier de données vit sur la machine.

Un nom de domaine et un certificat TLS sont nécessaires dès que l'on sort d'un essai : les cookies de session exigent HTTPS (`PUBLIC_URL` en `https://`).

## 2. Quelle distribution choisir

Notabene ne dépend pas de la distribution : il tourne dans un conteneur Debian 12 (`bookworm-slim`), publié pour **amd64 et arm64**. Le choix de la machine ne dépend donc que de Docker. Constat au 31 octobre 2026, d'après la documentation de Docker et ce qui a été essayé.

| Distribution | Docker Engine officiel | Verdict |
|---|---|---|
| **Debian 13 (trixie)** | oui, amd64, arm64, armhf | **Recommandée.** C'est ce qui fait tourner l'instance de test du projet (conteneur LXC, Docker 26 du paquet Debian). |
| **Debian 12 (bookworm)** | oui | Recommandée, support long déjà éprouvé. |
| **Ubuntu 24.04 LTS** | oui, amd64, arm64 | Recommandée si vous la connaissez déjà. |
| Ubuntu 22.04 LTS | oui | Convient ; prévoir la migration avant la fin de son support. |
| Ubuntu 26.04 LTS | oui (listée par Docker) | Convient ; pas essayée par le projet. |
| RHEL 8, 9, 10 ; CentOS Stream 9, 10 | oui, amd64, arm64 | Convient, avec `dnf` et SELinux actif (voir plus bas). Pas essayées par le projet. |
| Rocky Linux, AlmaLinux | non testées par Docker (dérivées de RHEL) | Les instructions RHEL fonctionnent en général ; sans garantie de Docker. |
| Fedora 43 à 45 | oui | Convient pour un poste ; durée de vie courte pour un serveur. |
| Raspberry Pi OS 64 bits | oui (base Debian) | Convient sur Pi 4 et 5 avec 2 Go ou plus ; utiliser un SSD plutôt qu'une carte SD. |
| Alpine, Arch, openSUSE | non listées par Docker | Possible avec le paquet de la distribution, mais non couvert par ce guide. |
| Raspberry Pi OS 32 bits, tout système armhf (32 bits) | oui pour Docker | **Non pris en charge** : l'image n'existe pas en arm 32 bits. |
| Windows et macOS | via Docker Desktop | Pour développer ou essayer, pas pour héberger. |

Une machine virtuelle (Proxmox, VMware, VPS) ou un conteneur LXC convient. Dans un LXC, activer l'imbrication (`nesting=1`) et créer le conteneur sur un système de fichiers qui accepte Docker ; l'instance de test du projet est un LXC non privilégié.

À éviter : une distribution en fin de vie (Debian 11 et antérieures, Ubuntu 20.04 et antérieures, CentOS 7 et 8 classiques), qui ne reçoit plus de correctifs de sécurité.

## 3. Préparer la machine

Connectez-vous en SSH avec un compte qui peut utiliser `sudo`, puis mettez le système à jour.

Debian ou Ubuntu :

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y ca-certificates curl openssl ufw
```

RHEL, Rocky, Alma, Fedora :

```bash
sudo dnf upgrade -y
sudo dnf install -y ca-certificates curl openssl
```

Pare-feu : n'ouvrez que SSH, HTTP et HTTPS (si un reverse proxy existant s'en charge sur une autre machine, ni 80 ni 443 : voir l'étape 6). Notabene lui-même n'écoute qu'en local (`127.0.0.1:3000`) et ne doit pas être exposé directement.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

(Sur RHEL et dérivés : `firewalld`, par exemple `sudo firewall-cmd --permanent --add-service={http,https} && sudo firewall-cmd --reload`.)

Heure : le système doit être à l'heure (`timedatectl` doit indiquer `System clock synchronized: yes`). Les codes à usage unique de la double authentification en dépendent.

## 4. Installer Docker

Deux voies. La première donne la version courante de Docker directement auprès de l'éditeur ; la seconde, plus courte, utilise le paquet de la distribution (Debian 13 : Docker 26, suffisant pour Notabene).

### 4.a Dépôt officiel Docker (Debian)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Sur **Ubuntu**, remplacer `debian` par `ubuntu` dans les deux adresses, et `$VERSION_CODENAME` par `${UBUNTU_CODENAME:-$VERSION_CODENAME}`.

### 4.b RHEL, Rocky, Alma, CentOS Stream

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

(CentOS Stream : adresse `https://download.docker.com/linux/centos/docker-ce.repo`. Fedora : `sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo`.)

### 4.c Paquets de la distribution (Debian 12 et 13)

```bash
sudo apt install -y docker.io docker-compose
```

Sur Debian 13 le paquet `docker-compose` fournit la commande `docker compose` (v2). Vérifiez avec la commande ci-dessous ; si elle échoue, utilisez la voie 4.a.

### Vérifier

```bash
sudo docker --version && sudo docker compose version
sudo docker run --rm hello-world
sudo systemctl is-enabled docker      # doit répondre : enabled
```

À savoir : appartenir au groupe `docker` revient à être administrateur de la machine. N'y ajoutez pas de comptes ordinaires ; lancez les commandes de ce guide avec `sudo`.

Les journaux de Docker grossissent sans limite par défaut. Plafonnez-les une fois pour toutes :

```bash
echo '{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

## 5. Installer Notabene

### 5.1 Dossiers et fichier de configuration

```bash
sudo mkdir -p /opt/notabene /srv/appdata/notabene
sudo chown 1000:1000 /srv/appdata/notabene && sudo chmod 700 /srv/appdata/notabene
cd /opt/notabene
```

Le conteneur tourne avec l'identifiant 1000 : sans le `chown`, le serveur s'arrête au démarrage avec un message qui le dit.

Créez le fichier `.env` (remplacez l'adresse par la vôtre ; la clé est tirée au hasard par la commande) :

```bash
sudo sh -c 'umask 077; cat > .env' <<EOF
PUBLIC_URL=https://wiki.example.com
NODE_ENV=production
LOG_LEVEL=info
TRUST_PROXY=1
AUTH_LOCAL=true
ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
```

- `PUBLIC_URL` : l'adresse exacte saisie dans les navigateurs, en `https://`.
- `TRUST_PROXY=1` : un seul reverse proxy devant l'application (voir [DEPLOIEMENT.md](DEPLOIEMENT.md) pour les autres cas).
- `AUTH_LOCAL=true` : comptes par e-mail et mot de passe. La connexion unique (OIDC, LDAP, SAML) se règle ensuite dans **Paramètres**.
- **Copiez `ENCRYPTION_KEY` dans un gestionnaire de mots de passe**, hors de la machine : elle chiffre les secrets en base, et une sauvegarde restaurée sans elle a des secrets illisibles.

### 5.2 Fichier Compose

Récupérez le condensat (digest) de la version à installer, ici la 3.9.0 :

```bash
sudo docker buildx imagetools inspect ghcr.io/lucasmolyn1/notabene:3.9.0 | grep -m1 Digest
```

Créez `/opt/notabene/docker-compose.yml` en remplaçant `<digest>` par le résultat (`sha256:…`). Le tag seul peut être déplacé, le digest non :

```yaml
name: notabene
services:
  notabene:
    image: ghcr.io/lucasmolyn1/notabene:3.9.0@<digest>
    restart: unless-stopped
    env_file: .env
    environment: { DATA_DIR: /data, HOST: 0.0.0.0, PORT: 3000 }
    ports: ["127.0.0.1:3000:3000"]
    volumes: ["/srv/appdata/notabene:/data"]
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    deploy: { resources: { limits: { memory: 512m } } }
```

Sur RHEL et dérivés avec SELinux actif, ajoutez `:Z` au volume : `"/srv/appdata/notabene:/data:Z"`.

### 5.3 Démarrer et créer l'administrateur

```bash
sudo docker compose up -d
sudo docker compose ps                       # l'état doit passer à "healthy"
curl -s http://127.0.0.1:3000/healthz        # {"ok":true}
sudo docker compose exec -it notabene node dist/server/cli.js create-admin admin@exemple.fr --name "Votre nom"
```

La commande `create-admin` demande le mot de passe (saisi sans écho, 12 caractères au minimum). Préférez-la au code d'installation des journaux, qui est un secret temporaire.

## 6. Reverse proxy et HTTPS

**Vous avez déjà un reverse proxy** (Traefik, Nginx Proxy Manager, HAProxy, Caddy, Apache) **qui porte vos autres services ? Passez cette étape** : n'installez pas un second proxy, ajoutez simplement Notabene derrière celui qui existe. Il faut alors :

1. **Un nom de domaine** qui mène à ce proxy, et `PUBLIC_URL=https://ce-nom` dans le `.env` (exactement le nom saisi dans les navigateurs).
2. **Un service** du proxy qui pointe vers `http://<adresse de la machine Notabene>:3000`, avec le certificat TLS géré par le proxy.
3. **Le port atteignable par le proxy, et par lui seul.** Le compose de ce guide publie `127.0.0.1:3000:3000`, ce qui ne convient que si le proxy tourne sur la même machine, hors Docker. Selon votre cas :
   - proxy sur **une autre machine** (autre VM ou LXC) : remplacez par l'adresse de la machine Notabene, par exemple `192.168.1.50:3000:3000`, et n'autorisez le port 3000 dans le pare-feu que depuis l'adresse du proxy ;
   - proxy **dans Docker, sur la même machine** : retirez la ligne `ports`, rattachez les deux conteneurs à un réseau Docker commun (`networks`) et visez `http://notabene:3000` ; le port n'est alors publié nulle part ;
   - proxy **sur la même machine, hors Docker** : gardez `127.0.0.1:3000:3000`.
4. **`TRUST_PROXY`** : le nombre de proxys entre Internet et Notabene (`1` pour un seul proxy ; plus si Cloudflare ou un second proxy est devant). Voir [DEPLOIEMENT.md](DEPLOIEMENT.md).
5. **WebSocket** autorisés jusqu'à Notabene (co-édition). Traefik et Caddy le font sans réglage ; Nginx Proxy Manager a une case « Websockets Support » à cocher ; HAProxy veut un `timeout tunnel` d'au moins une heure.
6. **Toutes les adresses transmises**, pas seulement `/` (`/p/…`, `/s/…`, `/share/…`, `/sitemap.xml`, `/robots.txt`).

Exemple Traefik (fichier dynamique), pour un proxy sur une autre machine :

```yaml
http:
  routers:
    notabene:
      rule: Host(`wiki.example.com`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: notabene
  services:
    notabene:
      loadBalancer:
        servers:
          - url: http://192.168.1.50:3000
```

(Le nom de l'entrée et du résolveur de certificats sont ceux de votre installation. Avec un gestionnaire graphique, l'équivalent est un hôte « domaine → http, adresse, 3000, TLS » avec les WebSocket activés.) Sur la machine Notabene, le pare-feu n'a alors pas besoin d'ouvrir les ports 80 et 443.

### Sans proxy existant : Caddy

Notabene attend un proxy qui termine TLS, transmet **toutes** les adresses (pas seulement `/`) et laisse passer les WebSocket (co-édition). Exemple avec [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) (installation par son dépôt officiel), qui obtient et renouvelle le certificat tout seul. Le nom de domaine doit déjà pointer vers la machine et les ports 80 et 443 être ouverts :

```
# /etc/caddy/Caddyfile
wiki.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Ouvrez `https://wiki.example.com` et connectez-vous. Nginx, Traefik ou HAProxy conviennent aussi : voir « Derrière un reverse proxy » dans [DEPLOIEMENT.md](DEPLOIEMENT.md) (en-têtes, délai des WebSocket, `TRUST_PROXY`).

## 7. À faire le premier jour

1. **Double authentification** : active-la sur le compte administrateur (profil) ; `LOCAL_REQUIRE_MFA=true` dans `.env` l'impose à tous.
2. **Sauvegardes** : générez une clé de chiffrement, gardez la clé privée hors du serveur, puis mettez la clé publique dans `BACKUP_AGE_RECIPIENT`. En production, une sauvegarde non chiffrée est refusée.

   ```bash
   sudo docker compose exec -T notabene node dist/server/backup.js keygen
   ```

   Planification et restauration (à essayer une fois) : [BACKUP.md](BACKUP.md).
3. **Mises à jour** : lisez [MISE-A-JOUR.md](MISE-A-JOUR.md). `UPDATE_CHECK=true` affiche une alerte dans l'application ; `scripts/install-updater.sh` ajoute le bouton « Mettre à jour » (voir le guide).
4. **Instantané de la machine** avant chaque montée de version, si votre hyperviseur le permet.
5. **Mises à jour du système** : activez les correctifs de sécurité automatiques (`sudo apt install unattended-upgrades` sur Debian et Ubuntu, `dnf-automatic` sur RHEL).
6. **Draw.io** (facultatif) : demande un second service et un second nom d'hôte, voir « Draw.io : un second nom d'hôte » dans [DEPLOIEMENT.md](DEPLOIEMENT.md). Sans lui, Mermaid, PlantUML et Excalidraw fonctionnent.

## 8. Dépannage rapide

| Symptôme | Cause probable |
|---|---|
| Le conteneur redémarre en boucle, message sur les permissions | Le dossier de données n'appartient pas à l'uid 1000 (§5.1). |
| Le conteneur s'arrête au démarrage et parle de `PUBLIC_URL` ou de HTTPS | `PUBLIC_URL` n'est pas en `https://` ; pour un essai local seulement, voir [ESSAI.md](ESSAI.md). |
| La page s'ouvre mais la connexion boucle | `PUBLIC_URL` diffère du nom saisi dans le navigateur, ou le proxy ne transmet pas `X-Forwarded-Proto`. |
| Les curseurs des autres personnes n'apparaissent pas | Le proxy bloque les WebSocket (`Upgrade`). |
| `permission denied` sur `/var/run/docker.sock` | Lancer la commande avec `sudo` (§4). |
| `no matching manifest` au téléchargement de l'image | Machine en 32 bits ou architecture non prise en charge (§2). |
| Erreur de certificat | Le domaine ne pointe pas encore vers la machine, ou le port 80 est fermé (validation du certificat). |
| Voir ce que fait le serveur | `sudo docker compose logs --tail 100 notabene` (ne partagez pas cette sortie : elle peut contenir un code d'installation). |
