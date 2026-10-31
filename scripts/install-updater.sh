#!/usr/bin/env bash
# Installe, sur l'hôte, le service qui permet le bouton « Mettre à jour » de Paramètres, À propos.
# Usage : sudo ./scripts/install-updater.sh [--sans-sauvegarde] [--sans-demarrage] [--activer-verification]
# Relançable sans risque : rien n'est écrasé de ce que vous avez réglé (fichier de configuration, .env).
#
# Pourquoi un service sur l'hôte : le conteneur de Notabene reste en lecture seule et sans accès à Docker ; il se
# contente de déposer une demande dans un dossier d'échange, que ce service (root) vérifie avant d'agir.
# Voir docs/MISE-A-JOUR.md.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SRC/.." && pwd)}"
EXCHANGE_DIR="${EXCHANGE_DIR:-/srv/appdata/notabene-updater}"
EXCHANGE_GID="${EXCHANGE_GID:-1000}" # identifiant de groupe de l'utilisateur du conteneur
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
ETC_DIR="${ETC_DIR:-/etc}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
OVERRIDE="docker-compose.updater.yml"

REQUIRE_BACKUP=true
START=true
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --sans-sauvegarde) REQUIRE_BACKUP=false ;;
    --sans-demarrage) START=false ;;
    --activer-verification) CHECK=true ;;
    -h|--help) sed -n 2,5p "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'Erreur : %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || [ -n "${NOTABENE_INSTALL_TEST:-}" ] || die "à lancer avec les droits root (sudo ./scripts/install-updater.sh)."
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "docker-compose.yml introuvable dans $COMPOSE_DIR."
[ -f "$COMPOSE_DIR/.env" ] || die ".env introuvable dans $COMPOSE_DIR : lancez d'abord ./scripts/setup.sh."
for f in notabene-updater.sh notabene-updater.service notabene-updater.timer; do [ -f "$SRC/updater/$f" ] || die "fichier manquant : scripts/updater/$f."; done
command -v docker >/dev/null || die "docker est introuvable."
command -v systemctl >/dev/null || [ -n "${NOTABENE_INSTALL_TEST:-}" ] || die "systemd est requis ; sans lui, voir l'installation manuelle dans docs/MISE-A-JOUR.md."

# 1. Dossier d'échange : possédé par root, écrit par le groupe du conteneur, hors du dossier de données.
install -d -m 0770 -g "$EXCHANGE_GID" "$EXCHANGE_DIR"

# 2. Volume du conteneur, dans un fichier à part : docker-compose.yml reste identique à celui du dépôt.
if grep -q ":/updater" "$COMPOSE_DIR/docker-compose.yml"; then
  say "Volume /updater déjà présent dans docker-compose.yml : rien à ajouter."
elif [ ! -f "$COMPOSE_DIR/$OVERRIDE" ]; then
  cat > "$COMPOSE_DIR/$OVERRIDE" <<EOF
# Ajouté par scripts/install-updater.sh : dossier d'échange avec le service de mise à jour de l'hôte.
services:
  notabene:
    volumes:
      - ${EXCHANGE_DIR}:/updater
EOF
fi

# 3. .env : fichiers compose chargés, dossier d'échange vu du conteneur, et (si demandé) vérification des versions.
env_file="$COMPOSE_DIR/.env"
if grep -q ":/updater" "$COMPOSE_DIR/docker-compose.yml"; then
  :
elif grep -q '^COMPOSE_FILE=' "$env_file"; then
  grep -q "^COMPOSE_FILE=.*$OVERRIDE" "$env_file" || sed -i.bak "s|^COMPOSE_FILE=.*|&:${OVERRIDE}|" "$env_file"
else
  printf 'COMPOSE_FILE=docker-compose.yml:%s\n' "$OVERRIDE" >> "$env_file"
fi
grep -q '^UPDATER_DIR=' "$env_file" || printf 'UPDATER_DIR=/updater\n' >> "$env_file"
if [ "$CHECK" = true ] && ! grep -q '^UPDATE_CHECK=' "$env_file"; then printf 'UPDATE_CHECK=true\n' >> "$env_file"; fi
rm -f "$env_file.bak"

# 4. Service et minuteur. La configuration existante n'est jamais écrasée.
install -m 0755 "$SRC/updater/notabene-updater.sh" "$SBIN_DIR/notabene-updater.sh"
install -d "$SYSTEMD_DIR"
install -m 0644 "$SRC/updater/notabene-updater.service" "$SRC/updater/notabene-updater.timer" "$SYSTEMD_DIR/"
if [ ! -f "$ETC_DIR/notabene-updater.conf" ]; then
  ( umask 077; printf 'COMPOSE_DIR=%s\nEXCHANGE_DIR=%s\nREQUIRE_BACKUP=%s\n' "$COMPOSE_DIR" "$EXCHANGE_DIR" "$REQUIRE_BACKUP" > "$ETC_DIR/notabene-updater.conf" )
else
  say "Configuration existante conservée : $ETC_DIR/notabene-updater.conf"
fi

if command -v systemctl >/dev/null; then
  systemctl daemon-reload
  systemctl enable --now notabene-updater.timer
fi

if [ "$START" = true ]; then ( cd "$COMPOSE_DIR" && docker compose up -d ); fi

say
say "Service de mise à jour installé."
if [ "$START" = false ]; then say "Démarrez ou relancez l'application : docker compose up -d"; fi
if ! grep -q '^UPDATE_CHECK=' "$env_file"; then say "Dernière étape : Paramètres, À propos, « Activer la vérification » (un appel à GitHub, désactivé par défaut)."; fi
if [ "$REQUIRE_BACKUP" = true ] && ! grep -q '^BACKUP_AGE_RECIPIENT=' "$env_file"; then
  say "Attention : aucune clé de sauvegarde (BACKUP_AGE_RECIPIENT) : le service refusera de mettre à jour tant qu'elle manque."
  say "Sur une instance de test seulement, relancez avec --sans-sauvegarde (prenez alors un instantané de la machine avant)."
fi
