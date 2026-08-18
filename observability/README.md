# Observabilidade — AiChatFlow (item A2 do backlog)

A instrumentação já existe no código (`server/metrics.ts`, 8 métricas Prometheus + endpoint `/metrics`). O que faltava era **consumo**: dashboards e alertas. Estes artefatos fecham essa malha.

## Conteúdo

| Arquivo                             | O que é                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `prometheus/alerts.yml`             | Regras de alerta (latência IA, TTFT, custo/demanda, retrabalho, 5xx, etc.) |
| `prometheus/prometheus.example.yml` | Scrape config de exemplo apontando para o `/metrics` da app                |
| `grafana/aichatflow-overview.json`  | Dashboard importável com 8 painéis                                         |

## Métricas consumidas (de `server/metrics.ts`)

- `ai_api_call_duration_seconds` (Histogram) — latência da chamada de IA
- `ai_first_token_duration_seconds` (Histogram) — TTFT
- `ai_api_tokens_total` (Counter) — tokens (prompt/completion)
- `http_request_duration_seconds` (Histogram) — latência HTTP
- `demands_by_classification_zone_total` (Counter) — demandas por zona
- `retrabalho_rate_by_zone` (Gauge) — retrabalho por zona
- `hybrid_classification_latency_seconds` (Histogram) — latência classificação híbrida
- `classification_cost_per_demand_usd` (Histogram) — custo por demanda

## Como subir (local)

### Opção A — Stack completa em 1 comando (recomendado)

Suba Prometheus + Grafana + Tempo com docker compose. A app **não** entra no compose
(continua rodando no host); os containers a alcançam via `host.docker.internal`.

```bash
docker compose -f observability/docker-compose.observability.yml up -d
```

Depois de subir:

| Serviço    | URL                   | Notas                                                  |
| ---------- | --------------------- | ------------------------------------------------------ |
| Grafana    | http://localhost:3000 | admin / admin. Dashboard já provisionado.              |
| Prometheus | http://localhost:9090 | Alertas em Status > Rules. Target em Status > Targets. |
| Tempo UI   | http://localhost:3200 | Recebe OTLP em :4318 (fim do dryRun do tracer).        |

O dashboard "AiChatFlow — Visão Geral (A2)" aparece automaticamente na pasta `AiChatFlow`
do Grafana, com datasources Prometheus e Tempo já configurados.

**Traces:** a app já posta em `http://localhost:4318/v1/traces` por padrão
(`OTEL_EXPORTER_OTLP_ENDPOINT`). Como o Tempo está exposto na porta 4318 do host,
os traces passam a chegar sem nenhuma mudança de código ou `.env`. Para confirmar,
abra Grafana → Explore → Tempo e busque por `service.name=aichatflow`.

**Porta da app:** o `prometheus.yml` assume `PORT=5000` (mesmo valor do `.env.example`).
Se a app usar outra porta, ajuste o target em `observability/prometheus/prometheus.yml`.

> Nota: `prometheus.example.yml` (porta 5001) é um artefato legado; o compose usa
> `prometheus.yml` (porta 5000). Mantemos o example apenas como referência manual.

### Opção B — Manual (sem Docker)

1. **App:** já expõe `GET /metrics` (ver `server/index.ts`).
2. **Prometheus:** `prometheus --config.file=observability/prometheus/prometheus.yml`
3. **Grafana:** importe `grafana/aichatflow-overview.json` e selecione o datasource Prometheus.

### Correlação trace ↔ audit ↔ métrica

O `requestId` (gerado em `openai-ai.ts`) já é o mesmo ponta-a-ponta:

- **Trace (OTLP):** atributo `llm.request_id` no span (`trace-exporter.ts`)
- **Audit log:** coluna `request_id` em `llm_audit_logs` (`llm-audit-log.ts`)
- **Usage tracker:** campo `requestId` em `AIUsageRecord` (`ai-usage-tracker.ts`)
- **Telemetria persistente:** PK `request_id` em `ai_requests` (`request-telemetry.ts`)

