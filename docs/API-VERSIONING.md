# Versionnement de l'API

L'API REST est servie sous `/api/v1`. Les versions disponibles et leur état sont publiés sur `GET /api/versions`.

## Règles

- **v1 est figée** : seuls des ajouts compatibles (nouveaux champs, nouvelles routes) y sont faits. Aucun champ n'est supprimé ni renommé.
- Une rupture de compatibilité crée une nouvelle version majeure (`/api/v2`, `/api/v3`) montée à côté de la précédente.
- Quand une version est remplacée, elle passe en `deprecated` : les réponses portent les en-têtes `Deprecation` et `Sunset`, avec un préavis d'au moins 6 mois.
- Les jetons d'API, les portées et le contrôle d'accès sont communs à toutes les versions : une version ne peut pas élargir les droits d'un jeton.
- Le point d'accès MCP (`/mcp`) et l'authentification (`/auth/*`) ne sont pas versionnés par préfixe.

## Feuille de route

| Version | État | Contenu prévu |
| --- | --- | --- |
| v1 | stable | Pages, espaces, recherche, jetons, IA, administration, webhooks |
| v2 | prévue | Pagination par curseur, filtres de liste, `ETag` / `If-Match` sur les pages, évènements webhooks étendus, erreurs normalisées (RFC 9457) |
| v3 | prévue | Commentaires, permissions fines par page, GraphQL optionnel |

## Ajouter une version

1. Créer le dossier de routes de la version et l'enregistrer dans `server/src/app.ts` avec `prefix: '/api/vN'`.
2. Passer l'état de la version à `stable` dans `API_VERSIONS` (`server/src/routes/versions.ts`) et celui de la précédente à `deprecated` avec sa date `sunset`.
3. Réutiliser les fonctions de `server/src/lib/` : la logique métier et le contrôle d'accès ne sont jamais dupliqués par version.
4. Documenter les changements dans ce fichier et dans l'OpenAPI.
