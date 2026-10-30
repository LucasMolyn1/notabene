# Journal des changements

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Numérotation : [versionnage sémantique](https://semver.org/lang/fr/) (MAJOR.MINOR.PATCH).

La version de référence est le champ `version` de `package.json` ; le premier titre de ce fichier doit toujours lui correspondre (un test le vérifie). Procédure de release : voir le README, « Versions et releases ».

## [Non publié]

### Ajouté
- **Vérification de types du client** (`checkJs`, `npm run typecheck`) : les 45 erreurs initiales sont corrigées (types des options par JSDoc, déclarations des modules CSS et des commandes TipTap). Mode non strict ; le passer en strict demanderait environ 700 annotations, à faire progressivement.
- Mesure de la couverture de tests (`npm run coverage`) avec seuils dans la CI : 76 % des instructions, 80 % des lignes, 65 % des branches, 82 % des fonctions au départ ; les modules les moins couverts sont le client IA, la recherche IA (RAG), OIDC et les routes d'espaces et de webhooks.
- **ESLint** dans la CI (`npm run lint`) : erreurs courantes, expressions régulières quadratiques (ReDoS), évaluation dynamique, processus enfants et HTML injecté côté client (chaque `innerHTML` est justifié). Installé dans `tools/lint` avec TypeScript 6, car `typescript-eslint` ne supporte pas encore TypeScript 7 ; le projet reste en TypeScript 7.

### Modifié
- L'image Draw.io du `docker-compose.yml` est épinglée par digest (tag + sha256).

### Corrigé
- Expressions régulières réécrites sans quantificateur imbriqué (import Markdown, origines autorisées, routes des réglages).

## [3.1.0] - 2026-10-30

Écran « À propos » avec les nouveautés, vérification de mise à jour optionnelle et réglage fin de la confiance envers les reverse proxys.

### Attention à la mise à jour
- **`TRUST_PROXY=1` change de sens :** il signifiait « tous les sauts », il signifie désormais « un seul proxy devant l'application ». Derrière Cloudflare puis HAProxy, réglez `TRUST_PROXY=2` ; `true` reste accepté mais déconseillé (voir [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)).

### Ajouté
- **À propos et nouveautés** : Paramètres, À propos affiche la version, le commit de l'image et les notes de version (lues dans `CHANGELOG.md`, embarqué dans l'image). Une pastille signale les nouveautés quand la version change.
- **Vérification de mise à jour** (désactivée par défaut, administrateur) : `UPDATE_CHECK=true` interroge la dernière release sur api.github.com, au plus toutes les 12 heures et seulement quand un administrateur ouvre l'écran. L'adresse IP du serveur et la version sont alors visibles de GitHub ; aucune donnée de l'instance n'est envoyée.

### Modifié
- `TRUST_PROXY` accepte un **nombre de sauts de confiance** (`1`, `2`…) ou une **liste de proxys** (adresses ou CIDR) en plus de `true` / `false`. L'adresse du client est alors lue en partant de la droite de `X-Forwarded-For` : un client ne peut plus la falsifier. `TRUST_PROXY=true` reste accepté mais déconseillé (avertissement au démarrage en production). **Attention :** `TRUST_PROXY=1` signifiait « tous les sauts » ; il signifie désormais « un seul proxy ». Paramètres, Instance affiche la valeur retenue.

### Corrigé
- Les images publiées affichent leur commit (argument de construction `GIT_COMMIT` transmis par la CI).

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
