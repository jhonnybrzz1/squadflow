/**
 * Spec 10140 — Self-Improvement Spike
 *
 * Extrator heurístico de padrões a partir do resultado de uma mesa redonda.
 * Sem uso de LLM, sem auto-mutação. O objetivo é identificar padrões úteis
 * (erros repetidos, falhas de parse, latência anômala, divergências) para
 * posterior revisão humana e eventual skill store.
 */

/**
 * Shape mínimo do output consolidado da mesa redonda (evita dependência circular
 * com roundtable-orchestrator.ts). Spec 10140.
 */
export interface RefinementOutputLike {
  problema?: string;
  objetivo?: string;
  escopo?: string;
  criterios_de_aceite?: unknown[];
  riscos?: unknown[];
  dependencias?: unknown[];
  divergencias?: string[];
  consolidacao?: string;
}

/**
 * Metadados de um turno capturados durante a execução da mesa redonda.
 * Usado internamente pelo hook de self-improvement.
 */
export interface RoundtableTurnMetadata {
  /** ID canônico do agente (ex: 'product_owner', 'tech_lead'). */
  agentId: string;
  /** Modelo que efetivamente processou o turno (pode incluir fallback). */
  modelUsed: string;
  /** Duração da chamada em milissegundos. */
  durationMs: number;
  /** Conteúdo textual da resposta (pode ser JSON cru em caso de falha de parse). */
  content: string;
  /** true se houve falha de parse/validação no turno. */
  parseFailed: boolean;
  /** true se foi necessário retry automático. */
  retried: boolean;
  /** Número da rodada (1-based). */
  round: number;
  /** Motivo do erro, quando disponível. */
  errorMessage?: string;
}

/**
 * Resultado bruto de uma mesa redonda, enriquecido com metadados por turno.
 */
export interface SelfImprovementInput {
  /** ID da demanda (roundtable está sempre vinculado a uma demanda). */
  demandId: number;
  /** Agentes que falharam durante a mesa. */
  agentsFailed: string[];
  /** Número total de divergências detectadas. */
  totalDivergences: number;
  /** Rodadas com contribuições e divergências. */
  rounds: Array<{
    round: number;
    contributions: Record<string, string>;
    divergences: string[];
  }>;
  /** Output consolidado da mesa redonda. */
  consolidation: RefinementOutputLike;
  /** Metadados capturados durante cada turno (agente/moderador). */
  turnMetadata: RoundtableTurnMetadata[];
}

/**
 * Padrão extraído pronto para logging.
 */
export interface ExtractedPattern {
  /** Tipo de agente associado ao padrão (ou 'squad' se for geral). */
  agent_type: string;
  /** ID do roundtable: usamos o demandId como identificador primário. */
  roundtable_id: number;
  /** Padrão extraído serializado em JSON. */
  extracted_pattern: unknown;
  /** Confiança heurística da extração. */
  confidence_hint: 'low' | 'medium' | 'high';
  /** Status de revisão humana pendente. */
  feedback_status: 'pending' | 'approved' | 'rejected';
  /** Mensagem de erro quando a extração falha. */
  extraction_error?: string;
}

// Thresholds heurísticos ajustáveis via env (spike).
const SLOW_TURN_MS = Number(process.env.SELF_IMPROVEMENT_SLOW_TURN_MS ?? 30_000);
const HIGH_DIVERGENCE_RATIO = Number(process.env.SELF_IMPROVEMENT_HIGH_DIVERGENCE_RATIO ?? 0.5);

/**
 * Conta ocorrências de valores em um array.
 */
function countOccurrences<T extends string>(items: T[]): Record<T, number> {
  return items.reduce(
    (acc, item) => {
      acc[item] = (acc[item] ?? 0) + 1;
      return acc;
    },
    {} as Record<T, number>,
  );
}

/**
 * Detecta agentes que falharam repetidamente (aparecem em >1 rodada com falha).
 */
function detectRepeatedFailures(turns: RoundtableTurnMetadata[]): ExtractedPattern[] {
  const failuresByAgent: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.parseFailed || turn.errorMessage) {
      failuresByAgent[turn.agentId] = (failuresByAgent[turn.agentId] ?? 0) + 1;
    }
  }

  return Object.entries(failuresByAgent)
    .filter(([, count]) => count > 1)
    .map(([agentId, count]) => ({
      agent_type: agentId,
      roundtable_id: 0, // preenchido pelo caller
      extracted_pattern: {
        type: 'repeated_parse_failure',
        agentId,
        failedTurns: count,
        suggestion: 'Revisar prompt/schema JSON para este agente; considerar exemplos few-shot.',
      },
      confidence_hint: 'high' as const,
      feedback_status: 'pending' as const,
    }));
}

/**
 * Detecta turnos com latência anômala.
 */
