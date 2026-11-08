# Journal d'audit, export et SIEM

BeNote inscrit les actions sensibles (connexions, échecs, changements de droits, réglages, exports, suppressions…) dans un journal d'audit. Le journal ne contient **jamais de secret ni de contenu de page**. Toutes les routes ci-dessous sont réservées aux administrateurs (rôle admin, portée `admin` pour un jeton d'API), sous `/api/v3`.

## Format des évènements

Format stable, commun à la liste paginée, à l'export, au SIEM et à la sortie standard. Identifiant de schéma : `notabene.audit/1`. Un changement incompatible donnera un nouvel identifiant ; des champs peuvent s'ajouter sans changer de schéma.

```json
{
  "schema": "notabene.audit/1",
  "id": 1842,
  "timestamp": "2026-11-08T14:03:12.511Z",
  "action": "auth.local.failed",
  "outcome": "failure",
  "actor": { "id": "u-123", "name": "Alice" },
  "target": "u-123",
  "ip": "203.0.113.9",
  "meta": { "reason": "password" }
}
```

| Champ | Description |
|---|---|
| `schema` | identifiant du format |
| `id` | entier croissant, unique dans l'instance (sert de clé de déduplication) |
| `timestamp` | date ISO 8601 en UTC, à la milliseconde |
| `action` | nom de l'action, par familles séparées par des points (`auth.login`, `settings.smtp`, `space.member.set`…) |
| `outcome` | `failure` pour `auth.denied` et toute action terminée par `.failed`, sinon `success` |
| `actor` | auteur (`id`, `name`, `name` à `null` si le compte a été effacé) ; `null` pour une action du système (purge, ligne de commande) |
| `target` | identifiant de l'objet visé (page, espace, compte, section de réglages…) ou `null` |
| `ip` | adresse du client, ou `null` après `AUDIT_IP_RETENTION_DAYS` |
| `meta` | détails techniques, ou `null` |

`meta` est filtré à la sortie : les valeurs textuelles des clés évoquant un secret ou un texte (nom contenant `pass`, `secret`, `token`, `key`, `hash`, `otp`, `authorization`, `cookie`, `credential`, `content`, `body`, `html`, `markdown`, `text`, `prompt`, `message`, `title`, `path`, `filename` ou `username`, pluriels et composés compris) sont retirées (un booléen ou un nombre reste : `password: true` signifie « mot de passe changé »). Les chaînes sont coupées à 200 caractères, les tableaux à 50 éléments, l'imbrication à 3 niveaux.

## Consultation

`GET /admin/audit/events` : du plus récent au plus ancien, pagination par curseur.

| Paramètre | Effet |
|---|---|
| `action` | action exacte (`auth.login`) ou famille si la valeur se termine par un point (`auth.`) |
| `userId` | identifiant de l'auteur |
| `target` | cible exacte |
| `outcome` | `success` ou `failure` |
| `from`, `to` | date (`2026-11-01`, en UTC) ou date et heure ISO 8601 avec fuseau ; `from` inclus, `to` exclu ; une date seule en `to` couvre toute la journée |
| `limit` | 1 à 200 (50 par défaut) |
| `cursor` | valeur `nextCursor` de la page précédente (un curseur modifié donne 400) |

Réponse : `{ "items": [évènements], "nextCursor": "…" | null }`.

`GET /admin/audit?limit=100` garde sa forme historique (tableau `id, at, action, target, ip, meta` en texte brut, `user`) et accepte les mêmes filtres.

## Export

`GET /admin/audit/export?format=csv|json` avec les mêmes filtres. Le fichier est produit en flux, par lots, du plus récent au plus ancien, plafonné à 100 000 lignes. En-têtes : `X-Export-Rows` (lignes exportées), `X-Export-Truncated` (`true` si le plafond est atteint : resserrez les dates). Dix exports au plus par tranche de dix minutes.

- **JSON** : un tableau d'évènements au format ci-dessus.
- **CSV** (UTF-8 avec BOM, séparateur virgule, toutes les cellules entre guillemets) : colonnes `id, timestamp, action, outcome, actor_id, actor_name, target, ip, meta` (`meta` en JSON). Une cellule qui commence par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée d'une apostrophe, pour qu'un tableur ne l'exécute pas comme une formule.

L'export est lui-même journalisé (`audit.export`, avec le format, le nombre de lignes et les noms des filtres employés) et ne figure pas dans son propre résultat. Un fichier exporté contient des adresses IP : il sort du périmètre des purges automatiques.

## Envoi vers un SIEM

Configuration dans **Paramètres** (section `siem` de `/admin/settings`), ou par l'environnement (`SIEM_URL`, `SIEM_SECRET`, `SIEM_ACTIONS` : familles validées et mises en minuscules au démarrage). Comme pour les autres fournisseurs : ressaisie du mot de passe, test d'envoi réussi exigé avant l'enregistrement, secret chiffré par `ENCRYPTION_KEY` et jamais renvoyé (seuls ses 4 derniers caractères sont affichés). Un changement d'adresse exige de ressaisir le secret.

```json
PUT /api/v3/admin/settings/siem
{ "config": { "enabled": true, "url": "https://siem.example.com/notabene", "actions": ["auth", "settings"] },
  "secrets": { "secret": "au-moins-16-caracteres" }, "reauth": { "password": "…" }, "testId": "…" }
```

