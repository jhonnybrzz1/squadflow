import { describe, it, expect } from 'vitest';
import { toDemandMetadata } from '../../shared/demand-metadata';
import type { Demand } from '../../shared/schema';

function makeDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: 10064,
    title: 'Melhorias aichatflow1',
    description: 'desc',
    type: 'nova_funcionalidade',
    priority: 'media',
    refinementType: 'technical',
    status: 'completed',
    progress: 100,
    chatMessages: [],
    domain: 'padrao',
    qualityGateStatus: 'passed',
    promptTokens: 12300,
    completionTokens: 4100,
    custoEstimado: 0.0352,
    repoFullName: 'example-org/AiChatFlow1',
    createdAt: new Date('2026-07-21T10:00:00Z'),
    completedAt: new Date('2026-07-22T12:00:00Z'),
    updatedAt: new Date('2026-07-22T12:05:00Z'),
    ...overrides,
  } as Demand;
}

describe('toDemandMetadata (spec 10064)', () => {
  it('projeta os campos user-facing e converte datas para ISO', () => {
    const meta = toDemandMetadata(makeDemand());
    expect(meta).toMatchObject({
      id: 10064,
      title: 'Melhorias aichatflow1',
      type: 'nova_funcionalidade',
      priority: 'media',
      refinementType: 'technical',
      domain: 'padrao',
      status: 'completed',
      qualityGateStatus: 'passed',
      promptTokens: 12300,
      completionTokens: 4100,
      custoEstimado: 0.0352,
      repoFullName: 'example-org/AiChatFlow1',
    });
    expect(meta.createdAt).toBe('2026-07-21T10:00:00.000Z');
    expect(meta.completedAt).toBe('2026-07-22T12:00:00.000Z');
  });

  it('não vaza chatMessages nem outros blobs', () => {
    const meta = toDemandMetadata(makeDemand());
    expect('chatMessages' in meta).toBe(false);
    expect('description' in meta).toBe(false);
    expect('documentVersions' in meta).toBe(false);
  });

  it('agentCount = agentes distintos em mensagens completed', () => {
    const meta = toDemandMetadata(
      makeDemand({
        chatMessages: [
          { id: '1', agent: 'product_owner', message: 'a', timestamp: '', type: 'completed' },
          { id: '2', agent: 'product_owner', message: 'b', timestamp: '', type: 'completed' },
          { id: '3', agent: 'tech_lead', message: 'c', timestamp: '', type: 'completed' },
          { id: '4', agent: 'qa', message: 'd', timestamp: '', type: 'processing' },
        ] as Demand['chatMessages'],
      }),
    );
    // product_owner + tech_lead (qa está 'processing', não conta)
    expect(meta.agentCount).toBe(2);
  });

  it('degrada graciosamente com campos nulos', () => {
    const meta = toDemandMetadata(
      makeDemand({
        refinementType: null,
        qualityGateStatus: null,
        repoFullName: null,
        completedAt: null,
      }),
    );
    expect(meta.refinementType).toBeNull();
    expect(meta.qualityGateStatus).toBeNull();
    expect(meta.repoFullName).toBeNull();
    expect(meta.completedAt).toBeNull();
    expect(meta.agentCount).toBe(0);
  });
});
