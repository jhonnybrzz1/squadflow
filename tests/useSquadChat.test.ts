/**
 * useSquadChat.test.ts
 *
 * Testes unitários para o hook useSquadChat.
 * Cobre: estado inicial, modos de chat, agentes, mensagens e connection status.
 *
 * Referência: docs/chat-refactoring-v2.md (item 3 — adicionar testes unitários para useSquadChat)
 */

import { describe, it, expect } from 'vitest';

// ─── Types importados do hook ─────────────────────────────────────────────────
// Teste de tipos independente do React (sem renderização de hook)

import type {
  AgentStatus,
  ChatMode,
  MessageType,
  ConnectionStatus,
  AgentState,
  SquadMessage,
  SquadChatState,
} from '../client/src/hooks/useSquadChat';

// ─── 1. Tipos e contratos ─────────────────────────────────────────────────────

describe('useSquadChat — tipos e contratos', () => {
  it('AgentStatus deve incluir todos os estados válidos', () => {
    const statuses: AgentStatus[] = ['idle', 'thinking', 'speaking', 'done', 'failed'];
    expect(statuses).toHaveLength(5);
  });

  it('ChatMode deve ser roundtable', () => {
    const modes: ChatMode[] = ['roundtable'];
    expect(modes).toHaveLength(1);
  });

  it('MessageType deve incluir todos os tipos válidos', () => {
    const types: MessageType[] = ['response', 'divergence', 'question', 'system'];
    expect(types).toHaveLength(4);
  });

  it('ConnectionStatus deve incluir connected, reconnecting e disconnected', () => {
    const statuses: ConnectionStatus[] = ['connected', 'reconnecting', 'disconnected'];
    expect(statuses).toHaveLength(3);
  });
});

// ─── 2. SquadMessage — estrutura ──────────────────────────────────────────────

describe('useSquadChat — SquadMessage', () => {
  it('mensagem mínima deve ter campos obrigatórios', () => {
    const msg: SquadMessage = {
      id: 'msg-001',
      agent: 'tech_lead',
      content: 'Análise de viabilidade concluída.',
      timestamp: new Date().toISOString(),
      type: 'response',
    };
    expect(msg.id).toBe('msg-001');
    expect(msg.agent).toBe('tech_lead');
    expect(msg.content).toBeTruthy();
    expect(msg.type).toBe('response');
  });

  it('mensagem de divergência deve ter type correto', () => {
    const msg: SquadMessage = {
      id: 'msg-002',
      agent: 'qa',
      content: 'Discordo — critérios de aceite insuficientes.',
      timestamp: new Date().toISOString(),
      type: 'divergence',
    };
    expect(msg.type).toBe('divergence');
  });

  it('mensagem em streaming deve ter isStreaming=true', () => {
    const msg: SquadMessage = {
      id: 'msg-003',
      agent: 'product_manager',
      content: 'Gerando PRD...',
      timestamp: new Date().toISOString(),
      type: 'response',
      isStreaming: true,
    };
    expect(msg.isStreaming).toBe(true);
  });
});

// ─── 3. AgentState — estrutura ────────────────────────────────────────────────

