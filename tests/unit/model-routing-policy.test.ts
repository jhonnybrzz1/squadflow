import { describe, expect, it } from 'vitest';
import { proposeAdaptiveModel } from '../../server/services/model-routing-policy';

describe('adaptive model routing policy', () => {
  it('proposes nano only when its observed quality is high', () => {
    expect(
      proposeAdaptiveModel({
        baseModel: 'mini',
        nanoModel: 'nano',
        miniModel: 'mini',
        nano: { successRate: 0.9, avgScore: 90 },
        mini: { successRate: 0.9, avgScore: 90 },
      }),
    ).toEqual({ model: 'nano', reason: 'adaptive_high_quality_nano' });
  });

  it('applies the kill-switch proposal for a failing model', () => {
    expect(
      proposeAdaptiveModel({
        baseModel: 'nano',
        nanoModel: 'nano',
        miniModel: 'mini',
        nano: { successRate: 0.4, avgScore: 40 },
        mini: { successRate: 0.9, avgScore: 90 },
      }),
    ).toEqual({ model: 'mini', reason: 'adaptive_kill_switch_nano' });
  });

  it('keeps the hardcoded decision when evidence is inconclusive', () => {
    expect(
      proposeAdaptiveModel({
        baseModel: 'mini',
        nanoModel: 'nano',
        miniModel: 'mini',
        nano: { successRate: 0.7, avgScore: 70 },
        mini: { successRate: 0.8, avgScore: 80 },
      }),
    ).toBeNull();
  });
});
