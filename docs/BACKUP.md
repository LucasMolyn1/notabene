# Sauvegarde et restauration

Toutes les données de Notabene (pages, versions, comptes, réglages, journal d'audit) sont dans un seul fichier SQLite : `notabene.db`, dans le volume `/data` du conteneur. Les images sont stockées dans les pages. La clé `ENCRYPTION_KEY` (dans le `.env`) n'est **pas** dans la base : sans elle, les secrets chiffrés (clé du fournisseur d'IA, secrets des webhooks, MFA) sont illisibles après restauration. Sauvegardez-la séparément et en lieu sûr.

## Sauvegarde

Copie cohérente pendant que le serveur tourne (API de sauvegarde en ligne de SQLite), vérifiée puis rangée dans `/data/backups` avec rotation (14 conservées, réglable par `BACKUP_KEEP`) :

```bash
docker compose exec -T notabene node dist/server/backup.js backup
```

Sans Docker : `npm run backup` (dossier `data/backups`). Un dossier de destination peut être passé en argument.

Depuis l'interface : Paramètres > Instance > Télécharger une sauvegarde (administrateurs).

### Chiffrer les sauvegardes (recommandé, obligatoire en production)

Les sauvegardes sont chiffrées avec [age](https://age-encryption.org) : la machine qui sauvegarde ne détient que la **clé publique** et ne peut donc pas relire ses propres sauvegardes. Un volume copié, un instantané ou un disque récupéré ne livrent rien sans la clé privée.

1. Générer la paire (une fois, sur votre poste ou un gestionnaire de secrets) :

   ```bash
   docker compose exec -T notabene node dist/server/backup.js keygen
   ```

2. Mettre la clé **publique** dans le `.env` : `BACKUP_AGE_RECIPIENT=age1...`. Les sauvegardes planifiées et le téléchargement depuis l'interface deviennent des fichiers `.db.age` ; le fichier en clair n'est jamais conservé.
3. Conserver la clé **privée** (`AGE-SECRET-KEY-...`) hors du serveur : gestionnaire de mots de passe, coffre, papier. **Clé perdue = sauvegardes perdues.**

En production (`NODE_ENV=production`), une sauvegarde sans `BACKUP_AGE_RECIPIENT` est refusée, sauf `BACKUP_ALLOW_PLAINTEXT=true` (choix explicite, déconseillé). La vérification et la restauration d'un `.age` demandent la clé privée dans un fichier : `BACKUP_AGE_IDENTITY_FILE=/chemin/identity.txt` (à fournir le temps de l'opération seulement).

Limite : le fichier est traité en mémoire (prévu pour des bases de quelques centaines de Mo).

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

Contrôle l'intégrité SQLite et la présence des tables principales (sur un fichier chiffré : déchiffrement temporaire, effacé ensuite). Faites-le périodiquement : une sauvegarde jamais testée n'est pas une sauvegarde.

### Exercice de restauration (à faire une fois, puis chaque trimestre)

1. Copier une sauvegarde sur une machine de test (jamais la production) avec une copie du `.env`.
2. `verify`, puis `restore ... --yes` sur cette machine, démarrer et se connecter.
3. Contrôler qu'une page récente, un compte et un réglage chiffré (clé IA, SMTP) sont lisibles. Si les secrets sont illisibles, la `ENCRYPTION_KEY` n'est pas la bonne.

## Restauration

1. Arrêter le serveur : `docker compose stop notabene`
2. Restaurer (l'ancienne base est conservée à côté, suffixe `.avant-restauration-…`) :

   ```bash
   docker compose run --rm --no-deps notabene node dist/server/backup.js restore /data/backups/notabene-AAAAMMJJ-HHMMSS.db --yes
   ```

3. Redémarrer : `docker compose up -d notabene`

Les migrations de schéma s'appliquent automatiquement au démarrage si la sauvegarde est plus ancienne que la version du serveur. Une sauvegarde plus récente que le serveur ne doit pas être restaurée sur une version plus ancienne.
