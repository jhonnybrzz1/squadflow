/**
 * Spec 10064 Batch 2 — deriva uma trilha legível de passos (`AgentJobStep[]`) a
 * partir do stdout do agente de código.
 *
 * Dois modos, escolhidos automaticamente:
 *  (a) stream-json (NDJSON de eventos do Claude CLI, com `AGENT_CLI_STREAM_JSON`):
 *      extrai tool_use (Edit/Write/Bash…), texto do assistente e o resultado.
 *  (b) transcript puro (fallback): quebra em linhas não vazias como passos de
 *      texto. Cobre o caso default (sem stream-json), garantindo passos úteis.
 *
 * Regra de ouro: NUNCA lança. Entrada inesperada degrada para o fallback ou para
 * uma lista vazia. Caps evitam inflar `agent_jobs.steps`.
 */
import type { AgentJobStep } from '@shared/agent-job';

/** Limites defensivos para não inflar o registro. */
const MAX_STEPS = 100;
const MAX_LABEL = 200;
const MAX_DETAIL = 500;

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Resumo curto do input de uma tool_use (arquivo, comando…). */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const candidate =
    (typeof obj.file_path === 'string' && obj.file_path) ||
    (typeof obj.path === 'string' && obj.path) ||
    (typeof obj.command === 'string' && obj.command) ||
    (typeof obj.pattern === 'string' && obj.pattern) ||
    '';
  return typeof candidate === 'string' ? candidate : '';
}

/** Extrai passos de um único evento stream-json já parseado. */
function stepsFromEvent(event: Record<string, unknown>): AgentJobStep[] {
  const steps: AgentJobStep[] = [];
  const type = event.type;

  // Evento de mensagem do assistente: pode conter texto e/ou tool_use.
  const message = event.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? event.content) as unknown;
  if ((type === 'assistant' || type === 'user') && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        const target = summarizeToolInput(b.input);
        steps.push({
          kind: 'tool',
          label: truncate(target ? `${b.name} ${target}` : String(b.name), MAX_LABEL),
        });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        steps.push({ kind: 'text', label: truncate(b.text, MAX_LABEL) });
      }
    }
  }

  // Evento de resultado final.
  if (type === 'result') {
    const resultText =
      (typeof event.result === 'string' && event.result) ||
      (typeof event.subtype === 'string' && event.subtype) ||
      'concluído';
    steps.push({ kind: 'result', label: truncate(String(resultText), MAX_LABEL) });
  }

  return steps;
}

/** Tenta interpretar o stdout como stream-json (NDJSON). */
function parseStreamJson(stdout: string): AgentJobStep[] | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const steps: AgentJobStep[] = [];
  let parsedAny = false;

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (_) {
      continue;
    }
    parsedAny = true;
    steps.push(...stepsFromEvent(event));
  }

  return parsedAny ? steps : null;
}

/** Fallback: transcript puro → passos de texto por linha não vazia. */
function parseTranscript(stdout: string): AgentJobStep[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ kind: 'text' as const, label: truncate(line, MAX_LABEL) }));
}

/**
 * Deriva os passos do stdout do agente. `stderr` opcional só é usado quando o
 * stdout não rende nenhum passo (ex.: falha precoce) — vira um passo de erro.
 */
export function parseAgentSteps(stdout: string, stderr = ''): AgentJobStep[] {
  const raw = typeof stdout === 'string' ? stdout : '';
  let steps = parseStreamJson(raw) ?? parseTranscript(raw);

  if (steps.length === 0 && stderr.trim()) {
    steps = [
      { kind: 'error', label: truncate(stderr, MAX_LABEL), detail: truncate(stderr, MAX_DETAIL) },
    ];
  }

  return steps.slice(0, MAX_STEPS);
}
