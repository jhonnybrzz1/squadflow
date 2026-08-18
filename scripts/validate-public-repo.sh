#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "[public-validation] ERROR: $*" >&2
  exit 1
}

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [GIT_REF]" >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || fail "git not found"
command -v node >/dev/null 2>&1 || fail "node not found"
command -v npm >/dev/null 2>&1 || fail "npm not found"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository"
GIT_REF=${1:-HEAD}
EXPECTED_NODE_MAJOR=$(tr -d '[:space:]' < "$REPO_ROOT/.node-version")
CURRENT_NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")

[ "$CURRENT_NODE_MAJOR" = "$EXPECTED_NODE_MAJOR" ] \
  || fail "Node $EXPECTED_NODE_MAJOR is required; current major is $CURRENT_NODE_MAJOR"

VALIDATION_PARENT=$(mktemp -d "${TMPDIR:-/tmp}/aichatflow-public-validation.XXXXXX")
SNAPSHOT="$VALIDATION_PARENT/repository"

cleanup_validation() {
  validation_exit_code=$?
  trap - EXIT
  if [ -d "$VALIDATION_PARENT" ]; then
    find "$VALIDATION_PARENT" -depth -delete
  fi
  exit "$validation_exit_code"
}
trap cleanup_validation EXIT

"$REPO_ROOT/scripts/export-public-repo.sh" "$SNAPSHOT" "$GIT_REF"

git -C "$SNAPSHOT" init -q -b main
git -C "$SNAPSHOT" remote add origin https://example.invalid/public/aichatflow.git
cp "$SNAPSHOT/.env.example" "$SNAPSHOT/.env"

(
  cd "$SNAPSHOT"
  unset DATABASE_URL DATABASE_DIALECT STORAGE ALLOW_REAL_DB_IN_TESTS
  export CI=true
  npm ci
  npm run audit:production
  npm run db:push
  node --env-file=.env scripts/verify-public-db.mjs
  npm run typecheck
  npm run build
  npm test
)

echo "[public-validation] OK: install, production audit, schema, typecheck, build and tests passed"
