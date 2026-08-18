import { resolvePath } from '@shared/utils/paths';
/**
 * Routing Evaluation — accuracy gate over a labeled golden set.
 *
 * Loads docs/golden-routing.json (task context → expected tier), runs
 * modelRoutingService.decideStageModel() on each case, and computes
 * accuracy (% of cases where the chosen tier matches expected).
 *
 * Writes a JSON report and exits 1 if accuracy falls below the baseline
 * floor (docs/evaluation-baseline.json → routing.minAccuracy).
 *
 * Design: this is a DETERMINISTIC eval (decideStageModel is pure given the
 * context, no LLM/DB call), so it is cheap to run on every PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { modelRoutingService, type StageDecisionContext } from '../services/model-routing';

type Tier = 'nano' | 'mini';

interface RoutingCase {
  id: string;
  description: string;
  demand: { priority: string; type: string };
  classification: { criteria: Record<string, number> } | null;
  stageName: string;
  expectedTier: Tier;
}

interface RoutingCaseResult extends RoutingCase {
  gotTier: Tier;
  gotModel: string;
  correct: boolean;
}

interface RoutingEvalReport {
  mode: 'smoke' | 'full';
  generatedAt: string;
  sampleSize: number;
  accuracy: number;
  failures: Array<{ id: string; description: string; expected: Tier; got: Tier }>;
  baselineFloor: number | null;
  passed: boolean;
  cases: RoutingCaseResult[];
}

function tierOf(decision: { model: string; reason: string }): Tier {
  // The reason field is stable regardless of env config (MODEL_NANO may equal
  // MODEL_MINI in some environments, which would make the model string
  // comparison meaningless). The reason encodes the actual policy decision:
  // 'critical_or_validation_stage' → mini, 'low_risk_operational_stage' → nano.
  return decision.reason === 'critical_or_validation_stage' ? 'mini' : 'nano';
}

function loadGoldenSet(smoke: boolean): RoutingCase[] {
  const file = resolvePath('docs/golden-routing.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: RoutingCase[] };
  return smoke ? data.cases.slice(0, 5) : data.cases;
}

function loadBaselineFloor(): number | null {
  const baselineFile = resolvePath('docs/evaluation-baseline.json');
  if (!fs.existsSync(baselineFile)) return null;
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as {
    routing?: { minAccuracy?: number };
  };
  return baseline.routing?.minAccuracy ?? null;
}

function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  console.log('\n========================================================================');
  console.log('🧭 ROUTING EVAL — task→tier accuracy over golden set');
  console.log('========================================================================');

  const cases = loadGoldenSet(smoke);
  const baselineFloor = loadBaselineFloor();

  const results: RoutingCaseResult[] = [];
  let correct = 0;
  const failures: RoutingEvalReport['failures'] = [];

  for (const c of cases) {
    const ctx: StageDecisionContext = {
      demand: c.demand as StageDecisionContext['demand'],
      classification: c.classification as StageDecisionContext['classification'],
      stageName: c.stageName as StageDecisionContext['stageName'],
    };
    const decision = modelRoutingService.decideStageModel(ctx);
    const gotTier = tierOf(decision);
    const isCorrect = gotTier === c.expectedTier;
    if (isCorrect) correct++;
    else {
      failures.push({
        id: c.id,
        description: c.description,
        expected: c.expectedTier,
        got: gotTier,
      });
    }
    results.push({ ...c, gotTier, gotModel: decision.model, correct: isCorrect });
    console.log(
      `  ${isCorrect ? '✓' : '✗'} ${c.id} expected=${c.expectedTier} got=${gotTier} | ${c.description}`,
    );
  }

  const accuracy = cases.length > 0 ? correct / cases.length : 0;
  const passed = baselineFloor === null ? true : accuracy >= baselineFloor;

  console.log('\n------------------------------------------------------------------------');
  console.log(`Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${cases.length})`);
  if (baselineFloor !== null) {
    console.log(`Baseline floor: ${(baselineFloor * 100).toFixed(1)}%`);
    console.log(`Gate: ${passed ? 'PASS ✅' : 'FAIL ❌'}`);
  }
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.id} expected=${f.expected} got=${f.got} | ${f.description}`);
    }
  }
  console.log('========================================================================\n');

  const report: RoutingEvalReport = {
    mode: smoke ? 'smoke' : 'full',
    generatedAt: new Date().toISOString(),
    sampleSize: cases.length,
    accuracy,
    failures,
    baselineFloor,
    passed,
    cases: results,
  };

  if (outputPath) {
    const resolved = resolvePath(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.exitCode = passed ? 0 : 1;
}

main();
