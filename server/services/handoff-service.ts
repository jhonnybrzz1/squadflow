/**
 * Spec 10007 — Handoff Auto-Commit no repositório de destino.
 *
 * Orquestra a geração do handoff (spec-kit) e, quando habilitado, o commit
 * automático no repo de destino da demanda ao concluir cada refinamento — sem
 * clique manual. Reusa `buildHandoffFiles` (spec 018) e `commitHandoffToRepo`
 * (specs 024/026, que já roda o gate anti-alucinação da 10014 antes de escrever).
 *
 * SEGURANÇA: a auto-escrita em repo real é opt-in (flag `handoffAutoCommitEnabled`,
 * default FALSE) e exige `GITHUB_WRITE_TOKEN` + `repoFullName` na demanda. Sem isso,
 * o handoff é apenas GERADO (nunca commitado). Fail-safe: nunca derruba a aplicação.
 */
import { buildHandoffFiles, type HandoffFile } from './handoff-bundle';
import type { HandoffManifest } from '@shared/handoff-manifest';
import { commitHandoffToRepo } from './handoff-commit';
import { demandRepository } from '../repositories/demand-repository';
import { featureFlags } from './feature-flags';
import { eventBus } from '../events/event-bus';
import { logger } from '../utils/logger';

export interface HandoffResult {
  status: 'generated' | 'committed' | 'pending_retry';
  demandId: number;
  fileCount: number;
  commitHash?: string;
  error?: string;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

// Idempotência (FR-009): dedupe por demandId — não gera/commita duas vezes para o
// mesmo refinamento concluído (múltiplos eventos, retries do event bus).
const committed = new Set<number>();
const inFlight = new Set<number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Só auto-commita com flag ligada, token de escrita presente e repo na demanda. */
function autoCommitEligible(repoFullName: string | null | undefined): boolean {
  return (
    featureFlags.getFlags().handoffAutoCommitEnabled === true &&
    Boolean(process.env.GITHUB_WRITE_TOKEN) &&
    Boolean(repoFullName && repoFullName.includes('/'))
  );
}

/**
 * Gera o handoff (sempre — FR-003) e, se elegível, commita no repo destino com
 * retry exponencial 3× (FR-004/005). Idempotente (FR-009). Não lança em falha de
 * commit — devolve `pending_retry`.
 */
export async function generateAndCommit(demandId: number): Promise<HandoffResult> {
  if (committed.has(demandId)) {
    return { status: 'committed', demandId, fileCount: 0, attempts: 0 };
  }
  if (inFlight.has(demandId)) {
    return { status: 'generated', demandId, fileCount: 0, attempts: 0 };
  }
  inFlight.add(demandId);
  try {
    // FR-003: gerar sempre (lança se não houver PRD válido — guard da 018).
    const { files, manifest } = await buildHandoffFiles(demandId);
    const fileCount = files.length;

    // Spec 10044: sinaliza que o speckit foi escrito para o pipeline do agente de
    // código. Fail-safe: um erro na emissão/handler nunca afeta o fluxo do handoff.
    emitSpeckitCompleted(demandId, files, manifest);

    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!autoCommitEligible(demand?.repoFullName)) {
      logger.info('Handoff gerado (auto-commit desabilitado ou sem repo/token)', {
        context: { demandId, fileCount },
      });
      return { status: 'generated', demandId, fileCount, attempts: 0 };
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await commitHandoffToRepo(demandId);
        committed.add(demandId);
        logger.info('Handoff auto-commitado no repo destino', {
          context: { demandId, commitHash: result.sha, attempt, fileCount },
        });
        return {
          status: 'committed',
          demandId,
          fileCount,
          commitHash: result.sha,
          attempts: attempt,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn(`Handoff auto-commit falhou (tentativa ${attempt}/${MAX_ATTEMPTS})`, {
          error: err instanceof Error ? err : undefined,
          context: { demandId },
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    // FR-005: após 3 falhas, pending_retry; o handoff segue disponível localmente.
    return {
      status: 'pending_retry',
      demandId,
      fileCount,
      error: lastError,
      attempts: MAX_ATTEMPTS,
    };
  } finally {
    inFlight.delete(demandId);
  }
}

/**
 * Spec 10044: emite `SPECKIT_COMPLETED` com o spec.md e o manifest. Envolto em
 * try/catch — a emissão é acessória ao handoff e nunca pode derrubá-lo.
 */
function emitSpeckitCompleted(
  demandId: number,
  files: HandoffFile[],
  manifest: HandoffManifest,
): void {
  try {
    const specPath = `specs/${demandId}-handoff/spec.md`;
    const spec = files.find((f) => f.path === specPath);
    if (!spec) return; // sem spec.md não há o que o agente implementar.
    eventBus.publish('SPECKIT_COMPLETED', {
      demandId,
      specDir: `specs/${demandId}-handoff`,
      specPath,
      specContent: spec.content,
      manifest,
    });
  } catch (err) {
    logger.warn('Falha ao emitir SPECKIT_COMPLETED (ignorada)', {
      error: err instanceof Error ? err : undefined,
      context: { demandId },
    });
  }
}

/** Limpa o estado de idempotência (para testes). */
export function __resetHandoffServiceState(): void {
  committed.clear();
  inFlight.clear();
}
