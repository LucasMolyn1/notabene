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

### Autorisation
- Rôle global (admin / éditeur / lecteur) croisé avec les **portées** du jeton d’API.
- Une page inaccessible renvoie **404** (et non 403) pour ne pas révéler son existence.
- Les jetons d’API ne peuvent être créés que depuis une session navigateur, jamais avec un autre jeton, et uniquement avec des portées autorisées par le rôle.
- Suppression définitive, gestion des espaces et des réglages : administrateurs uniquement.

### Protection des requêtes
- **CSRF** : en-tête `X-CSRF-Token` lié à la session, comparé en temps constant, et contrôle de l’en-tête `Origin` sur toute écriture authentifiée par cookie.
- **Limitation de débit** globale, renforcée sur l’authentification et l’IA.
- **Validation Zod** de toutes les entrées, taille des requêtes bornée.

### Contenu
- Documents validés par **liste blanche** de nœuds, marques et attributs. Seuls les liens `http(s)`, `mailto`, relatifs et ancres sont acceptés, et les images doivent être en `data:image/*` ou `https`.
- Diagrammes Excalidraw et Draw.io stockés en SVG et affichés via `<img>`, ce qui empêche l’exécution de script. Mermaid est rendu en `securityLevel: strict`.
- Recherche FTS : la saisie est transformée en termes entre guillemets, sans injection de syntaxe FTS. Toutes les requêtes SQL sont préparées.
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
- **Journal d’audit** : connexions, refus, jetons, réglages, suppressions définitives.
- CI : typecheck, tests de sécurité, `npm audit` et build Docker ; Dependabot hebdomadaire.

## Limites connues
- Instance unique : la présence et le bus d’événements sont en mémoire. Un déploiement multi-réplicas nécessiterait Redis ou un équivalent.
- Excalidraw tente aussi de charger ses polices depuis un CDN de secours : la CSP bloque ces requêtes (messages dans la console, sans impact).
- Les avis de faible gravité sur `katex`, dépendance de l’outil Mermaid→Excalidraw, ne concernent que le bundle front.
- Sauvegardes : copiez le volume `/data` (base SQLite) **et** conservez `ENCRYPTION_KEY`.
