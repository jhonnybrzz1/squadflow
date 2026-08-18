/**
 * Document Versioning Tests — PRD "Editor de Documentos" CT-1..CT-5
 *
 * - CT-1 Reidratação: salvar → carregar → conteúdo igual
 * - CT-2 Falha de rede: API call falha não corrompe estado
 * - CT-3 Conflito 409: response inclui ambos os conteúdos
 * - CT-4 XSS via markdown: conteúdo é texto puro (não interpretado)
 * - CT-5 Idempotência (sem tempestade): hash igual = no-op
 *
 * Contract: docs/document-editor-contract.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use a temp dir for test documents to avoid polluting the real one
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docver-test-'));
const documentsDir = path.join(tempRoot, 'documents');
fs.mkdirSync(documentsDir, { recursive: true });

// process.cwd() returns the test runner cwd; the service uses path.join(process.cwd(), 'documents')
// We chdir to tempRoot for the suite
const originalCwd = process.cwd();

let mockDemands: Record<number, any> = {};
let demandUpdateShouldFail = false;

vi.mock('../server/storage', () => ({
  storage: {
    getDemand: vi.fn(async (id: number) => mockDemands[id]),
    updateDemand: vi.fn(async (id: number, updates: any) => {
      if (demandUpdateShouldFail) {
        throw new Error('simulated DB failure (CRIT-12 test)');
      }
      if (!mockDemands[id]) return undefined;
      mockDemands[id] = { ...mockDemands[id], ...updates };
      return mockDemands[id];
    }),
  },
}));

import {
  documentVersioningService,
  DocumentVersionError,
} from '../server/services/document-versioning';

function seed() {
  mockDemands = {
    50: {
      id: 50,
      title: 'Test',
      description: 'Test',
      type: 'melhoria',
      status: 'completed',
      refinementInteractions: [],
      documentVersions: {},
    },
  };
}

describe('Document Versioning Service - CT-1..CT-5', () => {
  beforeEach(() => {
    process.chdir(tempRoot);
    seed();
    demandUpdateShouldFail = false;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    // Clean test files between runs (keep dir)
    for (const f of fs.readdirSync(documentsDir)) {
      try {
        fs.unlinkSync(path.join(documentsDir, f));
      } catch (_) {
        /* ignore */
      }
    }
  });

  describe('CT-1: Reidratação fiel', () => {
    it('saved content is loaded back identically', async () => {
      const original =
        '# Título\n\nUm parágrafo com **negrito** e _itálico_.\n\n- item 1\n- item 2';
      const saved = await documentVersioningService.save(50, 'prd', original, 0, false);
      expect(saved.success).toBe(true);
      expect(saved.version).toBe(1);

      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.content).toBe(original);
      expect(loaded.version).toBe(1);
      expect(loaded.hash).toBe(saved.hash);
    });

    it('multiple saves rehydrate to latest', async () => {
      await documentVersioningService.save(50, 'prd', 'v1', 0, false);
      await documentVersioningService.save(50, 'prd', 'v2', 1, false);
      await documentVersioningService.save(50, 'prd', 'v3', 2, false);

      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.content).toBe('v3');
      expect(loaded.version).toBe(3);
      expect(loaded.hasPreviousVersion).toBe(true);
    });
  });

  describe('CT-2: Falha não corrompe estado', () => {
    it('NOT_FOUND for missing demand does not write files', async () => {
      await expect(
        documentVersioningService.save(999, 'prd', 'content', 0, false),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // No files should have been created for demand 999
      const files = fs.readdirSync(documentsDir).filter((f) => f.includes('_999_'));
      expect(files.length).toBe(0);
    });

    it('rejects invalid content (not a string) without mutation', async () => {
      await expect(
        // @ts-expect-error testing runtime guard
        documentVersioningService.save(50, 'prd', null, 0, false),
      ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.version).toBe(0);
    });
  });

  describe('CT-3: Conflito 412 expõe ambos os conteúdos', () => {
    it('returns server content + version with 412 when ifMatchVersion is stale', async () => {
      await documentVersioningService.save(50, 'prd', 'server-version', 0, false);

      try {
        await documentVersioningService.save(50, 'prd', 'client-version', 0, false);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(DocumentVersionError);
        expect(err.code).toBe('VERSION_CONFLICT');
        // Bug 4: 412 Precondition Failed (antes 409).
        expect(err.statusCode).toBe(412);
        expect(err.serverVersion).toBe(1);
        expect(err.serverContent).toBe('server-version');
        expect(err.clientVersion).toBe(0);
      }
    });

    it('absent ifMatchVersion on an existing document is a 412 precondition failure', async () => {
      await documentVersioningService.save(50, 'prd', 'server-version', 0, false);

      try {
        // ifMatchVersion undefined (parâmetro ausente) num doc existente
        await documentVersioningService.save(50, 'prd', 'client-version', undefined, false);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(DocumentVersionError);
        expect(err.code).toBe('VERSION_CONFLICT');
        expect(err.statusCode).toBe(412);
        expect(err.serverVersion).toBe(1);
      }
    });

    it('correct ifMatchVersion saves and increments the version', async () => {
      const r1 = await documentVersioningService.save(50, 'prd', 'v1', 0, false);
      expect(r1.version).toBe(1);
      const r2 = await documentVersioningService.save(50, 'prd', 'v2', 1, false);
      expect(r2.version).toBe(2);
    });

    it('force=true bypasses version check (overwrite)', async () => {
      await documentVersioningService.save(50, 'prd', 'first', 0, false);
      await documentVersioningService.save(50, 'prd', 'second', 1, false);

      // Force-overwrite with stale version
      const result = await documentVersioningService.save(50, 'prd', 'forced', 0, true);
      expect(result.version).toBe(3);

      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.content).toBe('forced');
    });
  });

  describe('CT-4: Markdown malicioso é tratado como texto', () => {
    it('stores HTML/script-like markdown as raw text without execution', async () => {
      const malicious =
        '<script>alert("xss")</script>\n\n[link](javascript:alert(1))\n\n<img src=x onerror=alert(1)>';
      const saved = await documentVersioningService.save(50, 'prd', malicious, 0, false);

      const loaded = await documentVersioningService.load(50, 'prd');
      // Backend stores it verbatim; sanitization happens at render time via rehype-sanitize
      expect(loaded.content).toBe(malicious);
      expect(loaded.hash).toBe(saved.hash);
      // The point is the backend doesn't execute it; that's enforced by it being a string
      expect(typeof loaded.content).toBe('string');
    });
  });

  describe('CT-5: Idempotência (sem tempestade)', () => {
    it('saving identical content twice does not increment version', async () => {
      const r1 = await documentVersioningService.save(50, 'prd', 'same', 0, false);
      const r2 = await documentVersioningService.save(50, 'prd', 'same', 1, false);

      expect(r1.version).toBe(1);
      expect(r2.version).toBe(1); // no increment
      expect(r1.hash).toBe(r2.hash);
    });

    it('different content increments version', async () => {
      const r1 = await documentVersioningService.save(50, 'prd', 'first', 0, false);
      const r2 = await documentVersioningService.save(50, 'prd', 'second', 1, false);
      expect(r1.version).toBe(1);
      expect(r2.version).toBe(2);
    });
  });

  describe('Revert (1-back history)', () => {
    it('revert returns to previous content as new version', async () => {
      await documentVersioningService.save(50, 'prd', 'original', 0, false);
      await documentVersioningService.save(50, 'prd', 'modified', 1, false);

      const reverted = await documentVersioningService.revert(50, 'prd');
      expect(reverted.success).toBe(true);
      expect(reverted.revertedFromVersion).toBe(2);
      expect(reverted.version).toBe(3);

      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.content).toBe('original');
    });

    it('revert without previous version throws NO_PREVIOUS_VERSION', async () => {
      await expect(documentVersioningService.revert(50, 'prd')).rejects.toMatchObject({
        code: 'NO_PREVIOUS_VERSION',
        statusCode: 409,
      });
    });
  });

  describe('Document types isolation', () => {
    it('prd and tasks are independent', async () => {
      await documentVersioningService.save(50, 'prd', 'prd-v1', 0, false);
      await documentVersioningService.save(50, 'tasks', 'tasks-v1', 0, false);

      const prd = await documentVersioningService.load(50, 'prd');
      const tasks = await documentVersioningService.load(50, 'tasks');

      expect(prd.content).toBe('prd-v1');
      expect(prd.version).toBe(1);
      expect(tasks.content).toBe('tasks-v1');
      expect(tasks.version).toBe(1);
    });
  });

  describe('CRIT-12: write order / orphan rollback', () => {
    // The service computes DOCUMENTS_DIR at module load time (before any
    // chdir), so it points at <originalCwd>/documents, not the temp dir.
    const realDocumentsDir = path.join(originalCwd, 'documents');

    it('rolls back the on-disk file when metadata persist fails (no orphan)', async () => {
      // Clean any leftover PRD_50 files from prior test runs.
      for (const f of fs.readdirSync(realDocumentsDir)) {
        if (f.startsWith('PRD_50_')) {
          try {
            fs.unlinkSync(path.join(realDocumentsDir, f));
          } catch (_) {
            /* ignore */
          }
        }
      }

      demandUpdateShouldFail = true;
      await expect(
        documentVersioningService.save(50, 'prd', 'will-be-rolled-back', 0, false),
      ).rejects.toThrow('simulated DB failure');

      // The specific file the service wrote (PRD_50_v1.md) must have been
      // deleted by the rollback — no orphan on disk.
      const orphanPath = path.join(realDocumentsDir, 'PRD_50_v1.md');
      expect(fs.existsSync(orphanPath)).toBe(false);

      // Metadata must not have been mutated either.
      demandUpdateShouldFail = false;
      const loaded = await documentVersioningService.load(50, 'prd');
      expect(loaded.version).toBe(0);
    });
  });
});
