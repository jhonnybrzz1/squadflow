import fs from 'node:fs';
import path from 'node:path';
import { openAIService } from './openai-ai';
import { FAST_MODEL } from './llm-model-router';
import { logger } from '../utils/logger';
import { getPromptHash } from './system-prompts';
import { resolvePath } from '@shared/utils/paths';
import { env } from '../config/env';

export interface GroundednessResult {
  isGrounded: boolean;
  score: number | null; // 0.0 to 1.0 ou null em caso de erro de validação
  issues: string[];
  validationError?: boolean;
  /**
   * Spec 10259 T6: indica que o resultado veio de fallback determinístico
   * porque o score do LLM-judge não foi calculável.
   */
  fallback?: boolean;
  /**
   * A-2: true quando o LLM-judge falhou e o sistema entrou em degrade mode.
   */
  degradeMode?: boolean;
  /**
   * Avaliação de RAG (2026-07-26, A-2): true quando `documentContent` ou
   * `retrievedContext` vieram vazios e o juiz LLM nunca foi chamado —
   * `isGrounded: false`/`score: 0` indica "nada para validar".
   */
  skippedNoContext?: boolean;
  /**
   * A-2: score de bigram overlap (0.0 a 1.0) usado para pré-filtro determinístico.
   */
  overlapScore?: number;
  /**
   * A-2: indica a origem da decisão final — 'validated' (LLM-judge) ou 'unvalidated' (fallback/vazio).
   */
  answerSource?: 'validated' | 'unvalidated';
}

export interface GroundednessValidateOptions {
  demandId?: number;
  /** Identificador do agente que gerou o documento. */
  agentId?: string;
  /** Hash SHA-256 do system prompt externo; se omitido, é calculado a partir de agentId. */
  promptHash?: string;
  /** Identificador do modelo LLM usado para gerar o documento. */
  modelId?: string;
}

const DEGRADE_COUNTER_PATH = resolvePath('docs/groundedness-degrade-counter.json');

interface DegradeCounter {
  count: number;
  lastUpdatedAt: string;
}

