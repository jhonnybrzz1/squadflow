/**
 * Agent Tools Registry
 *
 * Sistema unificado de ferramentas para agentes.
 * Cada agente tem acesso a um conjunto específico de tools baseado em seu papel.
 *
 * Tools disponíveis usam APENAS dados internos do sistema:
 * - Repositórios indexados (repos, repoFiles)
 * - Histórico de demandas (demands)
 * - Feedback e métricas (feedbackRefinamento, telemetry)
 * - Intervenções anti-overengineering
 */
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { logger } from '../utils/logger';
import { toolExecutionDuration, toolExecutionTimeoutTotal } from '../metrics/tool-execution';

// ============================================================
// Tipos Base
// ============================================================

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  source: string;
}

export interface ToolExecutionContext {
  /** AbortSignal bound to the tool's timeout. Tools should pass this to
   * underlying fetch/DB calls so they cancel when the timeout fires. */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  agentAccess: string[]; // Quais agentes podem usar esta tool
  inputSchema: z.ZodTypeAny;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  execute: (params: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

// ============================================================
// Helper: Zod to JSON Schema (simplificado)
// ============================================================

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    let propDef: Record<string, unknown> = { type: 'string' };

    if (zodType instanceof z.ZodString) {
      propDef = { type: 'string' };
      if (zodType.description) propDef.description = zodType.description;
    } else if (zodType instanceof z.ZodNumber) {
      propDef = { type: 'number' };
      if (zodType.description) propDef.description = zodType.description;
    } else if (zodType instanceof z.ZodBoolean) {
      propDef = { type: 'boolean' };
    } else if (zodType instanceof z.ZodArray) {
      propDef = { type: 'array', items: { type: 'string' } };
    } else if (zodType instanceof z.ZodOptional) {
      const inner = zodType._def.innerType;
      if (inner instanceof z.ZodString) propDef = { type: 'string' };
      else if (inner instanceof z.ZodNumber) propDef = { type: 'number' };
    } else if (zodType instanceof z.ZodEnum) {
      propDef = { type: 'string', enum: zodType._def.values };
    }

    properties[key] = propDef;

    if (!(zodType instanceof z.ZodOptional) && !(zodType instanceof z.ZodDefault)) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

// ============================================================
// Helper: Criar Tool Definition
// ============================================================

export function defineTool<TInput>(config: {
  name: string;
  description: string;
  agentAccess: string[];
  inputSchema: z.ZodObject<z.ZodRawShape>;
  timeoutMs?: number;
  execute: (params: TInput, ctx: ToolExecutionContext) => Promise<ToolResult>;
}): ToolDefinition {
  validateTimeout(config.timeoutMs, `tool ${config.name}`);
  return {
    name: config.name,
    description: config.description,
    agentAccess: config.agentAccess,
    inputSchema: config.inputSchema,
    parameters: zodToJsonSchema(config.inputSchema),
    timeoutMs: config.timeoutMs,
    execute: config.execute as (params: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>,
  };
}

// ============================================================
// Registry Global
// ============================================================

const TOOLS_REGISTRY: Map<string, ToolDefinition> = new Map();

export function registerTool(tool: ToolDefinition): void {
  validateTimeout(tool.timeoutMs, `tool ${tool.name}`);
  TOOLS_REGISTRY.set(tool.name, tool);
  logger.debug(`Tool registrada: ${tool.name} (acesso: ${tool.agentAccess.join(', ')})`);
}

/**
 * @deprecated Dead-code-report-AiChatFlow1-2026-07-28 (demanda #10269):
 * função sem caller confirmado; preservada para decisão futura. TODO: remover
 * ou reintegrar ao registro de ferramentas.
 */
export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_REGISTRY.get(name);
}

export function getToolsForAgent(agentName: string): ToolDefinition[] {
  const normalizedAgent = agentName.toLowerCase().replace(/[^a-z_]/g, '_');
  return Array.from(TOOLS_REGISTRY.values()).filter(
    (tool) =>
      tool.agentAccess.includes('*') ||
      tool.agentAccess.some((a) => a.toLowerCase().replace(/[^a-z_]/g, '_') === normalizedAgent),
  );
}

export function getToolsForOpenAI(agentName: string): ChatCompletionTool[] {
  return getToolsForAgent(agentName).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function executeTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS_REGISTRY.get(name);
  if (!tool) {
    return { ok: false, error: `Tool desconhecida: ${name}`, source: 'registry' };
  }

  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Argumentos inválidos';
    return { ok: false, error: `[validation] ${message}`, source: tool.name };
  }

  // TOOL-TIMEOUT (P2-01): bound every tool execution so a single hung
  // external call (GitHub, DB, network) can't stall the agent loop
  // indefinitely. Default 30s; override via TOOL_TIMEOUT_MS env var.
  //
  // P2-01 fix: Use an AbortController so the signal is passed to the
  // tool's execute(), allowing it to cancel underlying fetch/DB calls.
  // The previous Promise.race approach left the underlying operation
  // running after the timeout — only the promise was abandoned.
  const timeoutMs = tool.timeoutMs ?? parseGlobalTimeout();
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let outcome: 'success' | 'error' | 'timeout' = 'error';
  try {
    const execution = Promise.resolve(tool.execute(parsed, { signal: controller.signal })).catch(
      (error) => {
        if (timedOut) {
          return { ok: false, error: '[timeout] late rejection ignored', source: tool.name };
        }
        throw error;
      },
    );
    const timeoutResult = new Promise<ToolResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve({
          ok: false,
          error: `[timeout] Tool ${name} excedeu o limite de ${timeoutMs}ms`,
          source: tool.name,
        });
        controller.abort();
      }, timeoutMs);
    });
    const result = await Promise.race([execution, timeoutResult]);
    outcome = timedOut ? 'timeout' : result.ok ? 'success' : 'error';
    if (outcome === 'timeout') toolExecutionTimeoutTotal.labels(classifyTool(tool.name)).inc();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro na execução';
    // P2-01: Redact sensitive args from logs (tokens, keys, passwords).
    const redactedArgs = redactSensitiveArgs(parsed);
    logger.warn(`Tool ${name} falhou`, {
      error: err instanceof Error ? err : undefined,
      context: { args: redactedArgs },
    });
    outcome = 'error';
    return { ok: false, error: message, source: tool.name };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    toolExecutionDuration
      .labels({ tool_class: classifyTool(tool.name), outcome })
      .observe(Date.now() - startedAt);
  }
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_TIMEOUT_MS = 300_000;

