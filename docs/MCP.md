# Serveur MCP

BeNote expose un serveur [MCP](https://modelcontextprotocol.io) (Model Context Protocol) pour qu'un assistant (Claude, ou tout client MCP) lise et modifie le wiki. Adresse : `POST /mcp` (JSON-RPC 2.0, HTTP sans état).

## Connexion

- **Authentification** : jeton d'API Bearer obligatoire (Paramètres, Jetons d'API). Une session de navigateur est refusée, comme toute origine étrangère (protection contre le DNS rebinding).
- **Droits** : chaque outil rappelle l'API v3 avec le jeton de l'appelant. Les portées du jeton (`read`, `write`), le rôle du compte, les droits d'espace et de page sont donc appliqués par le même code que le reste de l'application. Un jeton en lecture ne voit même pas les outils d'écriture.
- Il n'y a pas d'OAuth : le jeton se crée à la main et se révoque dans les paramètres.

## Outils

| Outil | Portée | Rôle |
|---|---|---|
| `list_spaces`, `list_pages`, `search_pages` | read | espaces, arborescence, recherche plein texte (y compris le texte des pièces jointes) |
| `get_page`, `get_page_info` | read | contenu en Markdown ; informations sans contenu (dont `version`) |
| `list_labels`, `add_label`, `remove_label` | read, write | libellés |
| `create_page` | write | crée une page (texte simple : `# Titre`, ligne vide entre paragraphes) |
| `update_page` | write | titre, icône, texte : ajouté à la fin (`append`, par défaut) ou remplacé (`replace`) |
| `move_page` | write | sous une autre page, à la racine ou vers un autre espace (changer d'espace change qui peut lire la page : annoncé comme destructif) |
| `trash_page`, `restore_page` | write | corbeille et restauration |
| `list_comments` | read | fils de discussion, filtrables par état |
| `add_comment`, `resolve_comment` | write | commenter ou répondre, résoudre ou rouvrir un fil |

Les outils qui peuvent écraser, supprimer ou changer qui lit une page (`update_page`, `move_page`, `trash_page`) sont annoncés avec `destructiveHint` : un client qui demande une confirmation avant ce genre d'action le fera.

## Modifier une page sans risque

- `update_page` en mode `append` n'ajoute que du texte à la fin : le reste de la page (tableaux, images, blocs) est conservé.
- Le mode `replace` remplace tout le contenu par du texte simple (non vide) et exige `expectedVersion` : la mise en forme riche est perdue. L'historique de la page garde en général la version précédente (Historique, Restaurer), mais une modification récente de la même personne est fusionnée dans la dernière version : ne comptez pas dessus. À réserver aux pages en texte simple.
- `expectedVersion` : passez le champ `version` lu avec `get_page_info`. Si quelqu'un a modifié la page entre-temps, la modification est refusée au lieu d'écraser son travail. Sans lui, le serveur lit la version juste avant d'écrire et refuse toujours d'écraser une modification qui arrive entre les deux (réponse 412).
- Le texte accepté fait 100 000 caractères au plus ; un commentaire 5 000.

## Limites

- Le texte transmis est simple (titres `#`, paragraphes) : pas de tableaux, de listes ni de blocs à la création ou à la modification par MCP.
- Les débits habituels de l'API s'appliquent (par exemple 120 modifications et 30 commentaires par minute).
- Pas de chat ni de contexte côté serveur : le serveur MCP ne garde aucun état entre deux appels.

## Contenu non fiable

Le contenu des pages et des commentaires est écrit par d'autres personnes : une page peut contenir un texte qui cherche à pousser l'assistant à agir (« supprime cette page », « déplace-la dans tel espace »). Le serveur l'annonce dans ses instructions et ses descriptions d'outils, et marque les outils risqués (`destructiveHint`), mais c'est au client de demander une confirmation avant une écriture, un déplacement ou une suppression, et de traiter ce contenu comme des données.
