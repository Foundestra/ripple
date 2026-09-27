#!/usr/bin/env bash
# Pushes the three demo PR branches to your fork of opentelemetry-demo and
# (if the GitHub CLI is installed) opens them as PRs.
#
#   scripts/create-demo-prs.sh /path/to/your/opentelemetry-demo-fork [--open]
#
# The patches in fixtures/prs/*/diff.patch were generated against
# open-telemetry/opentelemetry-demo@6a89fab. They are applied with --3way, so
# small upstream drift is fine.
set -euo pipefail

REPO="${1:?usage: $0 /path/to/opentelemetry-demo-fork [--open]}"
OPEN="${2:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${BASE_BRANCH:-main}"

cd "$REPO"
git fetch origin "$BASE"

for dir in "$HERE"/fixtures/prs/*/; do
  meta="$dir/meta.json"
  branch=$(node -e "console.log(require('$meta').branch)")
  title=$(node -e "console.log(require('$meta').title)")
  body=$(node -e "console.log(require('$meta').body)")
  echo "==> $branch"
  git checkout -q -B "$branch" "origin/$BASE"
  git apply --3way "$dir/diff.patch"
  git add -A
  git commit -q -m "$title" -m "$body"
  git push -q -f origin "$branch"
  if [[ "$OPEN" == "--open" ]] && command -v gh >/dev/null; then
    gh pr create --base "$BASE" --head "$branch" --title "$title" --body "$body" || true
  fi
done

git checkout -q "$BASE"
echo
echo "Branches pushed. Open the PRs live during the demo (or pass --open to open them now)."
echo "Tip: pre-run each once so the first live run isn't a cold start."
