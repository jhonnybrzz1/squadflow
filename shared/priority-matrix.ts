import type { Demand } from './schema';
import type { DemandListItem } from './demand-list';
import { getDemandTypeConfig, type DemandPriority, type DemandType } from './demand-types';

/** Campos usados pela matriz — aceita tanto a entidade quanto a projeção da lista (spec 014 S4). */
export type MatrixDemand = DemandListItem & {
  /** classification pode existir na entidade completa, mas não na projeção de lista. */
  classification?: Demand['classification'];
};

export type PriorityMatrixQuadrant =
  'do_first' | 'plan_strategically' | 'do_later' | 'avoid_or_split';

export type PriorityMatrixItem = {
  demand: MatrixDemand;
  quadrant: PriorityMatrixQuadrant;
  valueScore: number;
  effortScore: number;
  rationale: string;
};

export type PriorityMatrixQuadrantConfig = {
  label: string;
  shortLabel: string;
  description: string;
  action: string;
  color: 'cyan' | 'lime' | 'orange' | 'magenta';
};

export const PRIORITY_MATRIX_QUADRANTS: Record<
  PriorityMatrixQuadrant,
  PriorityMatrixQuadrantConfig
> = {
  do_first: {
    label: 'Fazer agora',
    shortLabel: 'Agora',
    description: 'Alto valor e baixo esforço',
    action: 'Priorizar execução',
    color: 'lime',
  },
  plan_strategically: {
    label: 'Planejar',
    shortLabel: 'Plano',
    description: 'Alto valor e alto esforço',
    action: 'Quebrar em etapas',
    color: 'cyan',
  },
  do_later: {
    label: 'Fazer depois',
    shortLabel: 'Depois',
    description: 'Baixo valor e baixo esforço',
    action: 'Manter no backlog',
    color: 'orange',
  },
  avoid_or_split: {
    label: 'Evitar ou quebrar',
    shortLabel: 'Quebrar',
    description: 'Baixo valor e alto esforço',
    action: 'Reavaliar escopo',
    color: 'magenta',
  },
};

// Spec 022: escala recalibrada — média/baixa deixam de ficar presas em
// "baixo valor" quando o esforço é pequeno (threshold de valor alto = 60).
const priorityValue: Record<DemandPriority, number> = {
  critica: 100,
  alta: 85,
  media: 75,
  baixa: 55,
};

// Spec 022: teto da contribuição da descrição no fallback de esforço —
// descrições longas não podem distorcer a matriz.
const FALLBACK_DESCRIPTION_CAP = 15;
const FALLBACK_TYPE_EFFORT_CAP = 100 - FALLBACK_DESCRIPTION_CAP;

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getClassificationComplexity(demand: MatrixDemand): number | null {
  const criteria =
    demand.classification?.classification?.criteria || demand.classification?.criteria;

  if (criteria && typeof criteria.complexity === 'number') {
    return criteria.complexity;
  }

  return null;
}

export function calculateDemandValueScore(
  demand: Pick<Demand, 'priority' | 'type' | 'status'>,
): number {
  const base = priorityValue[demand.priority as DemandPriority] ?? 50;
  const typeBoost =
    demand.type === 'bug'
      ? 8
      : demand.type === 'melhoria'
        ? 5
        : demand.type === 'nova_funcionalidade'
          ? 3
          : 0;
  const statusAdjustment = demand.status === 'error' ? -12 : demand.status === 'stopped' ? -8 : 0;

  return clampScore(base + typeBoost + statusAdjustment);
}

export function calculateDemandEffortScore(demand: MatrixDemand): number {
  // Spec 022: complexity (0-100) do Cognitive Core mapeia linearmente para o
  // effortScore — sem buckets, preservando a granularidade da classificação.
  const classificationComplexity = getClassificationComplexity(demand);
  if (classificationComplexity !== null) {
    return clampScore(classificationComplexity);
  }

  // Fallback (demanda sem classification): maxEffortDays normalizado + até 15
  // pontos pelo tamanho da descrição. O warn é o medidor de cobertura de
  // classification — a matriz roda no client, então console é o canal certo
  // (winston é server-only). Disable explícito: este é o único console
  // intencional em shared/, exigido pela spec 022 (medição de cobertura).
  // eslint-disable-next-line no-console
  console.warn(
    '[priority-matrix] fallback de esforço (demanda sem classification):',
    `demanda ${demand.id}`,
  );
  const config = getDemandTypeConfig(demand.type as DemandType);
  const typeEffort = Math.min(FALLBACK_TYPE_EFFORT_CAP, config.maxEffortDays * 8);
  const descriptionEffort = Math.min(
    FALLBACK_DESCRIPTION_CAP,
    Math.floor(demand.description.length / 100) * 3,
  );

  return clampScore(typeEffort + descriptionEffort);
}

export function getPriorityMatrixQuadrant(
  valueScore: number,
  effortScore: number,
): PriorityMatrixQuadrant {
  // Spec 022: threshold de valor alto 70→60 — média (75) e até baixa com boost
  // de tipo podem alcançar quadrantes superiores quando o esforço é baixo.
  const highValue = valueScore >= 60;
  const highEffort = effortScore >= 60;

  if (highValue && !highEffort) return 'do_first';
  if (highValue && highEffort) return 'plan_strategically';
  if (!highValue && !highEffort) return 'do_later';
  return 'avoid_or_split';
}

export function classifyDemandForPriorityMatrix(demand: MatrixDemand): PriorityMatrixItem {
  const valueScore = calculateDemandValueScore(demand);
  const effortScore = calculateDemandEffortScore(demand);
  const quadrant = getPriorityMatrixQuadrant(valueScore, effortScore);
  const config = PRIORITY_MATRIX_QUADRANTS[quadrant];

  return {
    demand,
    quadrant,
    valueScore,
    effortScore,
    rationale: `${config.description}. ${config.action}.`,
  };
}

export function buildPriorityMatrix(
  demands: MatrixDemand[],
): Record<PriorityMatrixQuadrant, PriorityMatrixItem[]> {
  const initial: Record<PriorityMatrixQuadrant, PriorityMatrixItem[]> = {
    do_first: [],
    plan_strategically: [],
    do_later: [],
    avoid_or_split: [],
  };

  return demands
    .map(classifyDemandForPriorityMatrix)
    .sort((a, b) => b.valueScore - b.effortScore - (a.valueScore - a.effortScore))
    .reduce((matrix, item) => {
      matrix[item.quadrant].push(item);
      return matrix;
    }, initial);
}
