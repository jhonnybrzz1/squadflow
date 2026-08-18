/**
 * Spec 028 (T2) — fonte única das env vars de modelo e sua validação contra a
 * allowlist de governança.
 *
 * As env vars de modelo eram lidas de forma espalhada por `process.env` em vários
 * serviços, sem nenhuma validação contra `ALLOWED_MODELS`. Foi por isso que ids
 * da era Bedrock (ex.: `qwen.qwen3-next-80b-a3b`) passaram despercebidos no `.env`
 * mesmo com a suíte verde (achados A-06/A-10/O-03/O-04 da auditoria 10041).
 *
 * Este módulo centraliza (a) a LISTA nomeada das env vars de modelo com sua
 * precedência real de resolução e (b) a checagem contra a allowlist — reusada
 * tanto pelo teste G-01 quanto pelo validador de boot (report mode).
 */
import { isAliasGoverned } from './model-governance';
import { logger } from '../utils/logger';

/** Default de `XIAOMI_PRO_MODEL` em `llm-model-router.ts` (espelhado aqui). */
const XIAOMI_PRO_DEFAULT = 'mimo-v2.5-pro';

export interface ModelEnvVar {
  /** Nome da variável "dona" (a que aparece no log/relatório). */
  name: string;
  /** Resolve o id efetivo na MESMA precedência que o código de produção usa. */
  resolve: (env: NodeJS.ProcessEnv) => string;
}

/**
 * Fonte da verdade: cada env var de modelo e como ela é resolvida em produção.
 * A precedência espelha exatamente os call sites (ver comentários por linha).
 */
export const MODEL_ENV_VARS: readonly ModelEnvVar[] = [
  {
    // cost-routing.ts / llm-model-router.ts
    name: 'OPENROUTER_MODEL_PRIMARY',
    resolve: (e) => e.OPENROUTER_MODEL_PRIMARY || 'deepseek/deepseek-v4-pro',
  },
  {
    // ai-squad/document-generation-prompts.ts
    name: 'PRD_GENERATION_MODEL',
    resolve: (e) =>
      e.PRD_GENERATION_MODEL || e.PRODUCT_MANAGER_MODEL || e.XIAOMI_MODEL_PRO || XIAOMI_PRO_DEFAULT,
  },
  {
    name: 'PRODUCT_MANAGER_MODEL',
    resolve: (e) => e.PRODUCT_MANAGER_MODEL || e.XIAOMI_MODEL_PRO || XIAOMI_PRO_DEFAULT,
  },
  {
    // semantic-injection-classifier.ts
    name: 'GUARDRAIL_INJECTION_MODEL',
    resolve: (e) => e.GUARDRAIL_INJECTION_MODEL || 'deepseek/deepseek-v4-flash',
  },
  {
    name: 'GUARDRAIL_INJECTION_FALLBACK_MODEL',
    resolve: (e) => e.GUARDRAIL_INJECTION_FALLBACK_MODEL || 'mistral-medium-3.5',
  },
  {
    // ai-squad/document-generator.ts
    name: 'CODE_MODEL',
    resolve: (e) => e.CODE_MODEL || e.OPENAI_MODEL_TECHNICAL || 'qwen/qwen3-coder-next',
  },
];

export interface ResolvedModelEnv {
  varName: string;
  value: string;
  /** true quando a própria variável está setada no ambiente (não é só o default). */
  fromEnv: boolean;
}

export interface ModelConfigIssue extends ResolvedModelEnv {
  /**
   * Offline só conseguimos distinguir "fora da allowlist". Distinguir
   * "inexistente" de "existe mas não permitido" exigiria o catálogo remoto
   * (GET /api/v1/models) — complemento opcional de CI descrito no G-01.
   */
  reason: 'not_in_allowlist';
}

/** Resolve todas as env vars de modelo na precedência real. Puro/testável. */
export function resolveConfiguredModels(env: NodeJS.ProcessEnv = process.env): ResolvedModelEnv[] {
  return MODEL_ENV_VARS.map((v) => ({
    varName: v.name,
    value: v.resolve(env),
    fromEnv: env[v.name] !== undefined,
  }));
}

/** Retorna os modelos configurados que NÃO estão na allowlist de governança. */
export function validateConfiguredModels(env: NodeJS.ProcessEnv = process.env): ModelConfigIssue[] {
  return resolveConfiguredModels(env)
    .filter((r) => !isAliasGoverned(r.value))
    .map((r) => ({ ...r, reason: 'not_in_allowlist' as const }));
}

/**
 * Spec 028 (T8) — validador de boot em MODO ENFORCE por default: qualquer id de
 * modelo fora da allowlist derruba o boot com mensagem acionável. Ausência de env
 * var NUNCA é erro — o default do código vale (fonte única confiável).
 *
 * Opt-out explícito: `MODEL_CONFIG_ENFORCE=false` volta ao modo report (apenas
 * loga, não lança) para quem precisar subir com uma config sabidamente inválida.
 *
 * Racional do fail-closed (T8): o modo report deixava passar silenciosamente um
 * override de shell velho (`~/.zshrc` exportando CODE_MODEL de era anterior) que
 * fazia a geração de código rodar num modelo fora da allowlist. Enforce grita.
 */
export function reportModelConfigAtBoot(env: NodeJS.ProcessEnv = process.env): ModelConfigIssue[] {
  const issues = validateConfiguredModels(env);
  if (issues.length === 0) {
    logger.info('[MODEL_CONFIG] Todas as env vars de modelo estão na allowlist');
    return issues;
  }

  for (const issue of issues) {
    logger.error('[MODEL_CONFIG] Modelo configurado fora da allowlist', {
      context: {
        variable: issue.varName,
        value: issue.value,
        fromEnv: issue.fromEnv,
        reason: issue.reason,
      },
    });
  }

  // Enforce é o default; só `=== 'false'` faz opt-out para o modo report.
  if (env.MODEL_CONFIG_ENFORCE !== 'false') {
    const names = issues.map((i) => `${i.varName}=${i.value}`).join(', ');
    throw new Error(
      `[MODEL_CONFIG] ${issues.length} modelo(s) fora da allowlist (enforce): ${names}. ` +
        `Corrija a env var ou o override de shell (~/.zshrc); ` +
        `use MODEL_CONFIG_ENFORCE=false para subir mesmo assim (modo report).`,
    );
  }
  return issues;
}
