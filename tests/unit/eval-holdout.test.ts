import { describe, it, expect } from 'vitest';
import {
  structuredFewShotExampleSchema,
  getInjectableFewShotForAgent,
  getHoldoutForAgent,
  renderFewShotBlock,
  type StructuredFewShotExample,
} from '../../server/services/few-shot-bank';
import { assertHoldoutDisjoint } from '../../server/evaluation/evaluate-agent';

function makeCase(id: string, split?: 'train' | 'holdout'): StructuredFewShotExample {
  return structuredFewShotExampleSchema.parse({
    id,
    agent: 'qa',
    demand: { title: 'T', description: 'D' },
    validOutput: `saida valida ${id}`,
    ...(split ? { split } : {}),
  });
}

describe('split train/holdout (spec 006 / US1)', () => {
  it('caso legado sem campo split é train por default', () => {
    const parsed = makeCase('legacy-1');
    expect(parsed.split).toBe('train');
  });

  it('getInjectableFewShotForAgent retorna só train; getHoldoutForAgent só holdout', () => {
    const dataset = [makeCase('a', 'train'), makeCase('b', 'holdout'), makeCase('c')];
    const injectable = getInjectableFewShotForAgent('qa', dataset);
    const holdout = getHoldoutForAgent('qa', dataset);
    expect(injectable.map((e) => e.id).sort()).toEqual(['a', 'c']);
    expect(holdout.map((e) => e.id)).toEqual(['b']);
  });

  it('renderFewShotBlock nunca injeta caso de holdout no prompt', () => {
    const dataset = [makeCase('holdout-only', 'holdout')];
    const block = renderFewShotBlock('qa', 2, dataset, [], 0);
    expect(block).not.toContain('saida valida holdout-only');
  });

  it('assertHoldoutDisjoint lança com os ids conflitantes (SC-001)', () => {
    const shared = makeCase('dup-1', 'holdout');
    const injectable = [makeCase('dup-1', 'train'), makeCase('ok', 'train')];
    expect(() => assertHoldoutDisjoint([shared], injectable)).toThrow(/dup-1/);
  });

  it('assertHoldoutDisjoint aceita conjuntos disjuntos', () => {
    expect(() =>
      assertHoldoutDisjoint([makeCase('h1', 'holdout')], [makeCase('t1', 'train')]),
    ).not.toThrow();
  });
});
