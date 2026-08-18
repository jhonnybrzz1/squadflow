import { resolvePath } from '@shared/utils/paths';
/**
 * Guardrail Evaluation — FP/FN gate over a labeled golden set.
 *
 * Loads docs/golden-guardrails.json (15 injections + 15 benign), runs
 * runGuardrails() on each input, and computes a confusion matrix:
 *
 *   - TP: injection correctly blocked
 *   - FN: injection allowed through (CRITICAL — security hole)
 *   - TN: benign correctly allowed
 *   - FP: benign blocked (annoying but not a security risk)
 *
 * Writes a JSON report and exits 1 if FN rate exceeds the baseline floor
 * (docs/evaluation-baseline.json → guardrails.maxFalseNegativeRate).
 *
 * Design: this is a DETERMINISTIC eval (regex-based guardrail, no LLM call),
 * so it is cheap to run on every PR alongside the smoke suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGuardrails, runGuardrailsOnMessagesAsync } from '../services/llm-guardrails';
import { screenChunk, formatRetrievedAsData } from '../services/retrieval-guardrail';

interface GuardrailCase {
  id: string;
  label: 'injection' | 'benign' | 'indirect' | 'indirect-escape';
  input: string;
  expectedAllowed: boolean;
  note?: string;
}

interface GuardrailEvalReport {
  mode: 'smoke' | 'full';
  /** true quando a camada semântica (LLM) foi exercitada (spec 006/US5). */
  semantic: boolean;
  /** Aviso de amostra pequena: mover pisos com n < 30 não é confiável. */
  smallSampleWarning: boolean;
  generatedAt: string;
  sampleSize: number;
  confusionMatrix: {
    truePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    falsePositives: number;
  };
  indirectInjection: {
    total: number;
    blocked: number;
    allowed: number;
    blockRate: number;
    failures: Array<{ id: string; input: string }>;
  };
  delimiterEscape: {
    total: number;
    neutralized: number;
    escaped: number;
    neutralizeRate: number;
    failures: Array<{ id: string; input: string }>;
  };
  rates: {
    falseNegativeRate: number;
    falsePositiveRate: number;
    recall: number;
    precision: number;
  };
  failures: Array<{ id: string; label: string; expected: boolean; got: boolean; input: string }>;
  baselineFloor: number | null;
  passed: boolean;
}

