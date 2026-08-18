/**
 * Compara dois runs da avaliação de agentes sem re-execução (spec 006 / US3).
 *
 * Uso:
 *   npx tsx scripts/compare-eval-runs.ts <runIdA|latest-1> <runIdB|latest>
 *
 * Saída: Δ por critério de rubrica, Δ por agente (overall, custo, p95) e casos
 * que mudaram de closerTo. Ferramenta de análise — exit 0 sempre que os runs
 * existem (não é gate).
 *
 * Spec 008 / US3: o caminho vazio (nenhum run gravado) é uma condição prevista,
 * não um crash — imprime orientação em PT-BR e termina com exit 0, sem stack.
 * Contrato: specs/008-correcoes-pos-qa-005-006-007/contracts/compare-eval-runs-contract.md
 */
import {
  loadRun,
  resolveRunAlias,
  compareRuns,
  listRuns,
  type EvalRun,
  type EvalRunIndexEntry,
  type RunComparison,
} from '../server/evaluation/eval-run-store';

export interface CompareCliDeps {
  listRuns: () => EvalRunIndexEntry[];
  resolveRunAlias: (alias: string) => string;
  loadRun: (runId: string) => EvalRun;
  compareRuns: (a: EvalRun, b: EvalRun) => RunComparison;
  log: (message: string) => void;
  logError: (message: string) => void;
}

const defaultDeps: CompareCliDeps = {
  listRuns: () => listRuns(),
  resolveRunAlias: (alias) => resolveRunAlias(alias),
  loadRun: (runId) => loadRun(runId),
  compareRuns,
  log: (message) => console.log(message),
  logError: (message) => console.error(message),
};

function formatDelta(delta: number | null, digits = 3): string {
  if (delta === null) return 'n/a';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(digits)}`;
}

const USES_ALIAS = new Set(['latest', 'latest-1']);

/**
 * Corpo do CLI, injetável para testes. Retorna o exit code:
 * 0 — comparação feita OU condição prevista sem dados (0/1 run);
 * 1 — argumentos ausentes ou erro inesperado.
 */
export function compareEvalRunsCli(args: string[], deps: CompareCliDeps = defaultDeps): number {
  const [aliasA, aliasB] = args;
  if (!aliasA || !aliasB) {
    deps.logError('Uso: npx tsx scripts/compare-eval-runs.ts <runIdA|latest-1> <runIdB|latest>');
    return 1;
  }

  try {
    // Caminho vazio tratado ANTES de resolver aliases: condição prevista, não erro.
    if (USES_ALIAS.has(aliasA) || USES_ALIAS.has(aliasB)) {
      const entries = deps.listRuns();
      if (entries.length === 0) {
        deps.log('Nenhum run de avaliação encontrado em artifacts/eval-runs/.');
        deps.log('Isso não é um erro: nenhuma avaliação foi gravada ainda.');
        deps.log('Execute uma avaliação primeiro:');
        deps.log('  npm run evaluate-agent -- --agent <agent-name>');
        deps.log(
          'Observação: avaliações INCONCLUSIVAS (sem casos de holdout) não gravam run — ' +
            'marque casos com "split": "holdout" em datasets/few-shot/ antes.',
        );
        return 0;
      }
      if (entries.length === 1) {
        deps.log(
          `Apenas 1 run encontrado (${entries[0].runId}) — são necessários 2 para comparar.`,
        );
        deps.log('Execute uma nova avaliação e rode a comparação novamente:');
        deps.log('  npm run evaluate-agent -- --agent <agent-name>');
        return 0;
      }
    }

    const runIdA = deps.resolveRunAlias(aliasA);
    const runIdB = deps.resolveRunAlias(aliasB);
    const runA = deps.loadRun(runIdA);
    const runB = deps.loadRun(runIdB);
    const diff = deps.compareRuns(runA, runB);

    deps.log(`\n=== Comparação de runs ===`);
    deps.log(`A: ${runA.runId} (${runA.generatedAt}, commit ${runA.gitCommit ?? '?'})`);
    deps.log(`B: ${runB.runId} (${runB.generatedAt}, commit ${runB.gitCommit ?? '?'})`);
    deps.log(
      `\nOverall: ${runA.metrics.overall.toFixed(3)} → ${runB.metrics.overall.toFixed(3)} (${formatDelta(diff.overallDelta)})`,
    );
    deps.log(
      `Custo total: US$ ${runA.metrics.totalCostUsd.toFixed(4)} → US$ ${runB.metrics.totalCostUsd.toFixed(4)} (${formatDelta(diff.costDelta, 6)})`,
    );

    deps.log('\n--- Por critério de rubrica ---');
    for (const [criterion, values] of Object.entries(diff.byCriterion)) {
      deps.log(
        `  ${criterion}: ${values.a?.toFixed(3) ?? 'n/a'} → ${values.b?.toFixed(3) ?? 'n/a'} (${formatDelta(values.delta)})`,
      );
    }

    deps.log('\n--- Por agente (Δ overall / Δ custo USD / Δ p95 ms) ---');
    for (const [agent, values] of Object.entries(diff.byAgent)) {
      deps.log(
        `  ${agent}: ${formatDelta(values.overallDelta)} / ${formatDelta(values.costDelta, 6)} / ${formatDelta(values.p95Delta, 1)}`,
      );
    }

    if (diff.closerToChanges.length > 0) {
      deps.log('\n--- Casos que mudaram de closerTo ---');
      for (const change of diff.closerToChanges) {
        deps.log(`  ${change.id}: ${change.from} → ${change.to}`);
      }
    } else {
      deps.log('\nNenhum caso mudou de closerTo.');
    }
    return 0;
  } catch (error) {
    // Erro inesperado: mensagem concisa em stderr, sem stack trace cru.
    const message = error instanceof Error ? error.message : String(error);
    deps.logError(`Erro inesperado ao comparar runs: ${message}`);
    deps.logError(
      'Verifique se os runIds existem em artifacts/eval-runs/ (use os aliases latest / latest-1).',
    );
    return 1;
  }
}

// Executa apenas quando invocado diretamente como script (não em import de teste).
const invokedDirectly = Boolean(process.argv[1]?.includes('compare-eval-runs'));
if (invokedDirectly) {
  process.exit(compareEvalRunsCli(process.argv.slice(2)));
}
