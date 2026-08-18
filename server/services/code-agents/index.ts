import { ClaudeCodeAgent, type ICodeAgent } from './code-agent';
import { ClaudeAgent } from './adapters/claude-agent';
import { CodexAgent } from './adapters/codex-agent';
import { CodeAgentRouter } from './router';

/** Factory com DI: testes podem fornecer o executor Claude existente. */
export function createCodeAgentRouter(
  claudeExecutor: ICodeAgent = new ClaudeCodeAgent(),
): CodeAgentRouter {
  return new CodeAgentRouter({ claude: new ClaudeAgent(claudeExecutor), codex: new CodexAgent() });
}

export * from './types';
export { ClaudeAgent } from './adapters/claude-agent';
export { CodexAgent } from './adapters/codex-agent';
export { CodeAgentRouter } from './router';
