#!/usr/bin/env node
/**
 * Spec 017 S3 (auditoria M-10/FR-007): orçamento do chunk inicial.
 *
 * Lê dist/public/assets após o build e falha quando o entry chunk
 * (index-*.js) excede o teto de `bundle-budget.json` — o bundle não volta
 * a crescer sem aprovação explícita (atualizar o arquivo no PR).
 *
 * Uso:  npm run build && node scripts/bundle-budget.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS_DIR = new URL('../dist/public/assets', import.meta.url).pathname;
const BUDGET = JSON.parse(readFileSync(new URL('../bundle-budget.json', import.meta.url), 'utf8'));

const entries = readdirSync(ASSETS_DIR).filter((f) => /^index-.*\.js$/.test(f));
if (entries.length === 0) {
  console.error(
    '❌ bundle-budget: entry chunk (index-*.js) não encontrado — rode npm run build antes.',
  );
  process.exit(1);
}

let failed = false;
for (const file of entries) {
  const sizeKb = Math.round(statSync(join(ASSETS_DIR, file)).size / 1024);
  const capKb = BUDGET.entryChunkKb;
  const status = sizeKb <= capKb ? '✅' : '❌';
  console.log(`${status} ${file}: ${sizeKb} kB (teto ${capKb} kB)`);
  if (sizeKb > capKb) failed = true;
}

if (failed) {
  console.error(
    'Entry chunk acima do orçamento. Se o crescimento é aprovado, atualize bundle-budget.json no mesmo PR.',
  );
  process.exit(1);
}
