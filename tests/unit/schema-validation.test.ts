import { describe, it, expect } from 'vitest';
import { feedbackPayloadSchema, classifyVaguenessPayloadSchema } from '../../shared/schema';

describe('Zod Schemas Unit Tests', () => {
  describe('feedbackPayloadSchema', () => {
    it('Deve validar um payload válido', () => {
      const validPayload = {
        demandId: 123,
        agentMessageId: 'msg_123',
        feedbackType: 'like',
        feedbackText: 'Ótima resposta!',
        agent: 'product_manager',
      };

      const result = feedbackPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('Deve falhar se agentMessageId for ausente ou vazio', () => {
      const invalidPayload = {
        feedbackType: 'like',
      };

      const result = feedbackPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('agentMessageId');
      }
    });

    it('Deve falhar se feedbackType for diferente de like/dislike', () => {
      const invalidPayload = {
        agentMessageId: 'msg_123',
        feedbackType: 'invalid',
      };

      const result = feedbackPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it('Deve falhar se feedbackText passar de 500 caracteres', () => {
      const invalidPayload = {
        agentMessageId: 'msg_123',
        feedbackType: 'like',
        feedbackText: 'A'.repeat(501),
      };

      const result = feedbackPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  describe('classifyVaguenessPayloadSchema', () => {
    it('Deve validar payload com title e description preenchidos', () => {
      const validPayload = {
        title: 'Criar tela de login',
        description: 'Preciso de uma tela com usuário e senha',
      };

      const result = classifyVaguenessPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('Deve falhar se title for vazio', () => {
      const invalidPayload = {
        title: '',
        description: 'Descrição qualquer',
      };

      const result = classifyVaguenessPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });
  });
});
