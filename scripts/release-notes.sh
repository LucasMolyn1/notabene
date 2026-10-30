#!/bin/sh
# Affiche la section du CHANGELOG.md d'une version (en-tête « ## [x.y.z] - date » compris).
# Usage : scripts/release-notes.sh 3.2.0   (utilisé par le workflow de release ; utilisable à la main)
set -eu
version="${1:?usage: release-notes.sh <version sans le v>}"
awk -v v="$version" '
  /^## \[/ { if (found) exit; if (index($0, "## [" v "]") == 1) found = 1 }
  found { print }
' "$(dirname "$0")/../CHANGELOG.md"
