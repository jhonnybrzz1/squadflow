<!--
Última atualização: 28/07/2026 — se precisar de automação, extrair via regex primeiro
Referências: [0]
-->

# Modelos suportados

Documento centralizado dos modelos/provedores usados pelo AiChatFlow1. Cada entrada indica as capacidades observadas no código e nos agentes: `code` (tarefas técnicas/código), `data` (análise de dados/evidências) e `routing` (classificação/escolha/fallback).

> **Aviso:** a fonte da verdade continua sendo `server/services/model-governance.ts` (`ALLOWED_MODELS`), `server/services/llm-client-manager.ts` (`AIProvider`) e os arquivos `agents/*.yaml`. Este arquivo é um paliativo manual enquanto o registry não é centralizado.

---

## Resumo por provedor

| Provedor   | Cliente nativo? | Chave de ambiente      | Modelos listados abaixo |
| ---------- | --------------- | ---------------------- | ----------------------- |
| OpenAI     | Sim             | `OPENAI_API_KEY`       | 10                      |
| Mistral    | Sim             | `MISTRAL_API_KEY`      | 3                       |
| OpenRouter | Sim             | `OPENROUTER_API_KEY`   | 17                      |
| NVIDIA     | Sim             | `NVIDIA_API_KEY`       | 0                       |
| Xiaomi     | Sim             | `XIAOMI_API_KEY`       | 2                       |
| Codex      | Sim             | `CODEX_API_KEY`        | 0                       |
| Tencent    | Sim             | `TENCENT_TOKENHUB_KEY` | 4                       |

> **Nota:** o handoff original e o código-fonte (`AIProvider` em `server/services/llm-client-manager.ts`) definem 7 provedores com clientes inicializados. Apenas `OpenRouter`, `Mistral`, `Xiaomi`, `Tencent`, `OpenAI` possuem modelos em uso no hot path. `NVIDIA` e `Codex` têm clientes configuráveis, mas não constam na allowlist de governança atual.

---

## OpenAI

Cliente nativo, roteado diretamente pela API OpenAI.

| Modelo                   | Code | Data | Routing | Observação                                     |
| ------------------------ | ---- | ---- | ------- | ---------------------------------------------- |
| `gpt-4o`                 | ❌   | ✅   | ❌      | Capacidade de dados/análise (preço tabela).    |
| `gpt-4o-mini`            | ❌   | ✅   | ❌      | Versão econômica para análise leve.            |
| `gpt-4.1`                | ❌   | ✅   | ❌      | Sucessor da série GPT-4.                       |
| `gpt-4.1-mini`           | ❌   | ✅   | ❌      | Versão compacta da linha 4.1.                  |
| `gpt-5.4-nano`           | ❌   | ❌   | ✅      | Roteamento econômico (`MODEL_NANO` fallback).  |
| `gpt-5.4-mini`           | ❌   | ❌   | ✅      | Roteamento adaptativo (`MODEL_MINI` fallback). |
| `o1`                     | ✅   | ❌   | ❌      | Reasoning, mapeado como `behavior: reasoning`  |
| `o3`                     | ✅   | ❌   | ❌      | Reasoning, mapeado como `behavior: reasoning`  |
| `o3-mini`                | ✅   | ❌   | ❌      | Reasoning leve.                                |
| `text-embedding-3-small` | ❌   | ✅   | ❌      | Embeddings para RAG.                           |
| `text-embedding-3-large` | ❌   | ✅   | ❌      | Embeddings mais densos para RAG.               |

---

## Mistral

Cliente nativo na API Mistral; modelos prefixados sem namespace.

| Modelo               | Code | Data | Routing | Observação                                             |
| -------------------- | ---- | ---- | ------- | ------------------------------------------------------ |
| `codestral-latest`   | ✅   | ❌   | ❌      | Fallback de código para agentes técnicos (`qa`, etc.). |
| `mistral-medium-3.5` | ✅   | ❌   | ✅      | Frontier-class, usado como fallback geral.             |
| `mistral-small-2603` | ❌   | ❌   | ✅      | Fallback econômico.                                    |

---

## OpenRouter

Cliente que consome catálogo OpenRouter (`https://openrouter.ai/api/v1/models`). Provedor agregador para diversas famílias.

