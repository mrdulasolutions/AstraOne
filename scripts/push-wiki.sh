#!/usr/bin/env bash
#
# Sync docs/wiki/ → GitHub wiki repo.
#
# One-time bootstrap (required before this script works):
#   1. Open https://github.com/mrdulasolutions/AstraOne/wiki in a browser.
#   2. Click "Create the first page" and save anything (e.g. a one-line "Bootstrap").
#      This initializes the underlying https://github.com/mrdulasolutions/AstraOne.wiki.git repo.
#   3. Run this script — it will overwrite that placeholder with the canonical pages.
#
# Subsequent updates: edit docs/wiki/*.md, commit, then run this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/docs/wiki"
TMP="$(mktemp -d)"
WIKI_REMOTE="https://github.com/mrdulasolutions/AstraOne.wiki.git"

if [[ ! -d "$SRC" ]]; then
  echo "✗ $SRC does not exist" >&2
  exit 1
fi

echo "Cloning wiki repo into $TMP …"
if ! git clone --quiet "$WIKI_REMOTE" "$TMP/wiki" 2>/dev/null; then
  echo "✗ Wiki repo not found. Bootstrap it first by creating one page in the GitHub UI:" >&2
  echo "    https://github.com/mrdulasolutions/AstraOne/wiki" >&2
  rm -rf "$TMP"
  exit 1
fi

echo "Copying docs/wiki/*.md → wiki/"
# Remove existing pages so deletions in docs/wiki/ propagate.
( cd "$TMP/wiki" && find . -maxdepth 1 -name '*.md' -delete )
cp "$SRC"/*.md "$TMP/wiki/"

cd "$TMP/wiki"
git add -A
if git diff --cached --quiet; then
  echo "Wiki is already up to date."
  rm -rf "$TMP"
  exit 0
fi

git commit -q -m "Sync docs/wiki → wiki ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git push -q origin "$(git rev-parse --abbrev-ref HEAD)"
echo "✓ Pushed to $WIKI_REMOTE"
rm -rf "$TMP"
