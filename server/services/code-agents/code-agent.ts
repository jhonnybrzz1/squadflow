/**
 * Spec 10044 T4 — plugin pattern do agente de código.
 *
 * `ICodeAgent` isola a orquestração (worker, fila, auditoria) do executor
 * concreto. A v1 só implementa `ClaudeCodeAgent` (Claude Code via CLI); o
 * seletor multi-agente é explicitamente "Fazer Depois" (PRD §5.2/5.3).
 */
import { spawn } from 'node:child_process';

export type CodeAgentOutcome = 'succeeded' | 'timeout' | 'spawn_error' | 'nonzero_exit';

export interface CodeAgentRequest {
  demandId: number;
  /** Caminho do spec.md dentro do repo, ex.: "specs/42-handoff/spec.md". */
  speckitPath: string;
  /** Conteúdo do speckit enviado como prompt (via stdin, evita ARG_MAX). */
  prompt: string;
  /** Diretório de trabalho onde o agente gera código. */
  cwd: string;
  /** Timeout de parede em ms; ao expirar, o processo é morto. */
  timeoutMs: number;
  /**
   * Chamado com o PID do processo-filho logo após o spawn. O worker persiste
   * esse PID na fila durável para que a recuperação no startup saiba se o
   * processo original ainda vive (evita re-executar um job cujo filho detached
   * sobreviveu a um restart — execução concorrente).
   */
  onSpawn?: (pid: number) => void | Promise<void>;
}

export interface CodeAgentResult {
  outcome: CodeAgentOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Preenchido quando outcome ≠ succeeded. */
  errorMessage?: string;
}

export interface ICodeAgent {
  readonly name: string;
  run(request: CodeAgentRequest): Promise<CodeAgentResult>;
}

/** Grace period entre SIGTERM e SIGKILL ao matar um processo travado. */
const SIGKILL_GRACE_MS = 2000;
/** Limite de buffer por stream para não estourar memória com saída verbosa. */
const MAX_STREAM_BYTES = 1_000_000;

function appendCapped(buffer: string, chunk: string): string {
  if (buffer.length >= MAX_STREAM_BYTES) return buffer;
  return (buffer + chunk).slice(0, MAX_STREAM_BYTES);
}

/**
 * Executor via Claude Code CLI. Envia o speckit pelo stdin (`claude -p`),
 * captura stdout/stderr, impõe timeout e garante que nenhum processo filho fica
 * zombie: SIGTERM no timeout, SIGKILL após grace, e cleanup no finally.
 *
 * O binário é configurável via `AGENT_CLI_BIN` (default "claude") para permitir
 * um mock nos testes de integração sem depender do Claude Code real instalado.
 */
export class ClaudeCodeAgent implements ICodeAgent {
  readonly name = 'claude-code';

  private readonly bin: string;
  private readonly extraArgs: string[];

  constructor(options?: { bin?: string; extraArgs?: string[] }) {
    this.bin = options?.bin ?? process.env.AGENT_CLI_BIN ?? 'claude';
    // `-p` = modo print/não-interativo; consumidor pode acrescentar flags via env.
    this.extraArgs = options?.extraArgs ?? buildExtraArgs();
  }

  run(request: CodeAgentRequest): Promise<CodeAgentResult> {
    return new Promise<CodeAgentResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      // detached: o filho vira líder do próprio grupo de processos, então um
      // kill no grupo (-pid) alcança netos que ele tenha spawnado (o Claude Code
      // pode iniciar subprocessos). Sem isso, um neto segurando o pipe de stdout
      // atrasa o evento 'close' até ele próprio morrer.
      const child = spawn(this.bin, ['-p', ...this.extraArgs], {
        cwd: request.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });

      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (_) {
          // grupo já morto / pid indisponível — best effort.
          try {
            child.kill(signal);
          } catch (_) {
            /* noop */
          }
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        // Escalada: se não morrer no grace, SIGKILL no grupo inteiro.
        killTimer = setTimeout(() => killGroup('SIGKILL'), SIGKILL_GRACE_MS);
      }, request.timeoutMs);

      const finish = (result: CodeAgentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };

      child.stdout?.on('data', (d: Buffer) => {
        stdout = appendCapped(stdout, d.toString());
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr = appendCapped(stderr, d.toString());
      });

      // Falha ao lançar o processo (ex.: binário `claude` ausente → ENOENT).
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({
          outcome: 'spawn_error',
          exitCode: null,
          stdout,
          stderr,
          errorMessage:
            err.code === 'ENOENT'
              ? `binário do agente não encontrado: "${this.bin}" (ENOENT)`
              : `falha ao iniciar o agente: ${err.message}`,
        });
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish({
            outcome: 'timeout',
            exitCode: code,
            stdout,
            stderr,
            errorMessage: `agente excedeu o timeout de ${request.timeoutMs}ms`,
          });
          return;
        }
        if (code === 0) {
          finish({ outcome: 'succeeded', exitCode: 0, stdout, stderr });
          return;
        }
        finish({
          outcome: 'nonzero_exit',
          exitCode: code,
          stdout,
          stderr,
          errorMessage: `agente saiu com código ${code}`,
        });
      });

      // Persiste o PID antes de liberar o prompt para o filho. Assim, um restart
      // depois de o agente começar a trabalhar encontra a guarda na fila durável.
      // `child.pid` é undefined se o spawn falhar (coberto pelo evento `error`).
      void (async () => {
        if (child.pid !== undefined && request.onSpawn) {
          try {
            await request.onSpawn(child.pid);
          } catch (_) {
            /* não impedimos a execução se a persistência auxiliar falhar */
          }
        }

        // Envia o speckit pelo stdin e fecha o pipe.
        try {
          child.stdin?.end(request.prompt);
        } catch (_) {
          // Se o stdin falhar (processo já morto), o 'error'/'close' cobre o resultado.
        }
      })();
    });
  }
}

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.trim().split(/\s+/);
}

/**
 * Args do CLI a partir de `AGENT_CLI_ARGS`. Spec 10064 Batch 2: quando
 * `AGENT_CLI_STREAM_JSON=true`, acrescenta `--output-format stream-json --verbose`
 * (a menos que o usuário já tenha definido `--output-format`), para o worker
 * derivar passos estruturados. Default OFF — não altera a invocação que já
 * funciona; o fallback de transcript ainda dá passos por linha.
 */
function buildExtraArgs(): string[] {
  const args = parseExtraArgs(process.env.AGENT_CLI_ARGS);
  const streamJson = String(process.env.AGENT_CLI_STREAM_JSON).toLowerCase() === 'true';
  if (streamJson && !args.includes('--output-format')) {
    args.push('--output-format', 'stream-json', '--verbose');
  }
  return args;
}
