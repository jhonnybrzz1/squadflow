import type { ICodeAgent } from '../code-agent';
import type { CodeAgent, CodeAgentExecuteResult, CodeAgentSpecWithLifecycle } from '../types';

/** Adapter: preserva integralmente o executor Claude Code já em produção. */
export class ClaudeAgent implements CodeAgent {
  readonly name = 'claude' as const;

  constructor(private readonly executor: ICodeAgent) {}

  async execute(
    spec: CodeAgentSpecWithLifecycle,
    _executionId: string,
  ): Promise<CodeAgentExecuteResult> {
    const raw = await this.executor.run(spec);
    return {
      success: raw.outcome === 'succeeded',
      output: raw.stdout,
      error: raw.errorMessage ?? (raw.stderr || undefined),
      raw,
    };
  }
}
