import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

import { openAIService } from '../services/openai-ai';
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from '../orchestration-contracts';
import { Demand } from '@shared/schema';

// Interface do Caso de Teste do Golden Set
interface TestCase {
  id: number;
  name: string;
  type: 'calibracao' | 'holdout';
  demandTitle: string;
  demandDescription: string;
  history: string[];
  divergences: string[];
  idealJson: string;
}

// Schema de saída do Juiz Semântico
const JudgeScoreSchema = z.object({
  completude: z.number().min(0).max(5),
  precisao: z.number().min(0).max(5),
  aderencia: z.number().min(0).max(5),
  justificativa: z.string(),
});

type JudgeScore = z.infer<typeof JudgeScoreSchema>;

// Notas de Referência Humanas para os 3 casos de hold-out (Meta-Eval)
const HUMAN_REFERENCE_SCORES: Record<
  number,
  { completude: number; precisao: number; aderencia: number }
> = {
  6: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 6: Agendamento Push
  7: { completude: 5, precisao: 4, aderencia: 5 }, // Caso 7: Exportação CSV
  8: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 8: Stripe Integration
  23: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 23: SSO Azure AD
  24: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 24: Fila BullMQ
  25: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 25: Criptografia em repouso
  26: { completude: 5, precisao: 4, aderencia: 5 }, // Caso 26: GraphQL
  27: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 27: Webhook para parceiros
  28: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 28: Telemetria de custo
  29: { completude: 5, precisao: 4, aderencia: 5 }, // Caso 29: Smoke test pós-deploy
  30: { completude: 5, precisao: 5, aderencia: 5 }, // Caso 30: LGPD esquecimento
};

// Limiar de concordância acordado para validação da régua (80%)
const CONCORDANCE_THRESHOLD = 0.8;

/**
 * Faz o parse estruturado do arquivo docs/evaluation-golden-set.md
 */
function parseGoldenSet(): TestCase[] {
  const filePath = resolvePath('docs/evaluation-golden-set.md');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo Golden Set não encontrado em: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const cases: TestCase[] = [];

  // Dividir o conteúdo nos blocos de casos de teste
  const caseBlocks = content.split('### Caso ');

  // O índice 0 é a introdução e rubrica. Os casos reais começam a partir do índice 1.
  for (let i = 1; i < caseBlocks.length; i++) {
    const block = caseBlocks[i];
    const lines = block.split('\n');

    const titleLine = lines[0].trim(); // ex: "1: Autenticação SSO em API Corporativa"
    const colonIndex = titleLine.indexOf(':');
    if (colonIndex === -1) continue;

    const id = parseInt(titleLine.substring(0, colonIndex).trim(), 10);
    const name = titleLine.substring(colonIndex + 1).trim();

    // Tipo: calibracao ou holdout
    const typeMatch = block.match(/\*\s+\*\*Tipo\*\*:\s*(calibracao|holdout)/i);
    const type = (typeMatch ? typeMatch[1].toLowerCase().trim() : 'calibracao') as
      'calibracao' | 'holdout';

    // Demanda original
    const demandOrigStart = block.indexOf('**Demanda original**:');
    const historyStart = block.indexOf('**Histórico do debate**:');
    let demandTitle = '';
    let demandDescription = '';
    if (demandOrigStart !== -1 && historyStart !== -1) {
      const demandSection = block
        .substring(demandOrigStart + '**Demanda original**:'.length, historyStart)
        .trim();
      const titleMatch = demandSection.match(/Título:\s*(.+)/i);
      demandTitle = titleMatch ? titleMatch[1].trim() : '';
      const descMatch = demandSection.match(/Descrição:\s*([\s\S]+)/i);
      demandDescription = descMatch ? descMatch[1].trim() : '';
    }

    // Histórico do debate
    const divsStart = block.indexOf('**Divergências identificadas**:');
    let historyStr = '';
    if (historyStart !== -1 && divsStart !== -1) {
      historyStr = block
        .substring(historyStart + '**Histórico do debate**:'.length, divsStart)
        .trim();
    }

    const history: string[] = [];
    if (historyStr && historyStr.toLowerCase() !== '(vazio)') {
      const linesHist = historyStr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('*') && !l.startsWith('-'));
      history.push(...linesHist);
    }

    // Divergências
    const responseIdealStart = block.indexOf('**Resposta Ideal Esperada**:');
    let divsStr = '';
    if (divsStart !== -1 && responseIdealStart !== -1) {
      divsStr = block
        .substring(divsStart + '**Divergências identificadas**:'.length, responseIdealStart)
        .trim();
    }
    const divergences = divsStr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.toLowerCase() !== 'nenhuma');

    // Resposta ideal
    const jsonBlockMatch = block.match(/```json\n([\s\S]+?)\n```/);
    const idealJson = jsonBlockMatch ? jsonBlockMatch[1].trim() : '{}';

    cases.push({
      id,
      name,
      type,
      demandTitle,
      demandDescription,
      history,
      divergences,
      idealJson,
    });
  }

  return cases;
}