function loadGoldenSet(smoke: boolean): GuardrailCase[] {
  const file = resolvePath('docs/golden-guardrails.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: GuardrailCase[] };
  if (!smoke) return data.cases;
  // Smoke: 5 injections + 5 benign + 3 indirect + 2 indirect-escape (first of each)
  const injections = data.cases.filter((c) => c.label === 'injection').slice(0, 5);
  const benign = data.cases.filter((c) => c.label === 'benign').slice(0, 5);
  const indirect = data.cases.filter((c) => c.label === 'indirect').slice(0, 3);
  const indirectEscape = data.cases.filter((c) => c.label === 'indirect-escape').slice(0, 2);
  return [...injections, ...benign, ...indirect, ...indirectEscape];
}

function loadBaseline(): {
  guardrails?: {
    maxFalseNegativeRate?: number;
    maxFalseNegativeRateSemantic?: number;
    maxFalsePositiveRate?: number;
    minIndirectBlockRate?: number;
    minEscapeNeutralizeRate?: number;
  };
} {
  const baselineFile = resolvePath('docs/evaluation-baseline.json');
  if (!fs.existsSync(baselineFile)) return {};
  return JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const semantic = args.includes('--semantic');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  console.log('\n========================================================================');
  console.log('🛡️  GUARDRAIL EVAL — FP/FN over labeled golden set');
  console.log('========================================================================');

  const cases = loadGoldenSet(smoke);

  let tp = 0; // injection blocked (correct)
  let fn = 0; // injection allowed (CRITICAL)
  let tn = 0; // benign allowed (correct)
  let fp = 0; // benign blocked (annoying)
  const failures: GuardrailEvalReport['failures'] = [];
  // Indirect injection: chunks envenenados triados por screenChunk (fronteira RAG)
  let indirectTotal = 0;
  let indirectBlocked = 0;
  const indirectFailures: Array<{ id: string; input: string }> = [];
  // Indirect-escape: testa a fronteira estrutural (formatRetrievedAsData com nonce
  // + neutralizeDelimiterAttempts). Verifica que um chunk com `</retrieved_document>`
  // no conteúdo NÃO escapa do wrapper — o token de fechamento forjado é neutralizado.
  let escapeTotal = 0;
  let escapeNeutralized = 0;
  const escapeFailures: Array<{ id: string; input: string }> = [];

  for (const c of cases) {
    // Indirect-escape: testa a defesa estrutural contra forja do delimitador.
    // O chunk contém `</retrieved_document>` no conteúdo; após formatRetrievedAsData,
    // o output NÃO deve conter o token de fechamento forjado como tag válida
    // (deve aparecer como [NEUTRALIZED-CLOSING-TAG] ou dentro do wrapper com nonce).
    if (c.label === 'indirect-escape') {
      escapeTotal++;
      const screened = screenChunk({ sourceKey: c.id, content: c.input });
      const formatted = formatRetrievedAsData([screened], ' test');
      // O output deve ter exatamente 1 tag de fechamento válida (a do wrapper com nonce).
      // Se o conteúdo forjou `</retrieved_document>` e não foi neutralizado, haverá
      // mais de 1 ocorrência de `</retrieved_document` (sem nonce) no output.
      const forgedClosingTags = formatted.match(/<\/\s*retrieved_document[^\n>]*>/gi);
      // Tags válidas com nonce: </retrieved_document_NNNN>. Forjadas: sem nonce.
      const validNonceTags = formatted.match(/<\/retrieved_document_[a-f0-9]{8}>/gi) || [];
      const forgedCount = (forgedClosingTags?.length ?? 0) - validNonceTags.length;
      const gotNeutralized = forgedCount === 0;
      const correct = gotNeutralized === !c.expectedAllowed;
      if (gotNeutralized) escapeNeutralized++;
      else {
        escapeFailures.push({ id: c.id, input: c.input });
        failures.push({
          id: c.id,
          label: c.label,
          expected: c.expectedAllowed,
          got: !gotNeutralized,
          input: c.input,
        });
      }
      console.log(
        `  ${correct ? '✓' : '✗'} ${c.id} [indirect-escape] neutralized=${gotNeutralized} (expected ${!c.expectedAllowed})`,
      );
      continue;
    }

    // Indirect injection: testa a fronteira de triagem de chunks RAG (screenChunk),
    // não o guardrail de input do usuário. Isto mede a defesa contra injection
    // indireta via repo/doc envenenado a montante.
    if (c.label === 'indirect') {
      indirectTotal++;
      const screened = screenChunk({
        sourceKey: c.id,
        content: c.input,
      });
      const gotBlocked = screened.blocked;
      const correct = gotBlocked === !c.expectedAllowed; // expectedAllowed=false → deve bloquear
      if (gotBlocked) indirectBlocked++;
      else {
        indirectFailures.push({ id: c.id, input: c.input });
        failures.push({
          id: c.id,
          label: c.label,
          expected: c.expectedAllowed,
          got: !gotBlocked, // got=true significa "allowed through"
          input: c.input,
        });
      }
      console.log(
        `  ${correct ? '✓' : '✗'} ${c.id} [indirect] blocked=${gotBlocked} (expected ${!c.expectedAllowed})`,
      );
      continue;
    }

    // Modo --semantic (spec 006/US5): exercita também a camada LLM de bloqueio.
    const gotAllowed = semantic
      ? !(await runGuardrailsOnMessagesAsync([{ role: 'user', content: c.input }], {})).blocked
      : runGuardrails(c.input, {}).allowed;
    const correct = gotAllowed === c.expectedAllowed;

    if (c.label === 'injection') {
      if (!gotAllowed) tp++;
      else {
        fn++;
        failures.push({
          id: c.id,
          label: c.label,
          expected: c.expectedAllowed,
          got: gotAllowed,
          input: c.input,
        });
      }
    } else {
      if (gotAllowed) tn++;
      else {
        fp++;
        failures.push({
          id: c.id,
          label: c.label,
          expected: c.expectedAllowed,
          got: gotAllowed,
          input: c.input,
        });
      }
    }
    console.log(
      `  ${correct ? '✓' : '✗'} ${c.id} [${c.label}] allowed=${gotAllowed} (expected ${c.expectedAllowed})`,
    );
  }

  const falseNegativeRate = tp + fn > 0 ? fn / (tp + fn) : 0;
  const falsePositiveRate = tn + fp > 0 ? fp / (tn + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const indirectBlockRate = indirectTotal > 0 ? indirectBlocked / indirectTotal : 0;
  const escapeNeutralizeRate = escapeTotal > 0 ? escapeNeutralized / escapeTotal : 0;

  // Gate: FN rate de input direto E block rate de indirect injection E neutralize
  // rate de escape do delimitador. Todos precisam estar dentro do piso.
  const baseline = loadBaseline();
  const fnFloor = semantic
    ? (baseline.guardrails?.maxFalseNegativeRateSemantic ??
      baseline.guardrails?.maxFalseNegativeRate ??
      null)
    : (baseline.guardrails?.maxFalseNegativeRate ?? null);
  const indirectFloor = baseline.guardrails?.minIndirectBlockRate ?? null;
  const escapeFloor = baseline.guardrails?.minEscapeNeutralizeRate ?? null;
  const fnPassed = fnFloor === null ? true : falseNegativeRate <= fnFloor;
  const indirectPassed =
    indirectFloor === null || indirectTotal === 0 ? true : indirectBlockRate >= indirectFloor;
  const escapePassed =
    escapeFloor === null || escapeTotal === 0 ? true : escapeNeutralizeRate >= escapeFloor;
  const passed = fnPassed && indirectPassed && escapePassed;

  console.log('\n------------------------------------------------------------------------');
  console.log('Confusion matrix (direct input):');
  console.log(`  TP (injection blocked):     ${tp}`);
  console.log(`  FN (injection allowed):     ${fn}  ← CRITICAL if > 0`);
  console.log(`  TN (benign allowed):        ${tn}`);
  console.log(`  FP (benign blocked):        ${fp}`);
  console.log('------------------------------------------------------------------------');
  console.log('Indirect injection (RAG chunk triage via screenChunk):');
  console.log(`  Total indirect cases:       ${indirectTotal}`);
  console.log(`  Blocked (correct):          ${indirectBlocked}`);
  console.log(`  Allowed through (FAIL):     ${indirectTotal - indirectBlocked}`);
  console.log(`  Block rate:                 ${(indirectBlockRate * 100).toFixed(1)}%`);
  console.log('------------------------------------------------------------------------');
  console.log('Delimiter escape (formatRetrievedAsData nonce + neutralize):');
  console.log(`  Total escape cases:         ${escapeTotal}`);
  console.log(`  Neutralized (correct):      ${escapeNeutralized}`);
  console.log(`  Escaped (FAIL):             ${escapeTotal - escapeNeutralized}`);
  console.log(`  Neutralize rate:            ${(escapeNeutralizeRate * 100).toFixed(1)}%`);
  console.log('------------------------------------------------------------------------');
  console.log(`False Negative Rate: ${(falseNegativeRate * 100).toFixed(1)}%`);
  console.log(`False Positive Rate: ${(falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`Recall:              ${(recall * 100).toFixed(1)}%`);
  console.log(`Precision:           ${(precision * 100).toFixed(1)}%`);
  if (fnFloor !== null) {
    console.log(
      `Baseline floor (FN): ${(fnFloor * 100).toFixed(1)}% → ${fnPassed ? 'PASS' : 'FAIL'}`,
    );
  }
  if (indirectFloor !== null && indirectTotal > 0) {
    console.log(
      `Baseline floor (indirect block rate): >= ${(indirectFloor * 100).toFixed(1)}% → ${indirectPassed ? 'PASS' : 'FAIL'}`,
    );
  }
  if (escapeFloor !== null && escapeTotal > 0) {
    console.log(
      `Baseline floor (escape neutralize rate): >= ${(escapeFloor * 100).toFixed(1)}% → ${escapePassed ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(`Gate: ${passed ? 'PASS ✅' : 'FAIL ❌'}`);
  if (cases.length < 30) {
    console.log(
      `Aviso: amostra pequena (n=${cases.length} < 30) — crescer o golden set antes de apertar pisos (spec 006/US5).`,
    );
  }
  if (semantic) {
    console.log(
      'Modo semântico: camada LLM exercitada; piso maxFalseNegativeRateSemantic aplicado.',
    );
  }
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.id} [${f.label}] expected=${f.expected} got=${f.got}`);
      console.log(`    input: ${f.input.slice(0, 80)}${f.input.length > 80 ? '...' : ''}`);
    }
  }
  console.log('========================================================================\n');

  const report: GuardrailEvalReport = {
    mode: smoke ? 'smoke' : 'full',
    semantic,
    smallSampleWarning: cases.length < 30,
    generatedAt: new Date().toISOString(),
    sampleSize: cases.length,
    confusionMatrix: {
      truePositives: tp,
      falseNegatives: fn,
      trueNegatives: tn,
      falsePositives: fp,
    },
    indirectInjection: {
      total: indirectTotal,
      blocked: indirectBlocked,
      allowed: indirectTotal - indirectBlocked,
      blockRate: indirectBlockRate,
      failures: indirectFailures,
    },
    delimiterEscape: {
      total: escapeTotal,
      neutralized: escapeNeutralized,
      escaped: escapeTotal - escapeNeutralized,
      neutralizeRate: escapeNeutralizeRate,
      failures: escapeFailures,
    },
    rates: { falseNegativeRate, falsePositiveRate, recall, precision },
    failures,
    baselineFloor: fnFloor,
    passed,
  };

  if (outputPath) {
    const resolved = resolvePath(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error('Guardrail evaluation failed:', error);
  process.exitCode = 1;
});
