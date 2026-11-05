# Sauvegarde et restauration

Les données de BeNote (pages, versions, comptes, réglages, journal d'audit) sont dans un fichier SQLite : `notabene.db`, dans le volume `/data` du conteneur. Les images collées dans l'éditeur sont stockées dans les pages. Les **pièces jointes** (fichiers joints à une page) sont à part, dans `/data/attachments` : la base n'en garde que l'inventaire (nom, taille, empreinte SHA-256). La sauvegarde, la vérification et la restauration traitent les deux ensemble. La clé `ENCRYPTION_KEY` (dans le `.env`) n'est **pas** dans la base : sans elle, les secrets chiffrés (clé du fournisseur d'IA, secrets des webhooks, MFA) sont illisibles après restauration. Sauvegardez-la séparément et en lieu sûr.

## Sauvegarde

Copie cohérente pendant que le serveur tourne (API de sauvegarde en ligne de SQLite), vérifiée puis rangée dans `/data/backups` avec rotation (14 conservées, réglable par `BACKUP_KEEP`) :

```bash
docker compose exec -T notabene node dist/server/backup.js backup
```

Sans Docker : `npm run backup` (dossier `data/backups`). Un dossier de destination peut être passé en argument.

Depuis l'interface : Paramètres > Instance > Télécharger une sauvegarde (administrateurs). **Ce téléchargement ne contient que la base, pas les pièces jointes** : pour une sauvegarde complète, utilisez la commande ci-dessus.

### Pièces jointes

Chaque sauvegarde `notabene-AAAAMMJJ-HHMMSS.db` (ou `.db.age`) est accompagnée du dossier `notabene-AAAAMMJJ-HHMMSS.attachments/`, qui contient un fichier par pièce jointe connue de la base sauvegardée (nommé par son identifiant) et un petit `manifest.json`. **Les deux vont ensemble** : copiez, déplacez et conservez toujours le fichier et le dossier du même nom.

- **Cohérence** : la base est copiée d'abord, puis les fichiers qu'elle référence, avec contrôle de l'empreinte de chacun. Une pièce jointe supprimée entre les deux est retirée de la copie de la base : la sauvegarde ne référence que des fichiers présents. Un fichier introuvable ou altéré sur le disque alors que la base le connaît encore est signalé (`ATTENTION : sauvegarde incomplète`, code de sortie 3, à surveiller dans la minuterie).
- **Espace occupé** : un fichier ne change jamais une fois envoyé. Un fichier déjà présent dans la sauvegarde précédente est repris par **lien physique** au lieu d'être recopié : 14 sauvegardes d'un dossier de 5 Go n'occupent pas 70 Go. Supprimer une ancienne sauvegarde ne touche pas aux fichiers encore liés par les suivantes. Un outil de copie externe doit préserver les liens physiques (`rsync -H`) pour garder cet avantage.
- **Préparation** : tout est écrit dans un dossier de travail `.notabene-…partiel`, puis mis en place, la base en dernier. Un dossier de travail abandonné (coupure) est retiré par la rotation après un jour.
- La rotation (`BACKUP_KEEP`) supprime le dossier avec sa base.

### Chiffrer les sauvegardes (recommandé, obligatoire en production)

Les sauvegardes sont chiffrées avec [age](https://age-encryption.org) : la machine qui sauvegarde ne détient que la **clé publique** et ne peut donc pas relire ses propres sauvegardes. Un volume copié, un instantané ou un disque récupéré ne livrent rien sans la clé privée.

1. Générer la paire (une fois, sur votre poste ou un gestionnaire de secrets) :

   ```bash
   docker compose exec -T notabene node dist/server/backup.js keygen
   ```

2. Mettre la clé **publique** dans le `.env` : `BACKUP_AGE_RECIPIENT=age1...`. Les sauvegardes planifiées et le téléchargement depuis l'interface deviennent des fichiers `.db.age` ; le fichier en clair n'est jamais conservé. Les pièces jointes sont chiffrées pour la même clé, **chacune dans son fichier** (`<identifiant>.age`), lues et écrites en flux (pas de limite de taille liée à la mémoire). Après un changement de clé, la sauvegarde suivante rechiffre tous les fichiers (rien n'est repris d'une sauvegarde chiffrée pour une autre clé).
3. Conserver la clé **privée** (`AGE-SECRET-KEY-...`) hors du serveur : gestionnaire de mots de passe, coffre, papier. **Clé perdue = sauvegardes perdues.**

En production (`NODE_ENV=production`), une sauvegarde sans `BACKUP_AGE_RECIPIENT` est refusée, sauf `BACKUP_ALLOW_PLAINTEXT=true` (choix explicite, déconseillé). La vérification et la restauration d'un `.age` demandent la clé privée dans un fichier : `BACKUP_AGE_IDENTITY_FILE=/chemin/identity.txt` (à fournir le temps de l'opération seulement).