function detectSlowTurns(turns: RoundtableTurnMetadata[]): ExtractedPattern[] {
  const slowTurns = turns.filter((turn) => turn.durationMs > SLOW_TURN_MS);
  const byAgent = countOccurrences(slowTurns.map((t) => t.agentId));

  return Object.entries(byAgent).map(([agentId, count]) => ({
    agent_type: agentId,
    roundtable_id: 0,
    extracted_pattern: {
      type: 'slow_turn',
      agentId,
      slowTurnCount: count,
      thresholdMs: SLOW_TURN_MS,
      avgDurationMs: Math.round(
        slowTurns.filter((t) => t.agentId === agentId).reduce((sum, t) => sum + t.durationMs, 0) /
          count,
      ),
      suggestion: 'Avaliar prompt longo ou modelo lento para este agente.',
    },
    confidence_hint: 'medium' as const,
    feedback_status: 'pending' as const,
  }));
}

/**
 * Detecta padrão de alto índice de divergência no roundtable.
 */
function detectHighDivergence(input: SelfImprovementInput): ExtractedPattern | null {
  const roundCount = input.rounds.length || 1;
  const ratio = input.totalDivergences / roundCount;
  if (ratio < HIGH_DIVERGENCE_RATIO) return null;

  return {
    agent_type: 'squad',
    roundtable_id: input.demandId,
    extracted_pattern: {
      type: 'high_divergence_rate',
      totalDivergences: input.totalDivergences,
      roundCount,
      ratio: Number(ratio.toFixed(2)),
      suggestion: 'Revisar pergunta da demanda ou agentes conflitantes; considerar PO moderador.',
    },
    confidence_hint: ratio > 1 ? 'high' : 'medium',
    feedback_status: 'pending' as const,
  };
}

/**
 * Detecta riscos não-mitigados no output consolidado.
 */
function detectUnhandledRisks(input: SelfImprovementInput): ExtractedPattern | null {
  const risks = input.consolidation?.riscos;
  if (!Array.isArray(risks) || risks.length === 0) return null;

  const highRiskCount = risks.filter((r: unknown) =>
    typeof r === 'string' ? /alta|grave|bloqueante/i.test(r) : false,
  ).length;

  if (highRiskCount === 0) return null;

  return {
    agent_type: 'squad',
    roundtable_id: input.demandId,
    extracted_pattern: {
      type: 'unmitigated_high_risk',
      riskCount: risks.length,
      highRiskCount,
      suggestion: 'Revisar plano de mitigação com tech_lead/scrum_master antes de seguir.',
    },
    confidence_hint: 'medium' as const,
    feedback_status: 'pending' as const,
  };
}

/**
 * Detecta agentes que precisaram de retry frequente.
 */
function detectRetryPattern(turns: RoundtableTurnMetadata[]): ExtractedPattern[] {
  const retriedByAgent = countOccurrences(turns.filter((t) => t.retried).map((t) => t.agentId));

  return Object.entries(retriedByAgent)
    .filter(([, count]) => count >= 2)
    .map(([agentId, count]) => ({
      agent_type: agentId,
      roundtable_id: 0,
      extracted_pattern: {
        type: 'retry_needed',
        agentId,
        retryCount: count,
        suggestion: 'Verificar formato de resposta esperado; talvez prompt esteja ambíguo.',
      },
      confidence_hint: count > 1 ? 'high' : ('medium' as const),
      feedback_status: 'pending' as const,
    }));
}

/**
 * Extrai padrões heurísticos do resultado de uma mesa redonda.
 * Retorna array vazio se nenhum padrão for encontrado.
 *
 * Pura: sem side effects, sem chamadas externas.
 */
export function extractPatterns(input: SelfImprovementInput): ExtractedPattern[] {
  if (!input || !Array.isArray(input.turnMetadata)) {
    return [
      {
        agent_type: 'squad',
        roundtable_id: input?.demandId ?? 0,
        extracted_pattern: null,
        confidence_hint: 'low',
        feedback_status: 'pending',
        extraction_error: 'Invalid input: turnMetadata missing or not an array',
      },
    ];
  }

  try {
    const patterns: ExtractedPattern[] = [];
    const turns = input.turnMetadata;

    patterns.push(...detectRepeatedFailures(turns));
    patterns.push(...detectSlowTurns(turns));
    patterns.push(...detectRetryPattern(turns));

    const divergencePattern = detectHighDivergence(input);
    if (divergencePattern) patterns.push(divergencePattern);

    const riskPattern = detectUnhandledRisks(input);
    if (riskPattern) patterns.push(riskPattern);

    // Fallback: nenhum padrão identificado, mas execução foi bem-sucedida.
    if (patterns.length === 0) {
      patterns.push({
        agent_type: 'squad',
        roundtable_id: input.demandId,
        extracted_pattern: {
          type: 'no_clear_pattern',
          observation:
            'Roundtable concluído sem falhas repetidas, lentidão ou divergências acima do threshold.',
        },
        confidence_hint: 'low',
        feedback_status: 'pending',
      });
    }

    // Preenche roundtable_id em todos os padrões.
    for (const pattern of patterns) {
      pattern.roundtable_id = input.demandId;
    }

    return patterns;
  } catch (error) {
    return [
      {
        agent_type: 'squad',
        roundtable_id: input.demandId,
        extracted_pattern: null,
        confidence_hint: 'low',
        feedback_status: 'pending',
        extraction_error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}
