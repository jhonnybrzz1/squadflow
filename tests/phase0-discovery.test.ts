import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletion: vi.fn() },
}));

import { openAIService } from '../server/services/openai-ai';
import {
  isPhase0DiscoveryEnabled,
  shouldTriggerPhase0,
  runPhase0Discovery,
  renderPhase0BriefBlock,
} from '../server/services/phase0-discovery';

describe('phase0-discovery', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('feature flag', () => {
    it('default off', () => {
      delete process.env.PHASE0_DISCOVERY_ENABLED;
      expect(isPhase0DiscoveryEnabled()).toBe(false);
    });

    it('on quando env=true', () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      expect(isPhase0DiscoveryEnabled()).toBe(true);
    });
  });

  describe('shouldTriggerPhase0', () => {
    it('false quando flag off mesmo com lowConfidence', () => {
      delete process.env.PHASE0_DISCOVERY_ENABLED;
      expect(shouldTriggerPhase0({ demandText: 'oi', lowConfidence: true })).toBe(false);
    });

    it('true para demanda curta', () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      expect(shouldTriggerPhase0({ demandText: 'usuário não consegue', minChars: 80 })).toBe(true);
    });

    it('true para lowConfidence mesmo se demanda longa', () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const longText = 'a'.repeat(500);
      expect(shouldTriggerPhase0({ demandText: longText, lowConfidence: true })).toBe(true);
    });

    it('false para demanda longa e confiança alta', () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const longText = 'a'.repeat(500);
      expect(shouldTriggerPhase0({ demandText: longText, lowConfidence: false })).toBe(false);
    });
  });

  describe('runPhase0Discovery', () => {
    it('no-op quando flag off', async () => {
      delete process.env.PHASE0_DISCOVERY_ENABLED;
      const result = await runPhase0Discovery({ demandText: 'curta' });
      expect(result.enabled).toBe(false);
      expect(result.triggered).toBe(false);
      expect(result.brief).toBe('');
      expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
    });

    it('chama LLM quando dispara e retorna brief', async () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const mock = vi.mocked(openAIService.generateChatCompletion);
      mock.mockResolvedValue('## 1. Problem Frame ...');
      const result = await runPhase0Discovery({ demandText: 'curta' });
      expect(result.enabled).toBe(true);
      expect(result.triggered).toBe(true);
      expect(result.brief).toContain('Problem Frame');
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('flag on mas demanda longa não dispara', async () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const longText = 'detalhamento completo da demanda com múltiplos parágrafos. '.repeat(20);
      const result = await runPhase0Discovery({ demandText: longText });
      expect(result.enabled).toBe(true);
      expect(result.triggered).toBe(false);
      expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
    });

    it('lowConfidence força disparo', async () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const mock = vi.mocked(openAIService.generateChatCompletion);
      mock.mockResolvedValue('brief');
      const longText = 'a'.repeat(500);
      const result = await runPhase0Discovery({ demandText: longText, lowConfidence: true });
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('low_confidence');
    });

    it('não bloqueia quando LLM falha', async () => {
      process.env.PHASE0_DISCOVERY_ENABLED = 'true';
      const mock = vi.mocked(openAIService.generateChatCompletion);
      mock.mockRejectedValue(new Error('boom'));
      const result = await runPhase0Discovery({ demandText: 'curta' });
      expect(result.triggered).toBe(true);
      expect(result.brief).toBe('');
      expect(result.reason).toBe('execution_error');
    });
  });

  describe('renderPhase0BriefBlock', () => {
    it('retorna vazio para brief vazio', () => {
      expect(renderPhase0BriefBlock('')).toBe('');
      expect(renderPhase0BriefBlock('   ')).toBe('');
    });

    it('envolve com headers do bloco', () => {
      const block = renderPhase0BriefBlock('## algo');
      expect(block).toContain('PHASE 0');
      expect(block).toContain('## algo');
      expect(block).toContain('FIM PHASE 0');
    });
  });
});
