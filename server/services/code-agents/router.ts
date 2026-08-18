import { circuitBreaker } from '../circuit-breaker';
import { featureFlags } from '../feature-flags';
import { logger } from '../../utils/logger';
import {
  estimateSpecTokens,
  type CodeAgent,
  type CodeAgentExecuteResult,
  type CodeAgentName,
  type CodeAgentSpecWithLifecycle,
  type FallbackCause,
  type RoutingDecision,
  validateCodeAgentSpec,
} from './types';

const CODEX_CIRCUIT = 'code-agent:codex';

interface RouterCircuitBreaker {
  execute<T>(service: string, fn: () => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

export interface CodeAgentRouterOptions {
  isEnabled?: () => boolean;
  override?: () => CodeAgentName | undefined;
  circuitBreaker?: RouterCircuitBreaker;
}

/** Strategy de MVP: Round Robin Claude/Codex e fallback seguro para Claude. */
export class CodeAgentRouter implements CodeAgent {
  readonly name = 'claude' as const;
  private next = 0;
  private readonly isEnabled: () => boolean;
  private readonly override: () => CodeAgentName | undefined;
  private readonly breaker: RouterCircuitBreaker;

  constructor(
    private readonly agents: Record<CodeAgentName, CodeAgent>,
    options: CodeAgentRouterOptions = {},
  ) {
    this.isEnabled = options.isEnabled ?? (() => featureFlags.getFlags().multi_agent_routing);
    this.override =
      options.override ?? (() => featureFlags.getFlags().multi_agent_routing_override);
    this.breaker = options.circuitBreaker ?? circuitBreaker;
  }

  async execute(
    input: CodeAgentSpecWithLifecycle,
    executionId: string,
  ): Promise<CodeAgentExecuteResult> {
    const spec = validateCodeAgentSpec(input);
    if (!this.isEnabled()) return this.agents.claude.execute(spec, executionId);

    const forced = this.override();
    const selected = forced ?? (this.next++ % 2 === 0 ? 'claude' : 'codex');
    const decision: RoutingDecision = forced ? 'forced' : 'round-robin';
    const startedAt = Date.now();

    if (selected === 'claude') {
      const result = await this.agents.claude.execute(spec, executionId);
      this.log('claude', decision, startedAt, spec.prompt, false, undefined, executionId);
      return result;
    }

    try {
      const result = await this.breaker.execute(
        CODEX_CIRCUIT,
        async () => {
          const codexResult = await this.agents.codex.execute(spec, executionId);
          if (!codexResult.success) throw new Error(codexResult.error ?? 'Codex falhou.');
          return codexResult;
        },
        { timeout: spec.timeoutMs },
      );
      this.log('codex', decision, startedAt, spec.prompt, false, undefined, executionId);
      return result;
    } catch (error) {
      const cause = this.fallbackCause(error);
      const fallback = await this.agents.claude.execute(spec, executionId);
      this.log('claude', 'fallback', startedAt, spec.prompt, true, cause, executionId);
      return fallback;
    }
  }

  private fallbackCause(error: unknown): FallbackCause {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('timed out')) return 'timeout';
    if (message.includes('circuit breaker is open')) return 'circuit_open';
    return 'agent_error';
  }

  private log(
    agent: CodeAgentName,
    routingDecision: RoutingDecision,
    startedAt: number,
    prompt: string,
    fallback: boolean,
    fallbackCause?: FallbackCause,
    executionId?: string,
  ): void {
    logger.info('Code agent routing decision', {
      context: {
        agent,
        routingDecision,
        latency: Date.now() - startedAt,
        specTokens: estimateSpecTokens(prompt),
        fallback,
        fallbackCause: fallbackCause ?? null,
        executionId: executionId ?? null,
      },
    });
  }
}
