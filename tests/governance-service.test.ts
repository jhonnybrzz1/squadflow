import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requiresHumanReview,
  getPrdContent,
  updateChecklist,
  recordInteraction,
} from '../server/services/governance-service';

// Mock dependencies
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findByIdOrNull: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: {
    load: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

import fs from 'fs';
import { demandRepository } from '../server/repositories/demand-repository';
import { documentVersioningService } from '../server/services/document-versioning';

describe('governance-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requiresHumanReview', () => {
    it('returns true when requiresHumanReview is true', () => {
      const demand = { requiresHumanReview: true };
      const result = requiresHumanReview(demand);
      expect(result).toBe(true);
    });

    it('returns true when requiresApproval is true', () => {
      const demand = { requiresApproval: true };
      const result = requiresHumanReview(demand);
      expect(result).toBe(true);
    });

    it('returns false when both flags are false', () => {
      const demand = { requiresHumanReview: false, requiresApproval: false };
      const result = requiresHumanReview(demand);
      expect(result).toBe(false);
    });

    it('returns false when flags are null', () => {
      const demand = { requiresHumanReview: null, requiresApproval: null };
      const result = requiresHumanReview(demand);
      expect(result).toBe(false);
    });

    it('falls back to requiresApproval when requiresHumanReview is null', () => {
      const demand = { requiresHumanReview: null, requiresApproval: true };
      const result = requiresHumanReview(demand);
      expect(result).toBe(true);
    });
  });

  describe('getPrdContent', () => {
    it('returns empty string when prdUrl is null', async () => {
      const result = await getPrdContent(null);
      expect(result).toBe('');
    });

    it('reads file content when file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('PRD content');

      const result = await getPrdContent('/path/to/prd.md');
      expect(result).toBe('PRD content');
      expect(fs.existsSync).toHaveBeenCalledWith('/path/to/prd.md');
      expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/prd.md', 'utf8');
    });

    it('prefers the versioned PRD when a demand id is available', async () => {
      vi.mocked(documentVersioningService.load).mockResolvedValue({
        demandId: 2,
        type: 'prd',
        content: 'Versioned PRD content',
        version: 1,
        hash: 'sha256:test',
        updatedAt: new Date().toISOString(),
        hasPreviousVersion: false,
      });

      const result = await getPrdContent('/api/documents/legacy.pdf', 2);

      expect(result).toBe('Versioned PRD content');
      expect(documentVersioningService.load).toHaveBeenCalledWith(2, 'prd');
      expect(fs.existsSync).not.toHaveBeenCalled();
    });

    it('returns empty string when file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await getPrdContent('/path/to/prd.md');
      expect(result).toBe('');
    });

    it('handles file read errors gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await getPrdContent('/path/to/prd.md');
      expect(result).toBe('');
    });
  });

  describe('updateChecklist', () => {
    it('updates demand with checklist', async () => {
      vi.mocked(demandRepository.update).mockResolvedValue(undefined);
      vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue(null as never);

      await updateChecklist(1, { section1: true, section2: false });
      expect(demandRepository.update).toHaveBeenCalledWith(1, {
        sectionChecklist: { section1: true, section2: false },
        updatedAt: expect.any(Date),
      });
    });

    // Auditoria 2026-08-01 (A04): o replace integral apagava evidências já
    // persistidas quando o cliente abria com estado incompleto.
    describe('merge por chave em vez de replace integral (A04)', () => {
      const withExistingChecklist = (sectionChecklist: Record<string, boolean>) => {
        vi.mocked(demandRepository.update).mockResolvedValue(undefined);
        vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue({
          id: 1,
          sectionChecklist,
        } as never);
      };

      const mergedChecklist = () =>
        vi.mocked(demandRepository.update).mock.calls.at(-1)?.[1].sectionChecklist;

      it('edição parcial preserva as chaves ausentes no payload', async () => {
        withExistingChecklist({ problema: true, escopo: true, riscos: true });

        await updateChecklist(1, { escopo: false });

        expect(mergedChecklist()).toEqual({ problema: true, escopo: false, riscos: true });
      });

      it('payload vazio é no-op e não zera nada', async () => {
        withExistingChecklist({ problema: true, escopo: true });

        await updateChecklist(1, {});

        expect(mergedChecklist()).toEqual({ problema: true, escopo: true });
      });

      it('chave nova convive com as existentes', async () => {
        withExistingChecklist({ problema: true });

        await updateChecklist(1, { metricas: true });

        expect(mergedChecklist()).toEqual({ problema: true, metricas: true });
      });

      it('null explícito não apaga a evidência existente', async () => {
        withExistingChecklist({ problema: true, escopo: true });

        await updateChecklist(1, { problema: null } as unknown as Record<string, boolean>);

        expect(mergedChecklist()).toEqual({ problema: true, escopo: true });
      });

      it('demanda sem checklist prévio aceita payload vazio sem erro', async () => {
        vi.mocked(demandRepository.update).mockResolvedValue(undefined);
        vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue({ id: 1 } as never);

        await expect(updateChecklist(1, {})).resolves.toBeUndefined();
        expect(mergedChecklist()).toEqual({});
      });
    });
  });

  describe('recordInteraction', () => {
    it('records a new interaction', async () => {
      const mockDemand = {
        id: 1,
        refinementInteractions: [],
      };
      vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue(mockDemand);
      vi.mocked(demandRepository.update).mockResolvedValue(undefined);

      const interaction = {
        type: 'PROPOSE' as const,
        content: 'Test comment',
        author: 'test-user',
      };

      const result = await recordInteraction(1, interaction);
      expect(result.type).toBe('PROPOSE');
      expect(result.content).toBe('Test comment');
      expect(result.author).toBe('test-user');
      expect(result.id).toBe('test-uuid');
      expect(result.timestamp).toBeDefined();
    });

    it('appends interaction to existing list', async () => {
      const mockDemand = {
        id: 1,
        refinementInteractions: [
          {
            id: 'existing-1',
            type: 'COMMENT' as const,
            content: 'Existing',
            timestamp: '2024-01-01',
          },
        ],
      };
      vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue(mockDemand);
      vi.mocked(demandRepository.update).mockResolvedValue(undefined);

      const interaction = {
        type: 'PROPOSE' as const,
        content: 'New comment',
        author: 'test-user',
      };

      const result = await recordInteraction(1, interaction);
      expect(result.type).toBe('PROPOSE');
      expect(demandRepository.update).toHaveBeenCalledWith(1, {
        refinementInteractions: expect.any(Array),
        updatedAt: expect.any(Date),
      });
    });

    it('throws error when demand not found', async () => {
      vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue(null);

      const interaction = {
        type: 'PROPOSE' as const,
        content: 'Test',
        author: 'test',
      };

      await expect(recordInteraction(1, interaction)).rejects.toThrow('Demand not found');
    });
  });
});
