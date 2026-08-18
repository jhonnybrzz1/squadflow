import { describe, expect, it } from 'vitest';

import { RealityConstraints } from '../../server/cognitive-core/reality-constraints';
import type { ProjectReality } from '../../server/cognitive-core/project-reality-reader';

function reality(maturityLevel: ProjectReality['maturityLevel'] = 'MVP'): ProjectReality {
  return {
    maturityLevel,
    stack: {
      frontend: ['React'],
      backend: ['Node.js'],
      database: ['PostgreSQL'],
      infrastructure: ['Docker'],
      ai: ['OpenAI'],
    },
    capabilities: {
      stableBackend: true,
      structuredAI: false,
      advancedFrontend: false,
    },
    detectedAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('RealityConstraints (spec 10069)', () => {
  it('retorna constraints específicas para security/refactoring/infrastructure', () => {
    const constraints = new RealityConstraints(reality());

    expect(constraints.getConstraintsForDemandType('security')).toMatchObject({
      canonicalDemandType: 'security',
      requireComplianceReview: true,
      maxNewExternalServices: 0,
    });
    expect(constraints.getConstraintsForDemandType('refactoring')).toMatchObject({
      canonicalDemandType: 'refactoring',
      allowArchitectureChange: false,
      mustPreserveBehavior: true,
    });
    expect(constraints.getConstraintsForDemandType('infraestrutura')).toMatchObject({
      canonicalDemandType: 'infrastructure',
      requireObservabilityPlan: true,
      allowMultiRegion: false,
    });
  });

  it('security reporta tecnologia proibida e ausência de compliance review', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      {
        technologies: ['Multi-region deployment'],
        complianceReviewIncluded: false,
        newExternalServices: 1,
      },
      'security',
    );

    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain('Forbidden technologies used');
    expect(check.issues.join('\n')).toContain('Compliance review is required');
    expect(check.issues.join('\n')).toContain('New external services');
  });

  it('refactoring bloqueia mudança arquitetural e quebra de comportamento em MVP', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      {
        filesChanged: 9,
        architectureChangeRequested: true,
        preservesBehavior: false,
      },
      'refactoring',
    );

    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain('Files changed');
    expect(check.issues.join('\n')).toContain('Architecture change is not allowed');
    expect(check.issues.join('\n')).toContain('Refactoring must preserve behavior');
  });

  it('infraestrutura bloqueia multi-region sem plano de observabilidade em MVP', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      {
        newComponents: 3,
        observabilityPlanIncluded: false,
        multiRegionDeployment: true,
      },
      'infraestrutura',
    );

    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain('New components');
    expect(check.issues.join('\n')).toContain('Observability plan is required');
    expect(check.issues.join('\n')).toContain('Multi-region deployment is not allowed');
  });

  // CRIT-14: os 3 casos que faltavam no switch de checkAdherence.
  it('discovery bloqueia excesso de hipóteses em MVP', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      { hypothesesCount: 6 },
      'discovery',
    );
    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain('Hypotheses 6 exceeds maximum of 5');
  });

  it('improvement bloqueia optimization level acima do máximo em MVP', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      {
        optimizationLevel: 'major',
        refactorsArchitecture: false,
        maintainsCompatibility: true,
      },
      'melhoria',
    );
    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain(
      'Optimization level major exceeds maximum of moderate',
    );
  });

  it('improvement bloqueia refatoração arquitetural quando não permitida', () => {
    // canRefactorArchitecture é true em todos os níveis — testa o caminho de
    // maintainsCompatibility=false em MVP (mustMaintainCompatibility=true).
    const check = new RealityConstraints(reality()).checkAdherence(
      {
        optimizationLevel: 'moderate',
        refactorsArchitecture: false,
        maintainsCompatibility: false,
      },
      'melhoria',
    );
    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain('Improvement must maintain backward compatibility');
  });

  it('exploratoryAnalysis bloqueia scope future quando máximo é adjacent em MVP', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      { explorationScope: 'future' },
      'analise_exploratoria',
    );
    expect(check.isAdherent).toBe(false);
    expect(check.issues.join('\n')).toContain(
      'Exploration scope future exceeds maximum of adjacent',
    );
  });

  it('discovery aderente quando dentro dos limites', () => {
    const check = new RealityConstraints(reality()).checkAdherence(
      { hypothesesCount: 5, exploresFutureTech: true, usesCurrentStack: false },
      'discovery',
    );
    expect(check.isAdherent).toBe(true);
    expect(check.adherenceScore).toBe(100);
  });
});
