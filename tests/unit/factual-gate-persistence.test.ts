/**
 * P0 grounding — persistência do gate factual (item 6 da revisão).
 *
 * O que estes testes travam:
 *  - `gateFinalDocuments` avalia o documento ENTREGUE (PRD+Tasks), não só a
 *    consolidação interna;
 *  - `passed` também é persistido — antes ficava `null`, indistinguível de
 *    "nunca avaliado";
 *  - erro no `update` PROPAGA: refinamento cujo veredito não pôde ser gravado
 *    não pode seguir para `completed`;
 *  - a evidência é descartada em todos os caminhos, inclusive no de erro.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    update,
    findById: vi.fn(),
    findByIdOrNull: vi.fn().mockResolvedValue(null),
    updateChat: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SquadCoordinator } from '../../server/services/ai-squad/squad-coordinator';
import type { AISquadService } from '../../server/services/ai-squad';
import type { RepoEvidencePackage } from '../../server/services/repo-evidence-collector';

const DEMAND_ID = 4242;

const evidencePackage: RepoEvidencePackage = Object.freeze({
  evidence: Object.freeze([
    Object.freeze({
      tool: 'local_checkout',
      file: 'shared/agent-roles.ts',
      symbols: Object.freeze(['MIN_ROUNDTABLE_AGENTS']),
      snippet: 'export const MIN_ROUNDTABLE_AGENTS = 3;',
      verifiedAt: new Date().toISOString(),
    }),
  ]),
  inspectionRequired: true,
  degraded: false,
  reason: null,
}) as RepoEvidencePackage;

/** Injeta o pacote sem passar por um roundtable inteiro. */
function coordinatorWithEvidence(): SquadCoordinator {
  const coordinator = new SquadCoordinator({} as AISquadService);
  (
    coordinator as unknown as { evidenceByDemand: Map<number, RepoEvidencePackage> }
  ).evidenceByDemand.set(DEMAND_ID, evidencePackage);
  return coordinator;
}

function evidenceMapOf(coordinator: SquadCoordinator): Map<number, RepoEvidencePackage> {
  return (coordinator as unknown as { evidenceByDemand: Map<number, RepoEvidencePackage> })
    .evidenceByDemand;
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue(undefined);
});

describe('gateFinalDocuments', () => {
  it('persiste `passed` — não deixa qualityGateStatus null', async () => {
    const coordinator = coordinatorWithEvidence();

    const gate = await coordinator.gateFinalDocuments(
      DEMAND_ID,
      'Confirmado no código: `MIN_ROUNDTABLE_AGENTS` está em shared/agent-roles.ts.',
    );

    expect(gate?.status).toBe('passed');
    expect(update).toHaveBeenCalledWith(
      DEMAND_ID,
      expect.objectContaining({ qualityGateStatus: 'passed', requiresHumanReview: false }),
    );
  });

  it('persiste `failed` e exige revisão quando o documento final tem alegação sem lastro', async () => {
    const coordinator = coordinatorWithEvidence();

    const gate = await coordinator.gateFinalDocuments(
      DEMAND_ID,
      'Confirmado no código: server/db.ts exporta resolveDatabaseUrl.',
    );

    expect(gate?.status).toBe('failed');
    expect(update).toHaveBeenCalledWith(
      DEMAND_ID,
      expect.objectContaining({ qualityGateStatus: 'failed', requiresHumanReview: true }),
    );
  });

  it('avalia o documento ENTREGUE, não a consolidação interna', async () => {
    const coordinator = coordinatorWithEvidence();

    // A consolidação poderia estar limpa; o PRD final é que carrega a alegação.
    const gate = await coordinator.gateFinalDocuments(
      DEMAND_ID,
      '# PRD\n\nA tabela passou de 669 registros para zero.\n\n# Tasks\n- [ ] T1',
    );

    expect(gate?.status).toBe('failed');
    expect(gate?.unsupportedClaims[0].reason).toBe('runtime_claim');
  });

  it('erro de persistência PROPAGA — não pode virar completed sem gate gravado', async () => {
    const coordinator = coordinatorWithEvidence();
    update.mockRejectedValue(new Error('db down'));

    await expect(coordinator.gateFinalDocuments(DEMAND_ID, 'texto qualquer')).rejects.toThrow(
      'db down',
    );
  });

  // Antes isto devolvia null em silêncio e o fluxo concluía SEM campos de gate —
  // o teste anterior institucionalizava o fail-open. Ausência do pacote é
  // violação de invariante: quem chega aqui passou por processRoundtable.
  it('pacote ausente FALHA FECHADO: warning + revisão humana, e persiste', async () => {
    const coordinator = new SquadCoordinator({} as AISquadService);

    const gate = await coordinator.gateFinalDocuments(999, 'texto');

    expect(gate.status).toBe('warning');
    expect(gate.requiresHumanReview).toBe(true);
    expect(gate.reason).toMatch(/invariante/i);
    expect(update).toHaveBeenCalledWith(
      999,
      expect.objectContaining({ qualityGateStatus: 'warning', requiresHumanReview: true }),
    );
  });

  it('pacote ausente com banco fora do ar também propaga', async () => {
    const coordinator = new SquadCoordinator({} as AISquadService);
    update.mockRejectedValue(new Error('db down'));

    await expect(coordinator.gateFinalDocuments(999, 'texto')).rejects.toThrow('db down');
  });
});

describe('ciclo de vida da evidência', () => {
  it('descarta a evidência no caminho de sucesso', async () => {
    const coordinator = coordinatorWithEvidence();
    await coordinator.gateFinalDocuments(DEMAND_ID, 'texto neutro');

    expect(evidenceMapOf(coordinator).has(DEMAND_ID)).toBe(false);
  });

  it('descarta a evidência mesmo quando a persistência falha', async () => {
    const coordinator = coordinatorWithEvidence();
    update.mockRejectedValue(new Error('db down'));

    await expect(coordinator.gateFinalDocuments(DEMAND_ID, 'texto')).rejects.toThrow();
    // Sem isto, a execução seguinte seria gateada contra evidência obsoleta.
    expect(evidenceMapOf(coordinator).has(DEMAND_ID)).toBe(false);
  });

  it('discardEvidence limpa o caminho de erro do refinamento', () => {
    const coordinator = coordinatorWithEvidence();
    coordinator.discardEvidence(DEMAND_ID);

    expect(evidenceMapOf(coordinator).has(DEMAND_ID)).toBe(false);
  });
});
