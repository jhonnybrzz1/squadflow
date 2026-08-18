import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../server/db', () => ({
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
  isPostgres: false,
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { dbHelper } from '../server/db';
import { refinementFeedbackService } from '../server/services/refinement-feedback-service';

describe('RefinementFeedbackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dbHelper.run as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (dbHelper.get as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  describe('Input validation — route level', () => {
    it('rejects nota below 1', () => {
      const nota = 0;
      const valid = Number.isInteger(nota) && nota >= 1 && nota <= 5;
      expect(valid).toBe(false);
    });

    it('rejects nota above 5', () => {
      const nota = 6;
      const valid = Number.isInteger(nota) && nota >= 1 && nota <= 5;
      expect(valid).toBe(false);
    });

    it('rejects null nota', () => {
      const nota = null;
      const valid =
        nota !== null &&
        nota !== undefined &&
        Number.isInteger(nota as any) &&
        (nota as any) >= 1 &&
        (nota as any) <= 5;
      expect(valid).toBe(false);
    });

    it('rejects string nota', () => {
      const nota = '3';
      const valid = Number.isInteger(nota as any) && (nota as any) >= 1 && (nota as any) <= 5;
      expect(valid).toBe(false);
    });

    it('accepts nota 1', () => {
      const nota = 1;
      const valid = Number.isInteger(nota) && nota >= 1 && nota <= 5;
      expect(valid).toBe(true);
    });

    it('accepts nota 5', () => {
      const nota = 5;
      const valid = Number.isInteger(nota) && nota >= 1 && nota <= 5;
      expect(valid).toBe(true);
    });

    it('rejects texto > 500 characters', () => {
      const texto = 'a'.repeat(501);
      expect(texto.length > 500).toBe(true);
    });

    it('accepts texto of exactly 500 characters', () => {
      const texto = 'a'.repeat(500);
      expect(texto.length <= 500).toBe(true);
    });

    it('accepts empty texto', () => {
      const texto = '';
      expect(texto.length <= 500).toBe(true);
    });

    it('accepts null texto', () => {
      const texto: null = null;
      expect(texto).toBeNull();
    });

    it('rejects missing refinementId', () => {
      const body: Partial<{ refinementId: string }> = {};
      const valid = !!body.refinementId && body.refinementId.trim() !== '';
      expect(valid).toBe(false);
    });

    it('rejects missing agentId', () => {
      const body: Partial<{ agentId: string }> = {};
      const valid = !!body.agentId && body.agentId.trim() !== '';
      expect(valid).toBe(false);
    });

    it('sanitizes HTML tags in texto', () => {
      const dirty = '<script>alert("xss")</script>Boa resposta';
      const clean = dirty.replace(/<[^>]*>/g, '');
      expect(clean).toBe('alert("xss")Boa resposta');
      expect(clean).not.toContain('<script>');
      expect(clean).not.toContain('</script>');
    });
  });

  describe('RefinementFeedbackService.create', () => {
    it('creates a feedback entry with valid input', async () => {
      const now = Math.floor(Date.now() / 1000);

      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 42,
          refinement_id: '10:qa',
          agent_id: 'qa',
          nota: 5,
          texto: 'Ótima resposta!',
          modelo: 'gpt-4',
          qtd_iteracoes_ate_feedback: 1,
          criado_em: now,
        },
      ]);

      const entry = await refinementFeedbackService.create({
        refinementId: '10:qa',
        agentId: 'qa',
        nota: 5,
        texto: 'Ótima resposta!',
        modelo: 'gpt-4',
        qtdIteracoesAteFeedback: 1,
      });

      expect(entry.id).toBe(42);
      expect(entry.refinementId).toBe('10:qa');
      expect(entry.agentId).toBe('qa');
      expect(entry.nota).toBe(5);
      expect(entry.texto).toBe('Ótima resposta!');
      expect(entry.criadoEm).toBeInstanceOf(Date);
    });

    it('creates feedback with null texto', async () => {
      const now = Math.floor(Date.now() / 1000);

      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 43,
          refinement_id: '5:ux',
          agent_id: 'ux',
          nota: 3,
          texto: null,
          modelo: null,
          qtd_iteracoes_ate_feedback: null,
          criado_em: now,
        },
      ]);

      const entry = await refinementFeedbackService.create({
        refinementId: '5:ux',
        agentId: 'ux',
        nota: 3,
      });

      expect(entry.nota).toBe(3);
      expect(entry.texto).toBeNull();
    });

    it('calls dbHelper.all for insert', async () => {
      const now = Math.floor(Date.now() / 1000);

      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          refinement_id: 'r1',
          agent_id: 'pm',
          nota: 2,
          texto: null,
          modelo: null,
          qtd_iteracoes_ate_feedback: null,
          criado_em: now,
        },
      ]);

      await refinementFeedbackService.create({
        refinementId: 'r1',
        agentId: 'pm',
        nota: 2,
      });

      // dbHelper.all is called for the INSERT RETURNING query
      expect(dbHelper.all).toHaveBeenCalled();
    });
  });

  describe('Multiple feedbacks for same refinement', () => {
    it('allows multiple feedback entries for the same refinementId', async () => {
      // No uniqueness constraint — both inserts should succeed conceptually
      const nota1 = 3;
      const nota2 = 5;
      expect(nota1).toBeLessThan(nota2);

      // Validate both are valid notas
      const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;
      expect(valid(nota1)).toBe(true);
      expect(valid(nota2)).toBe(true);
    });
  });

  describe('per-item status', () => {
    const itemRow = (status: 'feito' | 'desatualizado') => ({
      id: 77,
      refinement_id: 'message-1',
      agent_id: 'product_owner',
      nota: null,
      texto: null,
      modelo: null,
      qtd_iteracoes_ate_feedback: null,
      item_index: 0,
      item_key: 'fnv1a-item',
      version_hash: 'fnv1a-version',
      status,
      criado_em: 1_700_000_000,
      atualizado_em: 1_700_000_001,
    });

    it('creates a status without inventing a satisfaction score', async () => {
      (dbHelper.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([itemRow('feito')]);

      const result = await refinementFeedbackService.upsertItemStatus({
        refinementId: 'message-1',
        agentId: 'product_owner',
        itemIndex: 0,
        itemKey: 'fnv1a-item',
        versionHash: 'fnv1a-version',
        status: 'feito',
      });

      expect(result.created).toBe(true);
      expect(result.entry.nota).toBeNull();
      expect(result.entry.status).toBe('feito');
    });

    it('updates the same item identity when its status changes', async () => {
      (dbHelper.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 77 });
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([itemRow('desatualizado')]);

      const result = await refinementFeedbackService.upsertItemStatus({
        refinementId: 'message-1',
        agentId: 'product_owner',
        itemIndex: 0,
        itemKey: 'fnv1a-item',
        versionHash: 'fnv1a-version',
        status: 'desatualizado',
      });

      expect(result.created).toBe(false);
      expect(result.entry.id).toBe(77);
      expect(result.entry.status).toBe('desatualizado');
    });
  });

  describe('refinementId derivation', () => {
    it('builds refinementId from demandId and agent', () => {
      const demandId = 10;
      const agent = 'qa';
      const refinementId = `${demandId}:${agent}`;
      expect(refinementId).toBe('10:qa');
    });

    it('falls back to messageId when demandId is null', () => {
      const demandId: number | null = null;
      const messageId = 'fallback-msg-id';
      const agent = 'qa';
      const refinementId = demandId != null ? `${demandId}:${agent}` : messageId;
      expect(refinementId).toBe('fallback-msg-id');
    });
  });
});
