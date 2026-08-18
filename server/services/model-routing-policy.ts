export interface AdaptiveQualityScore {
  successRate: number;
  avgScore: number;
}

export function proposeAdaptiveModel(params: {
  baseModel: string;
  nanoModel: string;
  miniModel: string;
  nano: AdaptiveQualityScore;
  mini: AdaptiveQualityScore;
}): { model: string; reason: string } | null {
  const { baseModel, nanoModel, miniModel, nano, mini } = params;
  if (baseModel === miniModel && nano.successRate >= 0.85 && nano.avgScore >= 80) {
    return { model: nanoModel, reason: 'adaptive_high_quality_nano' };
  }
  if (baseModel === miniModel && mini.successRate < 0.5 && nano.successRate >= 0.5) {
    return { model: nanoModel, reason: 'adaptive_kill_switch_mini' };
  }
  if (baseModel === nanoModel && nano.successRate < 0.5 && mini.successRate >= 0.85) {
    return { model: miniModel, reason: 'adaptive_kill_switch_nano' };
  }
  return null;
}
