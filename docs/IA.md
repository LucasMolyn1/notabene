# Fonctionnalités IA : configurer un fournisseur

Les fonctions IA (« Demander à l'IA » dans `⌘K`, assistant de rédaction, chat) passent par **un seul fournisseur**, réglé par un administrateur dans **Paramètres → IA**. Rien n'est envoyé tant qu'il n'est pas configuré.

## Choisir un fournisseur

| Option | Coût | Données | Pour qui |
|---|---|---|---|
| **Ollama local** | Gratuit (votre matériel) | Ne quittent pas votre infrastructure | Serveur avec assez de mémoire pour le modèle |
| **Ollama Cloud** | Petit quota mensuel gratuit sur certains modèles, crédits au-delà | Envoyées à ollama.com | Pas de matériel dédié |
| **Anthropic Claude** | Payant (clé d'API) | Envoyées à Anthropic | Meilleure qualité |
| **Autre fournisseur compatible OpenAI** (OpenAI, Mistral, LM Studio…) | Selon le fournisseur | Envoyées au fournisseur | Selon le besoin |

Pour chaque question, seuls des extraits des pages **que la personne a le droit de lire** sont envoyés (voir `docs/RGPD.md`).

## Ollama Cloud

1. Créez un compte sur [ollama.com](https://ollama.com), puis une clé d'API (Settings → Keys).
2. Dans Notabene, **Paramètres → IA** :

| Champ | Valeur |
|---|---|
| Activer la recherche IA | coché |
| Fournisseur | Compatible OpenAI |
| URL de base | `https://ollama.com/v1` |
| Clé d'API | votre clé Ollama |
| Modèle | le nom exact d'un modèle cloud (voir ci-dessous) |

3. Cliquez sur **Enregistrer et tester** (le mot de passe est demandé). Le résultat s'affiche à côté du bouton.

`AI_ALLOW_PRIVATE` n'est pas nécessaire : l'adresse est publique et en https.

### Modèles gratuits (relevé du 6 novembre 2026)

Le plan gratuit d'Ollama inclut un petit quota mensuel d'utilisation, valable uniquement pour ces modèles cloud :

| Modèle | Remarque |
|---|---|
| `gemma4:31b` | **Recommandé pour commencer** : bon en français, réponses rapides, testé avec Notabene |
| `gpt-oss:120b` | Plus puissant, pour les questions complexes ; plus lent |
| `gpt-oss:20b` | Léger et rapide, qualité moindre |
| `nemotron-3-nano:30b`, `nemotron-3-super`, `nemotron-3-ultra` | Alternatives |
| `beam` | Alternative |

Cette liste **évolue** : Ollama la modifie régulièrement. Elle est affichée sur votre page de compte ollama.com (« Usage breakdown »), qui fait foi, ainsi que sur [la page des tarifs](https://ollama.com/pricing) et [l'usage du cloud](https://docs.ollama.com/api/cloud-usage). Tout autre modèle demande des crédits (paiement à l'usage) ou un abonnement, sinon l'erreur est `402`. Le quota gratuit s'épuise : suivez la barre « Free usage » de votre compte.

### Quel modèle choisir pour Notabene

Les tâches sont de lire quelques extraits de pages, répondre en français en citant les sources, et reformuler un texte. Il ne faut pas un très gros modèle.

- **Par défaut : `gemma4:31b`**, bon compromis qualité, rapidité et consommation du quota.
- **`gpt-oss:120b`** si les réponses sont trop approximatives sur des documents techniques.
- **`gpt-oss:20b`** pour économiser le quota ou si la rapidité compte plus que la finesse.

Ce conseil est un jugement d'usage, pas un benchmark : essayez deux modèles sur vos propres pages.

### La liste des modèles n'est pas la liste des modèles accessibles

**Charger les modèles** affiche le catalogue du fournisseur, pas ce que votre compte peut utiliser. Un modèle listé peut répondre `402` ou `404`. Le seul vrai test est une question posée avec ce modèle.

## Ollama local

1. Installez Ollama sur une machine ou un conteneur du réseau et téléchargez un modèle : `ollama pull <modèle>`.
2. Dans l'environnement du serveur Notabene : `AI_ALLOW_PRIVATE=true` (adresse du réseau interne ou en http).
3. **Paramètres → IA** : fournisseur Compatible OpenAI, URL de base `http://hote:11434/v1`, clé vide, modèle installé. La liste des modèles correspond alors aux modèles réellement présents.

Si Ollama tourne dans le même `docker compose`, l'URL est `http://ollama:11434/v1`.

## Erreurs courantes

| Message | Cause | Que faire |
|---|---|---|
| `401` | Clé fausse, absente ou collée avec un espace | Ressaisir la clé |
| `402` (« Crédits insuffisants… ») | Crédits ou abonnement insuffisants pour ce modèle | Choisir un modèle de la liste gratuite, ajouter des crédits, ou passer en local |
| `400` / `422` | Requête refusée : nom de modèle ou URL de base incorrects | Vérifier le modèle et l'URL |
| `5xx` (« indisponible ») | Panne côté fournisseur | Réessayer plus tard |
| `404` | Nom de modèle inexistant | Recharger les modèles, ou saisir le nom exact |
| `429` | Limite d'usage ou de requêtes simultanées atteinte | Attendre, ou changer de fournisseur |
| Délai dépassé / connexion impossible | Adresse en http ou interne sans `AI_ALLOW_PRIVATE=true`, ou pare-feu | Vérifier l'URL et la variable |

## Sécurité

- La clé est chiffrée en base (AES-256-GCM) et n'est jamais renvoyée au navigateur. Elle n'est utilisée que pour l'adresse enregistrée : pour une autre adresse, saisissez-la de nouveau.
- Modifier le fournisseur demande la ressaisie du mot de passe.
- Avec un modèle local, aucune donnée ne quitte votre infrastructure.
