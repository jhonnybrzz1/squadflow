import { describe, expect, it } from 'vitest';
import {
  applyDiscPersonalityToAgentConfigs,
  applyPmInnovationAgentActivation,
  applyPmInnovationToProductManager,
  buildPmInnovationPromptBlock,
  detectPmInnovationTrigger,
  normalizePersonalityTraits,
  PM_INNOVATION_AGENT_KEY,
} from '../server/services/disc-personality';

describe('DISC personalization and PM innovation activation', () => {
  it('detects AI innovation keywords without matching short tokens inside other words', () => {
    const triggered = detectPmInnovationTrigger({
      title: 'Automatizar relatorios',
      description: 'Usar IA para sumarizar os dados do cliente.',
    });
    const notTriggered = detectPmInnovationTrigger({
      title: 'Melhorar diario de bordo',
      description: 'Ajustar texto e layout sem recurso inteligente.',
    });

    expect(triggered.triggered).toBe(true);
    expect(triggered.matchedKeywords).toEqual(expect.arrayContaining(['IA', 'automatizar']));
    expect(notTriggered.matchedKeywords).not.toContain('IA');
  });

  it('turns conflicting DISC traits into a balanced tone instruction', () => {
    const instruction = normalizePersonalityTraits({
      paciencia: { natural: 40, adapted: 83 },
      planejamento: { natural: 80, adapted: 70 },
      prudencia: { natural: 70, adapted: 80 },
      sociabilidade: { natural: 95, adapted: 90 },
    });

    expect(instruction).toContain('Facilitador-Comunicador');
    expect(instruction).toContain('conciso mas completo');
    expect(instruction).toContain('sequencia clara');
    expect(instruction).toContain('riscos principais');
  });

  it('injects DISC personality into system_prompt without mutating the base config', () => {
    const base = {
      product_owner: {
        system_prompt: 'Base prompt',
        description: 'PO',
      },
    };

    const result = applyDiscPersonalityToAgentConfigs(base);

    expect(result.applied).toBe(true);
    expect(result.configs.product_owner.system_prompt).toContain('PERSONALIZACAO DISC DO PO');
    expect(base.product_owner.system_prompt).toBe('Base prompt');
  });

  it('adds PM innovation after Product Owner only when the trigger fires', () => {
    const scoped = {
      product_owner: { system_prompt: 'PO', description: 'PO' },
      qa: { system_prompt: 'QA', description: 'QA' },
    };
    const all = {
      ...scoped,
      [PM_INNOVATION_AGENT_KEY]: {
        system_prompt: 'PM IA',
        description: 'PM IA',
      },
    };

    const activated = applyPmInnovationAgentActivation(scoped, all, {
      triggered: true,
      matchedKeywords: ['IA'],
      confidence: 0.8,
    });
    const inactive = applyPmInnovationAgentActivation(
      { ...scoped, [PM_INNOVATION_AGENT_KEY]: all[PM_INNOVATION_AGENT_KEY] },
      all,
      {
        triggered: false,
        matchedKeywords: [],
        confidence: 0,
      },
    );

    expect(Object.keys(activated)).toEqual(['product_owner', PM_INNOVATION_AGENT_KEY, 'qa']);
    expect(Object.keys(inactive)).toEqual(['product_owner', 'qa']);
  });

  it('builds PM innovation prompt block when AI keywords are present', () => {
    const block = buildPmInnovationPromptBlock(
      { title: 'Automação com IA', description: 'Usar LLM para classificar demandas.' },
      { system_prompt: 'PM Innovation prompt', description: 'PM IA' },
    );

    expect(block).toContain('MODO PM INNOVATION');
    expect(block).toContain('PM Innovation prompt');
    expect(block).toContain('IA');
  });

  it('returns empty PM innovation block when no AI keywords are present', () => {
    const block = buildPmInnovationPromptBlock(
      { title: 'Ajustar layout', description: 'Melhorar cores e espaçamento.' },
      { system_prompt: 'PM Innovation prompt', description: 'PM IA' },
    );

    expect(block).toBe('');
  });

  it('injects PM innovation into product_manager prompt when triggered', () => {
    const productManager = {
      system_prompt: 'Product Manager prompt',
      description: 'PM',
    };
    const pmInnovation = {
      system_prompt: 'PM Innovation prompt',
      description: 'PM IA',
    };
    const demand = { title: 'Automação com IA', description: 'Usar LLM.' };

    const result = applyPmInnovationToProductManager(productManager, demand, pmInnovation);

    expect(result).toBeDefined();
    expect(result!.system_prompt).toContain('Product Manager prompt');
    expect(result!.system_prompt).toContain('PM Innovation prompt');
    expect(result!.system_prompt).toContain('MODO PM INNOVATION');
  });

  it('does not duplicate PM innovation marker when already present', () => {
    const productManager = {
      system_prompt: 'Product Manager prompt\n\n--- MODO PM INNOVATION (IA/Automação) ---',
      description: 'PM',
    };
    const pmInnovation = {
      system_prompt: 'PM Innovation prompt',
      description: 'PM IA',
    };
    const demand = { title: 'Automação com IA', description: 'Usar LLM.' };

    const result = applyPmInnovationToProductManager(productManager, demand, pmInnovation);

    expect(result).toBe(productManager);
    expect(result!.system_prompt).not.toContain('PM Innovation prompt');
  });
});
