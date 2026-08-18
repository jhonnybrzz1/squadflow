# Agentes YAML

Este diretório contém as configurações dos agentes do roundtable. Cada arquivo `.yaml` segue o schema validado em CI.

## Schema v1

| Campo            | Tipo     | Descrição                        |
| ---------------- | -------- | -------------------------------- |
| `version`        | `string` | Versão do agente (ex.: `1.0.0`). |
| `name`           | `string` | Nome legível do agente.          |
| `description`    | `string` | Descrição curta do papel.        |
| `model`          | `string` | Modelo principal.                |
| `model_fallback` | `string` | Modelo fallback.                 |
| `temperature`    | `number` | Temperatura (0–2).               |
| `max_tokens`     | `number` | Máximo de tokens (1–16384).      |
| `system_prompt`  | `string` | Prompt de sistema completo.      |

## Validação

```bash
npm run validate:agents
```

O CI roda este script a cada PR; YAMLs inválidos bloqueiam o merge.

## Campos opcionais futuros

- `schemaVersion`: versionamento explícito do schema (v2).
- Campos específicos por `role` (discriminated union) se os agentes divergirem.
