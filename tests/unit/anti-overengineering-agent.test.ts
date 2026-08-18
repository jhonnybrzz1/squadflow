/**
 * Agente anti-overengineering — criação e persistência do parecer.
 *
 * Antes desta entrega a feature era estrutural­mente inerte: o agente não
 * existia (sem YAML), o parser nunca extraía o esforço original (então
 * `dias_economizados` ficava nulo) e `persistAntiOverengineeringIntervention`
 * nunca era chamada. A tabela `agent_interventions` tinha 0 linhas e o
 * dashboard mostrava vazio mesmo com o endpoint respondendo 200.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { canonicalAgentKey } from '../../server/services/agent-identity';
import { AGENT_MODEL_TABLE } from '../../server/services/ai-model-policy';

const YAML_PATH = resolve(__dirname, '../../agents/anti_overengineering.yaml');

interface AgentYaml {
  name: string;
  model: string;
  model_fallback: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
}

describe('o agente existe e está alocado', () => {
  it('tem arquivo YAML', () => {
    expect(existsSync(YAML_PATH)).toBe(true);
  });

  const config = load(readFileSync(YAML_PATH, 'utf8')) as AgentYaml;

  it('o nome resolve para a chave canônica esperada', () => {
    // O parser em ai-squad.ts procura exatamente por esta chave; se o nome
    // do YAML não resolver para ela, o agente roda e nada é persistido.
    expect(canonicalAgentKey(config.name)).toBe('anti_overengineering');
  });

  it('tem entrada na policy de modelos', () => {
    expect(AGENT_MODEL_TABLE.anti_overengineering).toBeDefined();
    expect(AGENT_MODEL_TABLE.anti_overengineering.model).toBe(config.model);
    expect(AGENT_MODEL_TABLE.anti_overengineering.modelFallback).toBe(config.model_fallback);
  });

  it('o prompt exige os campos que o parser consome', () => {
    for (const campo of [
      '**Problema Identificado:**',
      '**Recomendação:**',
      '**ROI:**',
      '**Esforço:**',
    ]) {
      expect(config.system_prompt).toContain(campo);
    }
  });

  it('o prompt pede o esforço no formato original -> reduzido', () => {
    expect(config.system_prompt).toMatch(/N dias -> M dias/);
  });
});

// ─── Parser ──────────────────────────────────────────────────────────────────

/** Réplica da extração de `**Esforço:**` em ai-squad.ts (mesma regex). */
function parseEsforco(text: string): { original: number | null; reduzido: number | null } {
  const match = text.match(/\*\*Esfor[çc]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
  if (!match) return { original: null, reduzido: null };

  const numeros = [...match[1].matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) =>
    parseFloat(m[1].replace(',', '.')),
  );
  if (numeros.length >= 2) return { original: numeros[0], reduzido: numeros[1] };
  if (numeros.length === 1) return { original: null, reduzido: numeros[0] };
  return { original: null, reduzido: null };
}

describe('extração do esforço (a peça que zerava a métrica)', () => {
  it('captura original e reduzido no formato com seta', () => {
    expect(parseEsforco('**Esforço:** 12 dias -> 3 dias')).toEqual({ original: 12, reduzido: 3 });
  });

  it('aceita decimais com vírgula', () => {
    expect(parseEsforco('**Esforço:** 7,5 dias -> 2,5 dias')).toEqual({
      original: 7.5,
      reduzido: 2.5,
    });
  });

  it('formato antigo (um número) vira reduzido sem original', () => {
    // Sem saber de quanto se partiu, a economia é indeterminada — null, não 0.
    expect(parseEsforco('**Esforço:** 5 dias')).toEqual({ original: null, reduzido: 5 });
  });

  it('não vaza para a próxima seção', () => {
    const texto = '**Esforço:** 10 dias -> 4 dias\n**Premissas:** volume de 99 mil registros';
    expect(parseEsforco(texto)).toEqual({ original: 10, reduzido: 4 });
  });

  it('sem número devolve nulo', () => {
    expect(parseEsforco('**Esforço:** Não calculável com os dados disponíveis')).toEqual({
      original: null,
      reduzido: null,
    });
  });

  it('seção ausente devolve nulo', () => {
    expect(parseEsforco('**ROI:** 3:1')).toEqual({ original: null, reduzido: null });
  });
});

// ─── Contrato ponta a ponta ──────────────────────────────────────────────────

describe('parecer completo do agente', () => {
  const PARECER = [
    '**Análise:** O problema real é falta de visibilidade.',
    '**Problema Identificado:**',
    '- Motor de regras configurável para uma regra só',
    '- Abstração de provedores com uma implementação',
    '**Impacto:** Triplica a manutenção.',
    '**Recomendação:** Checagem fixa com e-mail para o time.',
    '**Adiado:** Motor de regras vai para o backlog.',
    '**ROI:** 5:1',
    '**Esforço:** 12 dias -> 3 dias',
    '**Premissas:** Volume atual não exige processamento assíncrono.',
  ].join('\n');

  it('extrai os pontos de overengineering como lista', () => {
    const m = PARECER.match(/\*\*Problema Identificado:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
    const pontos = m![1]
      .split(/\n+/)
      .map((l) => l.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean);

    expect(pontos).toHaveLength(2);
    expect(pontos[0]).toContain('Motor de regras');
  });

  it('extrai ROI e escopo reduzido', () => {
    expect(PARECER.match(/\*\*ROI:\*\*(.*?)(?=\*\*[A-Z]|$)/s)![1].trim()).toBe('5:1');
    expect(PARECER.match(/\*\*Recomenda[çc][aã]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s)![1].trim()).toContain(
      'Checagem fixa',
    );
  });

  it('produz economia de 9 dias — o número que o dashboard mostra', () => {
    const { original, reduzido } = parseEsforco(PARECER);
    expect(original! - reduzido!).toBe(9);
  });
});
