/**
 * Cost Routing Service
 *
 * Deterministic routing based on token count to optimize AI costs.
 * Simple prompts (≤ T tokens) use economic models.
 * Complex prompts (> T tokens) use capable models.
 *
 * Default threshold T = 600 tokens (configurable via ROUTING_TOKEN_THRESHOLD)
 */

import { logger } from '../utils/logger';
import type { RoutingMode } from './ai-usage-tracker';

// Kill-switch state
let killSwitchActive = false;
let killSwitchTriggeredAt: string | null = null;
let killSwitchDisabledComponent: 'routing' | 'cache' | null = null;
let killSwitchTriggerReason: string | null = null;

/**
 * Set kill-switch state (called by metrics monitoring)
 */
export function setKillSwitchState(
  active: boolean,
  disabledComponent: 'routing' | 'cache' | null = null,
  triggerReason: string | null = null,
): void {
  killSwitchActive = active;
  killSwitchDisabledComponent = disabledComponent;
  killSwitchTriggerReason = triggerReason;
  if (active && !killSwitchTriggeredAt) {
    killSwitchTriggeredAt = new Date().toISOString();
  }
  if (!active) {
    killSwitchTriggeredAt = null;
    killSwitchTriggerReason = null;
  }
  logger.info('Kill-switch state updated', {
    context: {
      active,
      disabledComponent,
      triggerReason,
      triggeredAt: killSwitchTriggeredAt,
    },
  });
}

/**
 * Get kill-switch state
 */
export function getKillSwitchState(): {
  active: boolean;
  disabledComponent: 'routing' | 'cache' | null;
  triggerReason: string | null;
  triggeredAt: string | null;
} {
  return {
    active: killSwitchActive,
    disabledComponent: killSwitchDisabledComponent,
    triggerReason: killSwitchTriggerReason,
    triggeredAt: killSwitchTriggeredAt,
  };
}

const DEFAULT_ROUTING_THRESHOLD = 600;

// Model configurations (read dynamically to support testing)
// Primary: DeepSeek V4 Flash for general agents, Mistral as fallback
const getEconomicModel = (): string =>
  process.env.ROUTING_ECONOMIC_MODEL || 'deepseek/deepseek-v4-pro';
const getSafeModel = (): string =>
  process.env.ROUTING_SAFE_MODEL ||
  (process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_MODEL_PRIMARY : null) ||
  'mistral-medium-3.5'; // Fallback
const getRoutingThreshold = (): number => {
  const raw = process.env.ROUTING_TOKEN_THRESHOLD;
  const parsed = raw ? parseInt(raw, 10) : DEFAULT_ROUTING_THRESHOLD;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROUTING_THRESHOLD;
};

export interface RoutingDecision {
  mode: RoutingMode;
  reason: string;
  model: string;
  threshold: number;
  tokenCount: number;
}

export interface RoutingConfig {
  threshold: number;
  economicModel: string;
  safeModel: string;
  enabled: boolean;
}

/**
 * Task types that always use the economic model regardless of token count.
 * These are low-complexity tasks where quality risk is minimal.
 */
const ALWAYS_ECONOMIC_TASK_TYPES = new Set(['classification', 'json', 'simple']);

/**
 * Get current routing configuration
 */
export function getRoutingConfig(): RoutingConfig {
  return {
    threshold: getRoutingThreshold(),
    economicModel: getEconomicModel(),
    safeModel: getSafeModel(),
    enabled: process.env.ROUTING_ENABLED !== 'false', // enabled by default
  };
}

/**
 * Decide routing mode based on token count and optionally task type.
 *
 * @param promptTokens - Number of tokens in the prompt
 * @param taskType - Optional task type for adaptive routing
 * @returns Routing decision with mode, reason, and model
 */
export function decideRoutingModel(promptTokens: number, taskType?: string): RoutingDecision {
  const config = getRoutingConfig();
  const safeTokenCount = Number.isFinite(promptTokens) && promptTokens >= 0 ? promptTokens : 0;

  // Check kill-switch first
  if (killSwitchActive && killSwitchDisabledComponent === 'routing') {
    return {
      mode: 'safe',
      reason: `kill_switch_active_for_routing_${killSwitchTriggeredAt}`,
      model: getSafeModel(),
      threshold: config.threshold,
      tokenCount: safeTokenCount,
    };
  }

  if (!config.enabled) {
    return {
      mode: 'safe',
      reason: 'routing_disabled',
      model: getSafeModel(),
      threshold: config.threshold,
      tokenCount: safeTokenCount,
    };
  }

  // [MA-2] Adaptive routing: force economic for low-complexity task types
  if (taskType && ALWAYS_ECONOMIC_TASK_TYPES.has(taskType)) {
    return {
      mode: 'economic',
      reason: `task_type_${taskType}_always_economic`,
      model: getEconomicModel(),
      threshold: config.threshold,
      tokenCount: safeTokenCount,
    };
  }

  if (safeTokenCount <= config.threshold) {
    return {
      mode: 'economic',
      reason: `token_threshold_${safeTokenCount}_lte_${config.threshold}`,
      model: getEconomicModel(),
      threshold: config.threshold,
      tokenCount: safeTokenCount,
    };
  }

  return {
    mode: 'safe',
    reason: `token_threshold_${safeTokenCount}_gt_${config.threshold}`,
    model: getSafeModel(),
    threshold: config.threshold,
    tokenCount: safeTokenCount,
  };
}

/**
 * Check if routing is in economic mode
 *
 * @param promptTokens - Number of tokens in the prompt
 * @returns True if economic mode should be used
 */
export function isEconomicMode(promptTokens: number): boolean {
  const decision = decideRoutingModel(promptTokens);
  return decision.mode === 'economic';
}

/**
 * Get routing reason for logging/tracking
 *
 * @param promptTokens - Number of tokens in the prompt
 * @returns Reason string for the routing decision
 */
export function getRoutingReason(promptTokens: number): string {
  const decision = decideRoutingModel(promptTokens);
  return decision.reason;
}

/**
 * Override model selection with specific model
 * This is useful for manual overrides or testing
 *
 * @param model - Specific model to use
 * @param reason - Reason for the override
 * @returns Routing decision with override
 */
export function overrideRoutingModel(
  model: string,
  reason: string = 'manual_override',
): RoutingDecision {
  return {
    mode: 'safe', // Manual overrides are treated as safe
    reason,
    model,
    threshold: getRoutingThreshold(),
    tokenCount: 0, // Unknown for manual overrides
  };
}

/**
 * Validate if a model is allowed for routing
 *
 * @param model - Model to validate
 * @returns True if model is in the allowed list
 */
export function isModelAllowed(model: string): boolean {
  return model === getEconomicModel() || model === getSafeModel();
}
