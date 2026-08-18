import { describe, it, expect } from 'vitest';
import type { Demand } from '../../shared/schema';
import {
  adaptCognitiveCoreOutput,
  toRoundtableConfig,
  type CognitiveConfigAdapterInput,
} from '../../server/cognitive-core/cognitive-config-adapter';

function buildInput(
  overrides: Partial<CognitiveConfigAdapterInput> = {},
): CognitiveConfigAdapterInput {
  return {
    demand: {
      id: 42,
      title: 'Test',
      description: 'Test description',
      type: 'technical',
      status: 'pending',
    } as unknown as Demand,
    classification: {
      category: 'technical',
      confidence: 85,
      recommendedAgents: ['tech_lead', 'architect'],
      criteria: {
        ambiguity: 10,
        interpretationRisk: 20,
        depthRequired: 50,
        complexity: 40,
        urgency: 60,
      },
      notes: 'notes',
      personalReadiness: {
        score: 80,
        level: 'ready',
        blockers: [],
        nextQuestions: [],
        recommendation: 'go',
      },
    },
    constraints: {
      demandType: 'technical',
      canonicalDemandType: 'newFeature',
      maturityLevel: 'MVP',
      capabilities: {
        stableBackend: true,
        structuredAI: false,
        advancedFrontend: false,
      },
      stack: {
        frontend: ['React'],
        backend: ['Node.js'],
        database: ['SQLite'],
        infrastructure: [],
        ai: [],
      },
      allowedTechnologies: ['TypeScript', 'React'],
      forbiddenTechnologies: ['kubernetes'],
      maxEffortDays: 5,
      minROI: '3:1',
      outputType: 'standard',
      typeRequirements: ['test coverage'],
    },
    projectReality: {
      stack: {
        frontend: ['React', 'TypeScript'],
        backend: ['Node.js'],
        database: ['SQLite'],
        infrastructure: [],
        ai: [],
      },
      maturityLevel: 'MVP',
      capabilities: {
        stableBackend: true,
        structuredAI: false,
        advancedFrontend: false,
      },
      detectedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe('cognitive-config-adapter', () => {
  it('produces CognitiveCoreOutput with all 5 gate fields', () => {
    const output = adaptCognitiveCoreOutput(buildInput());

    expect(output.demandId).toBe(42);
    expect(output.classification.type).toBe('newFeature');
    expect(output.classification.confidence).toBe(85);
    expect(output.constraints.length).toBeGreaterThanOrEqual(1);
    expect(output.constraints[0].name).toBeDefined();
    expect(output.constraints[0].severity).toBeDefined();
    expect(output.specialists.length).toBeGreaterThanOrEqual(1);
    expect(output.specialists[0].agentId).toBe('tech_lead');
    expect(output.framework).toBe('React/Node.js/SQLite');
    expect(output.numericFields.maxEffortDays).toBe(5);
    expect(output.numericFields.confidence).toBe(85);
  });

  it('derives framework from demand type when project reality is missing', () => {
    const output = adaptCognitiveCoreOutput(buildInput({ projectReality: undefined }));
    expect(output.framework).toBe('technical');
  });

  it('maps CognitiveCoreOutput to RoundtableConfig', () => {
    const output = adaptCognitiveCoreOutput(buildInput());
    const config = toRoundtableConfig(output);

    expect(config.agentIds).toEqual(['tech_lead', 'architect']);
    expect(config.maxRounds).toBe(3);
    expect(config.refinementLevel).toBe(3);
  });

  it('uses refinementLevel 2 when no high severity constraints', () => {
    const output = adaptCognitiveCoreOutput(
      buildInput({
        constraints: {
          demandType: 'technical',
          canonicalDemandType: 'newFeature',
          maturityLevel: 'MVP',
          capabilities: {
            stableBackend: true,
            structuredAI: false,
            advancedFrontend: false,
          },
          stack: {
            frontend: [],
            backend: [],
            database: [],
            infrastructure: [],
            ai: [],
          },
          allowedTechnologies: ['TypeScript'],
          forbiddenTechnologies: [],
          maxEffortDays: 0,
          minROI: '2:1',
          outputType: 'standard',
          typeRequirements: [],
        },
      }),
    );

    const config = toRoundtableConfig(output);
    expect(config.refinementLevel).toBe(2);
  });
});
