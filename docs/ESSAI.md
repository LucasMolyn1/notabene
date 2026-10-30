# Essayer Notabene en 10 minutes

Pour voir à quoi ressemble Notabene avant d'y consacrer une vraie installation. Il faut Docker avec le plugin Compose, et rien d'autre : pas de compte à créer ailleurs, pas de fournisseur d'identité, pas de certificat.

## Démarrer

```bash
curl -O https://raw.githubusercontent.com/LucasMolyn1/notabene/main/docker-compose.essai.yml
docker compose -f docker-compose.essai.yml up -d
```

1. Ouvrez <http://localhost:3000>.
2. À la première visite, la page demande un **code d'installation** : il est affiché dans les journaux du serveur, pour que seule la personne qui a la main sur la machine puisse créer le premier compte.

   ```bash
   docker compose -f docker-compose.essai.yml logs notabene | grep "code d'installation"
   ```

   (Si le conteneur a redémarré depuis, prenez le dernier code affiché.)
3. Saisissez le code, votre nom, votre adresse e-mail et un mot de passe de 12 caractères minimum : vous êtes administrateur. Un petit wiki de démonstration est déjà là.

## Ce que l'essai contient, et ce qu'il laisse de côté

Tout ce qui touche à l'écriture et à l'organisation fonctionne : espaces, pages imbriquées, éditeur riche, blocs de code colorés, emojis, co-édition à plusieurs, commentaires, historique, recherche, import et export Markdown, API REST et jetons, comptes locaux avec double authentification facultative.

Volontairement absents, car ils demandent un service ou une décision de votre part :

| Absent | Pourquoi | Pour l'avoir |
|---|---|---|
| **Draw.io** | Il faut un second service, accessible par le navigateur. Les diagrammes **Mermaid, PlantUML et Excalidraw** restent disponibles. | `docker-compose.yml` et `COMPOSE_PROFILES=drawio` |
| **Connexion unique (Authentik, SAML, LDAP)** | Dépend de votre annuaire. | [AUTHENTIK.md](AUTHENTIK.md) |
| **Recherche par IA** | Demande la clé d'un fournisseur (ou un modèle local). | Paramètres, Recherche IA, une fois l'instance en place |
| **E-mails** (notifications, mot de passe oublié) | Demande un serveur SMTP. | Paramètres, E-mail |
| **HTTPS** | L'essai écoute en HTTP, sur votre machine seulement. | Un reverse proxy TLS, voir [DEPLOIEMENT.md](DEPLOIEMENT.md) |

## Depuis un autre poste

Par défaut, seul votre ordinateur peut s'y connecter. Pour l'ouvrir à votre réseau local, indiquez l'adresse que les navigateurs utiliseront :

```bash
PUBLIC_URL=http://192.168.1.50:3000 NOTABENE_BIND=0.0.0.0 docker compose -f docker-compose.essai.yml up -d
```

En HTTP, le mot de passe circule en clair sur le réseau : réservez cela à un réseau de confiance, et pas à Internet.

## Garder une version précise

Le fichier utilise la dernière version publiée. Pour en figer une : `NOTABENE_VERSION=3.6.0 docker compose -f docker-compose.essai.yml up -d`.

## Arrêter, ou tout effacer

```bash
docker compose -f docker-compose.essai.yml down        # arrête, garde vos pages
docker compose -f docker-compose.essai.yml down -v     # arrête et efface tout (pages, comptes)
```

## Et ensuite

Pour une vraie instance, ne partez pas de ce fichier : il garde la clé de chiffrement à côté des données et ne protège pas la connexion. Suivez [DEPLOIEMENT.md](DEPLOIEMENT.md) : `scripts/setup.sh` génère un `.env` avec de vrais secrets, et le guide explique l'épinglage de l'image, le reverse proxy et les sauvegardes. Vos pages d'essai ne se migrent pas telles quelles, mais Paramètres, Instance permet de télécharger une sauvegarde, et l'export Markdown de chaque page se réimporte.
