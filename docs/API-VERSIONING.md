# Versionnement de l'API

L'API REST est servie sous `/api/v3`. Les versions et leur état sont publiés sur `GET /api/versions`.

## Règles

- **La version courante est figée** : seuls des ajouts compatibles (nouveaux champs, nouvelles routes) y sont faits. Aucun champ n'est supprimé ni renommé.
- Une rupture de compatibilité crée une nouvelle version majeure (`/api/v4`…) montée à côté de la précédente.
- Quand une version est remplacée, elle passe en `deprecated` : les réponses portent les en-têtes `Deprecation` et `Sunset`, avec un préavis d'au moins 6 mois.
- Les jetons d'API, les portées et le contrôle d'accès sont communs à toutes les versions : une version ne peut pas élargir les droits d'un jeton.
- Le point d'accès MCP (`/mcp`) et l'authentification (`/auth/*`) ne sont pas versionnés par préfixe.

## Versions

| Version | État | Contenu |
| --- | --- | --- |
| v1 | **retirée** | Première version (listes non paginées, `baseVersion`). |
| v2 | **retirée** | Pagination par curseur, `ETag`/`If-Match`, erreurs RFC 9457. Reprise par la v3. |
| v3 | stable (seule servie) | Tout v2, plus commentaires de page, permissions fines par page et notifications. |

v1 et v2 répondent 404. GraphQL (envisagé pour la v3) n'est pas fourni. Le client web et le serveur MCP utilisent la v3.

### Ce que la v3 a changé par rapport à l'ancienne v1

- `GET /pages` et `GET /search` renvoient `{ "items": [...], "nextCursor": "..." | null }`. Paramètres : `limit` (1 à 200, défaut 50), `cursor` (opaque, à renvoyer tel quel). Filtres de `/pages` : `spaceId`, `parentId` (identifiant ou `root`), `q` (titre), `updatedAfter` (millisecondes). La recherche est limitée à 500 résultats. Un curseur invalide donne 400.
- `GET /pages/:id` renvoie l'en-tête `ETag` (la version de la page, entre guillemets).
- `PATCH /pages/:id` : `If-Match` est **obligatoire pour modifier le contenu** (sinon 428) ; s'il est périmé, 412. Le titre et l'icône se modifient sans `If-Match`. Le champ `baseVersion` n'existe plus.
- Erreurs au format `application/problem+json` (RFC 9457) : `type`, `title`, `status`, `detail`, `instance`, plus `code` et `errors` (validation) ou des extensions (par exemple `version` pour un conflit). v1 garde son format `{ error, message }`.
- Nouveaux évènements de webhook : `page.permissions`, `comment.created`, `comment.updated`, `comment.deleted`.

### Ajouts de v3

- Commentaires : `GET|POST /api/v3/pages/:id/comments`, `PATCH|DELETE /api/v3/pages/:id/comments/:cid`. Fils à un niveau (réponse à un commentaire de premier niveau), résolution d'un fil, suppression logique. Écrire demande la portée `write` ; seul l'auteur modifie son texte ; l'auteur ou un administrateur supprime. Le texte est brut : le client doit l'échapper à l'affichage.
- Permissions par page : `GET /api/v3/pages/:id/permissions` et `PUT` (administrateur). Dès qu'une page a des entrées `{ userId, level: read|write }`, elle et ses sous-pages sont réservées à ces utilisateurs (la page restreinte la plus proche gouverne) ; les administrateurs voient tout. Une page restreinte est introuvable (404) pour les autres, y compris en liste, recherche, export, recherche IA et flux d'évènements, **dans toutes les versions** : la restriction vit dans le contrôle d'accès commun. Le niveau ne fait que restreindre : un lecteur n'écrit jamais, un niveau `read` empêche d'écrire malgré un rôle éditeur.
- Notifications : `GET /api/v3/notifications` (curseur, `unread=true`), `GET /notifications/unread-count`, `POST /notifications/read` (`ids` ou `all`), `GET|PUT /notifications/preferences`, `GET|PUT|DELETE /pages/:id/watch`. On suit une page en la créant, en la commentant ou à la main. Notifié : les suiveurs (hors auteur) d'un commentaire ou d'une modification, et l'auteur d'un commentaire auquel on répond. Les modifications se regroupent en une notification non lue par page ; l'e-mail (si SMTP et si la personne l'accepte) ne contient que le titre, l'auteur et un lien, et au plus un par heure et par page pour les modifications. L'accès à la page est revérifié à l'envoi et à la lecture : une page devenue restreinte ne notifie plus et disparaît de la boîte de réception. Temps réel : évènement SSE `notification` envoyé à son seul destinataire.
- Le client web propose la cloche, le suivi de page, les préférences, un panneau de commentaires par page et, pour les administrateurs, un écran de permissions par page. La co-édition en cours est coupée puis revérifiée au changement de permissions.

## Ajouter une version

1. Créer le dossier de routes de la version et l'enregistrer dans `server/src/app.ts` avec `prefix: '/api/vN'`.
2. Passer l'état de la version à `stable` dans `API_VERSIONS` (`server/src/routes/versions.ts`) et celui de la précédente à `deprecated` avec sa date `sunset`.
3. Réutiliser les fonctions de `server/src/lib/` : la logique métier et le contrôle d'accès ne sont jamais dupliqués par version.
4. Documenter les changements dans ce fichier et dans l'OpenAPI.
