#!/usr/bin/env bash
# scripts/check-env-docs.sh — diff entre process.env.* no código e .env.example
# Uso: ./scripts/check-env-docs.sh
# Exit code 0 se todas as variáveis usadas estão documentadas ou ignoradas.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.example"
IGNORE_FILE="$ROOT_DIR/.env.ignored"
LOG_FILE="$ROOT_DIR/.env.diff.log"

# Extrai chaves de process.env.VAR e process.env['VAR'] em server/, shared/, client/, scripts/.
USED_KEYS=$(
  grep -rhoE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*|process\.env\[["'"'"'][A-Za-z_][A-Za-z0-9_]*["'"'"']\]' \
    "$ROOT_DIR/server" "$ROOT_DIR/shared" "$ROOT_DIR/client" "$ROOT_DIR/scripts" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sh' 2>/dev/null || true
)

# Limpa o prefixo process.env. ou process.env['...'].
USED=$(
  echo "$USED_KEYS" |
    sed -E "s/process\.env\.//g; s/process\.env\[[\"']//g; s/[\"']\]$//g" |
    grep -E '^[A-Za-z_][A-Za-z0-9_]*$' |
    sort -u
)

# Extrai chaves declaradas em .env.example (antes do =, com ou sem #).
DECLARED=$(
  sed -n -E 's/^[#[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' "$ENV_FILE" 2>/dev/null | sort -u || true
)

# Chaves intencionalmente ignoradas.
if [[ -f "$IGNORE_FILE" ]]; then
  IGNORED=$(sed -n -E 's/^[#[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*.*/\1/p' "$IGNORE_FILE" | sort -u || true)
else
  IGNORED=""
fi

# Diff: usadas que não estão declaradas nem ignoradas.
MISSING=$(comm -23 <(echo "$USED") <((echo "$DECLARED"; echo "$IGNORED") | sort -u) || true)

{
  echo "=== Env var documentation diff ==="
  echo "Generated: $(date -Iseconds)"
  echo ""
  if [[ -z "$MISSING" ]]; then
    echo "OK: all used environment variables are documented or ignored."
  else
    echo "MISSING variables (present in code, absent from .env.example and .env.ignored):"
    echo "$MISSING"
  fi
} > "$LOG_FILE"

cat "$LOG_FILE"

if [[ -z "$MISSING" ]]; then
  exit 0
else
  exit 1
fi