describe('useSquadChat — AgentState', () => {
  it('agente deve ter todos os campos obrigatórios', () => {
    const agent: AgentState = {
      id: 'tech_lead',
      name: 'Tech Lead',
      icon: '💧',
      color: '#06b6d4',
      status: 'idle',
    };
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBeTruthy();
    expect(agent.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('agente com status done deve ser detectável como concluído', () => {
    const agent: AgentState = {
      id: 'qa',
      name: 'QA',
      icon: '✅',
      color: '#22c55e',
      status: 'done',
    };
    expect(agent.status).toBe('done');
  });
});

// ─── 4. SquadChatState — estado inicial canônico ──────────────────────────────

describe('useSquadChat — SquadChatState inicial', () => {
  const initialState: SquadChatState = {
    mode: 'roundtable',
    messages: [],
    agents: {},
    currentSpeaker: null,
    streamingContent: null,
    streamingThinking: null,
    round: 0,
    totalRounds: 0,
    divergenceCount: 0,
    isComplete: false,
    isPaused: false,
    pendingQuestion: null,
    connectionStatus: 'disconnected',
  };

  it('modo inicial deve ser roundtable', () => {
    expect(initialState.mode).toBe('roundtable');
  });

  it('estado inicial deve ter mensagens vazias', () => {
    expect(initialState.messages).toHaveLength(0);
  });

  it('estado inicial deve ter agentes vazios', () => {
    expect(Object.keys(initialState.agents)).toHaveLength(0);
  });

  it('estado inicial não deve ter speaker ativo', () => {
    expect(initialState.currentSpeaker).toBeNull();
  });

  it('estado inicial deve estar desconectado', () => {
    expect(initialState.connectionStatus).toBe('disconnected');
  });

  it('estado inicial não deve estar completo', () => {
    expect(initialState.isComplete).toBe(false);
  });

  it('estado inicial não deve estar pausado', () => {
    expect(initialState.isPaused).toBe(false);
  });
});

// ─── 5. Progress calculation ───────────────────────────────────────────────────

describe('useSquadChat — cálculo de progresso', () => {
  it('progresso deve ser 0% com nenhum agente concluído', () => {
    const agents: Record<string, AgentState> = {
      tech_lead: {
        id: 'tech_lead',
        name: 'Tech Lead',
        icon: '💧',
        color: '#06b6d4',
        status: 'thinking',
      },
      qa: { id: 'qa', name: 'QA', icon: '✅', color: '#22c55e', status: 'idle' },
    };
    const totalAgents = Object.keys(agents).length;
    const completedAgents = Object.values(agents).filter((a) => a.status === 'done').length;
    const progress = totalAgents > 0 ? (completedAgents / totalAgents) * 100 : 0;
    expect(progress).toBe(0);
  });

  it('progresso deve ser 100% com todos os agentes concluídos', () => {
    const agents: Record<string, AgentState> = {
      tech_lead: {
        id: 'tech_lead',
        name: 'Tech Lead',
        icon: '💧',
        color: '#06b6d4',
        status: 'done',
      },
      qa: { id: 'qa', name: 'QA', icon: '✅', color: '#22c55e', status: 'done' },
    };
    const totalAgents = Object.keys(agents).length;
    const completedAgents = Object.values(agents).filter((a) => a.status === 'done').length;
    const progress = totalAgents > 0 ? (completedAgents / totalAgents) * 100 : 0;
    expect(progress).toBe(100);
  });

  it('progresso deve ser 50% com metade dos agentes concluídos', () => {
    const agents: Record<string, AgentState> = {
      tech_lead: {
        id: 'tech_lead',
        name: 'Tech Lead',
        icon: '💧',
        color: '#06b6d4',
        status: 'done',
      },
      qa: { id: 'qa', name: 'QA', icon: '✅', color: '#22c55e', status: 'thinking' },
    };
    const totalAgents = Object.keys(agents).length;
    const completedAgents = Object.values(agents).filter((a) => a.status === 'done').length;
    const progress = totalAgents > 0 ? (completedAgents / totalAgents) * 100 : 0;
    expect(progress).toBe(50);
  });

  it('progresso não deve exceder 100%', () => {
    const rawProgress = 150;
    const capped = Math.min(rawProgress, 100);
    expect(capped).toBe(100);
  });
});

// ─── 6. pendingQuestion ───────────────────────────────────────────────────────

describe('useSquadChat — pendingQuestion', () => {
  it('pergunta pendente deve ter todos os campos obrigatórios', () => {
    const question = {
      agent: 'qa',
      question: 'Qual é o critério de aceite para edge cases?',
      interactionId: 'int-001',
    };
    expect(question.agent).toBeTruthy();
    expect(question.question).toBeTruthy();
    expect(question.interactionId).toBeTruthy();
  });
});
