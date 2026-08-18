#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 DESTINATION [GIT_REF]" >&2
  echo "DESTINATION must not exist. GIT_REF defaults to HEAD." >&2
}

fail() {
  echo "[public-export] ERROR: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

command -v git >/dev/null 2>&1 || fail "git not found"
command -v tar >/dev/null 2>&1 || fail "tar not found"
command -v gitleaks >/dev/null 2>&1 || fail "gitleaks not found"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository"
MANIFEST="$REPO_ROOT/config/public-export-allowlist.txt"
DEST_INPUT=$1
GIT_REF=${2:-HEAD}

[ -f "$MANIFEST" ] || fail "allowlist not found: $MANIFEST"
git -C "$REPO_ROOT" rev-parse --verify "${GIT_REF}^{tree}" >/dev/null 2>&1 \
  || fail "invalid Git ref: $GIT_REF"

DEST_PARENT_INPUT=$(dirname "$DEST_INPUT")
DEST_NAME=$(basename "$DEST_INPUT")
[ "$DEST_NAME" != "." ] && [ "$DEST_NAME" != ".." ] && [ -n "$DEST_NAME" ] \
  || fail "invalid destination name"
[ -d "$DEST_PARENT_INPUT" ] || fail "destination parent must already exist"
DEST_PARENT=$(cd "$DEST_PARENT_INPUT" && pwd -P)
DEST="$DEST_PARENT/$DEST_NAME"

[ ! -e "$DEST" ] || fail "destination already exists: $DEST"
case "$DEST/" in
  "$REPO_ROOT/"*) fail "destination must be outside the source repository" ;;
esac

ALLOWLIST=()
SEEN=$'\n'
while IFS= read -r entry || [ -n "$entry" ]; do
  case "$entry" in
    "" | \#*) continue ;;
  esac

  case "$entry" in
    *[[:space:]]*) fail "whitespace is not allowed in allowlist entries: $entry" ;;
    /* | . | .. | ../* | */../* | */..) fail "unsafe allowlist entry: $entry" ;;
  esac

  case "$SEEN" in
    *$'\n'"$entry"$'\n'*) fail "duplicate allowlist entry: $entry" ;;
  esac

  tree_path=${entry%/}
  git -C "$REPO_ROOT" ls-tree -r --name-only "$GIT_REF" -- "$tree_path" | grep -q . \
    || fail "allowlist entry is missing from $GIT_REF: $entry"

  ALLOWLIST+=("$entry")
  SEEN+="$entry"$'\n'
done < "$MANIFEST"

[ "${#ALLOWLIST[@]}" -gt 0 ] || fail "allowlist is empty"

mkdir "$DEST"
cleanup_on_exit() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ -d "$DEST" ]; then
    find "$DEST" -depth -delete
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

git -C "$REPO_ROOT" archive --format=tar "$GIT_REF" "${ALLOWLIST[@]}" \
  | tar -xf - -C "$DEST"

FORBIDDEN_ROOTS=(
  .agents
  .learnings
  .specify
  _bmad
  data
  documents
  memory
  screenshots
  specs
)
for forbidden in "${FORBIDDEN_ROOTS[@]}"; do
  [ ! -e "$DEST/$forbidden" ] || fail "forbidden path exported: $forbidden"
done

if find "$DEST" -type l -print -quit | grep -q .; then
  fail "symbolic links are not allowed in the public snapshot"
fi

while IFS= read -r exported_file; do
  relative=${exported_file#"$DEST/"}
  case "$relative" in
    .env.example) ;;
    .env | .env.* | *.pem | *.key | *.p12 | *.pfx | *.ppk | *.db | *.db.* | *.backup*)
      fail "sensitive filename exported: $relative"
      ;;
  esac
done < <(find "$DEST" -type f -print)

echo "[public-export] running Gitleaks on curated snapshot"
gitleaks dir --redact --no-banner --verbose "$DEST"

FILE_COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
SIZE_KB=$(du -sk "$DEST" | awk '{print $1}')
[ "$FILE_COUNT" -gt 0 ] || fail "snapshot contains no files"

trap - EXIT
echo "[public-export] OK: $FILE_COUNT files, ${SIZE_KB} KiB"
echo "[public-export] source: $GIT_REF"
echo "[public-export] destination: $DEST"
