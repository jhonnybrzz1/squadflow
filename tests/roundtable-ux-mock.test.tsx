/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { useRoundtableStream } from '../client/src/hooks/useRoundtableStream';
import { describe, expect, it, vi } from 'vitest';

// Mock the useToast hook to prevent errors during rendering
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

describe('useRoundtableStream - UX Validation (T5)', () => {
  it('handles response, divergence, and missing reference (orphan) correctly with deduplication', () => {
    const { result } = renderHook(() => useRoundtableStream());

    // 1. Resposta Direta
    act(() => {
      result.current.processEvent('roundtable_agent_message', {
        agent_id: 'tech_lead',
        round: 1,
        response_to: 'product_owner',
        type: 'response',
        content: 'Concordo com a visão arquitetural.',
      });
    });

    let contributions = Array.from(result.current.state.contributions.values());
    expect(contributions.length).toBe(1);
    expect(contributions[0].agent).toBe('tech_lead');
    expect(contributions[0].responseTo).toBe('product_owner');
    expect(contributions[0].type).toBe('response');

    // Teste de Deduplicação (Mesmo payload não deve alterar o tamanho do Map)
    act(() => {
      result.current.processEvent('roundtable_agent_message', {
        agent_id: 'tech_lead',
        round: 1,
        response_to: 'product_owner',
        type: 'response',
        content: 'Concordo com a visão arquitetural.',
      });
    });

    contributions = Array.from(result.current.state.contributions.values());
    expect(contributions.length).toBe(1); // Dedup manteve em 1

    // 2. Divergência
    act(() => {
      result.current.processEvent('roundtable_agent_message', {
        agent_id: 'qa',
        round: 1,
        response_to: 'tech_lead',
        type: 'divergence',
        content: 'DIVERGÊNCIA: Os testes não foram cobertos.',
      });
    });

    contributions = Array.from(result.current.state.contributions.values());
    expect(contributions.length).toBe(2);
    expect(contributions[1].agent).toBe('qa');
    expect(contributions[1].type).toBe('divergence');
    expect(contributions[1].hasDivergence).toBe(true);

    // 3. Pergunta com referência ausente (Órfão)
    // "ux_designer" respondendo a "agente_fantasma" que não enviou nada ainda
    act(() => {
      result.current.processEvent('roundtable_agent_message', {
        agent_id: 'ux_designer',
        round: 1,
        response_to: 'agente_fantasma',
        type: 'question',
        content: 'Como fica a acessibilidade dessa tela?',
      });
    });

    contributions = Array.from(result.current.state.contributions.values());
    expect(contributions.length).toBe(3);
    expect(contributions[2].agent).toBe('ux_designer');
    expect(contributions[2].type).toBe('question');
    expect(contributions[2].responseTo).toBe('agente_fantasma');

    // Validação estrutural de que não existe a chave "agente_fantasma" no histórico,
    // ou seja, na UI será interpretado como órfão.
    const isPhantomFound = contributions.some((c) => c.agent === 'agente_fantasma');
    expect(isPhantomFound).toBe(false); // Confirma condição de órfão para renderização
  });
});
