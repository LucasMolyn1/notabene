# Sécurité

## Signaler une vulnérabilité

Merci de ne pas ouvrir d’issue publique : utilisez les *GitHub Security Advisories* du dépôt (onglet **Security → Report a vulnerability**).

## Mesures en place

### Authentification et sessions
- OIDC **Authorization Code + PKCE (S256)**, `state` et `nonce` aléatoires, stockés côté serveur, **à usage unique** et expirant en 10 minutes.
- Aucun jeton OIDC n’est exposé au navigateur : seule une session opaque est posée en cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- Seul le **hash SHA-256** de l’identifiant de session est stocké. La durée de vie est absolue (12 h par défaut), et une nouvelle session est créée à chaque connexion, ce qui empêche la fixation de session.
- Redirections après connexion limitées aux chemins locaux, sans redirection ouverte.
- Accès refusé par défaut aux utilisateurs hors des groupes autorisés (`OIDC_DEFAULT_ROLE=none`).
- Une tentative de connexion SSO est **liée au navigateur** qui la lance (cookie court `__Host-nb_login`, dont seule l'empreinte est stockée) : un lien de retour transmis à une autre personne est refusé. SAML exige HTTPS pour cette liaison (cookie `SameSite=None; Secure`, car le retour est un POST du fournisseur d'identité).
- La MFA obligatoire est appliquée d'après la **route réellement appariée**, pas d'après le texte de l'URL (`/%61pi/…` ne la contourne pas), et couvre aussi la co-édition.
- Une connexion de **co-édition** ouverte est revérifiée toutes les 30 secondes (session, compte actif, rôle, permissions de la page) et coupée aussitôt à la déconnexion, à la désactivation du compte, à un changement de permissions ou au déplacement de la page.

### Autorisation
- Rôle global (admin / éditeur / lecteur) croisé avec les **portées** du jeton d’API.
- Une page inaccessible renvoie **404** (et non 403) pour ne pas révéler son existence.
- Les jetons d’API ne peuvent être créés que depuis une session navigateur, jamais avec un autre jeton, et uniquement avec des portées autorisées par le rôle.
- Suppression définitive, gestion des espaces et des réglages : administrateurs uniquement.
- Une **permission fine en lecture seule** n'autorise aucune écriture, commentaires compris.
- Déplacer une sous-page hors d'une zone restreinte est **réservé aux administrateurs** ; dupliquer une page restreinte conserve ses permissions ; une sous-page ne remonte pas à la racine à la restauration si son parent restreint est encore à la corbeille.

