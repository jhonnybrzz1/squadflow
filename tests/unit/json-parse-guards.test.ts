/**
 * CRIT-6 — JSON.parse desprotegido em 5 pontos do pipeline.
 *
 * Cobre os parsers que respondem a dados que podem chegar malformados
 * (resposta de LLM, payload de snapshot, embedding armazenado): cada um deve
 * logar e lançar um erro claro em vez de deixar escapar um SyntaxError cru.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({
  isPostgres: false,
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    run: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { embeddingService } from '../../server/services/embedding-service';
import { DocumentSnapshotService } from '../../server/services/document-snapshot-service';
import { extractJsonObject } from '../../server/services/ai-squad/roundtable-orchestrator';

describe('CRIT-6: parsers de JSON não protegidos', () => {
  it('embeddingService.deserializeEmbedding lança erro claro em dado corrompido', () => {
    expect(() => embeddingService.deserializeEmbedding('{not json')).toThrow(
      'Invalid stored embedding JSON',
    );
  });

  it('embeddingService.deserializeEmbedding continua funcionando com dado válido', () => {
    expect(embeddingService.deserializeEmbedding('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });

  it('DocumentSnapshotService.parsePayload lança erro claro em payload corrompido', () => {
    const snapshot = {
      snapshotId: 'snap-1',
      demandId: 1,
      snapshotType: 'REVIEW' as const,
      payloadJson: '{corrompido',
      snapshotHash: 'hash',
      createdAt: new Date(),
    };

    expect(() => DocumentSnapshotService.parsePayload(snapshot)).toThrow(
      /Corrupted snapshot payload/,
    );
  });

  it('DocumentSnapshotService.parsePayload continua funcionando com payload válido', () => {
    const snapshot = {
      snapshotId: 'snap-2',
      demandId: 1,
      snapshotType: 'APPROVED' as const,
      payloadJson: JSON.stringify({ title: 'ok' }),
      snapshotHash: 'hash',
      createdAt: new Date(),
    };

    expect(DocumentSnapshotService.parsePayload(snapshot)).toEqual({ title: 'ok' });
  });

  it('extractJsonObject (roundtable-orchestrator) lança erro claro em JSON malformado do LLM', () => {
    expect(() => extractJsonObject('não é json nenhum sem chaves')).toThrow(
      'Invalid JSON returned by LLM',
    );
  });

  it('extractJsonObject continua extraindo JSON válido cercado por texto/markdown', () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(extractJsonObject(raw)).toEqual({ a: 1 });
  });
});
