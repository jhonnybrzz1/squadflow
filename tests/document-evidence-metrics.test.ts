import { beforeEach, describe, expect, it } from 'vitest';
import { documentEvidenceMetrics } from '../server/services/document-evidence-metrics';

describe('documentEvidenceMetrics', () => {
  beforeEach(() => {
    documentEvidenceMetrics.reset();
  });

  it('counts invalid file references blocked during PRD evidence validation', () => {
    documentEvidenceMetrics.recordValidation({
      demandId: 42,
      issues: [
        'Texto livre: Arquivos/pastas citados no corpo NÃO EXISTEM: server/services/ai-client.ts, shared/types/tool.ts',
        'Evidence Block: Arquivos ALUCINADOS removidos (não estavam em ALLOWED_FILE_PATHS): server/fake.ts',
      ],
    });

    const summary = documentEvidenceMetrics.getSummary();

    expect(summary.invalidFilesBlockedCount).toBe(3);
    expect(summary.invalidEvidenceBlockedDemandCount).toBe(1);
    expect(summary.recentInvalidEvidenceBlocks[0].invalidReferences).toEqual([
      'server/services/ai-client.ts',
      'shared/types/tool.ts',
      'server/fake.ts',
    ]);
  });
});
