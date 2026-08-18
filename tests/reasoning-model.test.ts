import { describe, it, expect } from 'vitest';
import {
  getModelConfig,
  cleanReasoningPrompt,
  buildPrompt,
  buildDemandRefinementPrompt,
  buildEvaluationPrompt,
} from '../server/services/llm-model-router';

describe('Reasoning Model Adjustment Tests', () => {
  describe('getModelConfig & Fallback', () => {
    it('deve retornar a configuração correta para um modelo de raciocínio cadastrado (ex: openai/o3)', () => {
      const config = getModelConfig('openai/o3');
      expect(config.behavior).toBe('reasoning');
      expect(config.supportsReasoning).toBe(true);
      expect(config.defaultTemperature).toBe(0.2);
    });

    it('deve retornar behavior standard para modelos comuns não cadastrados (fallback)', () => {
      const config = getModelConfig('gpt-4o-mini');
      expect(config.behavior).toBe('standard');
      expect(config.supportsReasoning).toBe(false);
    });

    it('deve inferir behavior reasoning para modelo não cadastrado que contém heurísticas (ex: custom-r1)', () => {
      const config = getModelConfig('custom-r1-model');
      expect(config.behavior).toBe('reasoning');
      expect(config.supportsReasoning).toBe(true);
    });

    it('deve inferir behavior reasoning para formatos de modelos do OpenRouter (ex: openai/o1-mini, anthropic/claude-3-7-sonnet:thinking)', () => {
      const configO1Mini = getModelConfig('openai/o1-mini');
      expect(configO1Mini.behavior).toBe('reasoning');
      expect(configO1Mini.supportsReasoning).toBe(true);

      const configThinking = getModelConfig('anthropic/claude-3-7-sonnet:thinking');
      expect(configThinking.behavior).toBe('reasoning');
      expect(configThinking.supportsReasoning).toBe(true);
    });
  });

  describe('cleanReasoningPrompt', () => {
    it('deve remover expressões clássicas de chain-of-thought', () => {
      const prompt =
        'Gere o relatório. Pense passo a passo. Explique seu raciocínio. Mostre sua cadeia de pensamento.';
      const cleaned = cleanReasoningPrompt(prompt);
      expect(cleaned).not.toContain('Pense passo a passo');
      expect(cleaned).not.toContain('Explique seu raciocínio');
      expect(cleaned).not.toContain('Mostre sua cadeia de pensamento');
      expect(cleaned.trim()).toBe('Gere o relatório.');
    });

    it('deve remover a seção inteira de PROCESSO DE RACIOCÍNIO (Chain-of-Thought)', () => {
      const prompt = `Você é um Product Manager.
# PROCESSO DE RACIOCÍNIO (Chain-of-Thought)
1. Analise o valor.
2. Defina escopo.
---
Agora faça a tarefa.`;
      const cleaned = cleanReasoningPrompt(prompt);
      expect(cleaned).not.toContain('PROCESSO DE RACIOCÍNIO');
      expect(cleaned).not.toContain('Analise o valor');
      expect(cleaned).toContain('Você é um Product Manager.');
      expect(cleaned).toContain('Agora faça a tarefa.');
    });
  });

  describe('buildPrompt', () => {
    const inputMock = {
      objective: 'Analisar uma demanda.',
      context: 'Temos uma funcionalidade com problemas.',
      constraints: ['Não invente dados.', 'Pense passo a passo.'],
      successCriteria: ['Retorne o JSON.', 'Explique seu raciocínio.'],
      expectedOutput: 'JSON contendo o diagnóstico.',
    };

    it('deve gerar prompt estruturado de reasoning e livre de CoT para modelos de raciocínio', () => {
      const config = getModelConfig('openai/o3');
      const prompt = buildPrompt(inputMock, config);

      expect(prompt).toContain('Objetivo:');
      expect(prompt).toContain('Contexto:');
      expect(prompt).toContain('Restrições:');
      expect(prompt).toContain('Critérios de sucesso:');
      expect(prompt).toContain('Saída esperada:');

      // Não deve conter menções de CoT que estavam nas restrições/critérios originais
      expect(prompt).not.toContain('Pense passo a passo');
      expect(prompt).not.toContain('Explique seu raciocínio');
    });

    it('deve gerar prompt standard com CoT se o modelo for standard', () => {
      const config = getModelConfig('gpt-4o');
      const prompt = buildPrompt(inputMock, config);

      expect(prompt).toContain('Você é um agente inteligente operando no sistema.');
      expect(prompt).toContain(
        'Pense passo a passo para garantir a precisão de cada etapa de raciocínio.',
      );
    });
  });

  describe('buildDemandRefinementPrompt', () => {
    const demandMock = {
      title: 'Melhorar tela de login',
      description: 'A tela de login está lenta e sem feedback visual.',
      type: 'melhoria',
      priority: 'alta',
    };

    it('deve gerar o prompt de refinamento com os critérios e opções de recomendação final corretos', () => {
      const config = getModelConfig('openai/o3');
      const prompt = buildDemandRefinementPrompt(demandMock, 'Contexto de código...', config);

      // Deve cobrir clareza do problema, usuário impactado, valor, escopo, dependências, riscos, etc.
      expect(prompt).toContain('melhoria');
      expect(prompt).toContain('alta');
      expect(prompt).toContain('Melhorar tela de login');

      // Deve conter a recomendação final de forma estruturada
      expect(prompt).toContain('Recomendação final:');
      expect(prompt).toContain('- Aprovar');
      expect(prompt).toContain('- Devolver para refinamento');
      expect(prompt).toContain('- Quebrar em demandas menores');
      expect(prompt).toContain('- Enviar para análise técnica');
    });
  });

  describe('buildEvaluationPrompt', () => {
    const demandMock = {
      title: 'Melhorar tela de login',
      description: 'A tela de login está lenta e sem feedback visual.',
      type: 'melhoria',
      priority: 'alta',
    };

    it('deve gerar o prompt de avaliação contendo rubricas objetivas de avaliação', () => {
      const config = getModelConfig('openai/o3');
      const prompt = buildEvaluationPrompt(
        demandMock,
        'Refinamento consolidado da squad...',
        config,
      );

      expect(prompt).toContain('Rubrica de Avaliação:');
      expect(prompt).toContain('- Clareza do problema: [Nota 0-10]');
      expect(prompt).toContain('- Valor de negócio: [Nota 0-10]');
      expect(prompt).toContain('- Escopo delimitado: [Nota 0-10]');
      expect(prompt).toContain('- Critérios de aceite: [Nota 0-10]');
      expect(prompt).toContain('Recomendação final:');
    });
  });
});
