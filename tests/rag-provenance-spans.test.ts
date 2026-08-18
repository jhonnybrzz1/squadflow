/**
 * Testa provenância de retrieval nos RAG spans (item #4 do roadmap de obs).
 *
 * Verifica que enqueueRAGSpans:
 * 1. Inclui request.id como atributo do span pai quando requestId é passado
 * 2. Inclui rag.chunk_ids (array) e rag.chunk_count quando chunkIds é passado
 * 3. Trunca chunk_ids para 32 entries (proteção de tamanho)
 * 4. Não inclui atributos de provenância quando requestId/chunkIds são omitidos
 * 5. Mantém os atributos de timing originais (rag.total_ms, etc.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { traceExporterService } from '../server/services/trace-exporter';
import type { RAGSubstepTimings } from '../server/services/rag-substep-metrics';

const sampleTimings: RAGSubstepTimings = {
  embedding_ms: 10,
  vector_search_ms: 20,
  metadata_filter_ms: 5,
  rerank_ms: 30,
  doc_fetch_ms: 8,
  context_build_ms: 4,
  total_ms: 77,
};

interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: number;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: { values: Array<{ stringValue?: string }> };
  };
}

function findAttr(attrs: OtlpAttribute[] | undefined, key: string): OtlpAttribute | undefined {
  return attrs?.find((a) => a.key === key);
}

describe('RAG provenance spans (enqueueRAGSpans)', () => {
  const exportSpy = vi
    .spyOn(
      traceExporterService as unknown as { exportRAGPayload: (p: unknown) => Promise<void> },
      'exportRAGPayload',
    )
    .mockResolvedValue(undefined);

  beforeEach(() => {
    exportSpy.mockClear();
  });

  function getParentSpanAttrs(): OtlpAttribute[] {
    expect(exportSpy).toHaveBeenCalledTimes(1);
    const payload = exportSpy.mock.calls[0][0] as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string; attributes: OtlpAttribute[] }> }>;
      }>;
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const parent = spans.find((s) => s.name === 'rag.retrieve');
    expect(parent).toBeDefined();
    return parent!.attributes;
  }

  it('inclui request.id e rag.chunk_ids quando requestId e chunkIds são passados', () => {
    traceExporterService.enqueueRAGSpans(sampleTimings, 'trace-abc123', {
      requestId: 'req-001',
      chunkIds: ['chunk-a', 'chunk-b', 'chunk-c'],
    });

    const attrs = getParentSpanAttrs();
    expect(findAttr(attrs, 'request.id')?.value.stringValue).toBe('req-001');
    expect(findAttr(attrs, 'rag.chunk_count')?.value.intValue).toBe(3);
    const chunkIdsAttr = findAttr(attrs, 'rag.chunk_ids');
    expect(chunkIdsAttr?.value.arrayValue?.values.map((v) => v.stringValue)).toEqual([
      'chunk-a',
      'chunk-b',
      'chunk-c',
    ]);
  });

  it('trunca chunk_ids para 32 entries', () => {
    const many = Array.from({ length: 50 }, (_, i) => `chunk-${i}`);
    traceExporterService.enqueueRAGSpans(sampleTimings, 'trace-trunc', {
      chunkIds: many,
    });

    const attrs = getParentSpanAttrs();
    expect(findAttr(attrs, 'rag.chunk_count')?.value.intValue).toBe(32);
    const chunkIdsAttr = findAttr(attrs, 'rag.chunk_ids');
    expect(chunkIdsAttr?.value.arrayValue?.values).toHaveLength(32);
  });

  it('não inclui atributos de provenância quando omitidos', () => {
    traceExporterService.enqueueRAGSpans(sampleTimings, 'trace-bare', { cacheHit: false });

    const attrs = getParentSpanAttrs();
    expect(findAttr(attrs, 'request.id')).toBeUndefined();
    expect(findAttr(attrs, 'rag.chunk_ids')).toBeUndefined();
    expect(findAttr(attrs, 'rag.chunk_count')).toBeUndefined();
  });

  it('mantém atributos de timing e cache_hit', () => {
    traceExporterService.enqueueRAGSpans(sampleTimings, 'trace-timing', { cacheHit: true });

    const attrs = getParentSpanAttrs();
    expect(findAttr(attrs, 'rag.total_ms')?.value.intValue).toBe(77);
    expect(findAttr(attrs, 'rag.embedding_ms')?.value.intValue).toBe(10);
    expect(findAttr(attrs, 'rag.vector_search_ms')?.value.intValue).toBe(20);
    expect(findAttr(attrs, 'rag.cache_hit')?.value.boolValue).toBe(true);
  });

  it('cria spans filhos para cada subetapa', () => {
    traceExporterService.enqueueRAGSpans(sampleTimings, 'trace-children', {});

    const payload = exportSpy.mock.calls[0][0] as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string }> }>;
      }>;
    };
    const names = payload.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name);
    expect(names).toContain('rag.retrieve');
    expect(names).toContain('rag.embedding');
    expect(names).toContain('rag.vector_search');
    expect(names).toContain('rag.rerank');
    expect(names).toContain('rag.context_build');
  });
});
