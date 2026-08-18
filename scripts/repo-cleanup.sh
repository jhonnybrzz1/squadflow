#!/usr/bin/env bash
#
# repo-cleanup.sh — Spec 027 (Repo Cleanup Audit)
#
# Remove lixo seguro e backups antigos do repositório. DRY-RUN por padrão:
# só imprime o que faria. Passe --execute para deletar de verdade.
#
# Guardas de segurança (ver specs/027-repo-cleanup-audit/contracts/cleanup-safety-contract.md):
#   • NUNCA remove devDependencies — `autoprefixer`, `postcss` e `axe-core` SÃO
#     usados (postcss.config.js + testes a11y). A T022 do spec original está errada.
#   • NUNCA move `prd_mapping.json` — é lido em runtime por
#     server/routes/demands-utils.ts (process.cwd()/prd_mapping.json).
#   • MANTÉM o backup de banco mais recente como fallback; só remove os antigos.
#   • Só toca em arquivos gitignored/não-versionados — nada tracked é deletado.
#
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="dry-run"
[[ "${1:-}" == "--execute" ]] && MODE="execute"

say(){ printf '%s\n' "$*"; }
act(){ # act <descrição> <comando...>
  local desc="$1"; shift
  if [[ "$MODE" == "execute" ]]; then
    say "  [EXEC] $desc"; "$@"
  else
    say "  [dry ] $desc"
  fi
}

say "=== repo-cleanup.sh ($MODE) ==="

say "-- Lixo seguro (gitignored/untracked) --"
# .DS_Store
while IFS= read -r f; do act "rm $f" rm -f "$f"; done < <(find . -name .DS_Store -not -path '*/node_modules/*' 2>/dev/null)
# local.db vazio
[[ -f local.db && ! -s local.db ]] && act "rm local.db (0 bytes)" rm -f local.db
# saídas de avaliação em tmp/ (regeneráveis)
for f in tmp/eval-*.json; do [[ -e "$f" ]] && act "rm $f" rm -f "$f"; done

say "-- Backups de banco antigos (mantém o mais recente como fallback) --"
# ordena por mtime, mantém o mais novo, remove o resto (portável p/ bash 3.2)
BK=()
while IFS= read -r line; do [[ -n "$line" ]] && BK+=("$line"); done < <(ls -t sqlite.db.backup* 2>/dev/null || true)
if (( ${#BK[@]} > 1 )); then
  say "  MANTIDO (fallback): ${BK[0]}"
  for old in "${BK[@]:1}"; do act "rm $old ($(du -h "$old" | cut -f1))" rm -f "$old"; done
elif (( ${#BK[@]} == 1 )); then
  say "  Só há 1 backup (${BK[0]}) — mantido, nada a remover."
else
  say "  Nenhum backup encontrado."
fi

say "-- NÃO executado por segurança (faça manualmente se quiser) --"
say "  • Mover relatórios root (AICHATFLOW1_*.md, CODEBASE_AUDIT_*, MODEL_REGISTRY_*)"
say "    e screenshots para docs/archive|assets — checar referências antes."
say "  • prd_mapping.json / prd_audit_baseline.json PERMANECEM no root (uso runtime)."
say "  • devDeps autoprefixer/postcss/axe-core: MANTER (em uso)."

if [[ "$MODE" == "execute" ]]; then
  say "=== concluído. Rode: npm run check && npm test ==="
else
  say "=== dry-run. Reexecute com --execute para aplicar. ==="
fi
