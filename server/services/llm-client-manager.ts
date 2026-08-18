import OpenAI from 'openai';
import { logger } from '../utils/logger';

export type AIProvider =
  | 'openai'
  | 'mistral'
  | 'openrouter'
  | 'nvidia'
  | 'xiaomi'
  | 'codex'
  | 'tencent';

/**
 * Gerencia a configuração e instância de clientes HTTP para provedores de LLM.
 * Responsável por inicializar e fornecer clientes OpenAI configurados para cada provider.
 */
export class LLMClientManager {
  private clients: Map<AIProvider, OpenAI> = new Map();

  constructor() {
    this.initializeClients();
  }

  /**
   * Inicializa os clientes para todos os providers configurados com API keys.
   * Lê variáveis de ambiente: NVIDIA_API_KEY, OPENAI_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY
   */
  private initializeClients(): void {
    const codexKey = process.env.CODEX_API_KEY;
    if (codexKey) {
      this.clients.set(
        'codex',
        new OpenAI({
          apiKey: codexKey,
          baseURL: process.env.CODEX_BASE_URL ?? 'https://api.openai.com/v1',
        }),
      );
      logger.info('LLM Client Manager: Codex bridge client initialized');
    }
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    if (nvidiaKey) {
      this.clients.set(
        'nvidia',
        new OpenAI({
          apiKey: nvidiaKey,
          baseURL: 'https://integrate.api.nvidia.com/v1',
        }),
      );
      logger.info('LLM Client Manager: NVIDIA client initialized');
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.clients.set('openai', new OpenAI({ apiKey: openaiKey }));
      logger.info('LLM Client Manager: OpenAI client initialized');
    }

    const mistralKey = process.env.MISTRAL_API_KEY;
    if (mistralKey) {
      this.clients.set(
        'mistral',
        new OpenAI({
          apiKey: mistralKey,
          baseURL: 'https://api.mistral.ai/v1/',
        }),
      );
      logger.info('LLM Client Manager: Mistral client initialized');
    }

    const xiaomiKey = process.env.XIAOMI_API_KEY;
    if (xiaomiKey) {
      this.clients.set(
        'xiaomi',
        new OpenAI({
          apiKey: xiaomiKey,
          baseURL: process.env.XIAOMI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1',
        }),
      );
      logger.info('LLM Client Manager: Xiaomi (MiMo) client initialized');
    }

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey) {
      this.clients.set(
        'openrouter',
        new OpenAI({
          apiKey: openRouterKey,
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            ...(process.env.OPENROUTER_SITE_URL
              ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL }
              : {}),
            ...(process.env.OPENROUTER_APP_NAME
              ? { 'X-Title': process.env.OPENROUTER_APP_NAME }
              : {}),
          },
        }),
      );
      logger.info('LLM Client Manager: OpenRouter client initialized');
    }

    const tencentKey = process.env.TENCENT_TOKENHUB_KEY;
    if (tencentKey) {
      this.clients.set(
        'tencent',
        new OpenAI({
          apiKey: tencentKey,
          baseURL: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3',
        }),
      );
      logger.info('LLM Client Manager: Tencent TokenHub client initialized');
    }

    const initializedProviders = Array.from(this.clients.keys()).join(', ');
    logger.info(`LLM Client Manager: Initialized providers: ${initializedProviders || 'none'}`);
  }

  /**
   * Retorna o cliente OpenAI configurado para o provider solicitado.
   * Se o provider não estiver disponível, tenta fallback para OpenAI.
   *
   * @param provider - O provider desejado
   * @returns Instância do cliente OpenAI
   * @throws Error se nenhum cliente estiver disponível
   */
  getClient(provider: AIProvider): OpenAI {
    const client = this.clients.get(provider);
    if (!client) {
      if (provider === 'nvidia') {
        throw new Error('NVIDIA client unavailable. Set NVIDIA_API_KEY.');
      }
      if (provider === 'openrouter') {
        throw new Error(
          'OpenRouter client unavailable. Set OPENROUTER_API_KEY to use free models.',
        );
      }
      if (provider === 'xiaomi') {
        throw new Error('Xiaomi (MiMo) client unavailable. Set XIAOMI_API_KEY.');
      }
      if (provider === 'tencent') {
        throw new Error('Tencent TokenHub client unavailable. Set TENCENT_TOKENHUB_KEY.');
      }
      if (provider === 'codex') {
        throw new Error('Codex client unavailable. Set CODEX_API_KEY.');
      }
      const fallback = this.clients.get('openai');
      if (!fallback) throw new Error('No AI provider clients available.');
      logger.warn(`LLM Client Manager: Provider ${provider} unavailable, falling back to OpenAI`);
      return fallback;
    }
    return client;
  }

  /**
   * Verifica se um provider específico está configurado e disponível.
   *
   * @param provider - O provider a verificar
   * @returns true se o client estiver disponível
   */
  isProviderAvailable(provider: AIProvider): boolean {
    return this.clients.has(provider);
  }

  /**
   * Alias de compatibilidade para módulos que ainda usam a API antiga.
   */
  hasClient(provider: AIProvider): boolean {
    return this.isProviderAvailable(provider);
  }

  /**
   * Retorna lista de providers configurados.
   *
   * @returns Array de providers disponíveis
   */
  getAvailableProviders(): AIProvider[] {
    return Array.from(this.clients.keys());
  }
}

// Singleton instance
export const llmClientManager = new LLMClientManager();
