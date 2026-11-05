# Importer des pages

BeNote importe deux formats :

- **Notion** : archive ZIP exportée depuis Notion au format « Markdown & CSV ». Toute personne qui peut modifier un espace peut y importer.
- **Markdown** (export Wiki.js, dossier de notes) : réservé aux administrateurs, route `POST /api/v3/admin/import/markdown`.

Confluence n'est pas pris en charge : aucun export réel n'a servi à le tester.

## Notion

### Exporter depuis Notion

Menu de la page (ou de l'espace de travail), « Exporter », format **Markdown & CSV**, avec les sous-pages. Le format HTML n'est pas pris en charge : ses fichiers sont écartés et signalés dans le rapport.

### Simuler, puis importer

L'import se fait toujours en deux temps :

1. **Simulation** (`dryRun=true`) : l'archive est lue et convertie exactement comme pour un import, puis tout est annulé. Rien n'est créé ; seul le rapport est enregistré.
2. **Import** (`dryRun=false`) : même traitement, enregistré. L'import est tout ou rien : une erreur sur l'archive n'en laisse aucune trace.

Le rapport liste chaque fichier de l'archive : importé (page, base, tableau, dossier, pièce jointe) ou écarté avec son motif. Il se relit ensuite, par son auteur seulement, tant que celui-ci peut lire l'espace. Les 20 derniers rapports de chaque personne sont gardés.

### Ce qui est repris

| Notion | BeNote |
|---|---|
| Page `Titre <identifiant>.md` | Page « Titre » (identifiant retiré ; le titre exact est celui du `# Titre` de tête) |
| Dossier `Titre/` à côté d'une page | Sous-pages de cette page |
| Dossier sans page correspondante | Page intermédiaire au nom du dossier |
| Lien vers une autre page de l'export (relatif, ou `notion.so/…<identifiant>`) | Lien vers la page importée |
| Lien vers une page absente de l'archive | Texte du lien, signalé dans le rapport |
| Citation qui commence par un émoji (callout de Notion) | Encadré : avertissement (panneau, point d'exclamation, gyrophare, flamme), succès (coche, rond vert), danger (croix, sens interdit, rond rouge), information sinon |
| Tableaux, listes, cases à cocher, code, `---` | Équivalents BeNote |
| HTML dans le Markdown | Texte et structure seulement (conversion de `lib/html-import.ts`), jamais conservé tel quel |
| `![](Titre/image.png)` | Image, enregistrée comme pièce jointe de la page |
| `[fichier.pdf](Titre/fichier.pdf)` | Pièce jointe de la page (bloc fichier ; pas d'extraction de texte) |
| Base `Titre <id>.csv` et `Titre <id>_all.csv` | Base BeNote (voir ci-dessous) |

Les fichiers joints suivent les règles des pièces jointes : type reconnu sur les octets (un SVG ou un HTML n'est jamais affiché, il est proposé au téléchargement), nom assaini, plafonds `ATTACHMENT_MAX_MB`, `ATTACHMENTS_TOTAL_MB` et `ATTACHMENT_USER_MB`. Un fichier trop lourd ou hors quota est écarté et signalé, sans annuler l'import des pages. Un fichier que rien ne cite est écarté.

### Bases

Notion exporte deux CSV par base ; seul `_all.csv` (toutes les colonnes) est importé, l'autre est signalé comme doublon. Une base « simple » devient une base BeNote :

- toutes les colonnes sont en **texte** (Notion n'exporte pas leur type : à changer ensuite si besoin) ;
- la première colonne garde son nom et sert de titre de ligne ;
- les pages des lignes deviennent des sous-pages de la base ; une colonne « Page » relie chaque ligne à sa page (même titre). Les propriétés en tête de ces pages sont gardées une par ligne.

Une base est dite simple si elle tient dans les plafonds des bases BeNote : au plus 49 colonnes, 5 000 lignes, 2 000 caractères par cellule. Sinon, elle devient une page contenant un tableau (500 lignes au plus, le reste est signalé).

### Défenses

L'archive est un fichier non fiable. Elle reste en mémoire pendant l'import et n'est jamais décompressée sur le disque ; aucun contenu n'est exécuté.

| Contrôle | Effet | Réglage |
|---|---|---|
| Taille de l'archive envoyée | refus 413 | `IMPORT_ZIP_MAX_MB` (200) |
| Volume décompressé total annoncé, archives imbriquées comprises | archive refusée | `IMPORT_ZIP_UNCOMPRESSED_MB` (1024) |
| Nombre de fichiers, archives imbriquées comprises | archive refusée | `IMPORT_ZIP_MAX_ENTRIES` (10000) |
| Taux de compression d'un fichier de plus de 1 Mio (bombe ZIP) | archive refusée avant toute décompression | `IMPORT_ZIP_MAX_RATIO` (100) |
| Fichier plus gros que la taille annoncée | décompression arrêtée à la taille annoncée, archive refusée | |
| Somme de contrôle CRC-32 fausse, structure incohérente, ZIP64, archive multi-volumes | archive refusée | |
| Chemin absolu, `..`, segment vide, caractère de contrôle ou d'inversion de sens, nom réservé Windows (`CON`, `NUL`…) | fichier écarté | |
| Lien symbolique, fichier chiffré, compression inconnue, doublon | fichier écarté | |
| Archive dans l'archive (`…-Part-1.zip` d'un gros export Notion) | ouverte sur un seul niveau, à la racine, mêmes plafonds | |
| Page Markdown de plus de 4 Mo, plus de 2 000 pages | fichier écarté | |

Les noms de fichiers sont décodés en UTF-8 même quand l'en-tête ZIP ne le déclare pas (Latin-1 à défaut).

Derrière Nginx, réglez `client_max_body_size` au moins à `IMPORT_ZIP_MAX_MB`.

### Limites connues

- Testé sur deux vrais exports Notion « Markdown & CSV » (pages, sous-pages, trois bases, une image et un PDF). Les archives découpées en plusieurs parties, les vidéos et sons joints, et les liens entre parties n'ont été testés que sur des archives fabriquées.
- L'import est synchrone : une très grosse archive occupe le serveur pendant son traitement.
- Mentions de personnes, commentaires, historique et permissions de Notion ne sont pas exportés par Notion et ne sont donc pas repris.

### API

`POST /api/v3/spaces/:id/import/notion?dryRun=true|false[&parentId=<page>]`, corps : l'archive brute, `Content-Type: application/zip`. Session (avec l'en-tête CSRF) ou jeton de portée `write`. Droit d'édition sur l'espace ; `parentId`, s'il est donné, est une page modifiable de cet espace. 20 requêtes par heure.

Réponse (200 en simulation, 201 à l'import) :

```json
{
  "id": "…", "source": "notion", "spaceId": "…", "parentId": null, "dryRun": true, "createdAt": 0,
  "summary": { "pages": 0, "bases": 0, "tables": 0, "folders": 0, "attachments": 0, "skipped": 0, "links": { "resolved": 0, "unresolved": 0 } },
  "items": [{ "path": "Titre 0123….md", "status": "imported", "kind": "page", "title": "Titre", "pageId": "…", "notes": ["…"] },
            { "path": "x.html", "status": "skipped", "kind": "page", "reason": "…" }]
}
```

`pageId` n'est présent qu'après un import réel. Erreurs : 400 (archive invalide, paramètre manquant), 403, 404, 413 (archive trop grosse ou piégée), 415 (pas `application/zip`), 422 (aucune page Notion), 429.

`GET /api/v3/imports` : mes derniers rapports (sans `items`). `GET /api/v3/imports/:id` : un rapport complet ; 404 s'il n'est pas le mien ou si je ne lis plus l'espace.

## Documents Word et PDF

Menu de l'espace, « Importer un document (Word, PDF) » : un fichier `.docx` ou `.pdf` devient une page, dont le titre est le nom du fichier. Même parcours que Notion : simulation (rien n'est créé), puis import ; le rapport est conservé dans l'historique.

| Format | Repris | Non repris |
|---|---|---|
| Word (`.docx`) | titres, paragraphes, gras et italique, listes, tableaux, liens `http(s)` et `mailto`, images (jointes à la page) | zones de texte, formes, notes de bas de page complexes, commentaires, modifications suivies, macros ; les anciens `.doc` ne sont pas pris en charge |
| PDF | le texte, regroupé en paragraphes | mise en page, images, tableaux ; un PDF numérisé (images) n'a pas de texte : la reconnaissance de caractères n'est pas prise en charge ; un PDF protégé par mot de passe est refusé |

### Défenses

- Le type est reconnu sur les octets (`%PDF-`, archive ZIP), jamais sur le nom ni le type annoncé.
- Un `.docx` est une archive ZIP : elle est contrôlée avant toute conversion avec les mêmes défenses que l'import Notion (taux de compression, volume décompressé, nombre d'entrées, chemins, taille réelle et somme de contrôle de chaque entrée, `word/document.xml` obligatoire).
- La conversion tourne dans un fil d'exécution isolé (`worker_thread`) : mémoire plafonnée à 512 Mo, aucune variable d'environnement, délai maximal (`DOC_IMPORT_TIMEOUT_SECONDS`), arrêt forcé au-delà. Il n'a accès ni à la base ni aux fichiers de l'instance.
- Le texte converti est protégé (caractères Markdown échappés) : un PDF contenant `# titre`, `<script>` ou `[x](javascript:…)` reste du texte. Seuls les liens `http(s)` et `mailto` sont gardés ; le résultat passe ensuite par l'assainissement habituel des pages.
- Les images passent par le même chemin que les pièces jointes : type reconnu sur les octets, quotas de l'instance et de la personne, images non affichables (WMF, EMF) jointes comme fichiers.
- Un seul import à la fois sur l'instance (verrou commun avec l'import Notion).

| Réglage | Défaut | Rôle |
|---|---|---|
| `DOC_IMPORT_MAX_MB` | 30 | taille maximale du fichier |
| `DOC_IMPORT_TIMEOUT_SECONDS` | 30 | durée maximale de la conversion |
| `DOC_IMPORT_MAX_PAGES` | 500 | pages d'un PDF lues au plus |

Derrière Nginx, réglez `client_max_body_size` au moins à `DOC_IMPORT_MAX_MB`.

### API

`POST /api/v3/spaces/:id/import/document?dryRun=true|false&filename=<nom>[&parentId=<page>]`, corps : le fichier brut, `Content-Type: application/pdf` ou `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Mêmes droits, même forme de réponse (`source` vaut `docx` ou `pdf`) et mêmes erreurs que l'import Notion ; 422 pour un document illisible, protégé ou trop long à convertir.
