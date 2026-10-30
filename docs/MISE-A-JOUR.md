# Mettre à jour Notabene

Pour une instance qui tourne avec l'image publiée (`ghcr.io/lucasmolyn1/notabene`). Les changements de chaque version sont dans le [CHANGELOG](../CHANGELOG.md) et dans Paramètres, À propos.

## Savoir qu'une version existe

Une instance ne se met jamais à jour toute seule. Deux façons d'être prévenu :

- **Dans l'application (recommandé)** : Paramètres, À propos, « Activer la vérification » (administrateur ; ou `UPDATE_CHECK=true` dans le `.env`). Quand un administrateur ouvre l'application, Notabene demande à GitHub quelle est la dernière release (au plus toutes les 12 heures). Si elle est plus récente, une alerte « Version X disponible » apparaît dans la barre latérale et mène à Paramètres, À propos, qui affiche les nouveautés de cette version, y compris « Attention à la mise à jour », et les commandes ci-dessous.
  - Ce que GitHub voit : l'adresse IP publique du serveur, l'heure et le numéro de version. Aucune donnée de l'instance n'est envoyée. Ce n'est pas une mise à jour automatique : l'instance prévient, vous installez. C'est pourquoi la vérification est désactivée par défaut.
  - Si l'IP de sortie du serveur est celle que vous cachez derrière un proxy (Cloudflare), vérifiez-la avant d'activer.
  - Seuls les administrateurs voient l'alerte.
- **Sans appel sortant** : surveiller les [releases du dépôt](https://github.com/LucasMolyn1/notabene/releases) (bouton « Watch », « Custom », « Releases » sur GitHub pour être prévenu par e-mail).

## Avant de commencer

1. Lire la section **« Attention à la mise à jour »** de la version visée. Elle dit ce qui change de comportement (variables, API retirée, droits des dossiers).
2. Lire **toutes** les versions entre la vôtre et la cible si vous sautez plusieurs versions : les migrations de base s'appliquent dans l'ordre au démarrage.
3. Faire une **sauvegarde** et la vérifier (voir [BACKUP.md](BACKUP.md)) :

   ```bash
   docker compose exec -T notabene node dist/server/backup.js backup
   ```

   Sur une machine virtuelle ou un conteneur LXC, prendre aussi un instantané : c'est le retour arrière le plus rapide.
4. Choisir une fenêtre calme : le serveur redémarre quelques secondes, les éditions en cours se reconnectent seules.

## Mettre à jour

1. Dans le fichier compose, changer le numéro de version de l'image (et le digest si vous l'épinglez) :

   ```yaml
   image: ghcr.io/lucasmolyn1/notabene:3.3.0@sha256:<digest>
   ```

   Le digest d'un tag : `docker buildx imagetools inspect ghcr.io/lucasmolyn1/notabene:3.3.0`. Vérifier la provenance : `gh attestation verify oci://ghcr.io/lucasmolyn1/notabene:3.3.0 --owner LucasMolyn1`.
2. Télécharger et redémarrer :

   ```bash
   docker compose pull
   docker compose up -d
   ```

   Si l'image n'est pas épinglée par numéro (déconseillé en production), `pull` suffit à récupérer la dernière.
3. Les migrations s'appliquent au démarrage. Suivre le démarrage :

   ```bash
   docker compose logs -f --tail=50 notabene
   ```

## Vérifier

- `curl -s http://127.0.0.1:3000/healthz` répond `{"ok":true}`.
- Paramètres, Instance (ou À propos) affiche la nouvelle version et le commit de l'image.
- Se connecter, ouvrir une page, en modifier une, lancer une recherche.
- Paramètres, À propos : « À jour ».

## Revenir en arrière

Les migrations de base **ne reviennent pas en arrière** : un serveur plus ancien refuse de démarrer sur une base plus récente (message « la base est au schéma vN »). Ne remettez donc pas simplement l'ancienne image. Il faut les deux :

1. Arrêter : `docker compose stop notabene`.
2. Restaurer la sauvegarde d'avant la mise à jour (ou l'instantané de la machine), voir [BACKUP.md](BACKUP.md#restauration).
3. Remettre l'ancien numéro d'image dans le compose, puis `docker compose up -d`.

Tout ce qui a été écrit après la sauvegarde est perdu : c'est pourquoi on la prend juste avant.

## En cas de problème

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| Le conteneur redémarre en boucle, message sur le dossier de données | Le dossier monté n'appartient pas à l'utilisateur du conteneur (uid 1000) | `chown -R 1000:1000 /srv/appdata/notabene` |
| « La base est au schéma vN, ce serveur ne connaît que vM » | Image plus ancienne que la base | Remettre l'image visée, ou restaurer la sauvegarde (voir plus haut) |
| Connexion SSO en erreur juste après | Les connexions lancées avant la mise à jour échouent une fois | Recommencer |
| Dérive d'adresse IP des clients après une version qui change `TRUST_PROXY` | Sens de la variable modifié | Relire « Attention à la mise à jour » et [DEPLOIEMENT.md](DEPLOIEMENT.md) |
| L'alerte de mise à jour n'apparaît pas | `UPDATE_CHECK` désactivé, ou GitHub injoignable depuis le serveur | Paramètres, À propos indique la raison |

## Publier une version (mainteneur)

Voir le README, « Versions et releases ». Le tag `vX.Y.Z` construit l'image puis **crée la release GitHub avec les notes de la section du CHANGELOG** : c'est cette release que les instances lisent pour annoncer la mise à jour. Une version sans release GitHub est invisible pour la vérification. Pour une version déjà taguée sans release :

```bash
scripts/release-notes.sh 3.2.0 > notes.md
gh release create v3.2.0 --title "Notabene 3.2.0" --notes-file notes.md --verify-tag
```
