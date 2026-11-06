#!/usr/bin/env bash
# Service de mise à jour de BeNote, côté hôte. À lancer par un minuteur systemd (voir docs/MISE-A-JOUR.md).
#
# Rôle : quand un administrateur clique sur « Mettre à jour » dans l'interface, BeNote dépose une DEMANDE dans le
# dossier d'échange. Ce script, qui tourne sur l'hôte avec le droit d'utiliser Docker, décide et exécute. BeNote
# n'a jamais accès à Docker : son conteneur reste en lecture seule et sans privilèges.
#
# Le fichier de demande vient d'un conteneur potentiellement compromis : il est traité comme NON FIABLE.
# Seul un numéro de version « x.y.z » en est extrait, puis comparé à la dernière release publiée sur GitHub
# (interrogée directement par ce script). Aucune autre donnée de la demande n'est utilisée.
set -euo pipefail
umask 022

CONF="${NOTABENE_UPDATER_CONF:-/etc/notabene-updater.conf}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

: "${COMPOSE_DIR:?COMPOSE_DIR manquant dans $CONF}"
: "${EXCHANGE_DIR:?EXCHANGE_DIR manquant dans $CONF}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/lucasmolyn1/notabene}"
GITHUB_REPO="${GITHUB_REPO:-LucasMolyn1/notabene}"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
SERVICE="${SERVICE:-notabene}"
# Vide par défaut : on lit l'état de santé du conteneur (indépendant de l'adresse sur laquelle le port est publié).
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
REQUIRE_BACKUP="${REQUIRE_BACKUP:-false}"
PIN_DIGEST="${PIN_DIGEST:-false}"
VERIFY_ATTESTATION="${VERIFY_ATTESTATION:-false}"
STATE_DIR="${STATE_DIR:-/var/lib/notabene-updater}"

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

log() { logger -t notabene-updater -- "$*" 2>/dev/null || echo "notabene-updater: $*" >&2; }

# Un seul passage à la fois.
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

STATE_FILE="$STATE_DIR/state" # état|version|message|date (dernier changement)

json_escape() {
  local s="$1"
  s="${s//\\/ }"; s="${s//\"/\'}"
  s=$(printf '%s' "$s" | tr -d '\000-\037')
  printf '%s' "${s:0:300}"
}

# Écrit le statut lu par l'interface. Fichier temporaire + renommage : un lien symbolique posé à la place de
# status.json par le conteneur est remplacé, jamais suivi.
publish_status() {
  local state version message at tmp
  # Fichier d'état absent au premier passage : on teste avant la redirection, qui afficherait sinon une erreur.
  { [ -r "$STATE_FILE" ] && IFS='|' read -r state version message at < "$STATE_FILE"; } || { state=idle; version=''; message=''; at=0; }
  tmp=$(mktemp "$EXCHANGE_DIR/.status.XXXXXX")
  printf '{"state":"%s","version":"%s","message":"%s","at":%s,"heartbeat":%s}\n' \
    "$state" "$(json_escape "$version")" "$(json_escape "$message")" "${at:-0}" "$(date +%s)" > "$tmp"
  chmod 0644 "$tmp"
  mv -f -T "$tmp" "$EXCHANGE_DIR/status.json"
}

set_state() { # état version message
  printf '%s|%s|%s|%s\n' "$1" "${2:-}" "$(json_escape "${3:-}")" "$(date +%s)" > "$STATE_FILE"
  publish_status
}

# Un état « running » resté après un plantage ne doit pas bloquer l'interface.
if [ -r "$STATE_FILE" ]; then
  IFS='|' read -r st _ _ at < "$STATE_FILE" || true
  if [ "${st:-}" = running ] && [ $(( $(date +%s) - ${at:-0} )) -gt 1800 ]; then set_state failed '' 'Mise à jour interrompue (délai dépassé).'; fi
fi

REQ="$EXCHANGE_DIR/request.json"
if [ ! -e "$REQ" ] && [ ! -L "$REQ" ]; then
  publish_status # simple signe de vie
  exit 0
fi

# ---- Demande reçue : elle est consommée tout de suite (usage unique) ----
fail() { # message
  log "échec : $1"
  set_state failed "${VERSION:-}" "$1"
  exit 0
}

