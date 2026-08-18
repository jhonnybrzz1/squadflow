#!/usr/bin/env node
/**
 * Prioritize features from spec-registry.csv for PRD generation.
 *
 * Scoring: maturity (madura=3, utilitaria=2, implementada=1) + test count
 * + schema references + service imports. Outputs top features and a PRD
 * draft template for each.
 *
 * Usage: node scripts/prioritize-features.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const CSV = path.resolve('spec-registry.csv');
const OUTPUT = path.resolve('feature-prioritization.md');
const PRD_DIR = path.resolve('specs/10136-handoff/prd-drafts');

const csv = fs.readFileSync(CSV, 'utf8');
const lines = csv.split('\n').filter((l) => l.trim());
const header = lines[0].split(',');
const rows = lines.slice(1).map((line) => {
  // Simple CSV parse (handles quoted fields with semicolons inside)
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else current += ch;
  }
  cells.push(current);
  const obj = {};
  header.forEach((h, i) => (obj[h] = cells[i] || ''));
  return obj;
});

function score(row) {
  let s = 0;
  const m = (row.Maturidade || '').toLowerCase();
  if (m.includes('madura')) s += 3;
  else if (m.includes('util')) s += 2;
  else if (m.includes('implement')) s += 1;
  const tests = parseInt(row.Testes || '0', 10);
  s += Math.min(tests, 5); // cap at 5
  const schemas = (row.Schemas || '').split(';').filter(Boolean).length;
  s += Math.min(schemas, 3);
  const services = (row.Services || '').split(';').filter(Boolean).length;
  s += Math.min(services, 3);
  return s;
}

const scored = rows.map((r) => ({ ...r, _score: score(r) })).sort((a, b) => b._score - a._score);

// Group by feature name (routeFile) to find the highest-scoring feature per file
const byFeature = new Map();
for (const r of scored) {
  const key = r.Feature || r.Rota;
  if (!byFeature.has(key) || byFeature.get(key)._score < r._score) {
    byFeature.set(key, r);
  }
}

const topFeatures = [...byFeature.values()].slice(0, 10);

// Generate report
const lines2 = [
  '# Priorização de Features para PRD — Demanda #10136',
  '',
  `Gerado por \`scripts/prioritize-features.mjs\` em ${new Date().toISOString()}.`,
  '',
  '## Metodologia',
  '',
  'Score = maturidade (madura=3, utilitária=2, implementada=1) + min(testes, 5) + min(schemas, 3) + min(services, 3).',
  'Features agrupadas por arquivo de rota; apenas a rota de maior score por feature é listada.',
  '',
  '## Top 10 Features Prioritárias',
  '',
  '| # | Feature | Rota | Método | Score | Testes | Schemas | Services | Maturidade |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
topFeatures.forEach((r, i) => {
  lines2.push(
    `| ${i + 1} | ${r.Feature} | ${r.Path} | ${r.Metodo} | ${r._score} | ${r.Testes} | ${(r.Schemas || '').split(';').filter(Boolean).length} | ${(r.Services || '').split(';').filter(Boolean).length} | ${r.Maturidade} |`,
  );
});
lines2.push('', '## Rascunhos de PRD', '');
lines2.push(
  'Os rascunhos abaixo são templates iniciais para validação pelo PO/QA. Cada PRD deve ser refinado com input de negócio antes da implementação.',
  '',
);

// Generate PRD drafts
if (!fs.existsSync(PRD_DIR)) fs.mkdirSync(PRD_DIR, { recursive: true });

for (const r of topFeatures.slice(0, 3)) {
  const feature = r.Feature || r.Rota;
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const prdContent = `# PRD Draft — ${feature}

> Gerado automaticamente por \`scripts/prioritize-features.mjs\` em ${new Date().toISOString()}.
> **Status: DRAFT — requer validação do PO/QA.**

## Contexto

- **Rota principal**: ${r.Path} (${r.Metodo})
- **Arquivo**: ${r.Rota}
- **Maturidade**: ${r.Maturidade}
- **Testes vinculados**: ${r.Testes}
- **Schemas referenciados**: ${r.Schemas || 'nenhum'}
- **Services importados**: ${r.Services || 'nenhum'}

## User Stories

### US1: [Descrever a ação principal do usuário]
**Como** [persona],  
**Quero** [ação],  
**Para que** [benefício].

**Cenários de aceite:**
- Dado [contexto], quando [ação], então [resultado].
- Dado [contexto alternativo], quando [ação], então [resultado].

**Métrica de sucesso:** [A MEDIR — sem baseline]

### US2: [Descrever uma ação secundária]
**Como** [persona],  
**Quero** [ação],  
**Para que** [benefício].

**Cenários de aceite:**
- [A definir com PO]

**Métrica de sucesso:** [A MEDIR — sem baseline]

## Fora do Escopo

- [A definir com PO]

## Premissas Técnicas

- A rota já existe e está funcional (maturidade: ${r.Maturidade}).
- ${r.Testes} teste(s) vinculado(s) já passam.
- ${r.Services ? `Services: ${r.Services}` : 'Sem services dedicados.'}

## Riscos

- [A definir com PO/QA — risco comercial, técnico ou de compliance]

## Validação

- [ ] PO revisou e validou as user stories
- [ ] QA definiu cenários de teste adicionais
- [ ] Métricas de sucesso têm baseline definido
`;
  fs.writeFileSync(path.join(PRD_DIR, `prd-draft-${slug}.md`), prdContent);
  lines2.push(
    `- \`specs/10136-handoff/prd-drafts/prd-draft-${slug}.md\` — ${feature} (score: ${r._score})`,
  );
}

lines2.push('', '## Próximos Passos', '');
lines2.push('1. PO/QA revisa os 3 PRD drafts acima.');
lines2.push('2. PO seleciona 2-3 features para PRD completo.');
lines2.push('3. Agente expande os PRD drafts selecionados com spec.md + tasks.md completos.');
lines2.push('4. Validação final antes de handoff para implementação.');

fs.writeFileSync(OUTPUT, lines2.join('\n') + '\n');
console.log(`Priorização gerada: ${OUTPUT}`);
console.log(`${topFeatures.length} features analisadas, top 3 PRD drafts em ${PRD_DIR}/`);
