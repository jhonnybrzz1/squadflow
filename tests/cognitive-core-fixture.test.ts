import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { CognitiveCoreOutput } from '../server/cognitive-core/cognitive-config-adapter';

/**
 * Spec 10144 T3 — GATE de validação da fixture do cognitive-core.
 * Se qualquer critério falhar, o trabalho deve ser interrompido e reavaliado.
 */

describe('cognitive-core fixture gate', () => {
  const fixturePath = path.join(process.cwd(), 'fixtures', 'cognitive-core-output.fixture.json');

  it('fixture JSON existe', () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
  });

  it('passa nos 5 critérios obrigatórios', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const fixture = JSON.parse(raw) as CognitiveCoreOutput;

    // (1) classification.type deve ser o tipo canônico da demanda, não a categoria grossa
    expect(fixture.classification).toBeDefined();
    expect(typeof fixture.classification.type).toBe('string');
    expect(fixture.classification.type.trim()).not.toBe('');
    expect(fixture.classification.type).not.toBe('technical');

    // (2) constraints[] com pelo menos 1 item, cada item com name e severity (string não vazia)
    expect(Array.isArray(fixture.constraints)).toBe(true);
    expect(fixture.constraints.length).toBeGreaterThanOrEqual(1);
    for (const constraint of fixture.constraints) {
      expect(typeof constraint.name).toBe('string');
      expect(constraint.name.trim()).not.toBe('');
      expect(typeof constraint.severity).toBe('string');
      expect(constraint.severity.trim()).not.toBe('');
    }

    // (3) specialists[] com pelo menos 1 item
    expect(Array.isArray(fixture.specialists)).toBe(true);
    expect(fixture.specialists.length).toBeGreaterThanOrEqual(1);

    // (4) framework definido como string não vazia
    expect(typeof fixture.framework).toBe('string');
    expect(fixture.framework.trim()).not.toBe('');

    // (5) todo campo numérico ≥ 0 (ausência de NaN)
    const numericValues = [
      fixture.classification.confidence,
      fixture.numericFields.confidence,
      fixture.numericFields.maxEffortDays,
      fixture.numericFields.maxRounds,
    ];
    for (const value of numericValues) {
      expect(typeof value).toBe('number');
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBeGreaterThanOrEqual(0);
    }

    // (6) maxRounds não deve ser uma função direta de maxEffortDays (desacoplados)
    expect(fixture.numericFields.maxRounds).not.toBe(fixture.numericFields.maxEffortDays);
  });
});
