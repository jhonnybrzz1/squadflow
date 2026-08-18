#!/usr/bin/env bash
# Spec 10177: verify .env.example is in sync with process.env variables used in
# server/, shared/ and scripts/. Excludes auth/admin keys and npm_package_version.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export CHECK_ENV_SYNC_ROOT="$ROOT_DIR"

declare -a SEARCH_DIRS=("$ROOT_DIR/server" "$ROOT_DIR/shared" "$ROOT_DIR/scripts")

# Extract used env vars with a Node script (more reliable than portable grep).
USED_FILE=$(mktemp)
DECLARED_FILE=$(mktemp)

cleanup() {
  rm -f "$USED_FILE" "$DECLARED_FILE"
}
trap cleanup EXIT

node > "$USED_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.env.CHECK_ENV_SYNC_ROOT || process.cwd();
const dirs = [path.join(rootDir, 'server'), path.join(rootDir, 'shared'), path.join(rootDir, 'scripts')];
const files = [];

function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collect(full);
    } else if (/\.(ts|js)$/.test(entry.name)) {
      files.push(full);
    }
  }
}

for (const dir of dirs) collect(dir);

const used = new Set();

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');

  // process.env.VAR
  const dotMatches = content.match(/process\.env\.([A-Za-z0-9_]+)/g) || [];
  for (const m of dotMatches) used.add(m.replace('process.env.', ''));

  // process.env['VAR'] or process.env["VAR"]
  const bracketMatches = content.match(/process\.env\[(['"])([A-Za-z0-9_]+)\1\]/g) || [];
  for (const m of bracketMatches) {
    const name = m.replace(/process\.env\[(['"])(.+)\1\]/, '$2');
    if (name) used.add(name);
  }

  // destructuring: const { VAR1, VAR2 } = process.env
  const destructuringRegex = /(?:const|let|var)\s*\{\s*([A-Za-z0-9_,\s]+)\s*\}\s*=\s*process\.env/g;
  let match;
  while ((match = destructuringRegex.exec(content)) !== null) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) used.add(trimmed);
    }
  }

  // string-key helpers: getEnvAsNumber('VAR', ...)
  const helperRegex = /getEnvAs(?:Number|String|Boolean)\(\s*(['"])([A-Za-z0-9_]+)\1\s*[\),]/g;
  while ((match = helperRegex.exec(content)) !== null) {
    used.add(match[2]);
  }
}

used.delete('npm_package_version');

for (const name of used) {
  console.log(name);
}
NODE

# Normalize sort with C locale so comm can compare consistently.
LC_ALL=C sort -u "$USED_FILE" -o "$USED_FILE"

# Extract declared variables from .env.example.
grep -oE '^#?[ \t]*[A-Z_][A-Za-z0-9_]*[ \t]*=' "$ROOT_DIR"/.env.example | \
  sed 's/^#[ \t]*//;s/[ \t]*=$//;s/[ \t]*=//' | \
  LC_ALL=C sort -u > "$DECLARED_FILE"

# Compute missing and extra.
MISSING=$(comm -23 "$USED_FILE" "$DECLARED_FILE" || true)
EXTRA=$(comm -13 "$USED_FILE" "$DECLARED_FILE" || true)

if [ -n "$MISSING" ]; then
  echo "ERROR: variables used in code but missing from .env.example:"
  echo "$MISSING" | sed 's/^/  - /'
  echo
fi

if [ -n "$EXTRA" ]; then
  echo "INFO: variables declared in .env.example but not found in code:"
  echo "$EXTRA" | sed 's/^/  - /'
  echo
fi

if [ -n "$MISSING" ]; then
  exit 1
fi

echo "OK: .env.example is in sync with code (used: $(wc -l < "$USED_FILE" | tr -d ' '), declared: $(wc -l < "$DECLARED_FILE" | tr -d ' '))."
