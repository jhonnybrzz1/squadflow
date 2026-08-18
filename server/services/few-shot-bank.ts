import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { canonicalAgentKey } from './agent-identity';
import { featureFlags } from './feature-flags';
import { selectForInjection } from './few-shot-scoring';
import { logger } from '../utils/logger';

/**
 * Banco de few-shot estruturado (Fase 4). Hoje os exemplos vivem como texto solto
 * (`# EXEMPLO CORRETO` / `# EXEMPLO INCORRETO`) dentro do system_prompt de cada agente
 * em agents/*.yaml. Este módulo os extrai para registros tipados e reutilizáveis —
 * base para um dataset versionável (demanda, contexto, saída válida, saída rejeitada)
 * e para reduzir a variância entre agentes.
 */
export interface FewShotExample {
  agent: string;
  positive?: string; // conteúdo do bloco "# EXEMPLO CORRETO"
  negative?: string; // conteúdo do bloco "# EXEMPLO INCORRETO"
}

const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line.trim());

/**
 * Extrai o corpo que segue um heading que casa `matcher`, até o próximo heading.
 */
function extractAfterHeading(systemPrompt: string, matcher: RegExp): string | undefined {
  const lines = systemPrompt.split('\n');
  const start = lines.findIndex((line) => isHeading(line) && matcher.test(line));
  if (start === -1) return undefined;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) break;
    body.push(lines[i]);
  }

  const text = body.join('\n').trim();
  return text || undefined;
}

/**
 * Extrai os exemplos correto/incorreto de um system_prompt (função pura, testável).
 */
export function extractFewShotExamples(systemPrompt: string): {
  positive?: string;
  negative?: string;
} {
  return {
    positive: extractAfterHeading(systemPrompt, /EXEMPLO\s+CORRETO/i),
    negative: extractAfterHeading(systemPrompt, /EXEMPLO\s+INCORRETO/i),
  };
}

/**
 * Carrega o banco de few-shot a partir dos YAMLs de agente.
 */
export function loadFewShotBank(agentsDir = resolvePath('agents')): FewShotExample[] {
  if (!fs.existsSync(agentsDir)) {
    logger.warn('Banco de few-shot: diretório de agentes não encontrado', {
      context: { agentsDir },
    });
    return [];
  }

  const examples: FewShotExample[] = [];
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas como
      // !!js/function em YAMLs de agents/.
      const config = yaml.load(fs.readFileSync(path.join(agentsDir, file), 'utf8'), {
        schema: yaml.CORE_SCHEMA,
      }) as {
        name?: string;
        system_prompt?: string;
      } | null;
      if (!config?.system_prompt) continue;

      const { positive, negative } = extractFewShotExamples(config.system_prompt);
      if (!positive && !negative) continue;

      const agent = config.name ? canonicalAgentKey(config.name) : file.replace(/\.(ya?ml)$/i, '');
      examples.push({ agent, positive, negative });
    } catch (error) {
      logger.warn('Banco de few-shot: falha ao processar YAML de agente', {
        error: error instanceof Error ? error : undefined,
        context: { file },
      });
    }
  }
  return examples;
}

/** Retorna os exemplos de um agente específico (chave canônica). */
export function getFewShotExamplesForAgent(
  agent: string,
  bank = loadFewShotBank(),
): FewShotExample | undefined {
  const key = canonicalAgentKey(agent);
  return bank.find((example) => example.agent === key);
}

// ===== Dataset estruturado versionável (Fase 4 / slice 2) =====
// A tupla completa que a diagnose pede: demanda + contexto + evidência + saída válida
// + saída rejeitada. Vive em datasets/few-shot/*.json (committed; `data/` é gitignored).

/**
 * Metadados de eficácia de um exemplo (Fase 4 / slice 6 — achado 4.4).
 * `score` 0-100 (50 = neutro); `delta` é a contribuição marginal medida pela
 * ablação (similaridade COM o exemplo menos a baseline SEM ele).
 */
export const fewShotEfficacySchema = z.object({
  score: z.number().min(0).max(100),
  method: z.enum(['ablation', 'manual', 'heuristic']),
  delta: z.number().optional(),
  sampleSize: z.number().int().nonnegative().optional(),
  lastEvaluatedAt: z.string().optional(),
});

export type FewShotEfficacy = z.infer<typeof fewShotEfficacySchema>;

export const structuredFewShotExampleSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  demand: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.string().optional(),
  }),
  context: z.string().optional(),
  evidence: z.string().optional(),
  validOutput: z.string().min(1),
  rejectedOutput: z.string().optional(),
  rationale: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // Versionamento + proveniência (opcionais; ausência => v1, sem score).
  version: z.number().int().positive().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  efficacy: fewShotEfficacySchema.optional(),
  /**
   * Papel do caso (spec 006 / US1): `train` é elegível à injeção de few-shot e à
   * ablação; `holdout` é reservado à avaliação e NUNCA entra no prompt. Casos
   * legados sem o campo permanecem `train`.
   */
  split: z.enum(['train', 'holdout']).default('train'),
});

export type StructuredFewShotExample = z.infer<typeof structuredFewShotExampleSchema>;

/**
 * Carrega o dataset estruturado de few-shot de datasets/few-shot/*.json. Cada arquivo
 * pode conter um exemplo ou um array; exemplos que não validam contra o schema são
 * ignorados (com warning), nunca quebram o carregamento.
 */
