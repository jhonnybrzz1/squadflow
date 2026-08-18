/**
 * Demanda 10095 — motor de consenso da retrospectiva.
 *
 * O PRD descreve o processo como "puramente processual" (Notion/Docs). Ainda
 * assim, a REGRA de quando um plano está aprovado é determinística e cheia de
 * cantos onde uma decisão manual erra: unanimidade real, timeout de 2 rodadas,
 * aprovação tácita após 48h de ausência. Codar essa regra como função pura dá ao
 * processo um veredito auditável e reproduzível — sem substituir a cerimônia.
 *
 * Nada aqui persiste nem chama LLM: é a lógica que uma tela ou um bot de Notion
 * pode consumir para dizer, sem achismo, "aprovado" ou "ainda não".
 */

export const CONSENSUS_MAX_ROUNDS = 2;
export const TACIT_APPROVAL_WINDOW_MS = 48 * 60 * 60 * 1000;

export type ApprovalDecision = 'approved' | 'objected' | 'pending';

export interface ParticipantVote {
  agent: string;
  decision: ApprovalDecision;
  /** ISO. Obrigatório quando decision !== 'pending' — é a prova formal. */
  timestamp?: string;
}

export interface ConsensusInput {
  /** Todos os agentes que precisam se manifestar. */
  participants: string[];
  votes: ParticipantVote[];
  /** Rodada atual de aprovação (1-based). */
  round: number;
  /** Momento da avaliação (ISO) — para a janela de aprovação tácita. */
  now: string;
  /** Quando a rodada de aprovação foi aberta (ISO) — base da janela de 48h. */
  roundOpenedAt: string;
}

export interface ConsensusResult {
  /** true só quando TODOS aprovaram (explícito ou tácito por ausência). */
  approved: boolean;
  status: 'approved' | 'awaiting' | 'unresolved';
  /** Agentes que registraram aprovação explícita. */
  explicitApprovals: string[];
  /** Ausentes cuja janela de 48h expirou → aprovação tácita. */
  tacitApprovals: string[];
  /** Agentes que objetaram formalmente. */
  objections: string[];
  /** Ausentes ainda dentro da janela de 48h. */
  awaiting: string[];
  /**
   * Itens que viram pendência para a próxima sprint: só quando esgotou o número
   * de rodadas SEM consenso (objeção ativa).
   */
  deferredToNextSprint: boolean;
  evaluatedAt: string;
}

/**
 * Avalia o estado de consenso de uma rodada. Regras, na ordem em que importam:
 *
 *  1. Objeção formal derruba a unanimidade — não há "maioria aprova".
 *  2. Ausência conta como aprovação **tácita apenas depois de 48h**; antes disso
 *     é `awaiting`, não aprovação.
 *  3. Sem unanimidade ao fim da última rodada, o item é deferido — não fica em
 *     limbo nem é forçado.
 */
export function evaluateConsensus(input: ConsensusInput): ConsensusResult {
  const nowMs = new Date(input.now).getTime();
  const openedMs = new Date(input.roundOpenedAt).getTime();
  const windowElapsed =
    Number.isFinite(nowMs) && Number.isFinite(openedMs)
      ? nowMs - openedMs >= TACIT_APPROVAL_WINDOW_MS
      : false;

  const voteByAgent = new Map(input.votes.map((v) => [v.agent, v]));

  const explicitApprovals: string[] = [];
  const tacitApprovals: string[] = [];
  const objections: string[] = [];
  const awaiting: string[] = [];

  for (const agent of input.participants) {
    const vote = voteByAgent.get(agent);
    if (vote?.decision === 'approved' && vote.timestamp) {
      explicitApprovals.push(agent);
    } else if (vote?.decision === 'objected') {
      objections.push(agent);
    } else if (windowElapsed) {
      // Ausente (ou 'pending') com a janela de 48h vencida → aprovação tácita.
      tacitApprovals.push(agent);
    } else {
      awaiting.push(agent);
    }
  }

  const approved = objections.length === 0 && awaiting.length === 0;
  const roundsExhausted = input.round >= CONSENSUS_MAX_ROUNDS;

  let status: ConsensusResult['status'];
  if (approved) status = 'approved';
  else if (objections.length > 0 && roundsExhausted) status = 'unresolved';
  else status = 'awaiting';

  return {
    approved,
    status,
    explicitApprovals,
    tacitApprovals,
    objections,
    awaiting,
    deferredToNextSprint: status === 'unresolved',
    evaluatedAt: input.now,
  };
}

/** Template fixo de ponto de retrospectiva (categoria, descrição, impacto). */
export interface RetroPointInput {
  category: string;
  description: string;
  impact: string;
}

export const RETRO_POINT_REQUIRED_FIELDS = ['category', 'description', 'impact'] as const;

/**
 * Valida um ponto contra o template fixo. Campo vazio ou só espaço não conta —
 * "impacto: " em branco é o jeito de burlar o template.
 */
export function validateRetroPoint(point: Partial<RetroPointInput>): {
  valid: boolean;
  missing: string[];
} {
  const missing = RETRO_POINT_REQUIRED_FIELDS.filter((f) => !point[f] || !String(point[f]).trim());
  return { valid: missing.length === 0, missing };
}
