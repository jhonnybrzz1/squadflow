/** Single policy surface for provider routing and fallback rate limiting. */
import { logger } from '../utils/logger';
import { validateModelAllowed, validateModelAllowedAsync } from './model-governance';
import {
  CAPABLE_MODEL,
  OPENROUTER_PRIMARY_MODEL,
  isOpenRouterModel,
  normalizeModelForProvider,
} from './llm-model-router';
import { llmClientManager, type AIProvider } from './llm-client-manager';

export interface RoutingOptions {
  model: string;
  provider: AIProvider;
  originalModel: string;
  requestId: string;
}

export interface RoutingResult {
  model: string;
  provider: AIProvider;
}

class RoutingManager {
  applyDynamicFallback({ model, provider, requestId }: RoutingOptions): RoutingResult {
    if (llmClientManager.isProviderAvailable(provider)) return { model, provider };

    if (provider === 'openrouter') {
      throw new Error('OpenRouter client unavailable. Set OPENROUTER_API_KEY to use free models.');
    }
    if (llmClientManager.isProviderAvailable('openrouter')) {
      logger.info('Provider unavailable, switching to OpenRouter', {
        context: { requestId, originalProvider: provider },
      });
      return { model: OPENROUTER_PRIMARY_MODEL, provider: 'openrouter' };
    }

    logger.info('Provider unavailable, switching to OpenAI', {
      context: { requestId, originalProvider: provider },
    });
    return { model: this.getOpenAIFallbackModel(model), provider: 'openai' };
  }

  normalizeForProvider(model: string, provider: AIProvider): string {
    return normalizeModelForProvider(model, provider);
  }

  validateModel(model: string, agentName: string, operation: string, registryAlias?: string): void {
    validateModelAllowed(model, agentName, operation, registryAlias);
  }

  /**
   * Async variant that resolves model aliases via the registry before
   * validation. Use this when the caller can be made async — it enables
   * agent YAML files to reference stable aliases like `mimo-pro-latest`.
   */
  async validateModelAsync(model: string, agentName: string, operation: string): Promise<void> {
    await validateModelAllowedAsync(model, agentName, operation);
  }

  private getOpenAIFallbackModel(model: string): string {
    const normalized = model.toLowerCase();
    return normalized.includes('mistral') ||
      normalized.includes('codestral') ||
      isOpenRouterModel(model)
      ? CAPABLE_MODEL
      : model;
  }
}

export class FallbackManager {
  private fallbackTimestamps: number[] = [];
  private static readonly LIMIT = 5;
  private static readonly WINDOW_MS = 60_000;

  checkAndRecordFallback(): boolean {
    const now = Date.now();
    this.fallbackTimestamps = this.fallbackTimestamps.filter(
      (timestamp) => now - timestamp < FallbackManager.WINDOW_MS,
    );
    if (this.fallbackTimestamps.length >= FallbackManager.LIMIT) return false;
    this.fallbackTimestamps.push(now);
    return true;
  }
}

export const routingManager = new RoutingManager();
export const fallbackManager = new FallbackManager();
