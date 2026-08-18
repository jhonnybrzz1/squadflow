import { describe, expect, it } from 'vitest';
import { DEMAND_TYPES, demandTypeSchema } from '../../shared/demand-types';

describe('demand type schema integrity', () => {
  it('demandTypeSchema options match exactly the keys of DEMAND_TYPES', () => {
    const expectedKeys = Object.keys(DEMAND_TYPES).sort();
    const schemaOptions = demandTypeSchema.options.sort();
    expect(schemaOptions).toEqual(expectedKeys);
  });

  it('rejects values not present in DEMAND_TYPES', () => {
    const result = demandTypeSchema.safeParse('tipo_inexistente');
    expect(result.success).toBe(false);
  });

  it('accepts every key from DEMAND_TYPES', () => {
    for (const key of Object.keys(DEMAND_TYPES)) {
      const result = demandTypeSchema.safeParse(key);
      expect(result.success).toBe(true);
    }
  });
});
