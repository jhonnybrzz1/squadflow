#!/usr/bin/env tsx
/**
 * Few-Shot Efficacy Scoring — Harness de Ablação (achado 4.4)
 *
 * Mede a contribuição marginal de cada exemplo few-shot via ablação leave-one-out,
 * usando o próprio dataset estruturado como conjunto de avaliação:
 *
 *   Para o agente A com exemplos [e1..en] (n >= 2), para cada candidato ej:
 *     baseline_i = sim( gen(A, demanda_i, SEM few-shot), validOutput_i )      // i != j
 *     com_ej_i   = sim( gen(A, demanda_i, COM apenas ej),  validOutput_i )      // i != j
 *     delta_j    = média_i!=j ( com_ej_i − baseline_i )
 *     score_j    = deltaToScore(delta_j)   // 0-100, 50 = neutro
 *
 *   delta > 0 → o exemplo ajuda; delta < 0 → atrapalha (será filtrado na injeção
 *   se fewShotMinEfficacy estiver acima do score).
 *
 * O baseline por demanda é compartilhado entre candidatos (cacheado) para reduzir
 * chamadas LLM. Resultados são gravados de volta nos JSONs de datasets/few-shot/.
 *
 * Uso:
 *   npm run prompts:fewshot:score                 # todos os agentes com n>=2
 *   npm run prompts:fewshot:score -- --agent qa   # só um agente
 *   npm run prompts:fewshot:score -- --dry-run    # calcula e imprime, não grava
 *   npm run prompts:fewshot:score -- --verbose
 *
 * Requer OPENROUTER_API_KEY (ou a credencial usada pelo openAIService).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { openAIService } from '../server/services/openai-ai';
import { canonicalAgentKey } from '../server/services/agent-identity';
import {
  structuredFewShotExampleSchema,
  type StructuredFewShotExample,
} from '../server/services/few-shot-bank';
import { cosineSimilarity, deltaToScore } from '../server/services/few-shot-scoring';

import { env } from '../server/config/env';

// Diretórios configuráveis por env (útil para CI / demos contra um dataset de
// rascunho, sem tocar no dataset curado em datasets/few-shot/).
const DATASET_DIR = env.fewshotDatasetDir;
const AGENTS_DIR = env.fewshotAgentsDir;

interface Args {
  agent?: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const agentIdx = argv.indexOf('--agent');
  return {
    agent: agentIdx >= 0 ? argv[agentIdx + 1] : undefined,
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };
}

/** Mapa chave-canônica-de-agente -> system_prompt, lido dos YAMLs. */
function loadAgentSystemPrompts(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(AGENTS_DIR)) return map;
  for (const file of fs.readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas.
      const config = yaml.load(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'), {
        schema: yaml.CORE_SCHEMA,
      }) as {
        name?: string;
        system_prompt?: string;
      } | null;
      if (!config?.system_prompt) continue;
      const key = config.name ? canonicalAgentKey(config.name) : file.replace(/\.(ya?ml)$/i, '');
      map.set(key, config.system_prompt);
    } catch (_) {
      /* ignora YAML inválido */
    }
  }
  return map;
}

/** Bloco few-shot de UM exemplo (mesmo formato de renderFewShotBlock). */
function renderSingleExampleBlock(example: StructuredFewShotExample): string {
  const parts = [`EXEMPLO VÁLIDO:\n${example.validOutput}`];
  if (example.rejectedOutput) {
    parts.push(`EXEMPLO REJEITADO (não faça assim):\n${example.rejectedOutput}`);
  }
  return `=== EXEMPLOS DE REFERÊNCIA ===\n${parts.join('\n\n')}`;
}

function buildUserPrompt(example: StructuredFewShotExample): string {
  const { demand, context } = example;
  const base = `Analise a demanda: ${demand.description}`;
  return context ? `${base}\n\nContexto: ${context}` : base;
}

async function generate(systemPrompt: string, userPrompt: string): Promise<string> {
  return openAIService.generateChatCompletion(systemPrompt, userPrompt, { temperature: 0 });
}

interface DatasetFile {
  file: string;
  isArray: boolean;
  examples: StructuredFewShotExample[];
}

/** Carrega cada JSON do dataset preservando se era array ou objeto único. */
function loadDatasetFiles(): DatasetFile[] {
  if (!fs.existsSync(DATASET_DIR)) return [];
  const files: DatasetFile[] = [];
  for (const file of fs.readdirSync(DATASET_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(DATASET_DIR, file), 'utf8'));
      const isArray = Array.isArray(raw);
      const items = (isArray ? raw : [raw]) as unknown[];
      const examples: StructuredFewShotExample[] = [];
      for (const item of items) {
        const parsed = structuredFewShotExampleSchema.safeParse(item);
        if (parsed.success) examples.push(parsed.data);
      }
      if (examples.length > 0) files.push({ file, isArray, examples });
    } catch (_) {
      console.warn(`[skip] JSON inválido: ${file}`);
    }
  }
  return files;
}

