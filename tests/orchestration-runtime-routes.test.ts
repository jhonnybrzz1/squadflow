import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMock = vi.hoisted(() => ({
  listRunsByDemand: vi.fn(),
  getRunDetails: vi.fn(),
  getRun: vi.fn(),
  listTurns: vi.fn(),
  listEvents: vi.fn(),
  listToolCallsByRun: vi.fn(),
  listToolCallsByTurn: vi.fn(),
}));

vi.mock('../server/repositories/orchestration-runtime-repository', () => ({
  orchestrationRuntimeRepository: repositoryMock,
}));

import orchestrationRuntimeRouter from '../server/routes/orchestration-runtime';
import { errorHandler } from '../server/middleware/error-handler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(orchestrationRuntimeRouter);
  app.use(errorHandler);
  return app;
}

describe('Orchestration runtime routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista runs de uma demanda', async () => {
    repositoryMock.listRunsByDemand.mockResolvedValueOnce([
      { runId: 'run-1', demandId: 7, status: 'completed' },
    ]);

    const response = await request(createApp()).get('/api/demands/7/orchestration-runs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      demandId: 7,
      runs: [{ runId: 'run-1', demandId: 7, status: 'completed' }],
    });
    expect(repositoryMock.listRunsByDemand).toHaveBeenCalledWith(7);
  });

  it('retorna detalhes consolidados de um run', async () => {
    repositoryMock.getRunDetails.mockResolvedValueOnce({
      run: { runId: 'run-1', status: 'completed' },
      turns: [{ turnId: 'turn-1', agentName: 'pm' }],
      toolCalls: [{ toolCallId: 'tool-1', toolName: 'repo_search' }],
      events: [{ eventId: 'event-1', eventType: 'AGENT_COMPLETED' }],
      summary: {
        turnCount: 1,
        toolCallCount: 1,
        eventCount: 1,
        failedTurns: 0,
        failedToolCalls: 0,
      },
    });

    const response = await request(createApp()).get('/api/orchestration-runs/run-1');

    expect(response.status).toBe(200);
    expect(response.body.summary.turnCount).toBe(1);
    expect(response.body.toolCalls[0].toolName).toBe('repo_search');
  });

  it('retorna 404 quando run nao existe', async () => {
    repositoryMock.getRunDetails.mockResolvedValueOnce(null);

    const response = await request(createApp()).get('/api/orchestration-runs/missing');

    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe('NOT_FOUND');
    expect(response.body.message).toBe('Orchestration run not found');
  });
});
