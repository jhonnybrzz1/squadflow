#!/usr/bin/env bash
#
# Spec 016 B3 (auditoria H-03/PG, H-12, FR-007/FR-012, SC-005):
# Smoke real em PostgreSQL descartável — aplica a cadeia migrations-pg/
# do ZERO e valida os caminhos declarados compatíveis:
#   1. Cadeia de migrações aplica limpa (append-only, sem final_migration.sql).
#   2. DocuMente claim/lease usa BOOLEAN e TIMESTAMP corretos (não encoders SQLite).
#   3. Retenção: pg_database_size responde (métrica de tamanho por dialeto).
#
# Uso: ./scripts/pg-smoke.sh   (requer Docker)
set -euo pipefail

CONTAINER="aichatflow-pg-smoke-$$"
PORT="${PG_SMOKE_PORT:-55432}"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Subindo PostgreSQL descartável (porta $PORT)..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=smoke \
  -p "$PORT:5432" postgres:16-alpine >/dev/null

echo "==> Aguardando readiness..."
for i in $(seq 1 60); do
  # pg_isready pode passar durante o restart do init; exigir uma QUERY real.
  if docker exec "$CONTAINER" psql -U postgres -d smoke -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" psql -U postgres -d smoke -c 'SELECT 1' >/dev/null

PSQL=(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d smoke -q)

echo "==> Aplicando a cadeia migrations-pg/ do zero (ordem numérica, sem .down e sem final_migration)..."
applied=0
for file in $(ls migrations-pg/[0-9]*.sql | grep -v '\.down\.sql$' | sort); do
  echo "    - $file"
  "${PSQL[@]}" <"$file"
  applied=$((applied + 1))
done
echo "    OK: $applied migração(ões) aplicadas."

echo "==> FR-007: claim/lease do DocuMente com BOOLEAN e TIMESTAMP nativos..."
"${PSQL[@]}" <<'SQL'
INSERT INTO demand_external_docs (demand_id, doc_type, docu_mente_url, status, is_current, operation_token, lease_expires_at)
VALUES (1, 'epic', 'http://localhost', 'pending', TRUE, 'tok-1', NOW() + INTERVAL '5 minutes');

-- claim: lease vence e outro operador assume (timestamp real, não epoch text)
UPDATE demand_external_docs
SET operation_token = 'tok-2', lease_expires_at = NOW() + INTERVAL '5 minutes'
WHERE demand_id = 1 AND doc_type = 'epic' AND (lease_expires_at IS NULL OR lease_expires_at < NOW() + INTERVAL '10 minutes');

-- finalize
UPDATE demand_external_docs
SET status = 'success', is_current = TRUE, operation_token = NULL, lease_expires_at = NULL
WHERE demand_id = 1 AND doc_type = 'epic' AND operation_token = 'tok-2';

DO $$
DECLARE ok INT;
BEGIN
  SELECT COUNT(*) INTO ok FROM demand_external_docs
   WHERE demand_id = 1 AND doc_type = 'epic' AND status = 'success' AND is_current IS TRUE;
  IF ok <> 1 THEN RAISE EXCEPTION 'claim/finalize falhou (esperado 1, obtido %)', ok; END IF;
END $$;
SQL
echo "    OK: claim/finalize com boolean/timestamp nativos."

echo "==> Retenção: métrica de tamanho por dialeto (pg_database_size)..."
"${PSQL[@]}" -c "SELECT pg_database_size(current_database()) > 0 AS size_ok;" | grep -q t
echo "    OK: pg_database_size respondeu."

echo "==> Colunas críticas presentes (drift check)..."
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(col, ', ') INTO missing FROM (
    SELECT unnest(ARRAY['is_current','operation_token','lease_expires_at']) AS col
    EXCEPT
    SELECT column_name FROM information_schema.columns WHERE table_name = 'demand_external_docs'
  ) q;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'colunas ausentes: %', missing; END IF;
END $$;
SQL
echo "    OK: schema implantado consistente."

echo ""
echo "==> Provisionamento COMPLETO: toda pgTable declarada existe no banco..."
# Auditoria 2026-08-01 (A07): o drift check acima olhava três colunas de UMA
# tabela. O buraco real era outro — 21 das 55 `pgTable` de shared/schema-pg.ts
# não tinham CREATE em migration nenhuma e só nasciam por efeito colateral de
# boot (`ensureSchema`). Num PostgreSQL provisionado pela cadeia elas não
# existiam, e nada acusava. Esta verificação compara a declaração com o banco
# recém-provisionado e falha se sobrar alguma.
DECLARADAS=$(node -e '
const fs = require("fs");
const src = fs.readFileSync("shared/schema-pg.ts", "utf8");
const nomes = [...src.matchAll(/pgTable\(\s*[\x27"`]([a-z0-9_]+)/g)].map((m) => m[1]);
// Exclusão documentada em migrations-pg/0056: exige a extensão pgvector, que a
// cadeia não cria e a imagem deste smoke não tem.
console.log([...new Set(nomes)].filter((n) => n !== "chunk_embeddings").sort().join("\n"));
')

IMPLANTADAS=$(docker exec -i "$CONTAINER" psql -tA -U postgres -d smoke \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")

FALTANDO=$(comm -23 <(echo "$DECLARADAS") <(echo "$IMPLANTADAS" | sort))
if [ -n "$FALTANDO" ]; then
  echo "    FALHA: tabelas declaradas em schema-pg.ts sem CREATE na cadeia de migrations:"
  echo "$FALTANDO" | sed 's/^/      - /'
  echo "    Corrija com uma migration nova — criar em runtime não conta."
  exit 1
fi
echo "    OK: todas as $(echo "$DECLARADAS" | wc -l | tr -d ' ') tabelas declaradas existem."

echo ""
echo "PG-SMOKE PASS ✅ — cadeia do zero + claim/finalize + retenção + provisionamento completo validados em PostgreSQL real."