Para ir de um pico de latência no Grafana até o trace: Explore → Tempo → filtre por
`llm.request_id=<valor>` (ou copie o `requestId` do audit log em `/debug` e cole na busca
do Tempo). O link direto pico→trace via **Prometheus exemplars** é o próximo passo
(item #3 do roadmap — ainda não implementado).

### Correlação pico→trace via Prometheus exemplars (item #3)

Os histogramas `ai_api_call_duration_seconds` e `ai_first_token_duration_seconds` agora
emitem **exemplars** com `trace_id` e `request_id` no formato OpenMetrics. Isso significa
que no Grafana, ao passar o mouse sobre um ponto do gráfico de latência, você vê o
`traceId` da amostra e pode clicar para abrir o trace direto no Tempo — sem grep, sem
procurar na mão.

**Requisitos já configurados no compose:**

- Registry da app em modo OpenMetrics (`server/metrics.ts`)
- Prometheus com `--enable-feature=exemplar-storage` (`docker-compose.observability.yml`)
- Datasource Tempo no Grafana com `tracesToMetrics` configurado (`datasources.yml`)

**Fluxo completo (1 clique):**

1. Grafana → dashboard "AiChatFlow — Visão Geral" → painel "Latência chamada IA"
2. Passa o mouse sobre um pico → tooltip mostra `trace_id` e `request_id` (exemplar)
3. Clica no exemplar → abre o trace no Tempo (Explore)
4. Do trace, copia o `request_id` → consulta audit log em `/debug` ou SQL:
   `SELECT * FROM llm_audit_logs WHERE request_id = '<valor>'`

**Nota:** exemplars são anexados apenas no path não-streaming (onde `tracingContext.span`
existe). O path de streaming não tem tracing instrumentado ainda (ver comentário em
`openai-ai.ts` ~linha 1008).

### Provenância de retrieval nos traces (item #4)

Os spans RAG (`rag.retrieve` + subetapas) agora carregam atributos de provenância:

- `request.id` — junta o span RAG ao span LLM pai, ao audit log e à linha `ai_requests`
- `rag.chunk_ids` — array com os IDs dos chunks que fundamentaram a resposta (top 32)
- `rag.chunk_count` — número de chunks recuperados

Isso permite, a partir de um trace no Tempo, inspecionar **quais** chunks foram
recuperados — não apenas **quanto tempo** levou. O fluxo de depuração fica:
pico de latência → exemplar → trace → span `rag.retrieve` → `rag.chunk_ids` →
buscar o conteúdo dos chunks no banco.

**Lacuna conhecida:** a instrumentação de subetapas (`RAGTimer` / `ragSubstepMetrics`)
ainda não está wired no `RetrievalService.retrieve()` — os spans são emitidos apenas
quando um caller cria um timer e chama `finish()` com `traceId`. Quando a Seção 16
(RAG/evals) do roadmap avançar, instrumentar `retrieve()` com o timer passando
`requestId` e `chunkIds = results.map(r => r.id)`.

## SLOs — avaliação (item #5)

**Decisão: adiar SLOs formais até haver tráfego de produção.**

O roadmap (Seção 16 de `AI_TECHNICAL_AUDIT.md`) classifica observabilidade operacional
como etapa futura, e o sistema ainda não tem tráfego real para estabelecer baselines.
Definir SLOs com error budgets e burn-rate alerts agora seria especulação — os targets
não teriam base empírica.

**O que já existe e cobre o gap de curto prazo:**

`prometheus/alerts.yml` já contém alertas threshold-based que funcionam como "SLOs
infantis" sobre as SLIs naturais do sistema:

| SLI                         | Alerta                          | Threshold      |
| --------------------------- | ------------------------------- | -------------- |
| Latência p95 chamada IA     | `AiCallLatencyHighP95`          | > 15s / 10min  |
| TTFT p95                    | `AiTtftSlowP95`                 | > 10s / 10min  |
| Latência HTTP p95 por rota  | `HttpLatencyHighP95`            | > 5s / 10min   |
| Disponibilidade (5xx)       | `HttpErrorRateHigh`             | > 5% / 10min   |
| Custo por demanda           | `ClassificationCostHighP95`     | > $0,003 / 15m |
| Qualidade (retrabalho)      | `ReworkRateHighByZone`          | > 30% / 30min  |
| Qualidade (alucinação path) | `DocumentHallucinationRateHigh` | > 5% / 1h      |

**Quando houver tráfego, adicionar (não antes):**

1. `prometheus/slo-recording-rules.yml` — recording rules que pré-computam SLIs como
   razões `good/total` (ex: `slo:llm_availability:ratio = 1 - rate(errors[5m])/rate(total[5m])`)
2. `prometheus/slo-burn-rate.yml` — alertas multi-window (1h/5m, 6h/30m, 3d/6h) sobre
   error budget burn, em vez de thresholds fixos
3. Painel "Error budget burn" no dashboard do Grafana
4. Baseline empírico (1–2 semanas de tráfego) para fixar os targets

Os thresholds atuais dos alertas devem ser calibrados contra o baseline real (ver
seção ⚠️ abaixo) antes de serem tratados como acionáveis.

## ⚠️ Calibração de thresholds

Os limiares nas alert rules são **pontos de partida conservadores**. Ajuste-os ao baseline real do projeto (`docs/performance-baseline-*.md`, `docs/baseline.json`) antes de tratar os alertas como acionáveis — caso contrário haverá ruído de falso-positivo.

## Lacunas conhecidas (próximos passos)

- Não há métrica de **taxa de falha de schema** (suporta o item B4) nem de **bloqueio/shadow de guardrail** (suporta C1). Quando B4/C1 avançarem, adicionar 1–2 counters em `server/metrics.ts` e painéis aqui.