### Protection des requêtes
- **CSRF** : en-tête `X-CSRF-Token` lié à la session, comparé en temps constant, et contrôle de l’en-tête `Origin` sur toute écriture authentifiée par cookie.
- **Adresse du client** : `TRUST_PROXY` se règle en nombre de proxys de confiance (ou liste de proxys) ; l'adresse est lue à droite de `X-Forwarded-For`, donc une valeur ajoutée par le client est ignorée. `TRUST_PROXY=true` (tous les sauts) est déconseillé et signalé au démarrage.
- **Limitation de débit** globale, renforcée sur l’authentification et l’IA.
- **Validation Zod** de toutes les entrées, taille des requêtes bornée.
- Les secrets des fournisseurs (LDAP, SMTP, OIDC, clé d'IA) ne suivent **jamais** un changement d'adresse sans être ressaisis ; désactiver une section efface ses secrets ; la clé d'IA exige la ressaisie du mot de passe. Pour les comptes locaux, une preuve d'identité réussie ouvre une fenêtre fixe de 10 minutes, propre à la session, pendant laquelle les réglages sensibles ordinaires ne la redemandent pas ; la suppression d'un compte et la clé d'IA l'exigent toujours.
- Les requêtes sortantes vers le fournisseur d'IA passent par la garde réseau (adresses internes refusées, adresse vérifiée à la connexion). Pour un LLM local (Ollama, LM Studio), `AI_ALLOW_PRIVATE=true` est une variable d'environnement, jamais modifiable depuis l'interface.

### Contenu
- Documents validés par **liste blanche** de nœuds, marques et attributs. Seuls les liens `http(s)`, `mailto`, relatifs et ancres sont acceptés, et les images doivent être en `data:image/*` ou `https`.
- Diagrammes Excalidraw et Draw.io stockés en SVG et affichés via `<img>`, ce qui empêche l’exécution de script. Mermaid est rendu en `securityLevel: strict`.
- Recherche FTS : la saisie est transformée en termes entre guillemets, sans injection de syntaxe FTS. Toutes les requêtes SQL sont préparées.
- **Photo de profil** : type vérifié sur les octets (PNG, JPEG, WebP ; jamais de SVG), 256 Ko, 32 à 1024 px (pas de bombe de décompression), stockée en base, servie avec `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` et `private, no-cache`, lisible des seules personnes connectées. Envoi depuis une session avec CSRF, limité à 20 par heure, journalisé.
- **Pages publiques rendues pour les moteurs de recherche** : uniquement ce qu'un visiteur anonyme peut déjà lire par l'API (espace public, page non restreinte, hors corbeille) ; HTML construit en liste blanche, tout échappé, liens externes `nofollow ugc`, aucune image `data:`. Le reste de l'application répond `X-Robots-Tag: noindex`. `SEO_INDEX=false` coupe l'indexation.
- Réponses de l’IA affichées après échappement HTML complet. Le prompt système demande au modèle de traiter le contenu des pages comme des données.

### En-têtes HTTP
- **CSP stricte** : `script-src 'self'` sans `unsafe-inline` ni CDN. Dépendances embarquées au build, polices servies localement.
- `frame-ancestors` limité à `EMBED_ALLOWED_ORIGINS`, HSTS en HTTPS, `nosniff`, `Referrer-Policy`, COOP/CORP.

### Secrets
- Clé d’API du LLM chiffrée en **AES-256-GCM**, liée à son usage par AAD, et jamais renvoyée au client (seuls ses 4 derniers caractères sont affichés).
- Jetons d’API stockés hachés et affichés une seule fois.
- Journaux expurgés : en-têtes `Authorization`, `Cookie` et CSRF.

### Exploitation
- Configuration **validée au démarrage** : refus de `DEV_LOGIN` en production, HTTPS exigé, clé de chiffrement de 32 octets obligatoire.
- Conteneur **non root**, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, ports liés à `127.0.0.1`.
- Image Draw.io épinglée, intégrations cloud désactivées.
- **Mise à jour depuis l'interface** : Notabene n'a aucun accès à Docker. Il dépose une demande dans un dossier d'échange ; un service sur l'hôte la traite comme non fiable (seule une version `x.y.z` est lue, comparée à la dernière release qu'il interroge lui-même), sauvegarde, change l'image par digest, vérifie, et revient en arrière sinon. Mot de passe ressaisi à chaque fois. **Vérification de nouvelle version** : désactivée par défaut, ne révèle à GitHub que l'adresse IP du serveur et le numéro de version (expliqué dans l'interface).
- **Journal d’audit** : connexions, refus, jetons, réglages, suppressions définitives.
- CI : typecheck, tests de sécurité, `npm audit` et build Docker ; Dependabot hebdomadaire.

### Dépôt et chaîne d’approvisionnement
- Branche `main` protégée par un *ruleset* :
  - modifications uniquement via pull request avec CI verte (`test`, `docker`, `dependency-review`, CodeQL) ;
  - historique linéaire, conversations résolues avant fusion ;
  - ni force-push ni suppression.
- Tags de version `v*` protégés : création réservée aux administrateurs, ni modification ni suppression (ils déclenchent la publication de l’image).
- Actions GitHub épinglées par **SHA de commit**, limitées aux éditeurs GitHub et vérifiés ; jeton `GITHUB_TOKEN` en lecture seule par défaut, permissions élevées limitées au job de publication.
- Analyse de code **CodeQL**, *secret scanning* avec *push protection*, alertes et correctifs **Dependabot** (avec délai de carence avant d’adopter une nouvelle version), revue des dépendances sur chaque PR.
- **Dépendances corrigées par `overrides`** (`package.json`) : `katex` 0.18.10 (GHSA-238p-pmpm-9mq7, prototype pollution ; dépendance indirecte de Mermaid, donc d'Excalidraw), `lodash-es` et `nanoid`. Ce ne sont pas des dépendances directes : ne les retirez pas sans vérifier que `npm ls katex` ne montre plus aucune version vulnérable.
- **ESLint** (sécurité : regex quadratiques, `eval`, `innerHTML`) et **couverture de tests avec seuils** dans la CI ; images Docker épinglées par digest (Notabene, Draw.io).
- Images publiées avec **SBOM** et **attestation de provenance SLSA**, vérifiable avec :
  `gh attestation verify oci://ghcr.io/lucasmolyn1/notabene:<version> --owner LucasMolyn1`

## Limites connues
- Application installable (manifeste) sans service worker : rien n'est mis en cache hors ligne, donc aucune page privée ne reste sur l'appareil.
- Les pages publiques indexables sont lisibles de tous : l'indexation ne change pas qui peut les lire, seulement qui les trouve.
- Instance unique : la présence et le bus d’événements sont en mémoire. Un déploiement multi-réplicas nécessiterait Redis ou un équivalent.
- Excalidraw tente aussi de charger ses polices depuis un CDN de secours : la CSP bloque ces requêtes (messages dans la console, sans impact).
- Les avis de faible gravité sur `katex`, dépendance de l’outil Mermaid→Excalidraw, ne concernent que le bundle front.
- Sauvegardes : copiez le volume `/data` (base SQLite) **et** conservez `ENCRYPTION_KEY`.
