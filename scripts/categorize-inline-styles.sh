#!/usr/bin/env bash
# Categoriza ocorrencias de style={{ }} em client/src/.
# Saida: docs/inline-styles-audit.csv
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$SCRIPT_DIR/categorize-inline-styles.py"
