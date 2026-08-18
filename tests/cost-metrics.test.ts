/**
 * Tests for Cost Metrics and Kill-Switch
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCostMetrics } from '../server/services/cost-metrics';
import {
  setKillSwitchState,
  getKillSwitchState,
  decideRoutingModel,
} from '../server/services/cost-routing';
import { aiUsageTracker } from '../server/services/ai-usage-tracker';

describe('Cost Metrics Service', () => {
  beforeEach(() => {
    // Reset kill-switch state before each test
    setKillSwitchState(false, null, null);
    aiUsageTracker.reset();
  });

  afterEach(() => {
    // Reset state after each test
    setKillSwitchState(false, null, null);
    aiUsageTracker.reset();
  });

  describe('getCostMetrics', () => {
    it('should return metrics structure', () => {
      const metrics = getCostMetrics();
      expect(metrics).toHaveProperty('timestamp');
      expect(metrics).toHaveProperty('window');
      expect(metrics).toHaveProperty('baseline');
      expect(metrics).toHaveProperty('current');
      expect(metrics).toHaveProperty('routing');
      expect(metrics).toHaveProperty('cache');
      expect(metrics).toHaveProperty('quality');
      expect(metrics).toHaveProperty('latency');
      expect(metrics).toHaveProperty('killSwitch');
    });

    it('should return window information', () => {
      const metrics = getCostMetrics(15 * 60 * 1000); // 15 minutes
      expect(metrics.window.durationMs).toBe(15 * 60 * 1000);
      expect(metrics.window.start).toBeDefined();
      expect(metrics.window.end).toBeDefined();
    });

    it('should return baseline metrics', () => {
      const metrics = getCostMetrics();
      expect(metrics.baseline.avgCostPerRequest).toBeGreaterThan(0);
      expect(metrics.baseline.totalRequests).toBeGreaterThan(0);
    });

    it('should return current metrics', () => {
      const metrics = getCostMetrics();
      expect(metrics.current.avgCostPerRequest).toBeGreaterThanOrEqual(0);
      expect(metrics.current.totalRequests).toBeGreaterThanOrEqual(0);
      expect(metrics.current.changeFromBaseline).toBeDefined();
      expect(metrics.current.changePercent).toBeDefined();
    });

    it('should return routing metrics', () => {
      const metrics = getCostMetrics();
      expect(metrics.routing.economicRate).toBeGreaterThanOrEqual(0);
      expect(metrics.routing.safeRate).toBeGreaterThanOrEqual(0);
      expect(metrics.routing.fallbackRate).toBeGreaterThanOrEqual(0);
      expect(metrics.routing.economicCount).toBeGreaterThanOrEqual(0);
      expect(metrics.routing.safeCount).toBeGreaterThanOrEqual(0);
    });

    it('should return cache metrics', () => {
      const metrics = getCostMetrics();
      expect(metrics.cache.hitRate).toBeGreaterThanOrEqual(0);
      expect(metrics.cache.totalHits).toBeGreaterThanOrEqual(0);
      expect(metrics.cache.totalMisses).toBeGreaterThanOrEqual(0);
    });

    it('should return kill-switch status', () => {
      const metrics = getCostMetrics();
      expect(metrics.killSwitch).toHaveProperty('active');
      expect(metrics.killSwitch).toHaveProperty('disabledComponent');
      expect(metrics.killSwitch).toHaveProperty('triggerReason');
      expect(metrics.killSwitch).toHaveProperty('triggeredAt');
    });

    it('should accept custom window size', () => {
      const metrics1 = getCostMetrics(5 * 60 * 1000); // 5 minutes
      const metrics2 = getCostMetrics(30 * 60 * 1000); // 30 minutes

      expect(metrics1.window.durationMs).toBe(5 * 60 * 1000);
      expect(metrics2.window.durationMs).toBe(30 * 60 * 1000);
    });
  });

  describe('Kill-Switch', () => {
    it('should be inactive by default', () => {
      const state = getKillSwitchState();
      expect(state.active).toBe(false);
      expect(state.disabledComponent).toBeNull();
      expect(state.triggeredAt).toBeNull();
    });

    it('should activate kill-switch', () => {
      setKillSwitchState(true, 'routing', 'test_trigger');
      const state = getKillSwitchState();

      expect(state.active).toBe(true);
      expect(state.disabledComponent).toBe('routing');
      expect(state.triggerReason).toBe('test_trigger');
      expect(state.triggeredAt).toBeDefined();
    });

    it('should deactivate kill-switch', () => {
      setKillSwitchState(true, 'routing', 'test_trigger');
      setKillSwitchState(false);

      const state = getKillSwitchState();
      expect(state.active).toBe(false);
      expect(state.disabledComponent).toBeNull();
      expect(state.triggeredAt).toBeNull();
    });

    it('should preserve trigger timestamp when active', () => {
      setKillSwitchState(true, 'routing', 'test_trigger');
      const state1 = getKillSwitchState();
      const timestamp1 = state1.triggeredAt;

      // Try to activate again (should not change timestamp)
      setKillSwitchState(true, 'routing', 'test_trigger_2');
      const state2 = getKillSwitchState();
      const timestamp2 = state2.triggeredAt;

      expect(timestamp1).toBe(timestamp2);
    });

    it('should reset timestamp on deactivate', () => {
      setKillSwitchState(true, 'routing', 'test_trigger');
      setKillSwitchState(false);

      const state = getKillSwitchState();
      expect(state.triggeredAt).toBeNull();
    });
  });

  describe('Routing with Kill-Switch', () => {
    it('should respect kill-switch and force safe mode', () => {
      // Activate kill-switch for routing
      setKillSwitchState(true, 'routing', 'cost_spike_test');

      const decision = decideRoutingModel(300); // Would normally be economic
      expect(decision.mode).toBe('safe');
      expect(decision.reason).toContain('kill_switch_active_for_routing');
    });

    it('should use economic mode when kill-switch is inactive', () => {
      // Deactivate kill-switch
      setKillSwitchState(false);

      const decision = decideRoutingModel(300);
      expect(decision.mode).toBe('economic');
      expect(decision.reason).toContain('token_threshold');
    });

    it('should allow kill-switch for cache component', () => {
      setKillSwitchState(true, 'cache', 'cache_spike_test');

      const state = getKillSwitchState();
      expect(state.disabledComponent).toBe('cache');

      // Routing should not be affected (only cache is disabled)
      const decision = decideRoutingModel(300);
      expect(decision.mode).toBe('economic');
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle cost spike scenario', () => {
      // Simulate cost spike by triggering kill-switch
      setKillSwitchState(true, 'routing', 'cost_spike_1.5x_baseline');

      // Check that kill-switch is active
      const state = getKillSwitchState();
      expect(state.active).toBe(true);
      expect(state.disabledComponent).toBe('routing');

      // Routing should be forced to safe mode
      const decision = decideRoutingModel(300);
      expect(decision.mode).toBe('safe');
    });

    it('should recover from kill-switch when cost normalizes', () => {
      // Activate kill-switch
      setKillSwitchState(true, 'routing', 'cost_spike_test');

      // Deactivate (simulating cost normalization)
      setKillSwitchState(false);

      const state = getKillSwitchState();
      expect(state.active).toBe(false);

      // Routing should return to normal
      const decision = decideRoutingModel(300);
      expect(decision.mode).toBe('economic');
    });

    it('should handle multiple kill-switch activations', () => {
      // First activation
      setKillSwitchState(true, 'routing', 'spike_1');
      const state1 = getKillSwitchState();
      expect(state1.active).toBe(true);

      // Deactivation
      setKillSwitchState(false);
      const state2 = getKillSwitchState();
      expect(state2.active).toBe(false);

      // Second activation
      setKillSwitchState(true, 'routing', 'spike_2');
      const state3 = getKillSwitchState();
      expect(state3.active).toBe(true);
    });
  });
});
