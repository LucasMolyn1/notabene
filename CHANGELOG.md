# Journal des changements

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Numérotation : [versionnage sémantique](https://semver.org/lang/fr/) (MAJOR.MINOR.PATCH).

La version de référence est le champ `version` de `package.json` ; le premier titre de ce fichier doit toujours lui correspondre (un test le vérifie). Procédure de release : voir le README, « Versions et releases ».

## Non publié

### Ajouté
- **Groupes et droits par espace** : groupes locaux (Paramètres, Groupes), membres d'un espace (personnes ou groupes) avec les rôles lecture, édition et gestion, permissions de page visant un groupe. Le rôle global reste un plafond, le droit le plus élevé entre plusieurs chemins l'emporte, et la permission de page ne fait que restreindre. Un gestionnaire d'espace gère les membres et le nom de son espace. Nouvelles routes `/api/v3/groups`, `/spaces/:id/members`, `/spaces/:id/member-candidates`.
- **Synchronisation des groupes OIDC, LDAP et SAML** : un groupe local peut être lié à un groupe du fournisseur d'identité ; son adhésion est recopiée à chaque connexion.
- Un nouvel espace n'est ouvert qu'aux administrateurs (option « Tout le monde, en édition » à la création). Le groupe système « Tout le monde » est un groupe de tous les comptes.
- L'export des données personnelles inclut les groupes et les rôles d'espace.

- **Espaces personnels** : un espace par compte, créé à la demande (menu des espaces), lisible de son seul propriétaire, administrateurs compris. Réglage d'instance dans Paramètres, Espaces (désactivé par défaut). Les espaces dont le compte a été supprimé se reprennent ou se suppriment depuis le même écran. Migration v15.

- **Partage public par lien** : une page (et ses sous-pages, au choix) se publie par un lien lisible sans compte, retirable à tout moment (bouton Partager, Paramètres, Pages partagées). Désactivé par défaut ; réglage d'instance et réglage par espace (désactiver retire les liens). Les pages à permissions restreintes demandent une confirmation. Contenu assaini (ni noms, ni titres de pages non partagées), sans cache ni référent, `noindex` par défaut. Migration v16.

### Attention à la mise à jour
- Migration v14 : le groupe « Tout le monde » reçoit le droit d'édition sur chaque espace existant, donc aucun accès ne change. Pour fermer un espace, retirez ce groupe de ses membres (Paramètres, Espaces, Membres).

### Corrigé
- Un titre de page privée ou restreinte ne s'affiche plus dans le rendu HTML d'une page publique qui y renvoie (pages publiques indexables).
- Supprimer un groupe ou effacer un compte ne rend plus lisible de tout l'espace une page qui n'était réservée qu'à lui.
- La présence (qui consulte quelle page) ne liste plus les pages que l'on ne peut pas lire.
- Renommer un espace (PATCH avec le seul nom) ne remet plus sa visibilité à « privé », ni son icône et sa description à leur valeur par défaut.
- La recherche de personnes pour les mentions trouve les noms commençant par une majuscule accentuée (« Élodie »).

## [3.8.0] - 2026-10-31

### Ajouté
- **Assistant de rédaction dans l'éditeur** : sur un texte sélectionné, améliorer, raccourcir, corriger, traduire (sept langues) ou suivre une consigne libre. La réponse s'affiche en flux dans un aperçu ; la page n'est modifiée qu'après « Remplacer » ou « Insérer après » (texte simple, jamais du HTML, et seulement si la sélection n'a pas changé). Réservé aux personnes qui ont la portée IA et le droit de modifier la page ; seul le texte sélectionné part, et l'interface indique le destinataire avant l'envoi. Nouvelle route `POST /api/v3/ai/assist` (20 appels par minute et par compte), action `ai.assist` au journal d'audit (longueur et fournisseur, jamais le texte).
- Écran tactile : un bouton « Aa » dans la barre de l'éditeur ouvre les actions sur la sélection (couleur, fond, alignement, commentaire, assistant), qui n'existaient qu'avec la souris.
- `scripts/install-updater.sh` : installe en une commande le service de mise à jour de l'hôte (bouton « Mettre à jour »). Relançable, sans modifier `docker-compose.yml` ; `scripts/setup.sh` propose de l'installer.

### Corrigé
- Export Markdown : un bloc intégré, une image ou un schéma placé dans une cellule de tableau n'est plus perdu.
- Mentions en co-édition : quand plusieurs personnes ont écrit entre deux enregistrements, la notification n'est plus attribuée à la dernière qui a écrit (« quelqu'un » à la place).
- Coller du HTML venu d'un autre site n'y insère plus de mention (la copie d'une page Notabene la garde).
- Service de mise à jour : le premier passage n'affiche plus l'erreur « No such file or directory » sur le fichier d'état.

## [3.7.0] - 2026-10-31

### Modifié
- Dépendance de développement ajoutée : `katex` 0.18.10 (MIT), déjà présente via Mermaid et désormais déclarée.

### Documentation
- README : tableau des fonctionnalités complété (photo de profil, adresses et référencement, téléphone, mises à jour), index des guides, architecture à jour ; guide de déploiement : second nom d'hôte pour Draw.io ; sécurité et RGPD : photo de profil, pages publiques rendues pour les moteurs, service de mise à jour ; guide de mise à jour : « Vérifier maintenant ».

### Corrigé
- Export Markdown : les parenthèses, espaces et chevrons d'une adresse de lien, d'image ou de contenu intégré sont encodés, pour qu'une adresse ne puisse pas refermer le lien et en ouvrir un autre.
- Accessibilité : le nom accessible de la cloche contient maintenant le nombre de notifications non lues affiché (« Notifications, 2 non lues »), et le texte secondaire de l'élément actif de l'historique est lisible en thème sombre.

### Ajouté
- **Contenus intégrés (iframe), désactivés par défaut** : un administrateur autorise des hôtes précis (Paramètres, Contenus intégrés, ou `CONTENT_EMBED_HOSTS`) ; les éditeurs peuvent alors intégrer une adresse https de ces hôtes (menu `/`, « Intégrer une adresse »). La liste alimente la directive CSP `frame-src` sans redémarrage : le navigateur refuse tout autre hôte. Le contenu s'affiche dans une iframe en bac à sable, après un clic du lecteur (le site tiers voit son adresse IP). Pas de joker, d'adresse IP, de port ni de chemin dans la liste, et les hôtes du même site que Notabene (lui-même, un sous-domaine, le domaine parent) sont refusés ; la liste est revalidée à chaque réponse, une valeur enregistrée en base n'entre jamais dans l'en-tête sans contrôle, et elle figure dans le journal d'audit. Un hôte retiré de la liste affiche le bloc comme un lien. Exports et pages publiques : un lien, jamais une iframe.
- **Historique : différences avec la version actuelle** : dans l'historique d'une page, « Différences avec la version actuelle » compare le texte par blocs puis par mots (rouge barré : présent dans la version choisie et absent aujourd'hui ; vert : ajouté depuis). Les pages de plus de 1 500 blocs ne sont pas comparées.
- **Rétroliens** : sous le titre d'une page, « N pages renvoient ici » liste les pages qui contiennent un lien vers elle (liens de pages). Ne comptent que les pages que la personne peut lire, hors corbeille.
- **Copier vers un autre espace** (menu d'une page dans la barre latérale) : copie la page et ses sous-pages, l'original reste en place. Seules les sous-pages que la personne peut lire sont copiées ; la copie reste aussi restreinte que la source, y compris quand la restriction venait d'une page parente ; les libellés sont copiés, les ancres de commentaires et les mentions déjà notifiées ne le sont pas de nouveau ; 500 pages au plus. API v3 : `POST /pages/:id/copy` et `GET /pages/:id/backlinks`.
- **Nouveaux blocs d'éditeur** (menu `/` et barre flottante) : **bloc dépliable** (titre et contenu, replié au chargement, l'état ouvert ou fermé n'est pas enregistré dans la page), **colonnes** (2 ou 3 depuis le menu, jusqu'à 4, empilées sur téléphone), **formule** mathématique LaTeX rendue par KaTeX dans le navigateur (seul le texte de la formule est enregistré ; les commandes de lien, d'image ou de HTML sont désactivées), **couleur du texte**, **fond coloré** et **alignement** (barre flottante, bouton « A »). Les couleurs viennent d'une palette fixe de 8 noms : le contenu ne porte jamais de valeur de style, et le serveur refuse tout autre nom. Le serveur vérifie aussi la structure des blocs dépliables et des colonnes (un contenu mal formé rendrait l'éditeur muet). Exports Markdown et HTML, recherche et pages publiques les prennent en compte.
- Les boutons de la barre flottante ont un nom accessible complet (« Gras », « Italique »… au lieu de leur seule lettre).
- **Commentaires sur un texte** : sélectionnez un passage, « Commenter la sélection » ; le passage est surligné (jaune tant que le fil est ouvert, gris une fois résolu), un clic sur le surlignage rouvre le fil et « Voir dans la page » y ramène. Si le texte commenté est supprimé, le fil le signale et garde la citation d'origine. Marque `commentAnchor` dans le contenu (elle suit la co-édition) ; le texte cité est enregistré avec le commentaire (200 caractères au plus) et effacé avec lui.
- **Mentions `@personne`** dans les commentaires et dans les pages (`@` ouvre la liste, recherche sur le début du nom ou d'un de ses mots). Seules les personnes actives qui peuvent lire la page sont proposées et mentionnables ; les autres sont ignorées sans message, si bien qu'une mention ne révèle ni qui existe ni qui a accès à une page restreinte. La personne mentionnée reçoit une notification « vous a mentionné dans » (cloche, e-mail selon ses préférences), une seule par page pour une mention dans le contenu ; elle ne reçoit pas en plus la notification de commentaire. API v3 : `anchorText` et `mentions` sur `POST /pages/:id/comments`, `GET /pages/:id/mentionable`, `GET /pages/:id/mentioned`. Schéma v13 (la table des notifications est recréée pour le nouveau type). Une mention ne garde dans la page que l'identifiant de la personne : son nom vient du compte, jamais copié dans les pages, versions ou modèles (rien à effacer avec le compte, et rien de nominatif dans les pages publiques ni leur export pour un visiteur). Les mentions héritées d'une copie, d'un modèle ou d'une création par l'API ne notifient pas ; au plus un e-mail de mention par personne, par page et par heure ; modifier un commentaire ne change pas ses mentions.
- **Modèles de pages** : « Depuis un modèle » (barre latérale, accueil d'un espace, sous-page depuis le menu « … ») propose trois modèles fournis (compte rendu de réunion, procédure, post-mortem d'incident) et ceux de l'équipe ; « Enregistrer comme modèle » (menu « … » d'une page) copie le contenu actuel pour tout l'espace. Un modèle est stocké à part des pages (schéma v12) : il n'apparaît ni dans l'arborescence, ni dans la recherche, ni dans les pages publiques, ni dans le contexte de l'IA. Une page à permissions restreintes ne peut pas devenir un modèle (il serait lisible de tout l'espace), 50 modèles par espace au plus, seul l'auteur ou un administrateur renomme ou supprime un modèle. API v3 : `GET /templates`, `GET /templates/:id`, `POST /templates`, `PATCH` et `DELETE /templates/:id`.
- **Libellés de page** : pastilles sous le titre (ajout avec suggestions, retrait, jusqu'à 20 par page), page « toutes les pages portant ce libellé » (`/labels/<nom>`), filtre `#libellé` dans la recherche rapide (`#libellé mots` restreint la recherche). API v3 : `GET /labels`, `GET/POST /pages/:id/labels`, `DELETE /pages/:id/labels/:name`, paramètre `label` sur `GET /pages` et `GET /search` ; outils MCP `list_labels`, `add_label`, `remove_label`. Un libellé n'existe que par les pages qui le portent : liste, totaux et filtres ne comptent que les pages que la personne peut lire (jamais de fuite depuis une page à permissions restreintes). Noms en minuscules, 40 caractères au plus (lettres, chiffres, tirets, soulignés) ; la duplication d'une page copie ses libellés. Schéma v11.
- **Interface pour téléphone** : barre du haut réduite à l'essentiel (suivre, favoris, historique et permissions passent dans le menu « … »), cibles tactiles de 40 à 44 px, champs à 16 px (plus de zoom à la saisie sur iOS), rien qui dépende du survol, zones sûres, barre de mise en forme au-dessus du clavier virtuel (gras, italique, titres, listes, citation, code, annuler, « + » pour insérer un bloc), bande des sections des réglages centrée sur la section courante.
- **Installable comme une application** : manifeste et icônes (« Ajouter à l'écran d'accueil », « Installer » dans Chrome et Edge, « Ajouter au Dock » dans Safari). Pas de mode hors ligne.

## [3.6.1] - 2026-10-30

Adresses lisibles et pages publiques référençables, photo de profil, compose d'essai, bouton « Vérifier maintenant ».

### Modifié
- **Adresses lisibles** : `/p/titre-de-la-page-<identifiant>` et `/s/nom-de-l-espace-<identifiant>` à la place de `/#/p/<identifiant>`. Seul l'identifiant compte : renommer une page ne casse aucun lien (le titre périmé redirige, la barre d'adresse suit le titre). Les anciens liens `#/p/…` sont convertis à l'ouverture ; les liens des e-mails, de l'export Markdown et du serveur MCP utilisent la nouvelle forme. Le reverse proxy doit transmettre toutes les adresses à Notabene (docs/DEPLOIEMENT.md).
- Plafond général de requêtes réglable (`RATE_LIMIT_PER_MINUTE`, 600 par défaut) ; la lecture de l'état des mises à jour passe de 60 à 600 par heure (chaque chargement de page d'un administrateur l'appelle, la limite basse faisait disparaître l'alerte).

### Corrigé
- Paramètres, À propos : si l'état des mises à jour ne pouvait pas être lu, le mot « undefined » s'affichait à la place de la carte.

### Ajouté
- **Référencement des pages publiques** : pour les espaces publics, le serveur rend le contenu de chaque page en HTML (titre, description, adresse canonique, balises Open Graph) et publie `/sitemap.xml` et `/robots.txt`. Les pages privées ou à permissions restreintes ne sont jamais rendues ; le reste de l'application est en `noindex`. `SEO_INDEX=false` coupe tout.
- **Photo de profil** (Paramètres, Profil) : ajouter, recadrer (déplacement et zoom) et retirer sa photo ; elle remplace les initiales dans la barre latérale, la présence sur une page et la liste des utilisateurs. L'image est recadrée et réduite (256 px, WebP) dans le navigateur, qui en retire les métadonnées ; le serveur revérifie le type sur les octets (PNG, JPEG ou WebP, jamais de SVG), le poids (256 Ko) et les dimensions, et la sert sans pouvoir être interprétée comme une page. Visible des personnes connectées seulement ; un administrateur peut retirer la photo d'un compte ; elle disparaît avec le compte (schéma v10).
- **Compose d'essai** (`docker-compose.essai.yml`, [docs/ESSAI.md](docs/ESSAI.md)) : un fichier, aucune configuration, l'image publiée sur GHCR, comptes locaux, compte administrateur créé dans le navigateur avec le code d'installation des journaux. Sans Draw.io, connexion unique, IA ni e-mail, volontairement.
- **Bouton « Vérifier maintenant » (Paramètres, À propos)** : relance la vérification de version sans attendre les 12 h du cache, et indique l'heure de la dernière vérification. Au plus un appel à GitHub toutes les 30 secondes, réservé aux administrateurs.

## [3.6.0] - 2026-10-30

Mise à jour depuis l'interface, sans donner à Notabene l'accès à Docker.

### Ajouté
- **Bouton « Mettre à jour » (Paramètres, À propos)**, optionnel. Notabene dépose une demande dans un dossier d'échange (`UPDATER_DIR`) ; un service installé sur l'hôte ([docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md), `scripts/updater/`) la contrôle (version = dernière release interrogée par le service lui-même), sauvegarde la base, change l'image épinglée par digest, vérifie que la bonne version répond et revient à l'ancienne sinon. Mot de passe ressaisi à chaque fois, action journalisée. Sans le service, aucun bouton : la page explique comment l'installer. Le script est testé contre de fausses commandes (injection, liens symboliques, absence de sauvegarde, retour arrière).
## [3.5.1] - 2026-10-30

### Corrigé
- **Recherche IA : le modèle se choisit dans une vraie liste déroulante.** Le champ à suggestions n'affichait que les noms proches de la valeur déjà saisie, donc presque rien une fois la clé enregistrée. La liste montre tous les modèles du fournisseur ; « Autre modèle… » ouvre un champ libre pour un nom absent.

## [3.5.0] - 2026-10-30

La vérification de mise à jour s'active depuis l'interface.

### Ajouté
- **Activer la vérification de mise à jour dans Paramètres, À propos** (administrateur, mot de passe ressaisi, action journalisée), avec l'explication de ce qui part : GitHub voit l'adresse IP publique du serveur, l'heure et le numéro de version ; il ne reçoit ni page, ni utilisateur, ni nom d'instance. Ce n'est pas une mise à jour automatique : on prévient seulement. `UPDATE_CHECK` reste la valeur de départ ; `CONFIG_LOCKED=true` donne le dernier mot à l'environnement.

## [3.4.0] - 2026-10-30

Blocs de code colorés et éditables comme dans un éditeur de code, et vrai sélecteur d'emojis.

### Ajouté
- **Blocs de code CodeMirror 6** : coloration syntaxique (JavaScript, TypeScript, HTML, CSS, JSON, Markdown, YAML, XML, Python, SQL, shell, PowerShell, Dockerfile, Nginx, TOML, Diff), indentation automatique, fermeture des parenthèses et guillemets, numéros de ligne, choix du langage en haut du bloc. Les grammaires se chargent à la demande. La co-édition fonctionne dans les blocs (test à deux personnes, y compris en écriture simultanée) ; l'annulation est celle de la page. Au clavier : Échap ou les flèches aux bords quittent le bloc, Tab indente. Les curseurs des autres personnes ne sont pas affichés à l'intérieur d'un bloc de code.
- **Sélecteur d'emojis complet** pour les pages et les espaces : près de 1 900 emojis avec recherche en français (noms et mots-clés, sans accents), catégories, récents et navigation aux flèches. Les icônes de l'interface restent disponibles. L'emoji est affiché partout (arborescence, fil d'Ariane, recherche, liens de pages).
- Tests d'accessibilité axe du bloc de code (clair et sombre) et du sélecteur d'emojis.

### Modifié
- Dépendances de développement ajoutées : `@codemirror/*` et `@lezer/highlight` (MIT), `emojibase-data` (MIT, données seulement), `@tiptap/extension-code-block` (déjà présent via TipTap, à la même version).

## [3.3.0] - 2026-10-30

Les instances savent qu'une version existe et y mènent les administrateurs ; confirmation d'identité plus claire pour les comptes SSO.

### Attention à la mise à jour
- **Pour recevoir l'alerte de mise à jour, `UPDATE_CHECK=true` reste nécessaire** (désactivé par défaut : la vérification contacte api.github.com). Les versions 3.0.0 à 3.2.0 n'avaient pas de release GitHub : une instance qui les vérifiait ne pouvait rien détecter. À partir de la 3.3.0, chaque tag crée sa release.
- Une release GitHub n'est publiée automatiquement qu'avec ce workflow : pour la 3.2.0 déjà taguée, voir [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) (commande `gh release create`).

### Ajouté
- **Alerte de mise à jour** (administrateurs, avec `UPDATE_CHECK=true`) : « Version X disponible » dans la barre latérale et pastille sur Paramètres ; elle mène à Paramètres, À propos, qui affiche les nouveautés de la nouvelle version (notes lues dans sa release GitHub, « Attention à la mise à jour » en tête) et les commandes de mise à jour.
- **Release GitHub automatique** : le workflow de release la crée, avec les notes de la section du CHANGELOG, après la publication de l'image (`scripts/release-notes.sh`).
- **Guide de mise à jour** : [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) (être prévenu, sauvegarder, mettre à jour, vérifier, revenir en arrière, dépannage).
- **Comptes SSO** : les réglages sensibles affichent jusqu'à quand la session est confirmée, ou invitent à la confirmer ; le bouton « Confirmer auprès de mon fournisseur » renvoie à l'IdP en exigeant une réauthentification réelle (`prompt=login`, OIDC) puis ramène sur la page.
- **Audit d'accessibilité automatisé** (axe-core, WCAG 2.1 AA) dans la CI, en clair et en sombre, sur la connexion, les pages et toutes les sections des paramètres ; [docs/ACCESSIBILITE.md](docs/ACCESSIBILITE.md) décrit le test au lecteur d'écran à faire à la main.

### Modifié
- Code du client découpé sans changement de comportement : `settings.js` (828 lignes) en un routeur et six modules dans `client/src/settings/`, `editor.js` (625 lignes) en assemblage et quatre modules dans `client/src/editor/`. Le test d'accessibilité signale désormais une section des paramètres qui plante.

### Corrigé
- Contrastes (couleurs des avatars, chemin de la palette en thème sombre), noms manquants (éditeur, sélecteur de rôle, zones de code) et blocs de code défilables au clavier.

## [3.2.0] - 2026-10-30

Confort d'usage remonté par un premier déploiement : réauthentification moins répétitive, recherche par espace, blocs redimensionnables et import Wiki.js plus tolérant.

### Attention à la mise à jour
- **Base de données :** migration v9 (colonne `sessions.reauth_at`) appliquée au démarrage. Comme toujours, ne revenez pas à une image plus ancienne sans restaurer une sauvegarde.

### Ajouté
- **Fenêtre de réauthentification de 10 minutes** (comptes locaux) : après une saisie réussie du mot de passe, les réglages sensibles (fournisseurs d'identité, SMTP, intégrations) ne le redemandent plus pendant 10 minutes. La fenêtre est propre à la session, fixe (elle ne se prolonge pas à l'usage) et ne s'applique pas à la suppression d'un compte ni à la clé d'API de l'IA, qui exigent toujours le mot de passe.
- **Recherche par espace** : les résultats sont groupés par espace (repliables) avec un filtre « Tous les espaces » / un espace ; l'API accepte `spaceId` sur `GET /api/v3/search`.
- **Images et diagrammes redimensionnables** (Mermaid, PlantUML, Excalidraw, Draw.io) : poignée au pointeur ou au clavier (flèches, Début pour revenir à la taille d'origine), largeur conservée dans la page.
- **Rapport d'import** : fichiers écartés avec la raison, pages à vérifier (HTML converti, diagramme retrouvé, images non importées).

### Modifié
- Page de connexion : le fournisseur d'identité en premier, puis le mot de passe, séparés par « ou » ; l'écran d'activation obligatoire de la double authentification est mis en page.
- Import Markdown : limite portée à 4 Mo par fichier ; un fichier trop gros n'annule plus l'import des autres ; le HTML (page entière ou bloc) est converti en texte au lieu d'être ignoré.
- Les erreurs de syntaxe Mermaid affichent la ligne fautive et ce qui était attendu.

### Corrigé
- Import Wiki.js : un diagramme Mermaid dont la balise ``` a été perdue est retrouvé et reste un diagramme au lieu de devenir du texte.

## [3.1.1] - 2026-10-30

Correctif de la connexion OIDC (Authentik) et des sondes de répartiteur, remontés par un premier déploiement en production.

### Ajouté
- **Vérification de types du client** (`checkJs`, `npm run typecheck`) : les 45 erreurs initiales sont corrigées (types des options par JSDoc, déclarations des modules CSS et des commandes TipTap). Mode non strict ; le passer en strict demanderait environ 700 annotations, à faire progressivement.
- Mesure de la couverture de tests (`npm run coverage`) avec seuils dans la CI : 76 % des instructions, 80 % des lignes, 65 % des branches, 82 % des fonctions au départ ; les modules les moins couverts sont le client IA, la recherche IA (RAG), OIDC et les routes d'espaces et de webhooks.
- **ESLint** dans la CI (`npm run lint`) : erreurs courantes, expressions régulières quadratiques (ReDoS), évaluation dynamique, processus enfants et HTML injecté côté client (chaque `innerHTML` est justifié). Installé dans `tools/lint` avec TypeScript 6, car `typescript-eslint` ne supporte pas encore TypeScript 7 ; le projet reste en TypeScript 7.

### Modifié
- L'image Draw.io du `docker-compose.yml` est épinglée par digest (tag + sha256).

### Corrigé
- **OIDC : le « / » final de l'issuer est conservé** (Authentik le publie ainsi ; sa suppression faisait échouer la découverte, `/auth/login` répondait 500).
- `HEAD /` et `OPTIONS /` répondent sans erreur : les sondes HAProxy ne marquent plus le service hors service.
- Ouvert en HTTP (adresse IP), l'écran de chargement affiche un message au lieu de tourner indéfiniment.
- Expressions régulières réécrites sans quantificateur imbriqué (import Markdown, origines autorisées, routes des réglages).

### Documentation
- Authentik (mappings, issuer), `SEED_DEMO=false` par défaut, second nom d'hôte pour Draw.io, code d'installation, sondes de santé ; la double authentification obligatoire est un choix, pas un défaut.

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
