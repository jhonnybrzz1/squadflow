/**
 * Tests for Cost Routing Service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideRoutingModel,
  getRoutingConfig,
  isEconomicMode,
  getRoutingReason,
  overrideRoutingModel,
  isModelAllowed,
} from '../server/services/cost-routing';

describe('Cost Routing Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.ROUTING_TOKEN_THRESHOLD;
    delete process.env.ROUTING_ECONOMIC_MODEL;
    delete process.env.ROUTING_ENABLED;
    // Set default safe model for tests (fallback is mistral-medium-3.5 when no OpenRouter key)
    process.env.ROUTING_SAFE_MODEL = 'deepseek/deepseek-v4-pro';
  });

  afterEach(() => {
    // Restore environment after each test
    process.env = originalEnv;
  });

  describe('getRoutingConfig', () => {
    it('should return default configuration', () => {
      const config = getRoutingConfig();
      expect(config.threshold).toBe(600);
      expect(config.economicModel).toBe('deepseek/deepseek-v4-pro');
      expect(config.safeModel).toBe('deepseek/deepseek-v4-pro');
      expect(config.enabled).toBe(true);
    });

    it('should respect custom threshold from env', () => {
      process.env.ROUTING_TOKEN_THRESHOLD = '800';
      const config = getRoutingConfig();
      expect(config.threshold).toBe(800);
    });

    it('should respect custom models from env', () => {
      process.env.ROUTING_ECONOMIC_MODEL = 'gpt-4o-mini';
      process.env.ROUTING_SAFE_MODEL = 'gpt-4o';
      const config = getRoutingConfig();
      expect(config.economicModel).toBe('gpt-4o-mini');
      expect(config.safeModel).toBe('gpt-4o');
    });

    it('should allow disabling routing', () => {
      process.env.ROUTING_ENABLED = 'false';
      const config = getRoutingConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe('decideRoutingModel', () => {
    it('should route simple prompts to economic mode', () => {
      const decision = decideRoutingModel(400);
      expect(decision.mode).toBe('economic');
      expect(decision.model).toBe('deepseek/deepseek-v4-pro');
      expect(decision.threshold).toBe(600);
      expect(decision.tokenCount).toBe(400);
      expect(decision.reason).toContain('token_threshold_400_lte_600');
    });

    it('should route complex prompts to safe mode', () => {
      const decision = decideRoutingModel(800);
      expect(decision.mode).toBe('safe');
      expect(decision.model).toBe('deepseek/deepseek-v4-pro');
      expect(decision.threshold).toBe(600);
      expect(decision.tokenCount).toBe(800);
      expect(decision.reason).toContain('token_threshold_800_gt_600');
    });

    it('should route exactly at threshold to economic mode', () => {
      const decision = decideRoutingModel(600);
      expect(decision.mode).toBe('economic');
      expect(decision.reason).toContain('token_threshold_600_lte_600');
    });

    it('should respect custom threshold', () => {
      process.env.ROUTING_TOKEN_THRESHOLD = '800';
      const decision = decideRoutingModel(700);
      expect(decision.mode).toBe('economic');
      expect(decision.threshold).toBe(800);
    });

    it('should return safe mode when routing is disabled', () => {
      process.env.ROUTING_ENABLED = 'false';
      const decision = decideRoutingModel(100);
      expect(decision.mode).toBe('safe');
      expect(decision.reason).toBe('routing_disabled');
    });

    it('should handle zero tokens', () => {
      const decision = decideRoutingModel(0);
      expect(decision.mode).toBe('economic');
      expect(decision.tokenCount).toBe(0);
    });

    it('should handle very large token counts', () => {
      const decision = decideRoutingModel(10000);
      expect(decision.mode).toBe('safe');
      expect(decision.tokenCount).toBe(10000);
    });
  });

  describe('isEconomicMode', () => {
    it('should return true for simple prompts', () => {
      expect(isEconomicMode(300)).toBe(true);
      expect(isEconomicMode(500)).toBe(true);
      expect(isEconomicMode(600)).toBe(true);
    });

    it('should return false for complex prompts', () => {
      expect(isEconomicMode(700)).toBe(false);
      expect(isEconomicMode(1000)).toBe(false);
      expect(isEconomicMode(2000)).toBe(false);
    });

    it('should respect custom threshold', () => {
      process.env.ROUTING_TOKEN_THRESHOLD = '800';
      expect(isEconomicMode(750)).toBe(true);
      expect(isEconomicMode(850)).toBe(false);
    });
  });

  describe('getRoutingReason', () => {
    it('should return reason for economic routing', () => {
      const reason = getRoutingReason(400);
      expect(reason).toContain('token_threshold');
      expect(reason).toContain('400');
      expect(reason).toContain('lte');
    });

    it('should return reason for safe routing', () => {
      const reason = getRoutingReason(800);
      expect(reason).toContain('token_threshold');
      expect(reason).toContain('800');
      expect(reason).toContain('gt');
    });
  });

  describe('overrideRoutingModel', () => {
    it('should allow manual override with specific model', () => {
      const decision = overrideRoutingModel('gpt-4o', 'testing_override');
      expect(decision.mode).toBe('safe');
      expect(decision.model).toBe('gpt-4o');
      expect(decision.reason).toBe('testing_override');
      expect(decision.tokenCount).toBe(0);
    });

    it('should use default reason if not provided', () => {
      const decision = overrideRoutingModel('gpt-4o');
      expect(decision.reason).toBe('manual_override');
    });
  });

  describe('isModelAllowed', () => {
    it('should allow economic model', () => {
      expect(isModelAllowed('deepseek/deepseek-v4-pro')).toBe(true);
    });

    it('should allow safe model', () => {
      expect(isModelAllowed('deepseek/deepseek-v4-pro')).toBe(true);
    });

    it('should reject unknown models', () => {
      expect(isModelAllowed('gpt-4')).toBe(false);
      expect(isModelAllowed('unknown-model')).toBe(false);
    });

    it('should respect custom models from env', () => {
      process.env.ROUTING_ECONOMIC_MODEL = 'gpt-4o-mini';
      process.env.ROUTING_SAFE_MODEL = 'gpt-4o';
      expect(isModelAllowed('gpt-4o-mini')).toBe(true);
      expect(isModelAllowed('gpt-4o')).toBe(true);
      expect(isModelAllowed('deepseek/deepseek-v4-pro')).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical classification task', () => {
      // Classification tasks typically use 200-500 tokens
      const decision = decideRoutingModel(300);
      expect(decision.mode).toBe('economic');
      expect(decision.model).toBe('deepseek/deepseek-v4-pro');
    });

    it('should handle typical Q&A task', () => {
      // Simple Q&A typically uses 400-800 tokens
      const decision = decideRoutingModel(500);
      expect(decision.mode).toBe('economic');
    });

    it('should handle typical analysis task', () => {
      // Analysis tasks typically use 1000-2000 tokens
      const decision = decideRoutingModel(1500);
      expect(decision.mode).toBe('safe');
      expect(decision.model).toBe('deepseek/deepseek-v4-pro');
    });

    it('should handle typical code generation task', () => {
      // Code generation typically uses 1500-3000 tokens
      const decision = decideRoutingModel(2000);
      expect(decision.mode).toBe('safe');
    });

    it('should handle borderline case around threshold', () => {
      const economicDecision = decideRoutingModel(599);
      const safeDecision = decideRoutingModel(601);
      expect(economicDecision.mode).toBe('economic');
      expect(safeDecision.mode).toBe('safe');
    });
  });
});
