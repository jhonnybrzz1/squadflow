/**
 * Spec 028 (T1) — testes que capturam os defeitos de configuração de modelo.
 *
 * G-01 (achados A-06/A-10/O-03/O-04 da auditoria 10041): nenhum teste resolvia
 * as env vars de modelo do `.env` REAL e as conferia contra `ALLOWED_MODELS`.
 * Antes da correção (T3), este teste FALHA por causa de ids da era Bedrock
 * (`qwen.qwen3-next-80b-a3b`, `zai.glm-5`) em OPENROUTER_MODEL_PRIMARY,
 * PRD_GENERATION_MODEL, PRODUCT_MANAGER_MODEL e as duas GUARDRAIL_INJECTION_*.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  MODEL_ENV_VARS,
  reportModelConfigAtBoot,
  resolveConfiguredModels,
  validateConfiguredModels,
} from '../../server/services/model-config-validation';

/** Carrega o `.env` real por cima do process.env (mesma precedência do runtime). */
function loadRealEnv(): NodeJS.ProcessEnv {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return { ...process.env };
  const parsed = dotenv.parse(readFileSync(envPath));
  return { ...process.env, ...parsed };
}

describe('Spec 028 G-01 — env vars de modelo × ALLOWED_MODELS', () => {
  it('todo modelo resolvido do .env real está na allowlist de governança', () => {
    const env = loadRealEnv();
    const issues = validateConfiguredModels(env);
    const detail = issues.map((i) => `${i.varName}=${i.value}`).join(', ');
    expect(issues, `Modelos fora da allowlist: ${detail}`).toEqual([]);
  });

  it('os defaults do código (sem env) são todos válidos — fonte única confiável', () => {
    // Ambiente vazio => só os defaults hardcoded. Nunca deve produzir issue.
    const issues = validateConfiguredModels({});
    expect(issues).toEqual([]);
  });

  it('a lista de env vars cobre as variáveis auditadas', () => {
    const names = MODEL_ENV_VARS.map((v) => v.name);
    for (const required of [
      'OPENROUTER_MODEL_PRIMARY',
      'PRD_GENERATION_MODEL',
      'PRODUCT_MANAGER_MODEL',
      'GUARDRAIL_INJECTION_MODEL',
      'GUARDRAIL_INJECTION_FALLBACK_MODEL',
      'CODE_MODEL',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('resolveConfiguredModels marca fromEnv corretamente', () => {
    const withEnv = resolveConfiguredModels({
      OPENROUTER_MODEL_PRIMARY: 'deepseek/deepseek-v4-pro',
    });
    const primary = withEnv.find((r) => r.varName === 'OPENROUTER_MODEL_PRIMARY');
    expect(primary?.fromEnv).toBe(true);
    const noEnv = resolveConfiguredModels({});
    expect(noEnv.find((r) => r.varName === 'OPENROUTER_MODEL_PRIMARY')?.fromEnv).toBe(false);
  });
});

describe('Spec 028 T8 — reportModelConfigAtBoot em modo enforce por default', () => {
  const BAD = { OPENROUTER_MODEL_PRIMARY: 'qwen.qwen3-next-80b-a3b' }; // id era-Bedrock, fora da allowlist

  it('config limpa (só defaults) não lança e não gera issue', () => {
    expect(() => reportModelConfigAtBoot({})).not.toThrow();
    expect(reportModelConfigAtBoot({})).toEqual([]);
  });

  it('enforce é o DEFAULT: id inválido derruba o boot mesmo sem MODEL_CONFIG_ENFORCE', () => {
    expect(() => reportModelConfigAtBoot({ ...BAD })).toThrow(/fora da allowlist/);
  });

  it('MODEL_CONFIG_ENFORCE=false faz opt-out: loga mas não lança (modo report)', () => {
    let issues: ReturnType<typeof reportModelConfigAtBoot> = [];
    expect(() => {
      issues = reportModelConfigAtBoot({ ...BAD, MODEL_CONFIG_ENFORCE: 'false' });
    }).not.toThrow();
    expect(issues.map((i) => i.varName)).toContain('OPENROUTER_MODEL_PRIMARY');
  });

  it('qualquer valor que não seja "false" mantém o enforce (ex.: "true", "0", vazio)', () => {
    for (const v of ['true', '0', '', 'no']) {
      expect(() => reportModelConfigAtBoot({ ...BAD, MODEL_CONFIG_ENFORCE: v })).toThrow();
    }
  });
});
