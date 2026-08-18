import { logger } from '../utils/logger';
import { aiUsageTracker, estimateCost, estimateTextTokens } from './ai-usage-tracker';
import { circuitBreaker } from './circuit-breaker';
import { createMistralClient } from './mistral-client';
import type OpenAI from 'openai';

const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-medium-3.5';

interface MistralMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface MistralResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface MistralGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  operation?: string;
}

/**
 * Mistral AI Service - Used for classification and routing tasks
 * More cost-effective than GPT for simple classification tasks
 */
export class MistralService {
  private apiKey: string;
  private client: OpenAI | null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.MISTRAL_API_KEY || '';
    this.client = null;

    if (!this.apiKey) {
      logger.warn('No Mistral API key provided. Classification will fall back to OpenAI.');
    }
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: MistralGenerateOptions = {},
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Mistral API key not configured');
    }

    this.client ??= createMistralClient(this.apiKey);

    const startedAt = Date.now();
    const model = options.model || MISTRAL_MODEL;
    const operation = options.operation || 'mistral_chat';

    const messages: MistralMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    try {
      const data = await circuitBreaker.execute<MistralResponse>(
        'mistral',
        async () => {
          try {
            return (await this.client!.chat.completions.create({
              model,
              messages,
              temperature: options.temperature ?? 0.3,
              max_tokens: options.maxTokens ?? 500,
            })) as unknown as MistralResponse;
          } catch (error) {
            throw new Error(
              `Mistral API error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        { timeout: 60_000 },
      );

      const content = data.choices[0]?.message?.content || '';

      const promptTokens =
        data.usage?.prompt_tokens ??
        estimateTextTokens(systemPrompt) + estimateTextTokens(userPrompt);
      const completionTokens = data.usage?.completion_tokens ?? estimateTextTokens(content);
      const totalTokens = data.usage?.total_tokens ?? promptTokens + completionTokens;

      const costEstimate = await estimateCost(model, promptTokens, completionTokens);

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        operation,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: costEstimate.listCostUsd,
        pricingSource: costEstimate.pricingSource,
        pricingUpdatedAt: costEstimate.pricingUpdatedAt,
        billedCostUsd: costEstimate.billedCostUsd,
        creditAppliedUsd: costEstimate.creditAppliedUsd,
        isEstimated: costEstimate.isEstimated,
        cacheHit: false,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: null,
        latencyMs: Date.now() - startedAt,
      });

      return content;
    } catch (error) {
      logger.error('Mistral API error:', error);
      throw error;
    }
  }

  async generateJSONResponse<T = Record<string, unknown>>(
    systemPrompt: string,
    userPrompt: string,
    options: MistralGenerateOptions = {},
  ): Promise<T> {
    const content = await this.generateChatCompletion(
      `${systemPrompt}\nYou must respond with valid JSON only.`,
      userPrompt,
      {
        ...options,
        temperature: options.temperature ?? 0.2,
      },
    );

    try {
      return JSON.parse(content) as T;
    } catch (_) {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      throw new Error(`Failed to parse Mistral response as JSON: ${content}`);
    }
  }
}

export const mistralService = new MistralService();
