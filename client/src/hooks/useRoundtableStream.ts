import { useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

export type RoundtableAgentStatus = 'waiting' | 'analyzing' | 'done' | 'failed';

export interface RoundtableContribution {
  agent: string;
  round: number;
  message: string;
  hasDivergence: boolean;
  responseTo?: string;
  type?: 'response' | 'divergence' | 'question';
  references?: string[];
  timestamp: string;
}

export interface RoundtableDivergence {
  agent: string;
  round: number;
  text: string;
}

export interface RoundtableState {
  currentRound: number;
  totalRounds: number;
  agentStatuses: Record<string, RoundtableAgentStatus>;
  contributions: Map<string, RoundtableContribution>;
  divergences: RoundtableDivergence[];
  isComplete: boolean;
  agentsFailed: string[];
}

const INITIAL_STATE: RoundtableState = {
  currentRound: 0,
  totalRounds: 0,
  agentStatuses: {},
  contributions: new Map(),
  divergences: [],
  isComplete: false,
  agentsFailed: [],
};

export function useRoundtableStream() {
  const [state, setState] = useState<RoundtableState>(INITIAL_STATE);
  const { toast } = useToast();

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  /** Processa um evento SSE do tipo roundtable_* ou agent_failed */
  const processEvent = useCallback((eventType: string, data: Record<string, unknown>) => {
    switch (eventType) {
      case 'roundtable_round_start': {
        const agents = (data.agents as string[]) || [];
        setState((prev) => ({
          ...prev,
          currentRound: (data.round as number) || 1,
          totalRounds: (data.totalRounds as number) || 0,
          agentStatuses: agents.reduce(
            (acc, a) => ({ ...acc, [a]: 'waiting' as RoundtableAgentStatus }),
            prev.agentStatuses,
          ),
        }));
        break;
      }
      case 'roundtable_agent_start': {
        const agent = data.agent as string;
        setState((prev) => ({
          ...prev,
          agentStatuses: { ...prev.agentStatuses, [agent]: 'analyzing' },
        }));
        break;
      }
      case 'roundtable_agent_message': {
        // Validação do schema nativamente
        if (
          !data.agent_id ||
          typeof data.agent_id !== 'string' ||
          !data.round ||
          typeof data.round !== 'number' ||
          !data.type ||
          typeof data.type !== 'string' ||
          !data.content ||
          typeof data.content !== 'string'
        ) {
          console.warn(
            '[useRoundtableStream] Mensagem incompleta recebida. Exibindo o que foi possível.',
            data,
          );
          toast({
            title: 'Aviso',
            description: 'Mensagem incompleta recebida. Exibindo o que foi possível.',
            variant: 'destructive',
          });
          break;
        }

        setState((prev) => {
          // Dedup nativo baseado na chave composta e atualização imutável do Map
          const dedupKey = `${data.agent_id}-${data.round}-${data.response_to || ''}-${data.type}`;
          const newContributions = new Map(prev.contributions);

          if (newContributions.has(dedupKey)) {
            return prev; // Ignora duplicata
          }

          newContributions.set(dedupKey, {
            agent: data.agent_id as string,
            round: data.round as number,
            message: data.content as string,
            hasDivergence: data.type === 'divergence',
            responseTo: data.response_to as string | undefined,
            type: data.type as 'response' | 'divergence' | 'question',
            references: data.references as string[] | undefined,
            timestamp: new Date().toISOString(),
          });

          return {
            ...prev,
            contributions: newContributions,
          };
        });
        break;
      }
      case 'roundtable_agent_done': {
        const agent = data.agent as string;
        setState((prev) => ({
          ...prev,
          agentStatuses: { ...prev.agentStatuses, [agent]: 'done' },
        }));
        break;
      }
      case 'roundtable_divergence': {
        setState((prev) => ({
          ...prev,
          divergences: [
            ...prev.divergences,
            {
              agent: data.agent as string,
              round: data.round as number,
              text: data.text as string,
            },
          ],
        }));
        break;
      }
      case 'roundtable_complete': {
        setState((prev) => ({
          ...prev,
          isComplete: true,
          agentsFailed: (data.agentsFailed as string[]) || prev.agentsFailed,
        }));
        break;
      }
      case 'agent_failed': {
        const agent = data.agent as string;
        setState((prev) => ({
          ...prev,
          agentStatuses: { ...prev.agentStatuses, [agent]: 'failed' },
          agentsFailed: prev.agentsFailed.includes(agent)
            ? prev.agentsFailed
            : [...prev.agentsFailed, agent],
        }));
        break;
      }
    }
  }, []);

  /** Adiciona uma contribuição quando uma mensagem de chat completa chega */
  const addContribution = useCallback(
    (agent: string, round: number, message: string, hasDivergence: boolean) => {
      setState((prev) => {
        const newMap = new Map(prev.contributions);
        const dedupKey = `${agent}-${round}-manual-add`;
        newMap.set(dedupKey, {
          agent,
          round,
          message,
          hasDivergence,
          timestamp: new Date().toISOString(),
        });
        return {
          ...prev,
          contributions: newMap,
        };
      });
    },
    [],
  );

  /** Inicializa o estado a partir do histórico de chatMessages */
  const initFromHistory = useCallback((chatMessages: any[]) => {
    if (!chatMessages || chatMessages.length === 0) return;

    const historyContributions = new Map<string, RoundtableContribution>();
    let maxRound = 0;
    const historyDivergences: RoundtableDivergence[] = [];

    chatMessages.forEach((msg) => {
      const rtMeta = msg.metadata?.roundtable;
      if (rtMeta) {
        maxRound = Math.max(maxRound, rtMeta.round || 0);

        const type = rtMeta.msgType || (rtMeta.hasDivergence ? 'divergence' : 'response');
        const dedupKey = `${msg.agent}-${rtMeta.round || 1}-${rtMeta.responseTo || ''}-${type}`;

        historyContributions.set(dedupKey, {
          agent: msg.agent,
          round: rtMeta.round || 1,
          message: msg.message,
          hasDivergence: !!rtMeta.hasDivergence,
          responseTo: rtMeta.responseTo,
          type: type as 'response' | 'divergence' | 'question',
          references: rtMeta.references,
          timestamp: msg.timestamp,
        });

        if (rtMeta.hasDivergence) {
          historyDivergences.push({
            agent: msg.agent,
            round: rtMeta.round || 1,
            text: msg.message,
          });
        }
      }
    });

    if (historyContributions.size > 0) {
      setState((prev) => ({
        ...prev,
        currentRound: maxRound,
        totalRounds: maxRound,
        contributions: historyContributions,
        divergences: historyDivergences,
        isComplete: true, // Se veio do histórico, assumimos completo (a menos que eventos novos cheguem)
      }));
    }
  }, []);

  return { state, processEvent, addContribution, initFromHistory, reset };
}
