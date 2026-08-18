#!/usr/bin/env node
/**
 * Spec 017 S1 (auditoria M-10/FR-001/FR-002): gate de lint por baseline.
 *
 * Compara a contagem de warnings POR REGRA com `lint-budget.json`:
 *  - qualquer regra acima do teto → exit 1 (warning novo bloqueia o gate);
 *  - regra nova (fora do baseline) → exit 1;
 *  - contagens abaixo do teto são reportadas — reduzir o teto exige atualizar
 *    o lint-budget.json no MESMO PR (o orçamento nunca sobe em silêncio).
 *
 * Uso:  node scripts/lint-budget.mjs            # verifica
 *       node scripts/lint-budget.mjs --update   # regrava o baseline (onda de limpeza)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BUDGET_FILE = new URL('../lint-budget.json', import.meta.url);

function currentCounts() {
  let output;
  try {
    output = execSync('npx eslint . --format json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // eslint sai com código != 0 quando há errors; o JSON continua no stdout.
    output = error.stdout;
    if (!output) throw error;
  }
  const results = JSON.parse(output);
  const counts = {};
  let errors = 0;
  for (const file of results) {
    for (const message of file.messages) {
      if (message.severity === 2) errors++;
      const rule = message.ruleId ?? 'unknown';
      counts[rule] = (counts[rule] ?? 0) + 1;
    }
  }
  return { counts, errors };
}

const { counts, errors } = currentCounts();

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  writeFileSync(BUDGET_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log('lint-budget.json atualizado:', sorted);
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
const failures = [];

for (const [rule, count] of Object.entries(counts)) {
  const cap = budget[rule];
  if (cap === undefined) {
    failures.push(`regra fora do baseline: ${rule} (${count})`);
  } else if (count > cap) {
    failures.push(`${rule}: ${count} > teto ${cap}`);
  }
}

if (errors > 0) {
  failures.push(`${errors} erro(s) de lint (severity 2)`);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const budgetTotal = Object.values(budget).reduce((a, b) => a + b, 0);
console.log(`lint-budget: ${total} warnings (teto total ${budgetTotal})`);

if (failures.length > 0) {
  console.error('❌ Lint budget estourado:');
  for (const failure of failures) console.error('  -', failure);
  console.error(
    'Se isto é uma onda de limpeza legítima, rode: node scripts/lint-budget.mjs --update',
  );
  process.exit(1);
}

const shrinkable = Object.entries(budget).filter(([rule, cap]) => (counts[rule] ?? 0) < cap);
if (shrinkable.length > 0) {
  console.log(
    `✅ Dentro do orçamento. ${shrinkable.length} regra(s) abaixo do teto — considere reduzir o baseline (--update).`,
  );
} else {
  console.log('✅ Dentro do orçamento.');
}
