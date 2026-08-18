import { describe, expect, it } from 'vitest';
import { DEMAND_TYPES, getDemandTypeConfig } from '../../shared/demand-types';
import { KNOWN_FRAMEWORK_TYPES } from '../../server/frameworks/types';

describe('Framework registry integrity', () => {
  it('every framework referenced by DEMAND_TYPES is registered in KNOWN_FRAMEWORK_TYPES', () => {
    const referencedFrameworks = new Set<string>();

    for (const key of Object.keys(DEMAND_TYPES)) {
      const config = getDemandTypeConfig(key);
      referencedFrameworks.add(config.primaryFramework);
      for (const secondary of config.secondaryFrameworks) {
        referencedFrameworks.add(secondary);
      }
    }

    const known = new Set(KNOWN_FRAMEWORK_TYPES);
    const missing = [...referencedFrameworks].filter((f) => !known.has(f));

    expect(missing).toEqual([]);
  });
});
