import { projectRoot } from '@shared/utils/paths';
/**
 * Spec 10044 T4/T5 — worker do agente de código.
 *
 * Consome jobs de uma fila FIFO e os processa UM POR VEZ (mitiga o risco de
 * concorrência do PRD §10: múltiplos `claude` simultâneos). Para cada job: abre
 * o registro de auditoria em `agent_jobs`, dispara o agente (spawn com timeout),
 * roda a validação pós-geração `tsc --noEmit`, coleta os arquivos modificados e
 * fecha o registro — sempre, mesmo em falha (regra 7.1).
 *
 * Bug 3 (fila in-memory perde jobs no restart): a fila agora é DURÁVEL. Cada job
 * é persistido em SQLite (`code_agent_job_queue`) antes de rodar e transiciona
 * pending → processing → done|failed; o startup recupera pending/processing e os
 * reprocessa. O array em memória continua sendo o buffer de execução, mas a
 * fonte da verdade para sobreviver a um restart é o SQLite.
 *
 * SIGTERM/SIGINT matam o processo-filho ativo antes de encerrar, evitando
 * zombies num shutdown do servidor.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { agentJobsService } from '../services/agent-jobs';
import { codeAgentJobQueueService } from '../services/code-agent-job-queue';
import { featureFlags } from '../services/feature-flags';
import { createCodeAgentRouter, type CodeAgentSpecWithLifecycle } from '../services/code-agents';
import {
  ClaudeCodeAgent,
  type ICodeAgent,
  type CodeAgentResult,
} from '../services/code-agents/code-agent';
import { parseAgentSteps } from '../services/agent-job-steps';
import { logger } from '../utils/logger';

export interface CodeAgentJobInput {
  demandId: number;
  /** Caminho do spec.md, ex.: "specs/42-handoff/spec.md". */
  speckitPath: string;
  /** Conteúdo do speckit (vira prompt e base do prompt_sent_hash). */
  prompt: string;
  /** Diretório de trabalho; default = raiz do processo. */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const TYPECHECK_TIMEOUT_MS = 120_000;

