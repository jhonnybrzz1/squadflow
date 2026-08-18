import { llmClientManager } from '../../llm-client-manager';
import type { CodeAgent, CodeAgentExecuteResult, CodeAgentSpecWithLifecycle } from '../types';

/** Adapter HTTP do Codex. A chave/modelo são configurações operacionais, não defaults ocultos. */
export class CodexAgent implements CodeAgent {
  readonly name = 'codex' as const;

  async execute(
    spec: CodeAgentSpecWithLifecycle,
    _executionId: string,
  ): Promise<CodeAgentExecuteResult> {
    if (!process.env.CODEX_API_KEY) {
      return { success: false, output: '', error: 'CODEX_API_KEY não configurada.' };
    }
    if (!process.env.CODEX_MODEL) {
      return { success: false, output: '', error: 'CODEX_MODEL não configurado.' };
    }

    try {
      const client = llmClientManager.getClient('codex');
      const completion = await client.chat.completions.create({
        model: process.env.CODEX_MODEL,
        messages: [
          {
            role: 'user',
            content: `Execute a especificação em ${spec.speckitPath}.\n\n${spec.prompt}`,
          },
        ],
      });
      const output = completion.choices[0]?.message?.content ?? '';
      return output
        ? { success: true, output }
        : { success: false, output: '', error: 'Codex retornou saída vazia.' };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Falha desconhecida no Codex.',
      };
    }
  }
}
