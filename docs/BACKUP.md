# Sauvegarde et restauration

Toutes les données de Notabene (pages, versions, comptes, réglages, journal d'audit) sont dans un seul fichier SQLite : `notabene.db`, dans le volume `/data` du conteneur. Les images sont stockées dans les pages. La clé `ENCRYPTION_KEY` (dans le `.env`) n'est **pas** dans la base : sans elle, les secrets chiffrés (clé du fournisseur d'IA, secrets des webhooks, MFA) sont illisibles après restauration. Sauvegardez-la séparément et en lieu sûr.

## Sauvegarde

Copie cohérente pendant que le serveur tourne (API de sauvegarde en ligne de SQLite), vérifiée puis rangée dans `/data/backups` avec rotation (14 conservées, réglable par `BACKUP_KEEP`) :

```bash
docker compose exec -T notabene node dist/server/backup.js backup
```

Sans Docker : `npm run backup` (dossier `data/backups`). Un dossier de destination peut être passé en argument.

Depuis l'interface : Paramètres > Instance > Télécharger une sauvegarde (administrateurs).

### Automatiser (cron sur l'hôte)

```cron
15 3 * * * cd /opt/notabene && docker compose exec -T notabene node dist/server/backup.js backup >> /var/log/notabene-backup.log 2>&1
```

Le dossier `/data/backups` reste dans le même volume : copiez-le régulièrement hors de la machine (rsync, restic, snapshot du conteneur Proxmox…). Une sauvegarde contient des secrets chiffrés et des hash de jetons : traitez-la comme un secret.

## Vérification

```bash
docker compose exec -T notabene node dist/server/backup.js verify /data/backups/notabene-AAAAMMJJ-HHMMSS.db
```

Contrôle l'intégrité SQLite et la présence des tables principales. Faites-le périodiquement : une sauvegarde jamais testée n'est pas une sauvegarde.

## Restauration

1. Arrêter le serveur : `docker compose stop notabene`
2. Restaurer (l'ancienne base est conservée à côté, suffixe `.avant-restauration-…`) :

   ```bash
   docker compose run --rm --no-deps notabene node dist/server/backup.js restore /data/backups/notabene-AAAAMMJJ-HHMMSS.db --yes
   ```

3. Redémarrer : `docker compose up -d notabene`

Les migrations de schéma s'appliquent automatiquement au démarrage si la sauvegarde est plus ancienne que la version du serveur. Une sauvegarde plus récente que le serveur ne doit pas être restaurée sur une version plus ancienne.