| Modelo                       | Code | Data | Routing | Observação                                                    |
| ---------------------------- | ---- | ---- | ------- | ------------------------------------------------------------- |
| `deepseek/deepseek-v4-pro`   | ❌   | ✅   | ✅      | Análise e roteamento; fallback do PM/PO.                      |
| `deepseek/deepseek-v4-flash` | ❌   | ✅   | ✅      | Fast/economic; `FAST_MODEL`, `DEFAULT_MODELS.simple`.         |
| `deepseek/deepseek-r1`       | ✅   | ❌   | ❌      | Reasoning (`llm-model-router.ts` `modelConfigs`).             |
| `qwen/qwen3-coder-next`      | ✅   | ❌   | ❌      | Code tasks (`qa`, `architect`, `security`, `financial`).      |
| `qwen/qwen3-coder`           | ✅   | ❌   | ❌      | Variante 480B de Qwen3 Coder.                                 |
| `qwen/qwen3.7-max`           | ✅   | ❌   | ❌      | Tech Lead atual (`ai-model-policy.ts`).                       |
| `qwen/qwen3-coder-flash`     | ✅   | ❌   | ❌      | Alternativa econômica de Qwen.                                |
| `z-ai/glm-5.2`               | ✅   | ❌   | ❌      | Flagship reasoning via Tencent/OpenRouter.                    |
| `z-ai/glm-4.7-flash`         | ❌   | ✅   | ✅      | Scrum Master e UX Designer.                                   |
| `minimax/minimax-m3`         | ❌   | ✅   | ❌      | UX Designer (`ai-model-policy.ts`).                           |
| `minimax/minimax-m2.7`       | ❌   | ✅   | ❌      | Alternativa MiniMax.                                          |
| `minimax/minimax-m2.5`       | ❌   | ✅   | ❌      | Analista de Dados.                                            |
| `moonshotai/kimi-k2.6`       | ❌   | ✅   | ❌      | Kimi K2.6 fallback.                                           |
| `moonshotai/kimi-k2.5`       | ❌   | ✅   | ❌      | Kimi K2.5 deprecated.                                         |
| `xiaomi/mimo-v2.5-pro`       | ❌   | ❌   | ✅      | Espelho OpenRouter; **bloqueado pela governança**.            |
| `xiaomi/mimo-v2.5`           | ❌   | ❌   | ✅      | Espelho OpenRouter do MiMo multimodal.                        |
| `google/gemma-4-31b-it`      | ❌   | ✅   | ❌      | Modelo legado de PM.                                          |
| `inclusionai/ling-2.6-flash` | ❌   | ✅   | ❌      | Variante econômica do catálogo.                               |
| `inclusionai/ling-2.6-1t`    | ❌   | ✅   | ❌      | Variante maior do catálogo.                                   |
| `openrouter/free`            | ❌   | ❌   | ✅      | Modelo free genérico do OpenRouter (rate-limit imprevisível). |

---

## Tencent

Cliente nativo para Tencent TokenHub. Resolve ids sem prefixo quando roteado.

| Modelo                     | Code | Data | Routing | Observação                                        |
| -------------------------- | ---- | ---- | ------- | ------------------------------------------------- |
| `deepseek-v4-pro-202606`   | ❌   | ✅   | ✅      | DeepSeek V4 Pro resolvido via Tencent TokenHub.   |
| `deepseek-v4-flash-202605` | ❌   | ✅   | ✅      | DeepSeek V4 Flash resolvido via Tencent TokenHub. |
| `glm-5.2`                  | ❌   | ❌   | ✅      | GLM-5.2 flagship reasoning.                       |
| `kimi-k2.6`                | ❌   | ✅   | ❌      | Moonshot Kimi K2.6 via Tencent.                   |

---

## Xiaomi

Cliente nativo MiMo. Modelos roteados SEMPRE pela chave nativa (`ALLOWED_MODELS` bloqueia o espelho OpenRouter).

| Modelo          | Code | Data | Routing | Observação                                       |
| --------------- | ---- | ---- | ------- | ------------------------------------------------ |
| `mimo-v2.5-pro` | ✅   | ✅   | ❌      | PM/PO pro-tier, análise e geração de documentos. |
| `mimo-v2.5`     | ❌   | ✅   | ❌      | MiMo-V2.5 multimodal.                            |

---

## NVIDIA

Cliente nativo para `https://integrate.api.nvidia.com/v1`. Nenhum modelo consta na `ALLOWED_MODELS` atual; capaz de hospedar modelos NVIDIA NIM, mas não está no hot path.

| Modelo | Code | Data | Routing | Observação                          |
| ------ | ---- | ---- | ------- | ----------------------------------- |
| —      | —    | —    | —       | Nenhum modelo listado na allowlist. |

---

## Codex

Cliente nativo com `baseURL` configurável (`CODEX_BASE_URL`). Nenhum modelo consta na `ALLOWED_MODELS` atual.

| Modelo | Code | Data | Routing | Observação                          |
| ------ | ---- | ---- | ------- | ----------------------------------- |
| —      | —    | —    | —       | Nenhum modelo listado na allowlist. |

---

## Referências

- `server/services/llm-client-manager.ts` — definição de `AIProvider` e inicialização de clientes.
- `server/services/model-governance.ts` — `ALLOWED_MODELS` (contrato v1.1.0).
- `server/services/llm-model-router.ts` — `DEFAULT_MODELS` e `modelConfigs`.
- `agents/*.yaml` — alocação por agente.
- `docs/analysis/models-baseline.md` — análise detalhada usada como fonte.

---

## Atualização

- Quando adicionar/remover um modelo ou provedor, atualize este arquivo na mesma PR.
- Se o contador de referências atingir ≥5 em 2 semanas, crie uma demanda para automação via regex.
- Se <3 em 2 semanas, mantenha manual.