- `url` : https obligatoire ; mêmes protections que les webhooks (adresses internes refusées sauf `WEBHOOK_ALLOW_PRIVATE=true`, qui autorise aussi http ; aucune redirection suivie ; identifiants dans l'URL refusés ; délai de 5 secondes).
- `actions` : familles envoyées (`auth` couvre `auth` et `auth.*`) ; vide : tout le journal.
- `secret` : 16 caractères au moins après suppression des espaces de début et de fin (`openssl rand -hex 32`) ; la valeur rognée est celle testée et enregistrée.

### Requête envoyée

`POST` vers l'URL, corps JSON :

```json
{ "schema": "notabene.audit/1", "type": "audit.events", "sentAt": "2026-11-08T14:03:14.002Z", "events": [ … ] }
```

Jusqu'à 100 évènements par requête, dans l'ordre d'écriture. Le test envoie `type: "audit.test"` avec un évènement `audit.siem.test` (`id` 0).

| En-tête | Valeur |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Notabene-Audit/1` |
| `X-Notabene-Event` | `audit.events` ou `audit.test` |
| `X-Notabene-Delivery` | identifiant unique de la requête (UUID) |
| `X-Notabene-Timestamp` | secondes depuis l'époque Unix |
| `X-Notabene-Signature` | `sha256=` suivi de HMAC-SHA256(secret, `<timestamp>.<corps brut>`) en hexadécimal |

Même signature que les webhooks. Côté collecteur : recalculer la signature sur le corps brut, la comparer en temps constant, refuser un horodatage trop ancien (par exemple plus de 5 minutes), et dédupliquer par `id` d'évènement (un lot peut être renvoyé si la réponse s'est perdue).

### File, reprise et changements de configuration

La file est le journal lui-même : BeNote retient le dernier `id` traité (table `settings`, clé `audit:siem:state`) et envoie ce qui suit, toutes les 2 secondes, jusqu'à 10 lots de 100 évènements par passage tant qu'il en reste. Les familles sont filtrées en base. Le corps d'une requête est coupé vers 1 Mo ; un évènement de plus de 64 Ko voit son `meta` remplacé par `{"truncated": true}` et ses textes coupés, il ne bloque jamais la file. Les écritures de la ligne de commande et des purges sont reprises comme les autres.

Une réponse hors 2xx (ou une absence de réponse) laisse les évènements en file et déclenche un nouvel essai après 5 s, 10 s, 20 s…, puis toutes les 10 minutes au plus, **sans abandon**. Au 10e échec consécutif, une entrée `audit.siem.failing` est journalisée (une fois par série d'échecs).

Changement de configuration (enregistrement, désactivation, retour à l'environnement) :
- **même adresse** (familles ou secret modifiés, réactivation après une désactivation) : le curseur est conservé, rien de ce qui attend n'est sauté, y compris les entrées `settings.siem` écrites entre-temps ;
- **adresse différente, désactivation ou retour à l'environnement** : l'ancien collecteur reçoit d'abord ce qui attend encore (un passage), puis un évènement d'arrêt signé (`type: "audit.stop"`, action `audit.siem.stop`, `id` 0) ; les échecs sont tolérés et ne bloquent pas le changement ;
- **nouvelle adresse** : l'envoi part de l'entrée de configuration qui vient d'être écrite (`settings.siem`), ou plus tôt si l'ancien collecteur n'a pas tout reçu : aucun trou entre les deux.

Configurée par l'environnement seulement, une première mise en service part du dernier évènement existant, sans renvoyer l'historique : l'export couvre ce besoin.

`GET /admin/audit/siem` donne l'état, sans secret :

```json
{ "configured": true, "active": true, "origin": "https://siem.example.com", "actions": ["auth"], "disabled": false,
  "failures": 0, "maxFailures": 10, "lastStatus": 204, "lastAttemptAt": 1762610594002, "lastSuccessAt": 1762610594002,
  "nextAttemptAt": null, "pending": 0, "stdout": false }
```

`pending` compte les évènements en attente d'envoi (familles appliquées). `disabled` vaut toujours `false` (l'envoi n'est plus désactivé automatiquement, champ gardé pour la compatibilité) ; `maxFailures` est le seuil de l'alerte `audit.siem.failing`.

## Sortie standard

`AUDIT_STDOUT=true` écrit chaque nouvel évènement sur la sortie standard, une ligne JSON par évènement, au format ci-dessus, pour un collecteur de journaux (Loki, Vector, Fluent Bit…). Les lignes se reconnaissent au champ `"schema":"notabene.audit/1"` parmi les journaux du serveur. Pas d'historique au démarrage, pas de filtre par famille.

## Conservation

Le journal est purgé chaque heure : entrées après `AUDIT_RETENTION_DAYS` (365 jours), adresses IP après `AUDIT_IP_RETENTION_DAYS` (90 jours) ; `0` désactive la purge. `GET /admin/retention` (lecture seule) renvoie les durées effectives de toutes les données purgées automatiquement :

```json
{ "purgeIntervalMinutes": 60,
  "items": [ { "key": "AUDIT_RETENTION_DAYS", "label": "Journal d’audit", "description": "…", "days": 365, "purged": true }, … ],
  "fixed": [ { "label": "Sessions", "description": "…", "value": "12 h, ou 120 min sans activité" }, … ] }
```

Les copies transmises (SIEM, collecteur, fichiers exportés) ne sont pas atteintes par ces purges : voir [RGPD.md](RGPD.md).
