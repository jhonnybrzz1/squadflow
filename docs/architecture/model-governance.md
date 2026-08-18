# Inventário e governança de modelos

A whitelist é um limite de segurança, não um retrato apenas dos YAMLs. Modelos podem ser usados por agentes, fallbacks, roteamento por tarefa, variáveis de ambiente, avaliações e guardrails.

| Categoria                       | Modelos/regras atuais                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentes ativos                  | `deepseek/deepseek-v4-pro`, `qwen/qwen3-coder-next`, `qwen/qwen3-coder`, `xiaomi/mimo-v2.5-pro`, `mimo-v2.5-pro`, `mimo-v2.5`, `z-ai/glm-5.2`, `z-ai/glm-4.7-flash`, `minimax/minimax-m3`, `minimax/minimax-m2.7`   |
| Fallbacks declarados            | `mistral-medium-3.5`, `mistral-small-2603`, `codestral-latest`                                                                                                                                                      |
| Operações econômicas/guardrails | `deepseek/deepseek-v4-flash`, `mistral-medium-3.5`                                                                                                                                                                  |
| Compatibilidade/aliases         | `mistral-medium-latest`→`mistral-medium-3.5`, `mistral-medium-2604`→`mistral-medium-3.5`, `mistral-large-latest`→`mistral-medium-3.5`, `mistral-large-3`→`mistral-medium-3.5`, `codestral-25.08`→`codestral-latest` |

## Antes de remover um modelo

- Buscar em `agents/*.yaml`, roteadores, testes e prompts de avaliação.
- Verificar defaults e overrides de ambiente (`FAST_MODEL`, `CAPABLE_MODEL`, `OPENROUTER_MODEL_PRIMARY`, `ROUTING_SAFE_MODEL`, modelos Mistral e guardrails).
- Verificar aliases normalizados em `llm-model-router.ts`.
- Confirmar telemetria de uso em produção.
- Executar testes negativos de governança e evals relevantes.

Modelos marcados como legacy permanecem permitidos até existir telemetria suficiente para provar desuso. Ausência nos YAMLs, isoladamente, não autoriza remoção.