if [ -L "$REQ" ] || [ ! -f "$REQ" ]; then rm -f -- "$REQ"; VERSION=''; fail 'Demande invalide (ce n’est pas un fichier ordinaire).'; fi
size=$(wc -c < "$REQ" | tr -d ' ')
VERSION=''
if [ "$size" -gt 4096 ]; then rm -f -- "$REQ"; fail 'Demande invalide (trop volumineuse).'; fi
VERSION=$(grep -m1 -oE '"version" *: *"[0-9]+\.[0-9]+\.[0-9]+"' "$REQ" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
rm -f -- "$REQ"
if ! [[ "$VERSION" =~ $VERSION_RE ]]; then VERSION=''; fail 'Demande invalide (numéro de version illisible).'; fi

log "demande de mise à jour vers $VERSION"
set_state running "$VERSION" 'Vérification de la version…'

cd "$COMPOSE_DIR"
compose() { docker compose "$@"; }

# 1. La version demandée doit être la dernière release publiée, interrogée ici, pas fournie par la demande.
release=$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: notabene-updater' "$GITHUB_API/repos/$GITHUB_REPO/releases/latest") || fail 'GitHub injoignable : mise à jour annulée.'
latest=$(printf '%s' "$release" | grep -m1 -oE '"tag_name" *: *"v[0-9]+\.[0-9]+\.[0-9]+"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
[ -n "$latest" ] || fail 'Dernière release illisible : mise à jour annulée.'
[ "$latest" = "$VERSION" ] || fail "La version demandée ($VERSION) n’est pas la dernière release ($latest) : mise à jour annulée."

cid=$(compose ps -q "$SERVICE" 2>/dev/null | head -1)
current=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$cid" 2>/dev/null || true)
[[ "$current" =~ $VERSION_RE ]] || fail 'Version installée illisible : mise à jour annulée.'
if [ "$current" = "$VERSION" ] || [ "$(printf '%s\n%s\n' "$current" "$VERSION" | sort -V | tail -1)" != "$VERSION" ]; then
  fail "Déjà à jour ou version plus ancienne (installée : $current)."
fi

# 2. Sauvegarde : tentée à chaque fois. Un échec est signalé mais n'arrête la mise à jour que si REQUIRE_BACKUP=true
# (les migrations de base ne reviennent pas en arrière : sans sauvegarde, prenez un instantané de la machine).
set_state running "$VERSION" 'Sauvegarde de la base…'
backup_note=''
if ! compose exec -T "$SERVICE" node dist/server/backup.js backup >/dev/null 2>&1; then
  if [ "$REQUIRE_BACKUP" = true ]; then fail 'Sauvegarde impossible (clé de chiffrement BACKUP_AGE_RECIPIENT absente ?) : mise à jour annulée.'; fi
  log 'sauvegarde impossible, poursuite (REQUIRE_BACKUP=false)'
  backup_note=' Attention : aucune sauvegarde de la base n’a pu être faite.'
fi

# 3. Image : téléchargée par version exacte ; épinglée aussi par digest seulement si PIN_DIGEST=true.
set_state running "$VERSION" 'Téléchargement de l’image…'
docker pull "$IMAGE_REPO:$VERSION" >/dev/null 2>&1 || fail 'Téléchargement de l’image impossible : mise à jour annulée.'
new_image="$IMAGE_REPO:$VERSION"
if [ "$PIN_DIGEST" = true ]; then
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REPO:$VERSION" 2>/dev/null | sed 's/.*@//')
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Empreinte de l’image illisible : mise à jour annulée.'
  new_image="$new_image@$digest"
fi
if [ "$VERIFY_ATTESTATION" = true ]; then
  gh attestation verify "oci://$IMAGE_REPO:$VERSION" --owner "${GITHUB_REPO%%/*}" >/dev/null 2>&1 || fail 'Attestation de provenance invalide : mise à jour annulée.'
fi

# 4. Bascule, avec mémoire de l'ancienne image.
ENV_FILE="$COMPOSE_DIR/.env"
old_line=$(grep -m1 '^NOTABENE_IMAGE=' "$ENV_FILE" || true)
[ -n "$old_line" ] || fail 'NOTABENE_IMAGE absent du .env : mise à jour annulée.'
printf '%s\n' "$old_line" > "$STATE_DIR/previous-image"
set_state running "$VERSION" 'Redémarrage de BeNote…'
sed -i "s#^NOTABENE_IMAGE=.*#NOTABENE_IMAGE=$new_image#" "$ENV_FILE"
compose up -d >/dev/null 2>&1 || true

container_ok() {
  if [ -n "$HEALTH_URL" ]; then curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; return; fi
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q "$SERVICE" | head -1)" 2>/dev/null)" = healthy ]
}

healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) now_version
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if container_ok; then
      now_version=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$(compose ps -q "$SERVICE" | head -1)" 2>/dev/null || true)
      [ "$now_version" = "$1" ] && return 0
    fi
    sleep 3
  done
  return 1
}

if healthy "$VERSION"; then
  log "mise à jour réussie : $current -> $VERSION"
  set_state success "$VERSION" "Mise à jour réussie ($current vers $VERSION).$backup_note"
  exit 0
fi

# 5. Échec : on garde d'abord la trace de ce que disait la nouvelle version (le conteneur va être remplacé).
log "version $VERSION non fonctionnelle, retour à $current"
failed_cid=$(compose ps -q "$SERVICE" 2>/dev/null | head -1)
[ -n "$failed_cid" ] && docker logs --tail 15 "$failed_cid" 2>&1 | cut -c1-300 | while IFS= read -r l; do log "journal $VERSION : $l"; done
set_state running "$VERSION" 'Échec : retour à l’ancienne version…'
sed -i "s#^NOTABENE_IMAGE=.*#${old_line//#/\\#}#" "$ENV_FILE"
compose up -d >/dev/null 2>&1 || true
if healthy "$current"; then
  set_state failed "$VERSION" "La version $VERSION ne démarre pas : retour à la $current effectué."
else
  # Les migrations de base ne reviennent pas en arrière : l'ancienne version refuse souvent de relire une base déjà
  # migrée. Mieux vaut remettre la nouvelle version (peut-être seulement lente ou mal détectée) que laisser le site à l'arrêt.
  log "retour à $current impossible, la nouvelle version $VERSION est remise en place"
  sed -i "s#^NOTABENE_IMAGE=.*#NOTABENE_IMAGE=$new_image#" "$ENV_FILE"
  compose up -d >/dev/null 2>&1 || true
  if healthy "$VERSION"; then
    set_state failed "$VERSION" "La version $VERSION a été jugée non fonctionnelle, mais la $current ne peut pas relire la base migrée : la $VERSION est remise en place et fonctionne. Vérifiez le journal (journalctl -t notabene-updater)."
  else
    set_state failed "$VERSION" "La version $VERSION ne démarre pas et le retour à la $current est impossible : restaurez le snapshot ou la sauvegarde (docs/MISE-A-JOUR.md)."
  fi
fi
exit 0
