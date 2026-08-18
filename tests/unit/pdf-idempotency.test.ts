import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeDocumentWorker } from '../../server/workers/document-worker';
import { eventBus } from '../../server/events/event-bus';
import { pdfGenerator } from '../../server/services/pdf-generator';
import { db } from '../../server/db';
import fs from 'fs';
import path from 'path';

vi.mock('../../server/services/pdf-generator', () => ({
  pdfGenerator: {
    generatePRDDocument: vi.fn().mockResolvedValue(Buffer.from('test-prd-pdf')),
    generateTasksDocument: vi.fn().mockResolvedValue(Buffer.from('test-tasks-pdf')),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(true),
    },
  };
});

vi.mock('../../server/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue({}),
    }),
  },
  dbHelper: {
    isPostgres: false,
    all: vi.fn().mockResolvedValue([{ name: 'last_succeeded_dialect' }]),
  },
  isPostgres: false,
}));

describe('DocumentWorker Idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-initialize to register the subscriber
    // We clear subscribers first to avoid multiple listeners
    eventBus.removeAllListeners();
    initializeDocumentWorker();
  });

  it('should process the PDF successfully on the first request', async () => {
    const payload = {
      demandId: 1,
      type: 'PRD' as const,
      content: '# Test PRD',
      targetFilepath: '/tmp/test.pdf',
    };

    // Trigger event
    await eventBus.publish('DOCUMENT_GENERATION_REQUESTED', payload);

    // Give it a tick to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(db.insert).toHaveBeenCalled();
    expect(pdfGenerator.generatePRDDocument).toHaveBeenCalledWith('# Test PRD', 1);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.resolve('/tmp/test.pdf'),
      expect.any(Buffer),
    );
  });

  it('should skip PDF generation if idempotency key constraint fails', async () => {
    const payload = {
      demandId: 1,
      type: 'PRD' as const,
      content: '# Test PRD',
      targetFilepath: '/tmp/test.pdf',
    };

    // Mock DB throw unique constraint error
    vi.mocked(db.insert).mockImplementationOnce(
      () =>
        ({
          values: vi.fn().mockRejectedValue({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
        }) as any,
    );

    // Trigger event
    await eventBus.publish('DOCUMENT_GENERATION_REQUESTED', payload);

    // Give it a tick to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(db.insert).toHaveBeenCalled();
    // It should skip generation because it's a duplicate in the same minute
    expect(pdfGenerator.generatePRDDocument).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
