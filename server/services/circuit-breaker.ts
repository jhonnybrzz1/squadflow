/**
 * Circuit Breaker Service
 * Fase 1 - Item 1.4: Proteção contra falhas em cascata para APIs externas
 *
 * Implementa o padrão Circuit Breaker para prevenir chamadas a serviços
 * que estão falhando repetidamente.
 *
 * Estados:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered
 *
 * PERSISTÊNCIA / COLD-START (comportamento intencional):
 * O estado do circuito é mantido APENAS em memória. Em um restart/deploy, todos
 * os circuitos voltam para CLOSED — mesmo que o serviço downstream ainda esteja
 * instável. Na prática, isso gera uma janela curta em que o sistema volta a
 * tentar o downstream até reatingir o `failureThreshold` e reabrir o circuito.
 *
 * Essa escolha é DELIBERADA: o deploy é single-instance (Render), então não há
 * estado a compartilhar entre processos, e persistir em DB/Redis seria
 * overengineering (ver docs/ANTI-OVERENGINEERING-GUIDE.md — Redis não está na
 * stack). Reavaliar SOMENTE se a aplicação passar a rodar multi-instância: aí o
 * estado precisaria ser compartilhado para que um circuito aberto em uma
 * instância valha para as demais.
 */

import { logger } from '../utils/logger';
import { ExternalServiceError } from '../middleware/error-handler';

// ============================================
// Types
// ============================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before attempting to close the circuit */
  resetTimeout: number;
  /** Number of successful calls needed to close from HALF_OPEN */
  successThreshold: number;
  /** Time window in ms for counting failures */
  failureWindow: number;
  /** Custom name for logging */
  name: string;
}

export interface CircuitStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  openedAt: Date | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

interface CircuitData {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  openedAt: Date | null;
  failureTimestamps: number[];
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

// ============================================
// Default Configurations
// ============================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failureWindow: 60000, // 1 minute
  name: 'default',
};

const SERVICE_CONFIGS: Record<string, Partial<CircuitBreakerConfig>> = {
  openai: {
    failureThreshold: 5,
    resetTimeout: 60000, // 1 minute (API rate limits)
    successThreshold: 2,
    failureWindow: 120000, // 2 minutes
    name: 'OpenAI API',
  },
  mistral: {
    failureThreshold: 5,
    resetTimeout: 60000,
    successThreshold: 2,
    failureWindow: 120000,
    name: 'Mistral API',
  },
  openrouter: {
    failureThreshold: 5,
    resetTimeout: 60000,
    successThreshold: 2,
    failureWindow: 120000,
    name: 'OpenRouter API',
  },
  github: {
    failureThreshold: 3,
    resetTimeout: 30000,
    successThreshold: 1,
    failureWindow: 60000,
    name: 'GitHub API',
  },
  embeddings: {
    failureThreshold: 5,
    resetTimeout: 45000,
    successThreshold: 2,
    failureWindow: 90000,
    name: 'Embeddings API',
  },
};

// ============================================
// Circuit Breaker Class
// ============================================

export class CircuitBreaker {
  private circuits: Map<string, CircuitData> = new Map();
  private configs: Map<string, CircuitBreakerConfig> = new Map();

  constructor() {
    // Initialize with default service configs
    for (const [service, config] of Object.entries(SERVICE_CONFIGS)) {
      this.configs.set(service, { ...DEFAULT_CONFIG, ...config });
    }
  }

