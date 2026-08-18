/**
 * Demanda 10096 — backlog steps: atualização automática via DOCUMENT_GENERATED.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backlogActivityService,
  __setBacklogDbForTests,
} from '../server/services/backlog-activity-service';
import {
  registerBacklogStepSubscriber,
  __resetBacklogStepSubscriberForTests,
} from '../server/services/backlog-step-subscriber';
import { eventBus } from '../server/events/event-bus';

// A08: o serviço passou a usar Drizzle tipado, então o seam recebe a própria
// instância — os testes seguem contra SQLite real, agora sem SQL cru no meio.
function makeDb(sqlite: Database.Database) {
  return drizzle(sqlite) as unknown as Parameters<typeof __setBacklogDbForTests>[0];
}

vi.mock('../server/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  __setBacklogDbForTests(null);
  __resetBacklogStepSubscriberForTests();
});

describe('BacklogStepSubscriber', () => {
  beforeEach(() => {
    registerBacklogStepSubscriber();
  });

  it('DOCUMENT_GENERATED do tipo PRD atualiza hasPrd da atividade', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({ demandId: 42, title: 'X' });
    const before = (await backlogActivityService.list())[0];
    expect(before.hasPrd).toBe(false);

    eventBus.publish('DOCUMENT_GENERATED', {
      demandId: 42,
      filepath: 'documents/X_PRD.pdf',
      type: 'PRD',
    });

    // EventBus é síncrono; subscriber é async fire-and-forget.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = (await backlogActivityService.list())[0];
    expect(after.hasPrd).toBe(true);
  });

  it('DOCUMENT_GENERATED do tipo Tasks atualiza hasTasks', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({ demandId: 43, title: 'Y' });
    eventBus.publish('DOCUMENT_GENERATED', {
      demandId: 43,
      filepath: 'documents/Y_Tasks.pdf',
      type: 'Tasks',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = (await backlogActivityService.list())[0];
    expect(after.hasTasks).toBe(true);
  });

  it('DOCUMENT_GENERATED de tipo ignorado não altera a atividade', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({ demandId: 44, title: 'Z' });
    eventBus.publish('DOCUMENT_GENERATED', {
      demandId: 44,
      filepath: 'documents/Z_TSD.pdf',
      type: 'TSD',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = (await backlogActivityService.list())[0];
    expect(after.hasPrd).toBe(false);
    expect(after.hasTasks).toBe(false);
  });
});

describe('BacklogActivityService.updateArtifactFlags', () => {
  it('atualiza hasPrd, hasTasks e hasChat de uma atividade existente', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({ demandId: 10, title: 'A' });
    const updated = await backlogActivityService.updateArtifactFlags(10, {
      hasPrd: true,
      hasChat: true,
    });
    expect(updated).not.toBeNull();
    expect(updated?.hasPrd).toBe(true);
    expect(updated?.hasChat).toBe(true);
    expect(updated?.hasTasks).toBe(false);
  });

  it('não cria atividade inexistente', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    const updated = await backlogActivityService.updateArtifactFlags(99, { hasPrd: true });
    expect(updated).toBeNull();
  });
});