function writeDatasetFile(entry: DatasetFile): void {
  const payload = entry.isArray ? entry.examples : entry.examples[0];
  fs.writeFileSync(
    path.join(DATASET_DIR, entry.file),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Calcula os scores de eficácia (ablação leave-one-out) para os exemplos de UM agente.
 * Muta os objetos `examples` no lugar (efficacy/updatedAt/version).
 */
async function scoreAgent(
  agent: string,
  examples: StructuredFewShotExample[],
  systemPrompt: string,
  args: Args,
): Promise<boolean> {
  if (examples.length < 2) {
    console.log(`[skip] ${agent}: n=${examples.length} (<2) — ablação leave-one-out exige >=2`);
    return false;
  }

  // Baseline por demanda (sem few-shot), compartilhado entre candidatos.
  const baseline = new Map<string, number>();
  for (const ex of examples) {
    const out = await generate(systemPrompt, buildUserPrompt(ex));
    baseline.set(ex.id, cosineSimilarity(out, ex.validOutput));
  }

  const now = new Date().toISOString();
  let changed = false;

  for (const candidate of examples) {
    const block = renderSingleExampleBlock(candidate);
    const systemWith = `${systemPrompt}\n\n${block}`;
    const deltas: number[] = [];

    for (const heldOut of examples) {
      if (heldOut.id === candidate.id) continue; // leave-one-out
      const out = await generate(systemWith, buildUserPrompt(heldOut));
      const withScore = cosineSimilarity(out, heldOut.validOutput);
      deltas.push(withScore - (baseline.get(heldOut.id) ?? 0));
    }

    const delta = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
    const score = deltaToScore(delta);

    candidate.efficacy = {
      score,
      method: 'ablation',
      delta: Math.round(delta * 10000) / 10000,
      sampleSize: deltas.length,
      lastEvaluatedAt: now,
    };
    candidate.version = candidate.version ?? 1;
    if (!candidate.createdAt) candidate.createdAt = now;
    candidate.updatedAt = now;
    changed = true;

    if (args.verbose) {
      console.log(
        `  ${candidate.id}: delta=${delta.toFixed(4)} score=${score} (n=${deltas.length})`,
      );
    }
  }

  return changed;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targetAgent = args.agent ? canonicalAgentKey(args.agent) : undefined;

  const systemPrompts = loadAgentSystemPrompts();
  const datasetFiles = loadDatasetFiles();

  if (datasetFiles.length === 0) {
    console.error('Nenhum exemplo estruturado encontrado em datasets/few-shot/.');
    process.exit(1);
  }

  // Agrupa exemplos por agente; rastreia a quais arquivos cada exemplo pertence
  // (um agente pode, em tese, ter exemplos espalhados em mais de um arquivo).
  const byAgent = new Map<string, StructuredFewShotExample[]>();
  const agentEntries = new Map<string, Set<DatasetFile>>();
  for (const entry of datasetFiles) {
    for (const ex of entry.examples) {
      // Spec 006 / FR-002: casos de holdout ficam fora da ablação — nem como
      // candidato de injeção nem como base de comparação (heldOut).
      if (ex.split === 'holdout') continue;
      const key = canonicalAgentKey(ex.agent);
      if (!byAgent.has(key)) {
        byAgent.set(key, []);
        agentEntries.set(key, new Set());
      }
      byAgent.get(key)!.push(ex);
      agentEntries.get(key)!.add(entry);
    }
  }

  let scoredAgents = 0;
  for (const [agent, examples] of byAgent) {
    if (targetAgent && agent !== targetAgent) continue;

    const systemPrompt = systemPrompts.get(agent);
    if (!systemPrompt) {
      console.log(`[skip] ${agent}: system_prompt não encontrado em agents/*.yaml`);
      continue;
    }

    console.log(`\n=== Avaliando ${agent} (${examples.length} exemplo(s)) ===`);
    let changed = false;
    try {
      changed = await scoreAgent(agent, examples, systemPrompt, args);
    } catch (error) {
      console.error(`[erro] ${agent}:`, error instanceof Error ? error.message : error);
      continue;
    }

    if (changed) {
      scoredAgents++;
      if (!args.dryRun) {
        for (const entry of agentEntries.get(agent) ?? []) {
          writeDatasetFile(entry);
          console.log(`  → gravado em ${path.join(DATASET_DIR, entry.file)}`);
        }
      } else {
        console.log('  → dry-run: nada gravado');
      }
    }
  }

  console.log(`\nConcluído. Agentes pontuados: ${scoredAgents}.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Scoring falhou:', error);
  process.exit(1);
});