/**
 * Roda a avaliação usando o LLM como Juiz Semântico Neutro
 */
async function evaluateResponse(testCase: TestCase, actualResponse: string): Promise<JudgeScore> {
  const judgeSystemPrompt = `Você é um avaliador neutro especialista em refinamento de produtos e qualidade de IA.
Sua única tarefa é aplicar estritamente a rubrica abaixo para julgar uma consolidação gerada em JSON, comparando-a com uma resposta ideal de referência.

DADOS DO CONTEXTO DE AVALIAÇÃO:
- TÍTULO DA DEMANDA: ${testCase.demandTitle}
- DESCRIÇÃO DA DEMANDA: ${testCase.demandDescription}
- HISTÓRICO DO DEBATE DA SQUAD:
${testCase.history.length > 0 ? testCase.history.join('\n\n') : '(vazio)'}

RESPOSTA IDEAL ESPERADA (CURADA POR HUMANO):
${testCase.idealJson}

RESPOSTA GERADA PELO PROMPT-ALVO (A SER AVALIADA):
${actualResponse}

RUBRICA DE AVALIAÇÃO:
1. Completude (0-5): A resposta em JSON cobre todos os campos obrigatórios do RefinementOutputSchema?
   - 0: Campos centrais como "problema", "objetivo", "escopo" ou "consolidacao" estão ausentes ou vazios.
   - 3: Todos os campos estão presentes, mas 1 ou 2 seções (como "riscos" ou "criterios_de_aceite") estão superficiais ou com descrições genéricas/insuficientes.
   - 5: Todos os 8 campos estão preenchidos de forma rica, detalhada e cobrem plenamente a discussão ocorrida.

2. Precisão/Correção (0-5): A consolidação reflete dados verdadeiros e evita inventar números, baselines, prazos ou ROIs fabricados?
   - 0: Inventa dados factuais, percentuais de ganho ou baselines (ex: inventa "redução de 80%" sem fonte).
   - 3: Não inventa números, mas faz inferências qualitativas um pouco ousadas que não estavam explícitas no debate.
   - 5: Absolutamente preciso. Segue rigorosamente a Regra de Integridade Numérica. Usa "A MEDIR — sem baseline" ou "Definir após coletar baseline" quando o dado não foi fornecido.

3. Aderência ao Contexto (0-5): A consolidação foca especificamente no escopo da demanda avaliada ou inclui generalidades vagas?
   - 0: Resposta genérica que poderia servir para qualquer software ou projeto de TI, ignorando a demanda específica.
   - 3: Cita termos específicos da demanda, mas o tom do resumo ou escopo é genérico em partes importantes.
   - 5: Totalmente de acordo com o contexto, capturando os termos técnicos específicos, restrições e divergências discutidos no debate.

REGRAS DE RETORNO:
- Não justifique nada fora do JSON. Não adicione tags de markdown.
- O campo "justificativa" deve ter NO MÁXIMO 200 caracteres.
- Retorne APENAS um JSON válido contendo exatamente as seguintes propriedades:
{
  "completude": 0-5 (número inteiro),
  "precisao": 0-5 (número inteiro),
  "aderencia": 0-5 (número inteiro),
  "justificativa": "máx 200 chars — uma frase por critério"
}`;

  const judgeUserPrompt = `Por favor, aplique a rubrica e retorne a avaliação exclusivamente no formato JSON.`;

  const judgeCallOptions = {
    demandId: 999,
    model: 'deepseek/deepseek-v4-pro',
    temperature: 0.1,
    maxTokens: 600,
    taskType: 'classification' as const,
    operation: 'evaluation:judge',
    cache: false,
  };

  const parseJudgeRaw = (rawContent: string): JudgeScore => {
    const start = rawContent.indexOf('{');
    const end = rawContent.lastIndexOf('}');
    const jsonStr =
      start >= 0 && end > start
        ? rawContent.slice(start, end + 1)
        : rawContent
            .replace(/```json\n?/gi, '')
            .replace(/```\n?/gi, '')
            .trim();
    const parsed = JSON.parse(jsonStr);
    const normalized = {
      completude: parsed.completude ?? parsed.completude_score ?? parsed.completeness ?? 0,
      precisao:
        parsed.precisao ?? parsed.precisao_score ?? parsed.precision ?? parsed.accuracy ?? 0,
      aderencia:
        parsed.aderencia ?? parsed.aderencia_score ?? parsed.adherence ?? parsed.relevance ?? 0,
      justificativa:
        parsed.justificativa ??
        parsed.justification ??
        parsed.reasoning ??
        parsed.explanation ??
        '',
    };
    return JudgeScoreSchema.parse(normalized);
  };

  try {
    let rawContent = '';
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await openAIService.generateChatCompletionWithMetadata(
        judgeSystemPrompt,
        judgeUserPrompt,
        judgeCallOptions,
      );
      rawContent = result.content ?? '';
      const isEmpty = rawContent.trim() === '' || rawContent.trim() === '{}';
      console.log(
        `  [Juiz Caso ${testCase.id} | attempt ${attempt}] raw: ${rawContent.slice(0, 200)}`,
      );
      if (!isEmpty) break;
      if (attempt < MAX_RETRIES) {
        console.warn(`  [Juiz] Resposta vazia — retry ${attempt}/${MAX_RETRIES - 1}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt)); // backoff: 1.5s, 3s
      }
    }

    return parseJudgeRaw(rawContent);
  } catch (err) {
    console.error(`Erro ao avaliar caso ${testCase.id} com o Juiz:`, err);
    return {
      completude: 0,
      precisao: 0,
      aderencia: 0,
      justificativa: `Falha: ${(err as Error).message}`.slice(0, 200),
    };
  }
}

/**
 * Calcula a variância amostral de uma lista de números
 */
function calculateVariance(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const sqDiffs = values.map((val) => Math.pow(val - mean, 2));
  return sqDiffs.reduce((sum, val) => sum + val, 0) / (values.length - 1);
}

/**
 * Executa a avaliação de um caso de teste RUNS vezes
 */
async function evaluateTestCase(
  testCase: TestCase,
  runs = 3,
): Promise<{
  scores: JudgeScore[];
  avgCompletude: number;
  avgPrecisao: number;
  avgAderencia: number;
  varCompletude: number;
  varPrecisao: number;
  varAderencia: number;
}> {
  const scores: JudgeScore[] = [];

  // 1. Instanciar os prompts de consolidação com o mock da demanda
  const demandMock = {
    id: testCase.id,
    title: testCase.demandTitle,
    description: testCase.demandDescription,
    type: 'feature',
    priority: 'high',
    status: 'processing',
    progress: 0,
    createdAt: new Date(),
  } as unknown as Demand;

  const systemPrompt = buildConsolidationSystemPrompt();
  const userPrompt = buildConsolidationUserPrompt(
    demandMock.title,
    demandMock.description,
    testCase.history,
    testCase.divergences,
  );

  // 2. Executar o prompt-alvo no LLM
  const completion = await openAIService.generateChatCompletionWithMetadata(
    systemPrompt,
    userPrompt,
    {
      demandId: testCase.id,
      model: 'deepseek/deepseek-v4-pro',
      temperature: 0.3,
      maxTokens: 1500,
      taskType: 'analysis',
      operation: 'evaluation:target',
      cache: false,
    },
  );

  const response = completion.content || '{}';

  // 3. Executar o Juiz runs vezes
  for (let r = 0; r < runs; r++) {
    const score = await evaluateResponse(testCase, response);
    scores.push(score);
  }

  // 4. Agregar resultados (médias e variâncias)
  const completudes = scores.map((s) => s.completude);
  const precisoes = scores.map((s) => s.precisao);
  const aderencias = scores.map((s) => s.aderencia);

  const avgCompletude = completudes.reduce((a, b) => a + b, 0) / runs;
  const avgPrecisao = precisoes.reduce((a, b) => a + b, 0) / runs;
  const avgAderencia = aderencias.reduce((a, b) => a + b, 0) / runs;

  const varCompletude = calculateVariance(completudes);
  const varPrecisao = calculateVariance(precisoes);
  const varAderencia = calculateVariance(aderencias);

  return {
    scores,
    avgCompletude,
    avgPrecisao,
    avgAderencia,
    varCompletude,
    varPrecisao,
    varAderencia,
  };
}

/**
 * Executa a suíte completa de avaliação
 */
async function main() {
  const args = process.argv.slice(2);
  const smokeMode = args.includes('--smoke');
  const outputArgIndex = args.indexOf('--output');
  const outputPath = outputArgIndex >= 0 ? args[outputArgIndex + 1] : undefined;
  console.log('\n========================================================================');
  console.log('🧪 EXPERIMENTO DE AVALIAÇÃO SEMÂNTICA (Consolidação de PRDs)');
  console.log('========================================================================');

  try {
    const testCases = parseGoldenSet();
    const allCalibrationCases = testCases.filter((c) => c.type === 'calibracao');
    const allHoldoutCases = testCases.filter((c) => c.type === 'holdout');
    const calibrationCases = smokeMode ? allCalibrationCases.slice(0, 1) : allCalibrationCases;
    const holdoutCases = smokeMode ? allHoldoutCases.slice(0, 2) : allHoldoutCases;
    const runsPerCase = smokeMode ? 1 : 3;

    console.log(
      `\n📦 Golden Set carregado. Calibração: ${calibrationCases.length} | Hold-out: ${holdoutCases.length}`,
    );

    // --- FRENTE A: CALIBRAÇÃO (BASELINE) ---
    console.log('\n------------------------------------------------------------------------');
    console.log('🏁 FASE 1: AVALIANDO BASELINE (CALIBRAÇÃO - 5 CASOS)');
    console.log('------------------------------------------------------------------------');

    let totalCompletude = 0;
    let totalPrecisao = 0;
    let totalAderencia = 0;
    let totalVar = 0;

    for (const c of calibrationCases) {
      console.log(`\nCaso ${c.id} [${c.type.toUpperCase()}]: "${c.name}"...`);
      const evalResult = await evaluateTestCase(c, runsPerCase);

      console.log(
        `  └─ Médias: Completude: ${evalResult.avgCompletude.toFixed(2)}/5.0 | Precisão: ${evalResult.avgPrecisao.toFixed(2)}/5.0 | Aderência: ${evalResult.avgAderencia.toFixed(2)}/5.0`,
      );
      console.log(
        `  └─ Variâncias: Completude: ${evalResult.varCompletude.toFixed(2)} | Precisão: ${evalResult.varPrecisao.toFixed(2)} | Aderência: ${evalResult.varAderencia.toFixed(2)}`,
      );
      console.log(`  └─ Justificativa Juiz (Run 1): ${evalResult.scores[0].justificativa}`);

      totalCompletude += evalResult.avgCompletude;
      totalPrecisao += evalResult.avgPrecisao;
      totalAderencia += evalResult.avgAderencia;
      totalVar += (evalResult.varCompletude + evalResult.varPrecisao + evalResult.varAderencia) / 3;
    }

    const countCalib = calibrationCases.length;
    const avgCompletude = totalCompletude / countCalib;
    const avgPrecisao = totalPrecisao / countCalib;
    const avgAderencia = totalAderencia / countCalib;
    const avgScoreCalib = (avgCompletude + avgPrecisao + avgAderencia) / 3;
    const avgVarCalib = totalVar / countCalib;

    console.log('\n========================================================================');
    console.log('📊 RESULTADOS DO BASELINE (Fase de Calibração)');
    console.log('========================================================================');
    console.log(`Score Médio Geral: ${avgScoreCalib.toFixed(2)}/5.0`);
    console.log(`Variância Média:   ${avgVarCalib.toFixed(3)}`);
    console.log(`\nBreakdown de Médias por Critério:`);
    console.log(` - Completude:          ${avgCompletude.toFixed(2)}/5.0`);
    console.log(` - Precisão/Correção:   ${avgPrecisao.toFixed(2)}/5.0`);
    console.log(` - Aderência:           ${avgAderencia.toFixed(2)}/5.0`);
    console.log('------------------------------------------------------------------------');

    // --- FASE 2: META-EVAL (HOLD-OUT) ---
    console.log('\n------------------------------------------------------------------------');
    console.log('🎯 FASE 2: EXECUÇÃO DO META-EVAL (HOLD-OUT - 3 CASOS)');
    console.log('------------------------------------------------------------------------');

    let totalCriteria = 0;
    let concordantCriteria = 0;

    for (const h of holdoutCases) {
      console.log(`\nAvaliação Hold-out Caso ${h.id}: "${h.name}"...`);
      const evalResult = await evaluateTestCase(h, runsPerCase);

      const humanRef = HUMAN_REFERENCE_SCORES[h.id];
      if (!humanRef) {
        console.warn(
          `  ⚠️ Sem score humano de referência para o caso ${h.id}. Pulando concordância.`,
        );
        continue;
      }

      const scorerScores = {
        completude: Math.round(evalResult.avgCompletude),
        precisao: Math.round(evalResult.avgPrecisao),
        aderencia: Math.round(evalResult.avgAderencia),
      };

      console.log(
        `  └─ Scorer Médio (Arredondado): Completude: ${scorerScores.completude} | Precisão: ${scorerScores.precisao} | Aderência: ${scorerScores.aderencia}`,
      );
      console.log(
        `  └─ Humano Referência:          Completude: ${humanRef.completude} | Precisão: ${humanRef.precisao} | Aderência: ${humanRef.aderencia}`,
      );

      // Avaliar concordância de cada critério (diferença <= 1 ponto)
      const criteriaList: ('completude' | 'precisao' | 'aderencia')[] = [
        'completude',
        'precisao',
        'aderencia',
      ];
      for (const crit of criteriaList) {
        totalCriteria++;
        const diff = Math.abs(scorerScores[crit] - humanRef[crit]);
        const concordant = diff <= 1;
        if (concordant) {
          concordantCriteria++;
        }
        console.log(
          `     - Critério "${crit}": Dif: ${diff} | Concordante: ${concordant ? 'SIM ✅' : 'NÃO ❌'}`,
        );
      }
    }

    const concordanceRate = concordantCriteria / totalCriteria;
    const isRuleValid = concordanceRate >= CONCORDANCE_THRESHOLD;

    console.log('\n========================================================================');
    console.log('⚖️ RELATÓRIO DO META-EVAL (Validação da Régua)');
    console.log('========================================================================');
    console.log(`Concordância Humano-Scorer: ${(concordanceRate * 100).toFixed(1)}%`);
    console.log(`Limiar Mínimo Exigido:      ${(CONCORDANCE_THRESHOLD * 100).toFixed(0)}%`);
    console.log(
      `Status de Validação da Régua: ${isRuleValid ? 'VÁLIDA (APROVADA) 🎉' : 'REPROVADA (AJUSTAR RUBRICA) ❌'}`,
    );
    console.log('========================================================================\n');

    const report = {
      mode: smokeMode ? 'smoke' : 'full',
      generatedAt: new Date().toISOString(),
      sampleSize: calibrationCases.length + holdoutCases.length,
      calibration: {
        completude: avgCompletude,
        precisao: avgPrecisao,
        aderencia: avgAderencia,
        overall: avgScoreCalib,
      },
      concordanceRate,
      rubricValid: isRuleValid,
    };
    if (outputPath) {
      const resolvedOutput = resolvePath(outputPath);
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    process.exitCode = isRuleValid ? 0 : 1;
  } catch (error) {
    console.error('Erro durante a execução do experimento:', error);
    process.exitCode = 1;
  }
}

main();
