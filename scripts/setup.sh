#!/usr/bin/env bash
# Prépare un déploiement : génère un .env avec des secrets aléatoires.
# Usage : ./scripts/setup.sh   (un clone du dépôt = un déploiement)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  read -rp ".env existe déjà. L'écraser ? [o/N] " answer
  [[ "$answer" =~ ^[oO]$ ]] || { echo "Abandon."; exit 1; }
fi

random_key() {
  if command -v openssl >/dev/null; then openssl rand -base64 32
  else head -c 32 /dev/urandom | base64; fi
}

ask() { local prompt="$1" default="${2:-}" value; read -rp "$prompt${default:+ [$default]} : " value; echo "${value:-$default}"; }

echo "== Notabene : configuration du déploiement =="
PUBLIC_URL=$(ask "URL publique (https://…)" "https://wiki.example.com")
PROJECT=$(ask "Nom du déploiement (unique sur cette machine)" "notabene")
PORT=$(ask "Port local de l'application" "3000")
ISSUER=$(ask "Issuer OIDC Authentik" "https://auth.example.com/application/o/notabene/")
CLIENT_ID=$(ask "Client ID OIDC")
read -rsp "Client secret OIDC : " CLIENT_SECRET; echo
DRAWIO_URL=$(ask "URL publique de Draw.io (vide pour désactiver)" "")
DRAWIO_PORT=$(ask "Port local de Draw.io" "8081")
EMBED=$(ask "Origines autorisées à intégrer Notabene (portfolio, séparées par des virgules)" "")

umask 077
cat > .env <<EOF
PUBLIC_URL=${PUBLIC_URL%/}
NODE_ENV=production
LOG_LEVEL=info
TRUST_PROXY=true
ENCRYPTION_KEY=$(random_key)

OIDC_ISSUER=${ISSUER}
OIDC_CLIENT_ID=${CLIENT_ID}
OIDC_CLIENT_SECRET=${CLIENT_SECRET}
OIDC_SCOPES=openid profile email
OIDC_ADMIN_GROUPS=notabene-admins
OIDC_EDITOR_GROUPS=notabene-editors
OIDC_READER_GROUPS=notabene-readers
OIDC_DEFAULT_ROLE=none
SESSION_TTL_HOURS=12

DRAWIO_URL=${DRAWIO_URL%/}
EMBED_ALLOWED_ORIGINS=${EMBED}
SEED_DEMO=true

COMPOSE_PROJECT_NAME=${PROJECT}
NOTABENE_BIND=127.0.0.1
NOTABENE_PORT=${PORT}
DRAWIO_BIND=127.0.0.1
DRAWIO_PORT=${DRAWIO_PORT}
COMPOSE_PROFILES=$([[ -n "$DRAWIO_URL" ]] && echo drawio || true)
EOF

echo
echo ".env créé (permissions 600). Sauvegardez ENCRYPTION_KEY en lieu sûr."
echo "Redirect URI à déclarer dans Authentik : ${PUBLIC_URL%/}/auth/callback"
echo "Démarrage : docker compose up -d --build"