function readDegradeCounter(): DegradeCounter {
  try {
    const raw = fs.readFileSync(DEGRADE_COUNTER_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as DegradeCounter;
    if (typeof parsed.count === 'number' && typeof parsed.lastUpdatedAt === 'string') {
      return parsed;
    }
  } catch (_) {
    /* não existe ou malformado — inicia do zero */
  }
  return { count: 0, lastUpdatedAt: new Date(0).toISOString() };
}

function writeDegradeCounter(counter: DegradeCounter): void {
  try {
    const dir = path.dirname(DEGRADE_COUNTER_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DEGRADE_COUNTER_PATH, JSON.stringify(counter, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('A-2: falha ao persistir degrade counter', {
      error: err instanceof Error ? err : undefined,
    });
  }
}

function incrementDegradeCounter(threshold: number): void {
  try {
    const counter = readDegradeCounter();
    counter.count += 1;
    counter.lastUpdatedAt = new Date().toISOString();
    writeDegradeCounter(counter);

    if (counter.count > threshold) {
      logger.warn('A-2: degrade counter acima do threshold', {
        context: { count: counter.count, threshold },
      });
    }
  } catch (_) {
    /* não-fatal */
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function bigrams(tokens: string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    set.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return set;
}

function jaccardOverlap(source: string, target: string): number {
  const sourceTokens = tokenize(source);
  const targetTokens = tokenize(target);
  if (sourceTokens.length < 2 || targetTokens.length < 2) return 0.0;

  const sourceBigrams = bigrams(sourceTokens);
  const targetBigrams = bigrams(targetTokens);
  if (sourceBigrams.size === 0 || targetBigrams.size === 0) return 0.0;

  let intersection = 0;
  for (const bg of sourceBigrams) {
    if (targetBigrams.has(bg)) intersection++;
  }
  const union = sourceBigrams.size + targetBigrams.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

function getBigramThresholds(): { low: number; high: number } {
  return {
    low: env.groundednessBigramLowThreshold ?? 0.2,
    high: env.groundednessBigramHighThreshold ?? 0.5,
  };
}

function getDegradeThreshold(): number {
  return env.groundednessDegradeThreshold ?? 10;
}

function extractJsonObject(raw: string): unknown {
  const withoutFences = raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? withoutFences.slice(start, end + 1) : withoutFences;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    logger.warn('Falha ao parsear JSON do LLM-judge de groundedness', {
      error: err instanceof Error ? err : undefined,
      context: { rawPreview: candidate.slice(0, 200) },
    });
    throw new Error('Invalid JSON returned by groundedness judge', {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

export class GroundednessValidator {
  /**
   * Avalia se as afirmações e citações contidas no documento gerado são de fato suportadas
   * pelo contexto recuperado (RAG/Chunks), atuando como LLM-judge de groundedness.
   *
   * A-2: agora com pré-filtro determinístico de bigram overlap e fail-open.
   */
  static async validate(
    documentContent: string,
    retrievedContext: string,
    optionsOrDemandId?: GroundednessValidateOptions | number,
  ): Promise<GroundednessResult> {
    const startedAt = Date.now();
    const options: GroundednessValidateOptions =
      typeof optionsOrDemandId === 'number'
        ? { demandId: optionsOrDemandId }
        : (optionsOrDemandId ?? {});

    const agentId = options.agentId ?? 'groundedness';
    const promptHash = options.promptHash ?? (agentId ? getPromptHash(agentId) : null) ?? 'unknown';
    const modelId = options.modelId ?? FAST_MODEL;

    // A-2: conteúdo vazio = fail-safe (não aprova silenciosamente)
    if (!documentContent.trim() || !retrievedContext.trim()) {
      const source = 'unvalidated';
      logger.info('A-2: [GroundednessValidator] Validação pulada — sem conteúdo ou contexto RAG', {
        context: {
          demandId: options.demandId,
          hasDocumentContent: Boolean(documentContent.trim()),
          hasRetrievedContext: Boolean(retrievedContext.trim()),
          answerSource: source,
          overlapScore: 0,
        },
      });
      return {
        isGrounded: false,
        score: 0,
        issues: ['empty_content_or_context'],
        skippedNoContext: true,
        overlapScore: 0,
        answerSource: source,
      };
    }

    // A-2: pré-filtro determinístico por bigram overlap
    const overlapScore = jaccardOverlap(retrievedContext, documentContent);
    const { low, high } = getBigramThresholds();

    if (overlapScore < low) {
      logger.info('A-2: bigram overlap abaixo do threshold low — rejeitado sem LLM', {
        context: {
          demandId: options.demandId,
          overlapScore,
          thresholdLow: low,
          answerSource: 'unvalidated',
        },
      });
      return {
        isGrounded: false,
        score: 0,
        issues: ['bigram_overlap_below_threshold'],
        overlapScore,
        answerSource: 'unvalidated',
      };
    }

    if (overlapScore >= high) {
      logger.info('A-2: bigram overlap acima do threshold high — aprovado sem LLM', {
        context: {
          demandId: options.demandId,
          overlapScore,
          thresholdHigh: high,
          answerSource: 'validated',
        },
      });
      return {
        isGrounded: true,
        score: 1.0,
        issues: [],
        overlapScore,
        answerSource: 'validated',
      };
    }

    const systemPrompt = `Você é um avaliador especialista em integridade de RAG (LLM-as-judge de Groundedness).
Sua tarefa é analisar se o "Documento Gerado" é factual e totalmente suportado pelo "Contexto de Referência" (RAG).

Regras de Avaliação:
1. Qualquer afirmação, fato ou citação no "Documento Gerado" que NÃO esteja presente ou implícito diretamente no "Contexto de Referência" é considerado alucinação/sem suporte.
2. Identifique citações seletivas que distorçam o significado original do texto de referência.
3. Se houver desvios ou fatos sem suporte, forneça as falhas específicas de forma concisa.

Você deve responder APENAS com um objeto JSON no seguinte formato:
{
  "score": 0.0 a 1.0 (onde 1.0 é totalmente suportado, 0.0 é totalmente alucinado/sem suporte),
  "isGrounded": true ou false (true se score >= 0.85),
  "issues": ["descreva a falha 1", "descreva a falha 2"] (deve estar vazio se score for 1.0)
}`;

    const userPrompt = `=== CONTEXTO DE REFERÊNCIA (RAG) ===\n${retrievedContext.slice(0, 15000)}\n\n=== DOCUMENTO GERADO ===\n${documentContent.slice(0, 15000)}\n\nPor favor, analise a fidelidade das informações e retorne o JSON.`;

    try {
      const response = await openAIService.generateChatCompletion(systemPrompt, userPrompt, {
        model: FAST_MODEL,
        maxTokens: 500,
        temperature: 0.0,
        responseFormat: 'json_object',
        agentName: agentId,
      });

      const parsed = extractJsonObject(response || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Groundedness judge returned a non-object JSON value');
      }
      const score =
        typeof (parsed as Record<string, unknown>).score === 'number'
          ? ((parsed as Record<string, unknown>).score as number)
          : 0.0;
      const isGrounded = score >= 0.85;
      const issues = Array.isArray((parsed as Record<string, unknown>).issues)
        ? ((parsed as Record<string, unknown>).issues as string[])
        : [];

      if (issues.length > 0) {
        logger.warn('Groundedness validation failed or found issues', {
          context: {
            demandId: options.demandId,
            score,
            overlapScore,
            issues,
            answerSource: 'validated',
          },
        });
      } else {
        logger.info('A-2: Groundedness validado pelo LLM-judge', {
          context: {
            demandId: options.demandId,
            score,
            overlapScore,
            isGrounded,
            answerSource: 'validated',
          },
        });
      }

      return { isGrounded, score, issues, overlapScore, answerSource: 'validated' };
    } catch (err) {
      // A-2: fail-open — quando o LLM-judge falha, rejeitamos e entramos em degrade mode
      const elapsedMs = Date.now() - startedAt;
      const answerSource = 'unvalidated';

      incrementDegradeCounter(getDegradeThreshold());

      logger.warn('A-2: Groundedness score não calculável; rejeitando em degrade mode', {
        error: err instanceof Error ? err : undefined,
        context: {
          agent_id: agentId,
          prompt_hash: promptHash,
          model_id: modelId,
          elapsed_ms: elapsedMs,
          demandId: options.demandId,
          overlapScore,
          answerSource,
          degradeMode: true,
        },
      });

      return {
        isGrounded: false,
        score: null,
        issues: ['llm_failure'],
        validationError: true,
        fallback: true,
        degradeMode: true,
        overlapScore,
        answerSource,
      };
    }
  }
}
