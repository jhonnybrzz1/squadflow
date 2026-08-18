import { describe, expect, it } from 'vitest';
import { resolveChatDemand } from '@/lib/demand-selection';

type Candidate = {
  id: number;
  status: string;
  updatedAt?: string;
};

describe('resolveChatDemand', () => {
  const activeOld: Candidate = {
    id: 1,
    status: 'processing',
    updatedAt: '2026-07-14T20:00:00Z',
  };
  const activeNew: Candidate = {
    id: 2,
    status: 'processing',
    updatedAt: '2026-07-14T21:00:00Z',
  };
  const history: Candidate = { id: 3, status: 'completed' };

  it('automatically displays the newest active refinement without a click', () => {
    expect(resolveChatDemand([activeOld, activeNew, history], null, 'auto')).toBe(activeNew);
  });

  it('preserves the active refinement selected among multiple running items', () => {
    expect(resolveChatDemand([activeOld, activeNew], activeOld, 'manual-active')).toBe(activeOld);
  });

  it('preserves explicit history inspection while a refinement is active', () => {
    expect(resolveChatDemand([activeNew, history], history, 'manual-history')).toBe(history);
  });

  it('advances to another active refinement when the current active one completes', () => {
    const completedCurrent = { ...activeOld, status: 'completed' };
    expect(
      resolveChatDemand([completedCurrent, activeNew], completedCurrent, 'manual-active'),
    ).toBe(activeNew);
  });
});

describe('status routed é ativo (spec 014 S4 / M-04)', () => {
  const routedDemand: Candidate = {
    id: 10,
    status: 'routed',
    updatedAt: '2026-07-17T10:00:00Z',
  };
  const completed: Candidate = { id: 11, status: 'completed' };

  it('seleciona automaticamente uma demanda routed como ativa', () => {
    expect(resolveChatDemand([routedDemand, completed], null, 'auto')).toBe(routedDemand);
  });

  it('mantém a demanda routed selecionada (não a trata como pendente/inativa)', () => {
    expect(resolveChatDemand([routedDemand, completed], routedDemand, 'manual-active')).toBe(
      routedDemand,
    );
  });
});

describe('rótulos de status compartilhados (M-04)', () => {
  it('routed possui rótulo próprio e é considerado ativo pelo contrato', async () => {
    const { DEMAND_STATUS_LABELS, isActiveDemandStatus } = await import('@shared/demand-status');
    expect(DEMAND_STATUS_LABELS.routed).toBe('ROTEADA');
    expect(isActiveDemandStatus('routed')).toBe(true);
    expect(isActiveDemandStatus('completed')).toBe(false);
    expect(isActiveDemandStatus(undefined)).toBe(false);
  });
});