export function loadStructuredFewShot(
  dir = resolvePath('datasets/few-shot'),
): StructuredFewShotExample[] {
  if (!fs.existsSync(dir)) return [];

  const examples: StructuredFewShotExample[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const parsed = structuredFewShotExampleSchema.safeParse(item);
        if (parsed.success) {
          examples.push(parsed.data);
        } else {
          logger.warn('Dataset few-shot: exemplo inválido ignorado', {
            context: { file, issues: parsed.error.issues.map((i) => i.message) },
          });
        }
      }
    } catch (error) {
      logger.warn('Dataset few-shot: falha ao ler/parsear JSON', {
        error: error instanceof Error ? error : undefined,
        context: { file },
      });
    }
  }
  return examples;
}

/** Retorna os exemplos estruturados de um agente específico (chave canônica). */
export function getStructuredFewShotForAgent(
  agent: string,
  dataset = loadStructuredFewShot(),
): StructuredFewShotExample[] {
  const key = canonicalAgentKey(agent);
  return dataset.filter((example) => canonicalAgentKey(example.agent) === key);
}

/**
 * Casos elegíveis à injeção no prompt (split === 'train'). Único caminho que a
 * produção deve usar para escolher exemplos — casos de holdout nunca aparecem aqui
 * (spec 006 / FR-001).
 */
export function getInjectableFewShotForAgent(
  agent: string,
  dataset = loadStructuredFewShot(),
): StructuredFewShotExample[] {
  // `!== 'holdout'` (e não `=== 'train'`) para tratar objetos construídos fora do
  // schema Zod (sem default aplicado) como train — o comportamento legado.
  return getStructuredFewShotForAgent(agent, dataset).filter(
    (example) => example.split !== 'holdout',
  );
}

/** Casos reservados à avaliação (split === 'holdout'); nunca injetados. */
export function getHoldoutForAgent(
  agent: string,
  dataset = loadStructuredFewShot(),
): StructuredFewShotExample[] {
  return getStructuredFewShotForAgent(agent, dataset).filter(
    (example) => example.split === 'holdout',
  );
}

// ===== Consumo no prompt (Fase 4 / slice 3) =====
// Acessores cacheados (os arquivos são estáticos) para não reler a cada chamada de
// agente quando a injeção estiver ligada.

let bankCache: FewShotExample[] | null = null;
let datasetCache: StructuredFewShotExample[] | null = null;

export function getFewShotBank(): FewShotExample[] {
  if (!bankCache) bankCache = loadFewShotBank();
  return bankCache;
}

export function getStructuredFewShotBank(): StructuredFewShotExample[] {
  if (!datasetCache) datasetCache = loadStructuredFewShot();
  return datasetCache;
}

/**
 * Threshold mínimo de eficácia para injetar um exemplo (achado 4.4). Lido da flag
 * `fewShotMinEfficacy`, na escala 0-100 (neutro = 50; ver few-shot-scoring.ts).
 *
 * B5: setado em 40 — descarta apenas exemplos que a ablação provou claramente
 * NOCIVOS (delta < 0 ⇒ score < 50), com margem conservadora para ruído do
 * harness. Exemplos SEM score sempre passam (ver filterByThreshold), então este
 * valor só tem efeito depois de rodar `npm run prompts:fewshot:score`
 * (scripts/score-fewshot.ts), que grava os scores em datasets/few-shot/*.json.
 * Recalibrar com a distribuição real de scores quando ela existir.
 */
export function getFewShotMinEfficacy(): number {
  const value = featureFlags.getFlags().fewShotMinEfficacy;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Renderiza um bloco de exemplos de referência para injetar no prompt de um agente.
 * Prefere o dataset estruturado (tupla completa); cai para os exemplos extraídos do
 * YAML. Retorna '' quando não há exemplo — seguro para concatenar sempre.
 *
 * Os exemplos estruturados são filtrados por eficácia (descarta reprovados pela
 * ablação) e rankeados (melhores primeiro) antes do corte por `maxExamples`.
 */
export function renderFewShotBlock(
  agent: string,
  maxExamples = 2,
  dataset = getStructuredFewShotBank(),
  bank = getFewShotBank(),
  minEfficacy = getFewShotMinEfficacy(),
): string {
  const parts: string[] = [];
  const structured = selectForInjection(getInjectableFewShotForAgent(agent, dataset), minEfficacy);

  if (structured.length > 0) {
    for (const example of structured.slice(0, maxExamples)) {
      parts.push(`EXEMPLO VÁLIDO:\n${example.validOutput}`);
      if (example.rejectedOutput) {
        parts.push(`EXEMPLO REJEITADO (não faça assim):\n${example.rejectedOutput}`);
      }
    }
  } else {
    const fallback = getFewShotExamplesForAgent(agent, bank);
    if (fallback?.positive) parts.push(`EXEMPLO VÁLIDO:\n${fallback.positive}`);
    if (fallback?.negative) {
      parts.push(`EXEMPLO REJEITADO (não faça assim):\n${fallback.negative}`);
    }
  }

  if (parts.length === 0) return '';
  return `=== EXEMPLOS DE REFERÊNCIA ===\n${parts.join('\n\n')}`;
}