function validateTimeout(value: number | undefined, context: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TOOL_TIMEOUT_MS) {
    throw new Error(`${context} timeoutMs must be an integer between 1 and ${MAX_TOOL_TIMEOUT_MS}`);
  }
}

function parseGlobalTimeout(): number {
  const parsed = Number(process.env.TOOL_TIMEOUT_MS ?? DEFAULT_TOOL_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TOOL_TIMEOUT_MS
    ? parsed
    : DEFAULT_TOOL_TIMEOUT_MS;
}

function classifyTool(name: string): 'github' | 'documente' | 'retrieval' | 'internal' {
  const normalized = name.toLowerCase();
  if (normalized.includes('github') || normalized.includes('repo') || normalized.includes('code')) {
    return 'github';
  }
  if (normalized.includes('document')) return 'documente';
  if (normalized.includes('search') || normalized.includes('rag')) return 'retrieval';
  return 'internal';
}

/**
 * P2-01: Redacts sensitive-looking fields from tool args before logging.
 * Replaces values for keys matching token/key/password/secret patterns
 * with '[REDACTED]'. Non-sensitive fields are preserved for debugging.
 */
function redactSensitiveArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(redactSensitiveArgs);
  const SENSITIVE_KEY_PATTERNS =
    /(?:token|key|password|passwd|secret|api[-_]?key|auth|credential)/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERNS.test(k)) {
      result[k] = '[REDACTED]';
    } else if (v !== null && typeof v === 'object') {
      result[k] = redactSensitiveArgs(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/** Revalidates agent authorization at execution time; provider tool_calls are untrusted input. */
export async function executeToolForAgent(
  agentName: string,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const authorized = getToolsForAgent(agentName).some((tool) => tool.name === name);
  if (!authorized) {
    logger.warn('Agent attempted to execute an unauthorized tool', {
      context: { agentName, toolName: name },
    });
    return {
      ok: false,
      error: `Tool não autorizada para o agente ${agentName}: ${name}`,
      source: 'registry',
    };
  }
  return executeTool(name, rawArgs);
}

export function getAllRegisteredTools(): ToolDefinition[] {
  return Array.from(TOOLS_REGISTRY.values());
}

export function isAgentToolsEnabled(agentName: string): boolean {
  // Feature flag global
  if (process.env.AGENT_TOOLS_ENABLED === 'false') return false;

  // Feature flags por agente
  const agentKey = agentName.toUpperCase().replace(/[^A-Z_]/g, '_');
  const envKey = `${agentKey}_TOOLS_ENABLED`;

  // Default: habilitado se existem tools para o agente
  const hasTools = getToolsForAgent(agentName).length > 0;
  const envValue = process.env[envKey];

  if (envValue === 'false') return false;
  if (envValue === 'true') return true;

  return hasTools;
}
