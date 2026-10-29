# Versionnement de l'API

L'API REST est servie sous `/api/v1`. Les versions disponibles et leur état sont publiés sur `GET /api/versions`.

## Règles

- **v1 est figée** : seuls des ajouts compatibles (nouveaux champs, nouvelles routes) y sont faits. Aucun champ n'est supprimé ni renommé.
- Une rupture de compatibilité crée une nouvelle version majeure (`/api/v2`, `/api/v3`) montée à côté de la précédente.
- Quand une version est remplacée, elle passe en `deprecated` : les réponses portent les en-têtes `Deprecation` et `Sunset`, avec un préavis d'au moins 6 mois.
- Les jetons d'API, les portées et le contrôle d'accès sont communs à toutes les versions : une version ne peut pas élargir les droits d'un jeton.
- Le point d'accès MCP (`/mcp`) et l'authentification (`/auth/*`) ne sont pas versionnés par préfixe.

## Versions

| Version | État | Contenu |
| --- | --- | --- |
| v1 | **dépréciée** (fin le 1er mai 2027) | Pages, espaces, recherche, jetons, IA, administration, webhooks. Toujours utilisée par le client web et le serveur MCP. Les réponses portent `Deprecation`, `Sunset` et `Link`. |
| v2 | stable | Tout v1, avec : listes paginées par curseur, filtres, `ETag` / `If-Match`, erreurs RFC 9457, évènements de webhooks étendus. |
| v3 | stable (version courante) | Tout v2, plus commentaires de page et permissions fines par page. |

GraphQL (envisagé pour la v3) n'est pas fourni.

### Changements de v2 (rupture avec v1)

- `GET /pages` et `GET /search` renvoient `{ "items": [...], "nextCursor": "..." | null }`. Paramètres : `limit` (1 à 200, défaut 50), `cursor` (opaque, à renvoyer tel quel). Filtres de `/pages` : `spaceId`, `parentId` (identifiant ou `root`), `q` (titre), `updatedAfter` (millisecondes). La recherche est limitée à 500 résultats. Un curseur invalide donne 400.
- `GET /pages/:id` renvoie l'en-tête `ETag` (la version de la page, entre guillemets).
- `PATCH /pages/:id` : `If-Match` est **obligatoire pour modifier le contenu** (sinon 428) ; s'il est périmé, 412. Le titre et l'icône se modifient sans `If-Match`. Le champ `baseVersion` n'existe plus.
- Erreurs au format `application/problem+json` (RFC 9457) : `type`, `title`, `status`, `detail`, `instance`, plus `code` et `errors` (validation) ou des extensions (par exemple `version` pour un conflit). v1 garde son format `{ error, message }`.
- Nouveaux évènements de webhook : `page.permissions`, `comment.created`, `comment.updated`, `comment.deleted`.

### Ajouts de v3

- Commentaires : `GET|POST /api/v3/pages/:id/comments`, `PATCH|DELETE /api/v3/pages/:id/comments/:cid`. Fils à un niveau (réponse à un commentaire de premier niveau), résolution d'un fil, suppression logique. Écrire demande la portée `write` ; seul l'auteur modifie son texte ; l'auteur ou un administrateur supprime. Le texte est brut : le client doit l'échapper à l'affichage.
- Permissions par page : `GET /api/v3/pages/:id/permissions` et `PUT` (administrateur). Dès qu'une page a des entrées `{ userId, level: read|write }`, elle et ses sous-pages sont réservées à ces utilisateurs (la page restreinte la plus proche gouverne) ; les administrateurs voient tout. Une page restreinte est introuvable (404) pour les autres, y compris en liste, recherche, export, recherche IA et flux d'évènements, **dans toutes les versions** : la restriction vit dans le contrôle d'accès commun. Le niveau ne fait que restreindre : un lecteur n'écrit jamais, un niveau `read` empêche d'écrire malgré un rôle éditeur.
- Limite connue : le client web ne propose pas encore d'écrans pour les commentaires ni les permissions ; la co-édition en cours est coupée et revérifiée au changement de permissions.

## Ajouter une version

1. Créer le dossier de routes de la version et l'enregistrer dans `server/src/app.ts` avec `prefix: '/api/vN'`.
2. Passer l'état de la version à `stable` dans `API_VERSIONS` (`server/src/routes/versions.ts`) et celui de la précédente à `deprecated` avec sa date `sunset`.
3. Réutiliser les fonctions de `server/src/lib/` : la logique métier et le contrôle d'accès ne sont jamais dupliqués par version.
4. Documenter les changements dans ce fichier et dans l'OpenAPI.