Limite : la base est traitée en mémoire (prévu pour des bases de quelques centaines de Mo). Ce qui reste lisible sans la clé privée : le nombre de pièces jointes, leurs identifiants et leur taille approximative (pas leur nom, leur type ni leur contenu, qui sont dans la base chiffrée ou dans les fichiers chiffrés).

### Automatiser

Cron sur l'hôte :

```cron
15 3 * * * cd /opt/notabene && docker compose exec -T notabene node dist/server/backup.js backup >> /var/log/notabene-backup.log 2>&1
```

Ou une minuterie systemd (journalisée, rattrape un arrêt de la machine) :

```ini
# /etc/systemd/system/notabene-backup.service
[Service]
Type=oneshot
WorkingDirectory=/opt/notabene
ExecStart=/usr/bin/docker compose exec -T notabene node dist/server/backup.js backup

# /etc/systemd/system/notabene-backup.timer
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
[Install]
WantedBy=timers.target
```

Le dossier `/data/backups` reste dans le même volume : copiez-le régulièrement hors de la machine (Proxmox Backup Server, rsync, restic…). Une sauvegarde chiffrée peut partir sur un stockage moins sûr ; une sauvegarde en clair contient les pages et des hash de jetons : traitez-la comme un secret.

### Chiffrement de la base elle-même

La base active (`notabene.db`) n'est pas chiffrée par l'application. Pour la protéger au repos, chiffrez le stockage de l'hôte (LUKS, ZFS chiffré, volume Proxmox chiffré). Les secrets (clé IA, webhooks, SMTP, LDAP, MFA) sont déjà chiffrés champ par champ avec `ENCRYPTION_KEY`, et les sauvegardes le sont par age.

## Vérification

```bash
docker compose exec -T notabene node dist/server/backup.js verify /data/backups/notabene-AAAAMMJJ-HHMMSS.db
```

Contrôle l'intégrité SQLite et la présence des tables principales (sur un fichier chiffré : déchiffrement temporaire, effacé ensuite), puis **chaque pièce jointe** : présence dans le dossier `.attachments` et empreinte SHA-256 du contenu (déchiffré en flux si besoin, jamais écrit sur le disque). Une pièce jointe absente ou altérée est listée (`PROBLÈME : …`) et la commande sort avec le code 1. La vérification lit tous les fichiers : comptez le temps de lecture du dossier. Faites-la périodiquement : une sauvegarde jamais testée n'est pas une sauvegarde.

### Exercice de restauration (à faire une fois, puis chaque trimestre)

1. Copier une sauvegarde sur une machine de test (jamais la production) avec une copie du `.env`.
2. `verify`, puis `restore ... --yes` sur cette machine, démarrer et se connecter.
3. Contrôler qu'une page récente, un compte, une pièce jointe (téléchargement) et un réglage chiffré (clé IA, SMTP) sont lisibles. Si les secrets sont illisibles, la `ENCRYPTION_KEY` n'est pas la bonne.

## Restauration

