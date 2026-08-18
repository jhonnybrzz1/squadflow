import fs from 'node:fs';
import { z } from 'zod';
import { classifyDemandTypeF1 } from '../shared/demand-start-contract';

const baselineCaseSchema = z.object({
  historicalId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  humanLabel: z.enum([
    'nova_funcionalidade',
    'melhoria',
    'bug',
    'discovery',
    'analise_exploratoria',
  ]),
});

const inputPath = process.argv[2];
if (!inputPath || !fs.existsSync(inputPath)) {
  console.log('A MEDIR — sem baseline');
  console.log('Informe um JSON com exatamente 10 demandas históricas rotuladas por humano.');
  process.exit(0);
}

let rawInput: unknown;
try {
  rawInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (_) {
  console.log('A MEDIR — sem baseline');
  console.log('O arquivo informado não contém JSON válido.');
  process.exit(0);
}

const parsed = z.array(baselineCaseSchema).length(10).safeParse(rawInput);
if (!parsed.success) {
  console.log('A MEDIR — sem baseline');
  console.log('A entrada precisa conter exatamente 10 casos históricos válidos e rotulados.');
  process.exit(0);
}

const results = parsed.data.map((item) => ({
  historicalId: item.historicalId,
  humanLabel: item.humanLabel,
  classification: classifyDemandTypeF1(item),
}));
const matches = results.filter(
  (item) => item.classification.suggestedType === item.humanLabel,
).length;
console.log(JSON.stringify({ cases: results.length, matches, results }, null, 2));
