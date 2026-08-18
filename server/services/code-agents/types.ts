/**
 * Demanda "Ampliar agentes de código além do Claude" — contrato do plugin
 * multi-agente (padrão Adapter na interface, Strategy no roteador).
 *
 * `CodeAgent.execute(spec, executionId)` é a interface que os adaptadores
 * (`ClaudeAgent`, `CodexAgent`) implementam. É deliberadamente mais enxuta que o
 * `ICodeAgent.run()` de baixo nível (spec 10044): o roteador só precisa de
 * sucesso/saída/erro para decidir fallback. O campo `raw` é ADITIVO — carrega o
 * `CodeAgentResult` completo quando existe, para que o worker preserve
 * stdout/stderr/outcome byte a byte (AC de regressão do Claude).
 */
import { z } from 'zod';
import type { CodeAgentResult } from './code-agent';

/** Nomes dos agentes suportados no MVP (Devin em backlog; vaporware descartado). */
export type CodeAgentName = 'claude' | 'codex';

/**
 * Contrato validado do spec enviado ao agente. Reusa a mesma forma do
 * `CodeAgentRequest` de baixo nível para o adaptador Claude repassar sem
 * conversão, mas passa por Zod na fronteira do roteador (dependência do PRD).
 */
export const codeAgentSpecSchema = z.object({
  demandId: z.number().int(),
  speckitPath: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

export type CodeAgentSpec = z.infer<typeof codeAgentSpecSchema>;
export type CodeAgentSpecWithLifecycle = CodeAgentSpec & {
  onSpawn?: (pid: number) => void | Promise<void>;
};

/** Valida apenas dados serializáveis e preserva o callback interno do worker. */
export function validateCodeAgentSpec(
  input: CodeAgentSpecWithLifecycle,
): CodeAgentSpecWithLifecycle {
  return { ...codeAgentSpecSchema.parse(input), onSpawn: input.onSpawn };
}

/**
 * Retorno da interface. `{success, output, error}` é o contrato literal do AC;
 * `raw` é opcional e só o adaptador Claude o preenche (passthrough do executor
 * CLI existente). O roteador usa `raw` quando presente para devolver ao worker
 * um `CodeAgentResult` idêntico ao caminho legado.
 */
export interface CodeAgentExecuteResult {
  success: boolean;
  output: string;
  error?: string;
  raw?: CodeAgentResult;
}

export interface CodeAgent {
  /** Identificador estável usado em logs e no nome do circuito. */
  readonly name: CodeAgentName;
  execute(spec: CodeAgentSpecWithLifecycle, executionId: string): Promise<CodeAgentExecuteResult>;
}

/** Causa do fallback registrada no log estruturado (baseline futuro). */
export type FallbackCause = 'timeout' | 'circuit_open' | 'server_error' | 'agent_error';

/** Decisão de roteamento registrada no log estruturado. */
export type RoutingDecision = 'round-robin' | 'forced' | 'fallback';

/**
 * Ainda não há tokenizer comum aos dois provedores. Mantemos o campo no log
 * como `null`, em vez de inventar uma estimativa de tokens.
 */
export function estimateSpecTokens(_prompt: string): null {
  return null;
}
