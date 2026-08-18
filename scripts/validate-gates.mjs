#!/usr/bin/env node
/**
 * R-4 (spec 025) — Gate único de validação.
 *
 * Roda TODOS os gates de qualidade e falha o fechamento se qualquer um
 * falhar. Institui a regra do diagnóstico: um gate pulado é o que deixou a
 * regressão de `no-console` da spec 022 furar o lint-budget. Aqui nenhum é
 * opcional — a saída é uma tabela e o exit code é !=0 se algo falhar.
 *
 * Uso: node scripts/validate-gates.mjs   (ou `npm run gates`)
 */
import { spawnSync } from 'node:child_process';

const GATES = [
  { id: 'typecheck', cmd: 'npm', args: ['run', 'check'] },
  { id: 'tests', cmd: 'npm', args: ['test'] },
  { id: 'lint-budget', cmd: 'node', args: ['scripts/lint-budget.mjs'] },
  { id: 'build', cmd: 'npm', args: ['run', 'build'] },
  // bundle-budget depende do artefato de build acima, por isso vem depois.
  { id: 'bundle-budget', cmd: 'node', args: ['scripts/bundle-budget.mjs'] },
];

const results = [];
for (const gate of GATES) {
  process.stdout.write(`\n▶ gate: ${gate.id} (${gate.cmd} ${gate.args.join(' ')})\n`);
  const started = Date.now();
  const run = spawnSync(gate.cmd, gate.args, { stdio: 'inherit', shell: false });
  const ms = Date.now() - started;
  // spawnSync retorna status null se o processo foi morto por sinal — trata como falha.
  const ok = run.status === 0;
  results.push({ id: gate.id, ok, ms, status: run.status });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n──────── Resumo dos gates ────────');
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${pad(r.id, 16)} ${pad((r.ms / 1000).toFixed(1) + 's', 8)}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n❌ Fechamento bloqueado: ${failed.map((r) => r.id).join(', ')} falhou/faltou.`);
  process.exit(1);
}
console.log('\n✅ Todos os gates passaram — fechamento liberado.');