  /**
   * Register a new circuit with custom configuration
   */
  register(service: string, config?: Partial<CircuitBreakerConfig>): void {
    const fullConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      name: config?.name || service,
    };
    this.configs.set(service, fullConfig);
    logger.info(`Circuit breaker registered for ${service}`, {
      context: { config: fullConfig },
    });
  }

  /**
   * Get or create circuit data for a service
   */
  private getCircuit(service: string): CircuitData {
    let circuit = this.circuits.get(service);
    if (!circuit) {
      circuit = {
        state: 'CLOSED',
        failures: 0,
        successes: 0,
        lastFailure: null,
        lastSuccess: null,
        openedAt: null,
        failureTimestamps: [],
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      };
      this.circuits.set(service, circuit);
    }
    return circuit;
  }

  /**
   * Get configuration for a service
   */
  private getConfig(service: string): CircuitBreakerConfig {
    return this.configs.get(service) || { ...DEFAULT_CONFIG, name: service };
  }

  /**
   * Check if circuit allows requests
   */
  canRequest(service: string): boolean {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);

    if (circuit.state === 'CLOSED') {
      return true;
    }

    if (circuit.state === 'OPEN') {
      // Check if reset timeout has passed
      if (circuit.openedAt) {
        const elapsed = Date.now() - circuit.openedAt.getTime();
        if (elapsed >= config.resetTimeout) {
          this.transitionTo(service, 'HALF_OPEN');
          return true;
        }
      }
      return false;
    }

    // HALF_OPEN: allow limited requests for testing
    return true;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(
    service: string,
    fn: () => Promise<T>,
    options?: { timeout?: number },
  ): Promise<T> {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);

    circuit.totalRequests++;

    // Check if circuit allows requests
    if (!this.canRequest(service)) {
      const error = new ExternalServiceError(
        service,
        `Circuit breaker is OPEN for ${config.name}. Service temporarily unavailable.`,
      );
      logger.warn(`Circuit breaker blocked request to ${config.name}`, {
        context: { state: circuit.state, service },
      });
      throw error;
    }

    try {
      // Execute with optional timeout
      let result: T;
      if (options?.timeout) {
        result = await this.withTimeout(fn(), options.timeout, service);
      } else {
        result = await fn();
      }

      this.recordSuccess(service);
      return result;
    } catch (error) {
      this.recordFailure(service, error);
      throw error;
    }
  }

  /**
   * Wrap a promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    service: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ExternalServiceError(service, `Request to ${service} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Record a successful call
   */
  recordSuccess(service: string): void {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);

    circuit.lastSuccess = new Date();
    circuit.totalSuccesses++;

    if (circuit.state === 'HALF_OPEN') {
      circuit.successes++;
      if (circuit.successes >= config.successThreshold) {
        this.transitionTo(service, 'CLOSED');
      }
    } else if (circuit.state === 'CLOSED') {
      // Clear old failure timestamps
      this.cleanOldFailures(service);
    }
  }

  /**
   * Record a failed call
   */
  recordFailure(service: string, error?: unknown): void {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);
    const now = Date.now();

    circuit.lastFailure = new Date();
    circuit.totalFailures++;
    circuit.failureTimestamps.push(now);

    // Clean old failures outside the window
    this.cleanOldFailures(service);

    if (circuit.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN opens the circuit again
      this.transitionTo(service, 'OPEN');
    } else if (circuit.state === 'CLOSED') {
      circuit.failures = circuit.failureTimestamps.length;
      if (circuit.failures >= config.failureThreshold) {
        this.transitionTo(service, 'OPEN');
      }
    }

    logger.warn(`Circuit breaker recorded failure for ${config.name}`, {
      context: {
        service,
        state: circuit.state,
        failures: circuit.failures,
        threshold: config.failureThreshold,
      },
      error: error instanceof Error ? error : undefined,
    });
  }

  /**
   * Clean failures outside the time window
   */
  private cleanOldFailures(service: string): void {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);
    const cutoff = Date.now() - config.failureWindow;

    circuit.failureTimestamps = circuit.failureTimestamps.filter((ts) => ts > cutoff);
    circuit.failures = circuit.failureTimestamps.length;
  }

  /**
   * Transition circuit to a new state
   */
  private transitionTo(service: string, newState: CircuitState): void {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);
    const oldState = circuit.state;

    if (oldState === newState) return;

    circuit.state = newState;

    switch (newState) {
      case 'OPEN':
        circuit.openedAt = new Date();
        circuit.successes = 0;
        logger.warn(`Circuit breaker OPENED for ${config.name}`, {
          context: {
            service,
            previousState: oldState,
            failures: circuit.failures,
            resetTimeout: config.resetTimeout,
          },
        });
        break;

      case 'HALF_OPEN':
        circuit.successes = 0;
        logger.info(`Circuit breaker entering HALF_OPEN for ${config.name}`, {
          context: { service, previousState: oldState },
        });
        break;

      case 'CLOSED':
        circuit.failures = 0;
        circuit.failureTimestamps = [];
        circuit.openedAt = null;
        logger.info(`Circuit breaker CLOSED for ${config.name}`, {
          context: {
            service,
            previousState: oldState,
            successesInHalfOpen: circuit.successes,
          },
        });
        break;
    }
  }

  /**
   * Get statistics for a service
   */
  getStats(service: string): CircuitStats {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);

    return {
      name: config.name,
      state: circuit.state,
      failures: circuit.failures,
      successes: circuit.successes,
      lastFailure: circuit.lastFailure,
      lastSuccess: circuit.lastSuccess,
      openedAt: circuit.openedAt,
      totalRequests: circuit.totalRequests,
      totalFailures: circuit.totalFailures,
      totalSuccesses: circuit.totalSuccesses,
    };
  }

  /**
   * Get all circuit stats
   */
  getAllStats(): Record<string, CircuitStats> {
    const stats: Record<string, CircuitStats> = {};
    for (const service of this.circuits.keys()) {
      stats[service] = this.getStats(service);
    }
    return stats;
  }

  /**
   * Force a circuit to a specific state (for testing/admin)
   */
  forceState(service: string, state: CircuitState): void {
    const circuit = this.getCircuit(service);
    const config = this.getConfig(service);

    logger.warn(`Circuit breaker force-transitioned for ${config.name}`, {
      context: { service, previousState: circuit.state, newState: state },
    });

    this.transitionTo(service, state);
  }

  /**
   * Reset a circuit to initial state
   */
  reset(service: string): void {
    this.circuits.delete(service);
    logger.info(`Circuit breaker reset for ${service}`);
  }

  /**
   * Reset all circuits
   */
  resetAll(): void {
    this.circuits.clear();
    logger.info('All circuit breakers reset');
  }
}

// ============================================
// Singleton Instance
// ============================================

export const circuitBreaker = new CircuitBreaker();

// ============================================
// Decorator Helper
// ============================================

/**
 * Helper to wrap an async function with circuit breaker protection
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  service: string,
  fn: T,
  options?: { timeout?: number },
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return circuitBreaker.execute(service, () => fn(...args), options) as ReturnType<T>;
  }) as T;
}
