/**
 * Spec 028 / T7 — paridade entre `ai-model-policy.ts` e `agents/*.yaml`.
 *
 * A policy é a fonte da verdade do caminho NÃO-streaming (`openai-ai.ts:226`),
 * mas o caminho de streaming não a aplica: ele usa o modelo do YAML. Quando as
 * duas divergem, o mesmo agente responde com modelos diferentes conforme a
 * resposta seja streamada ou não — foi exatamente o que aconteceu com o UX
 * Designer (achados A-01/R-02 da auditoria 10041).
 *
 * Este teste é o que faltava para a divergência não passar despercebida.
 * Detalhes em `docs/analysis/models-baseline.md`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { canonicalAgentKey } from '../../server/services/agent-identity';
import { AGENT_MODEL_TABLE } from '../../server/services/ai-model-policy';
import { XIAOMI_PRO_MODEL, PRO_TIER_FALLBACK_MODEL } from '../../server/services/llm-model-router';
import { ALLOWED_MODELS } from '../../server/services/model-governance';

const AGENTS_DIR = resolve(__dirname, '../../agents');

/**
 * Divergências intencionais entre policy e YAML. Manter VAZIO por padrão:
 * cada entrada aqui é um agente que responde com modelos diferentes conforme o
 * transporte, e precisa de justificativa explícita.
 */
const DIVERGENCIAS_ACEITAS: Record<string, string> = {};

interface AgentYaml {
  name?: string;
  model?: string;
  model_fallback?: string;
}

function loadAgentYamls(): Array<{ file: string; key: string; config: AgentYaml }> {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('EXAMPLE-'))
    .map((file) => {
      const config = load(readFileSync(resolve(AGENTS_DIR, file), 'utf8')) as AgentYaml;
      return { file, key: canonicalAgentKey(config.name ?? file.replace(/\.yaml$/, '')), config };
    });
}

const agentYamls = loadAgentYamls();

describe('paridade policy x YAML', () => {
  it('encontra os YAMLs de agente', () => {
    expect(agentYamls.length).toBeGreaterThan(0);
  });

  it.each(agentYamls.map((a) => [a.file, a.key] as const))(
    '%s tem entrada na policy',
    (_file, key) => {
      expect(Object.keys(AGENT_MODEL_TABLE)).toContain(key);
    },
  );

  it.each(agentYamls.map((a) => [a.file, a.key, a.config] as const))(
    '%s usa o mesmo modelo na policy e no YAML',
    (file, key, config) => {
      const policy = AGENT_MODEL_TABLE[key];
      if (!policy) return; // coberto pelo teste anterior

      if (DIVERGENCIAS_ACEITAS[key]) {
        expect(policy.model).not.toBe(config.model);
        return;
      }

      // PM/PO usam a constante do MiMo nativo, que resolve para o id do YAML.
      const expected = config.model === XIAOMI_PRO_MODEL ? XIAOMI_PRO_MODEL : config.model;

      expect(policy.model, `divergência em ${file} (chave "${key}")`).toBe(expected);
    },
  );

  it.each(agentYamls.map((a) => [a.file, a.key, a.config] as const))(
    '%s usa o mesmo fallback na policy e no YAML',
    (file, key, config) => {
      const policy = AGENT_MODEL_TABLE[key];
      if (!policy || DIVERGENCIAS_ACEITAS[key]) return;

      const expected =
        config.model_fallback === PRO_TIER_FALLBACK_MODEL
          ? PRO_TIER_FALLBACK_MODEL
          : config.model_fallback;

      expect(policy.modelFallback, `fallback divergente em ${file}`).toBe(expected);
    },
  );

  it('não há entrada na policy sem YAML correspondente', () => {
    const yamlKeys = new Set(agentYamls.map((a) => a.key));
    const orfas = Object.keys(AGENT_MODEL_TABLE).filter((k) => !yamlKeys.has(k));

    expect(orfas, `entradas na policy sem YAML: ${orfas.join(', ')}`).toEqual([]);
  });
});

describe('governança dos modelos alocados', () => {
  const allowed = new Set<string>(ALLOWED_MODELS.map((m) => m.toLowerCase()));

  it.each(Object.entries(AGENT_MODEL_TABLE))('%s usa modelo permitido', (_key, allocation) => {
    expect(allowed).toContain(allocation.model.toLowerCase());
    expect(allowed).toContain(allocation.modelFallback.toLowerCase());
  });
});

describe('UX Designer, Scrum Master e Anti-Overengineering (TokenHub)', () => {
  it('resolvem para glm-5.2 via Tencent TokenHub', () => {
    const ux = agentYamls.find((a) => a.key === 'ux');
    const scrum = agentYamls.find((a) => a.key === 'scrum_master');
    const anti = agentYamls.find((a) => a.key === 'anti_overengineering');

    expect(ux?.config.model).toBe('glm-5.2');
    expect(AGENT_MODEL_TABLE.ux.model).toBe('glm-5.2');
    expect(scrum?.config.model).toBe('glm-5.2');
    expect(anti?.config.model).toBe('glm-5.2');
  });
});

describe('Analista de Dados (TokenHub)', () => {
  it('resolve para minimax-m3 nativo via Tencent TokenHub', () => {
    const data = agentYamls.find((a) => a.key === 'analista_de_dados');

    expect(data?.config.model).toBe('minimax-m3');
    expect(AGENT_MODEL_TABLE.analista_de_dados.model).toBe('minimax-m3');
  });
});