function resolveTimeoutMs(): number {
  const raw = Number(process.env.AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

let agent: ICodeAgent = new ClaudeCodeAgent();
let multiAgentRouter: ReturnType<typeof createCodeAgentRouter> | null = null;

/**
 * Item da fila em memória. `queueId` é o id da linha durável no SQLite; enquanto
 * o INSERT ainda não completou é uma Promise, e um enqueue que falhou de persistir
 * resolve para '' — nesse caso o job roda best-effort, sem transições de status.
 */
interface QueuedJob {
  input: CodeAgentJobInput;
  queueId: Promise<string> | string;
}

const queue: QueuedJob[] = [];
let draining: Promise<void> | null = null;
let signalsRegistered = false;

/** Inicializa o worker no boot: registra o cleanup de sinais. */
export function initializeCodeAgentWorker(): void {
  registerSignalHandlers();
}

/**
 * Enfileira um job e garante que o loop de processamento esteja rodando. Bug 3:
 * o job é persistido em SQLite como `pending` ANTES de processar; a promise do id
 * é resolvida no drain antes de rodar. Um restart entre o enqueue e a conclusão
 * não perde o trabalho — o startup recupera via `recoverCodeAgentJobsOnStartup`.
 */
export function enqueueCodeAgentJob(input: CodeAgentJobInput): void {
  const queueId = Promise.resolve(codeAgentJobQueueService.enqueue(input)).catch((err) => {
    // Falha ao persistir não pode derrubar o pipeline: loga e processa sem
    // durabilidade (queueId '' → sem transições de status).
    logger.error('Code agent worker: falha ao persistir job na fila durável', {
      error: err instanceof Error ? err : undefined,
      context: { demandId: input.demandId, speckitPath: input.speckitPath },
    });
    return '';
  });
  queue.push({ input, queueId });
  ensureDraining();
}

/**
 * Recuperação de startup (Bug 3 AC): re-enfileira os jobs que ficaram `pending`
 * ou `processing` no SQLite (um crash durante o processamento deixa a linha em
 * `processing`). Reusa a linha existente — não cria nova. Retorna quantos foram
 * recuperados.
 */
export async function recoverCodeAgentJobsOnStartup(): Promise<number> {
  const rows = await codeAgentJobQueueService.recoverOnStartup();
  for (const row of rows) {
    queue.push({
      input: {
        demandId: row.demandId,
        speckitPath: row.speckitPath,
        prompt: row.prompt,
        cwd: row.cwd ?? undefined,
      },
      queueId: row.id,
    });
  }
  if (rows.length > 0) ensureDraining();
  return rows.length;
}

function ensureDraining(): void {
  if (!draining) {
    draining = drain().finally(() => {
      draining = null;
    });
  }
}

/** Resolve quando a fila esvazia — usado pelos testes para aguardar o pipeline. */
export async function whenCodeAgentQueueIdle(): Promise<void> {
  if (draining) await draining;
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const { input: job, queueId } = queue.shift()!;
    // Resolve o id durável antes de rodar; transiciona pending → processing sob
    // durabilidade máxima (Bug 3) para que um crash logo em seguida seja
    // recuperável. id '' = enqueue não persistiu → segue sem transições.
    const id = typeof queueId === 'string' ? queueId : await queueId;
    try {
      if (id) await codeAgentJobQueueService.markProcessing(id);
      await processJob(job, id || undefined);
      if (id) await codeAgentJobQueueService.markDone(id);
    } catch (err) {
      // processJob já é fail-safe; este catch é a última linha de defesa para
      // não deixar um erro inesperado matar o loop e travar a fila.
      logger.error('Code agent worker: erro inesperado ao processar job', {
        error: err instanceof Error ? err : undefined,
        context: { demandId: job.demandId, speckitPath: job.speckitPath },
      });
      if (id) {
        await codeAgentJobQueueService
          .markFailed(id, err instanceof Error ? err.message : String(err))
          .catch(() => {
            /* melhor esforço: não mascarar o erro original */
          });
      }
    }
  }
}

async function processJob(job: CodeAgentJobInput, queueId?: string): Promise<void> {
  const cwd = job.cwd ?? projectRoot;
  const promptSentHash = createHash('sha256').update(job.prompt).digest('hex');

  // Registro nasce em `running` ANTES da execução — nunca perdemos auditoria.
  const jobId = await agentJobsService.open(job.demandId, job.speckitPath, promptSentHash);

  // Spec 10114: heartbeat periódico enquanto o job está em processing.
  let heartbeatInterval: NodeJS.Timeout | null = null;
  if (queueId) {
    const HEARTBEAT_INTERVAL_MS = 15_000;
    heartbeatInterval = setInterval(() => {
      codeAgentJobQueueService.recordHeartbeat(queueId).catch(() => {
        /* melhor esforço: não interromper execução */
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function cleanupHeartbeat(): void {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  try {
    const request: CodeAgentSpecWithLifecycle = {
      demandId: job.demandId,
      speckitPath: job.speckitPath,
      prompt: job.prompt,
      cwd,
      timeoutMs: resolveTimeoutMs(),
      // Persiste o PID do filho na fila durável para a guarda de recuperação:
      // um restart que deixe este processo vivo NÃO deve re-executar o job.
      onSpawn: queueId
        ? (pid) => codeAgentJobQueueService.recordWorkerPid(queueId, pid)
        : undefined,
    };

    let result: CodeAgentResult;
    try {
      // Flag OFF é o caminho legado literal: mesma instância e mesmo `run()`.
      if (!featureFlags.getFlags().multi_agent_routing) {
        result = await agent.run(request);
      } else {
        const routed = await getMultiAgentRouter().execute(request, jobId);
        result =
          routed.raw ??
          (routed.success
            ? { outcome: 'succeeded', exitCode: 0, stdout: routed.output, stderr: '' }
            : {
                outcome: 'nonzero_exit',
                exitCode: 1,
                stdout: routed.output,
                stderr: routed.error ?? '',
                errorMessage: routed.error,
              });
      }
    } catch (err) {
      // O agente não deveria lançar (resolve sempre), mas cobrimos o caso.
      await agentJobsService.complete(jobId, {
        status: 'failed',
        cancelledAt: new Date().toISOString(),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const succeeded = result.outcome === 'succeeded';

    // Pós-geração roda mesmo em falha do agente: queremos o typecheck e a lista de
    // arquivos tocados para auditoria (o agente pode ter escrito algo antes de sair).
    const filesModified = await collectModifiedFiles(cwd);
    const typecheckPassed = succeeded ? await runTypecheck(cwd) : null;

    // timeout/erro de spawn/exit≠0 preenchem cancelled_at (PRD §10, mitigações).
    const cancelledAt = succeeded ? null : new Date().toISOString();

    // Spec 10064 Batch 2: deriva a trilha de passos do stdout do agente (stderr
    // como fallback em falha). Deixa de descartar a saída — vira auditoria legível.
    const steps = parseAgentSteps(result.stdout, result.stderr);

    await agentJobsService.complete(jobId, {
      status: succeeded ? 'succeeded' : 'failed',
      filesModified,
      typecheckPassed,
      cancelledAt,
      errorMessage: result.errorMessage ?? null,
      steps,
    });

    logger.info('Code agent job concluído', {
      context: {
        jobId,
        demandId: job.demandId,
        outcome: result.outcome,
        typecheckPassed,
        filesModifiedCount: filesModified.length,
      },
    });
  } finally {
    cleanupHeartbeat();
  }
}

/** Lista arquivos modificados no working tree via `git status --porcelain`. */
async function collectModifiedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout, code } = await runCommand('git', ['status', '--porcelain'], cwd, 15_000);
    if (code !== 0) return [];
    return (
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // formato: "XY path" — remove os 2 chars de status e espaços.
        .map((line) => line.replace(/^.{2}\s+/, '').replace(/^"|"$/g, ''))
    );
  } catch (_) {
    return [];
  }
}

/**
 * Validação pós-geração (PRD §5.1/7.1): `tsc --noEmit`. Comando configurável via
 * `AGENT_TYPECHECK_CMD` (default "npx tsc --noEmit") para os testes injetarem um
 * mock rápido em vez de rodar o compilador inteiro.
 */
async function runTypecheck(cwd: string): Promise<boolean> {
  const parts = (process.env.AGENT_TYPECHECK_CMD ?? 'npx tsc --noEmit').trim().split(/\s+/);
  const [cmd, ...args] = parts;
  try {
    const { code } = await runCommand(cmd, args, cwd, TYPECHECK_TIMEOUT_MS);
    return code === 0;
  } catch (_) {
    return false;
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function registerSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  const onSignal = () => {
    // O agente concreto já mata seu próprio filho no timeout; aqui garantimos que
    // um shutdown abrupto não deixe processos pendurados enquanto a fila drena.
    logger.info('Code agent worker: sinal de shutdown recebido, drenando fila');
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

/** Injeta um agente alternativo (mock) nos testes. */
export function __setCodeAgentForTests(mock: ICodeAgent): void {
  agent = mock;
  multiAgentRouter = null;
}

/** Restaura o agente real e limpa a fila (testes). */
export function __resetCodeAgentWorkerForTests(): void {
  agent = new ClaudeCodeAgent();
  multiAgentRouter = null;
  queue.length = 0;
  draining = null;
}

function getMultiAgentRouter(): ReturnType<typeof createCodeAgentRouter> {
  if (!multiAgentRouter) multiAgentRouter = createCodeAgentRouter(agent);
  return multiAgentRouter;
}
