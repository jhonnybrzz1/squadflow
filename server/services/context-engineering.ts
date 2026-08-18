import type { AgentInsight } from './context-builder';

const CRITICAL_MARKERS =
  /(decis[aã]o|recomenda[cç][aã]o|risco|diverg[êe]ncia|prioridade|bloqueio|evid[êe]ncia)/i;

function scoreInsight(insight: AgentInsight): number {
  const markerBonus = CRITICAL_MARKERS.test(insight.insight) ? 3 : 0;
  const structureBonus = /^(\*\*|- |\d+\.)/m.test(insight.insight) ? 1 : 0;
  return markerBonus + structureBonus + 1;
}

export function selectSalientInsights(insights: AgentInsight[], historyK: number): AgentInsight[] {
  if (historyK <= 0 || insights.length <= historyK) return insights;

  return insights
    .map((insight, index) => ({ insight, index, score: scoreInsight(insight) }))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, historyK)
    .sort((left, right) => left.index - right.index)
    .map(({ insight }) => insight);
}
