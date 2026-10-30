# Journal des changements

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Numérotation : [versionnage sémantique](https://semver.org/lang/fr/) (MAJOR.MINOR.PATCH).

La version de référence est le champ `version` de `package.json` ; le premier titre de ce fichier doit toujours lui correspondre (un test le vérifie). Procédure de release : voir le README, « Versions et releases ».

## [3.0.0] - 2026-10-30

Cette version regroupe tout ce qui a été fait depuis la 2.0.0 : comptes locaux et MFA, configuration web des fournisseurs, notifications, API v3, audit de sécurité complet, RGPD et accessibilité.

### Attention à la mise à jour
- **API :** seule `/api/v3` est servie. `/api/v1` et `/api/v2` sont retirées (réponse 404). Les intégrations qui les utilisaient doivent passer à la v3 (pagination par curseur, `ETag` / `If-Match`, erreurs RFC 9457). C'est ce retrait qui motive le changement de version majeure.
- **Image 2.0.0 :** elle ne contient aucune des fonctions listées ci-dessous (comptes locaux, `create-admin`, sauvegardes chiffrées, import Markdown, configuration web…). Une procédure de déploiement écrite pour la 2.1.0 ou la 3.0.0 ne fonctionne pas avec elle : épinglez l'image `3.0.0`.
- **Dossier de données monté :** il doit appartenir à l'utilisateur du conteneur (uid 1000) ; sinon le serveur s'arrête avec un message qui l'indique (voir [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)).
- **Base de données :** les migrations s'appliquent au démarrage (jusqu'au schéma v8). Une base plus récente que le serveur est refusée au démarrage : ne revenez pas à une image plus ancienne sans restaurer une sauvegarde compatible.
- **Purges automatiques actives par défaut :** corbeille 30 jours, notifications lues 90 jours, adresses IP du journal d'audit 90 jours, journal 365 jours (`TRASH_RETENTION_DAYS`, `NOTIFICATION_RETENTION_DAYS`, `AUDIT_IP_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS` ; `0` désactive).
- **Désactiver un fournisseur (LDAP, SMTP, OIDC, SAML) efface ses secrets :** il faut les ressaisir pour le réactiver.
- **Connexions SSO en cours à la mise à jour :** celles lancées avant échouent une fois (liaison de la connexion au navigateur).

### Ajouté
- Comptes locaux avec double authentification (TOTP), codes de secours, verrouillage, mot de passe oublié et invitations par e-mail.
- Configuration des fournisseurs (OIDC, LDAP, SAML, SMTP, sites autorisés) depuis l'interface, à chaud, avec test de connexion et ressaisie du mot de passe.
- Commande `create-admin`, serveur MCP, webhooks signés, export PDF.
- Notifications : suivi de pages, cloche, e-mails sans contenu.
- Commentaires de page (fils à un niveau) et permissions fines par page.
- Sauvegardes chiffrées (age) avec restauration vérifiée, téléchargeables depuis l'interface.
- Recherche IA : liste des modèles du fournisseur, option `AI_ALLOW_PRIVATE` pour un modèle local.
- RGPD : export des données d'un compte, suppression par anonymisation, purges réglables, [docs/RGPD.md](docs/RGPD.md).
- Accessibilité : navigation clavier de l'arborescence, lien « Aller au contenu », menus et dialogues nommés.
- Affichage de la version (et du commit de l'image) dans Paramètres, Instance ; [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md) (déploiement derrière un proxy, mises à jour, vérification de l'image).
- Tests de bout en bout Playwright ; CI avec gitleaks, Semgrep, Trivy, CodeQL et images épinglées par digest.

### Modifié
- Liste des pages 40 fois plus rapide (402 ms → 10 ms pour 2 000 pages de 50 Ko) ; filtrage des permissions proportionnel aux pages demandées.
- Sessions : durée absolue plus fermeture après inactivité ; documentation de l'API réservée aux connectés.
- Démarrage : message explicite quand le dossier de données n'est pas inscriptible.
- Arrêt du serveur propre même avec des flux d'événements ouverts ; `/healthz` vérifie la base.

### Corrigé
- Palette de recherche : sans IA configurée, elle ne s'ouvrait pas correctement.
- Vidage de la corbeille interrompu quand un parent et son enfant y étaient ensemble.
- Notification de co-édition envoyée à son propre auteur ; frappes perdues au changement de permissions d'une page.
- Fichiers `-wal` et `-shm` orphelins dans les sauvegardes.

### Sécurité
- MFA obligatoire appliquée sur la route réellement appariée (contournement par chemin encodé), co-édition comprise.
- Déplacer, dupliquer ou restaurer une page ne lève plus sa restriction ; la lecture seule n'autorise plus les commentaires.
- Les secrets des fournisseurs ne suivent jamais un changement d'adresse sans être ressaisis ; la clé de l'IA exige le mot de passe.
- Requêtes sortantes (webhooks, IA) protégées contre le SSRF, y compris le rebinding DNS.
- Co-édition : droits revérifiés toutes les 30 secondes et coupure immédiate (déconnexion, compte désactivé, permissions, déplacement).
- Connexion SSO liée au navigateur par un cookie à courte durée.
- Dépendances : `katex` 0.18.10 (GHSA-238p-pmpm-9mq7), `nodemailer` 10.

### Retiré
- API `/api/v1` et `/api/v2`.

## [2.0.0] - 2026-10-29

Première version : wiki collaboratif auto-hébergé (Fastify, TipTap, SQLite FTS5), authentification OIDC, espaces, pages et versions, éditeur riche et diagrammes, recherche plein texte, API REST à jetons, recherche IA, intégration en iframe, CI durcie.
