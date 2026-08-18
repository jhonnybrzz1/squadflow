/**
 * Demanda 10095 — motor de consenso da retrospectiva.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateConsensus,
  validateRetroPoint,
  CONSENSUS_MAX_ROUNDS,
  TACIT_APPROVAL_WINDOW_MS,
} from '../../server/services/retro-consensus';

const PARTICIPANTS = ['tech_lead', 'qa', 'product_owner', 'scrum_master'];
const OPENED = '2026-07-23T10:00:00.000Z';
const allApproved = PARTICIPANTS.map((agent) => ({
  agent,
  decision: 'approved' as const,
  timestamp: '2026-07-23T10:05:00.000Z',
}));

describe('evaluateConsensus — unanimidade real', () => {
  it('aprova só quando TODOS registram Aprovado + timestamp', () => {
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes: allApproved,
      round: 1,
      now: '2026-07-23T10:10:00.000Z',
      roundOpenedAt: OPENED,
    });
    expect(r.approved).toBe(true);
    expect(r.status).toBe('approved');
    expect(r.explicitApprovals).toHaveLength(4);
  });

  it('aprovação sem timestamp não conta como aprovação formal', () => {
    const votes = allApproved.map((v, i) =>
      i === 0 ? { agent: v.agent, decision: 'approved' as const } : v,
    );
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes,
      round: 1,
      now: '2026-07-23T10:10:00.000Z',
      roundOpenedAt: OPENED,
    });
    expect(r.approved).toBe(false); // tech_lead sem timestamp cai em awaiting
    expect(r.awaiting).toContain('tech_lead');
  });

  it('uma objeção derruba a unanimidade (não há maioria)', () => {
    const votes = [
      ...allApproved.slice(1),
      { agent: 'tech_lead', decision: 'objected' as const, timestamp: OPENED },
    ];
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes,
      round: 1,
      now: '2026-07-23T10:10:00.000Z',
      roundOpenedAt: OPENED,
    });
    expect(r.approved).toBe(false);
    expect(r.objections).toContain('tech_lead');
    expect(r.status).toBe('awaiting'); // ainda há rodada
  });
});

describe('aprovação tácita (48h de ausência)', () => {
  it('ausente ANTES de 48h fica awaiting, não aprova', () => {
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes: allApproved.slice(1), // product_owner? não: falta tech_lead
      round: 1,
      now: new Date(new Date(OPENED).getTime() + TACIT_APPROVAL_WINDOW_MS - 1).toISOString(),
      roundOpenedAt: OPENED,
    });
    expect(r.awaiting).toContain('tech_lead');
    expect(r.approved).toBe(false);
  });

  it('ausente DEPOIS de 48h vira aprovação tácita e fecha o consenso', () => {
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes: allApproved.slice(1),
      round: 1,
      now: new Date(new Date(OPENED).getTime() + TACIT_APPROVAL_WINDOW_MS + 1).toISOString(),
      roundOpenedAt: OPENED,
    });
    expect(r.tacitApprovals).toContain('tech_lead');
    expect(r.approved).toBe(true);
  });
});

describe('timeout de rodadas → pendência', () => {
  it('objeção ativa na última rodada difere para a próxima sprint', () => {
    const votes = [
      ...allApproved.slice(1),
      { agent: 'tech_lead', decision: 'objected' as const, timestamp: OPENED },
    ];
    const r = evaluateConsensus({
      participants: PARTICIPANTS,
      votes,
      round: CONSENSUS_MAX_ROUNDS,
      now: '2026-07-23T10:10:00.000Z',
      roundOpenedAt: OPENED,
    });
    expect(r.status).toBe('unresolved');
    expect(r.deferredToNextSprint).toBe(true);
  });
});

describe('validateRetroPoint — template fixo', () => {
  it('exige categoria, descrição e impacto', () => {
    expect(
      validateRetroPoint({ category: 'processo', description: 'x', impact: 'alto' }).valid,
    ).toBe(true);
  });
  it('campo em branco não burla o template', () => {
    const r = validateRetroPoint({ category: 'processo', description: 'x', impact: '  ' });
    expect(r.valid).toBe(false);
    expect(r.missing).toContain('impact');
  });
});