1. Arrêter le serveur : `docker compose stop notabene`
2. Restaurer (l'ancienne base est conservée à côté, suffixe `.avant-restauration-…`) :

   ```bash
   docker compose run --rm --no-deps notabene node dist/server/backup.js restore /data/backups/notabene-AAAAMMJJ-HHMMSS.db --yes
   ```

3. Redémarrer : `docker compose up -d notabene`

Les pièces jointes sont restaurées **avant** la base, et **rien n'est écrasé** :

- un fichier déjà présent dans `/data/attachments` et identique (même empreinte) est laissé en place ;
- un fichier présent mais différent est déplacé dans `/data/attachments-quarantaine` (suffixe `.avant-restauration-…`) avant d'être remplacé ;
- chaque fichier restauré est écrit à part, contrôlé, puis mis en place ;
- les fichiers que la base restaurée ne connaît pas (envoyés après la sauvegarde) restent sur le disque ; au démarrage suivant, le serveur les **déplace en quarantaine** (`/data/attachments-quarantaine`) au lieu de les effacer. Videz ce dossier à la main une fois la restauration validée.

S'il manque des fichiers dans la sauvegarde ou que certains sont altérés, **la base actuelle n'est pas remplacée** et la commande liste les identifiants concernés. Pour restaurer quand même (les pièces jointes manquantes seront introuvables) : ajoutez `--allow-missing`. Une sauvegarde antérieure aux pièces jointes (sans dossier `.attachments`) se restaure normalement.

Les migrations de schéma s'appliquent automatiquement au démarrage si la sauvegarde est plus ancienne que la version du serveur. Une sauvegarde plus récente que le serveur ne doit pas être restaurée sur une version plus ancienne.

## Conversion des images collées en pièces jointes

Les images collées dans l'éditeur avant les pièces jointes sont stockées dans les pages, en base64. La conversion les range dans `/data/attachments` comme des pièces jointes ordinaires (pages plus légères, recherche et historique plus rapides, export ZIP avec les images). Elle touche toutes les pages concernées : **faites d'abord une sauvegarde complète et vérifiez-la** (et, sur Proxmox, un instantané du conteneur).

```bash
docker compose exec -T notabene node dist/server/backup.js backup
docker compose exec -T notabene node dist/server/backup.js verify /data/backups/notabene-AAAAMMJJ-HHMMSS.db
docker compose exec -T notabene node dist/server/cli.js migrate-images --dry-run   # estimation, rien n'est modifié
docker compose exec -T notabene node dist/server/cli.js migrate-images             # conversion
docker compose exec -T notabene node dist/server/cli.js migrate-images --status    # exécutions passées
docker compose exec -T notabene node dist/server/cli.js migrate-images --revert <exécution>
```

La même opération existe pour les administrateurs dans l'API (`/api/v3/admin/images/migration`), depuis une session web ; elle tourne alors en tâche de fond dans le serveur. Préférez-la quand le serveur est en marche : la commande en ligne ne voit pas les pages ouvertes en co-édition et ignore seulement celles co-éditées dans les dix dernières minutes.

Ce que fait la conversion, page par page :

- seules les images PNG, JPEG, GIF et WebP **reconnues sur leurs octets** sont converties ; un SVG, un contenu non reconnu ou une image plus lourde que `ATTACHMENT_MAX_MB` reste dans la page, qui est signalée ;
- avant de modifier une page, son contenu d'origine est inscrit dans l'historique des versions, puis le résultat ; la date de modification de la page ne change pas, aucune notification ni webhook n'est envoyé ;
- les fichiers comptent dans `ATTACHMENTS_TOTAL_MB` et dans le quota de l'auteur de la page (`ATTACHMENT_USER_MB`) : une page qui les dépasserait est laissée telle quelle et signalée ;
- une page ouverte en co-édition n'est pas touchée (signalée, reprise à l'exécution suivante) ;
- une seule exécution à la fois, commande en ligne et serveur confondus ; une exécution interrompue se relance sans rien refaire.

**Retour arrière** : `--revert <exécution>` remet chaque image à l'identique (reconstruite depuis son fichier et vérifiée sur l'empreinte enregistrée) ; une page inchangée depuis retrouve exactement son contenu d'origine, une page modifiée depuis ne retrouve que ses images. Les fichiers créés restent, car l'historique des versions les cite. Le journal de chaque exécution est dans la base (tables `image_migration_*`) : il fait partie des sauvegardes.
