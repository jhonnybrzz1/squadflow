import { type TaskType, isClassificationEnabled } from './request-telemetry';

/**
 * Task Type Classifier
 *
 * Heuristic-based classification of AI requests into complexity categories.
 * Uses prompt length + keyword analysis (no ML, no external API).
 *
 * Categories:
 * - simple: Short prompts, greetings, yes/no, basic lookups
 * - intermediate: Standard queries, moderate length, single-topic
 * - complex: Multi-step analysis, code generation, long context
 * - critical: Production deployments, security, compliance, financial decisions
 * - unknown: Cannot classify with confidence
 *
 * PRD target: ≥70% accuracy against manual ground truth (50 requests)
 */

// Keyword patterns for each category
const CRITICAL_KEYWORDS = [
  /\b(deploy.*produ[çc]|produção.*deploy|rollback|hotfix)\b/i,
  /\b(security|segurança|vulnerabilid|cve|exploit|injection)\b/i,
  /\b(compliance|auditoria|regulatóri|bacen|bcb|banco.*central)\b/i,
  /\b(financeiro|pagamento|transação|saldo|cobrança)\b/i,
  /\b(migra[çc]ão.*dados|data.*migrat|migrar.*registros)\b/i,
  /\b(pii|gdpr|lgpd|dados.*pessoais|esquecimento)\b/i,
  /\b(downtime|incident|outage|postmortem|fora.*do.*ar)\b/i,
  /\b(urgente|emergência|critical|imediato|prazo.*regulat)\b/i,
  /\b(multa|penalidade|sanção|risco.*operacional)\b/i,
  /\b(ssl.*expir|certificado.*expir|disaster.*recovery)\b/i,
  /\b(lavagem|coaf|suspeita|fraude)\b/i,
  /\b(backup.*produ|recovery.*produ|rpo|rto)\b/i,
];

const COMPLEX_KEYWORDS = [
  /\b(refactor|arquitetura|architecture|redesign)\b/i,
  /\b(implementar|implement|criar.*sistema|build.*system)\b/i,
  /\b(anális[ei]|analysis|investigar|debug.*complex)\b/i,
  /\b(integra[çc]ão|integrat|api.*design)\b/i,
  /\b(performance|otimiz|optimiz|benchmark|gargalo)\b/i,
  /\b(test.*suite|cobertura|coverage|e2e)\b/i,
  /\b(pipeline|ci\/cd|infra.*code|terraform)\b/i,
  /\b(multi.*step|passo.*a.*passo|step.*by.*step)\b/i,
  /\b(prd|requisitos|requirements|especifica[çc]ão)\b/i,
  /\b(microservi[çc]|distributed|escala|scaling)\b/i,
  /\b(websocket|real.*time|tempo.*real|filas?|queue)\b/i,
  /\b(elasticsearch|full.*text|indexa[çr])\b/i,
  /\b(rbac|abac|permiss[ãõ]|authorization)\b/i,
  /\b(caching.*multi|multi.*layer|cache.*layer)\b/i,
  /\b(migrar.*monolito|microservic|bounded.*context)\b/i,
  /\b(wireframe|protótipo|dashboard.*complet)\b/i,
  /\b(multi.*tenant|row.*level|schema.*per)\b/i,
];

const SIMPLE_KEYWORDS = [
  /\b(ol[aá]|hi|hello|bom.*dia|boa.*tarde)\b/i,
  /\b(obrigad[oa]|thanks|thank.*you)\b/i,
  /\b(sim|não|yes|no|ok|certo)\b/i,
  /\b(o.*que.*[eé]|what.*is|defin[ei])\b/i,
  /\b(listar|list|mostrar|show|exibir)\b/i,
  /\b(quanto|when|onde|where|quem|who)\b/i,
  /\b(status|verificar|check)\b/i,
  /\b(resumo|summary|tldr)\b/i,
];

interface ClassificationResult {
  taskType: TaskType;
  confidence: number;
  signals: string[];
}

/**
 * Classify a request based on prompt content and metadata.
 *
 * @param promptText - Combined system+user prompt text (for length analysis only)
 * @param tokenCount - Token count of the prompt
 * @param operation - Operation type from the AI service
 * @param existingTaskType - Task type from GenerateOptions (if provided internally)
 * @param demandDescription - Descrição da demanda para verificar domínio (opcional)
 */
export function classifyTaskType(
  promptText: string,
  tokenCount: number,
  operation?: string,
  existingTaskType?: string,
  _demandDescription?: string,
): ClassificationResult {
  // If classification is disabled, return unknown
  if (!isClassificationEnabled()) {
    return { taskType: 'unknown', confidence: 0, signals: ['classification_disabled'] };
  }

  const signals: string[] = [];
  const scores: Record<TaskType, number> = {
    simple: 0,
    intermediate: 0,
    complex: 0,
    critical: 0,
    unknown: 0,
  };

  // --- Signal 1: Token count ---
  if (tokenCount <= 30) {
    scores.simple += 4;
    signals.push('tokens_very_short');
  } else if (tokenCount <= 60) {
    scores.simple += 2;
    signals.push('tokens_short');
  } else if (tokenCount <= 150) {
    scores.intermediate += 2;
    signals.push('tokens_medium_low');
  } else if (tokenCount <= 350) {
    scores.intermediate += 1;
    scores.complex += 2;
    signals.push('tokens_medium_high');
  } else if (tokenCount <= 1000) {
    scores.complex += 3;
    signals.push('tokens_long');
  } else {
    scores.complex += 4;
    signals.push('tokens_very_long');
  }

  // --- Signal 2: Keyword matching ---
  const criticalMatches = CRITICAL_KEYWORDS.filter((kw) => kw.test(promptText)).length;
  const complexMatches = COMPLEX_KEYWORDS.filter((kw) => kw.test(promptText)).length;
  const simpleMatches = SIMPLE_KEYWORDS.filter((kw) => kw.test(promptText)).length;

  if (criticalMatches >= 3) {
    scores.critical += 6;
    signals.push(`critical_keywords_${criticalMatches}`);
  } else if (criticalMatches >= 2) {
    scores.critical += 5;
    signals.push(`critical_keywords_${criticalMatches}`);
  } else if (criticalMatches === 1) {
    scores.critical += 3;
    signals.push('critical_keyword_1');
  }

  if (complexMatches >= 4) {
    scores.complex += 6;
    signals.push(`complex_keywords_${complexMatches}`);
  } else if (complexMatches >= 2) {
    scores.complex += 4;
    signals.push(`complex_keywords_${complexMatches}`);
  } else if (complexMatches === 1) {
    scores.complex += 2;
    signals.push(`complex_keywords_1`);
  }

  if (simpleMatches >= 2) {
    scores.simple += 3;
    signals.push(`simple_keywords_${simpleMatches}`);
  } else if (simpleMatches === 1) {
    scores.simple += 1;
    signals.push('simple_keyword_1');
  }

  // --- Signal 3: Operation type ---
  if (operation) {
    if (operation.includes('classification') || operation.includes('cache')) {
      scores.simple += 2;
      signals.push('op_classification');
    } else if (operation.includes('embedding')) {
      scores.simple += 1;
      signals.push('op_embedding');
    } else if (operation.includes('document') || operation.includes('prd')) {
      scores.complex += 2;
      signals.push('op_document');
    } else if (operation.includes('agent_interaction')) {
      scores.intermediate += 1;
      scores.complex += 1;
      signals.push('op_agent_interaction');
    }
  }

  // --- Signal 4: Internal taskType hint ---
  if (existingTaskType) {
    switch (existingTaskType) {
      case 'classification':
      case 'json':
      case 'simple':
        scores.simple += 2;
        signals.push(`hint_${existingTaskType}`);
        break;
      case 'analysis':
      case 'document':
      case 'generation':
        scores.complex += 2;
        signals.push(`hint_${existingTaskType}`);
        break;
      case 'technical':
        scores.complex += 1;
        scores.critical += 1;
        signals.push('hint_technical');
        break;
    }
  }

  // --- Signal 5: Prompt structure indicators ---
  const lineCount = promptText.split('\n').length;
  const hasCodeBlocks = /```[\s\S]*```/.test(promptText);
  const hasJsonStructure = /\{[\s\S]*"[\w]+":/.test(promptText);
  const hasMultipleQuestions = (promptText.match(/\?/g) || []).length >= 3;

  if (hasCodeBlocks) {
    scores.complex += 2;
    signals.push('has_code_blocks');
  }
  if (hasJsonStructure && tokenCount > 300) {
    scores.intermediate += 1;
    signals.push('has_json_structure');
  }
  if (hasMultipleQuestions) {
    scores.intermediate += 1;
    scores.complex += 1;
    signals.push('multiple_questions');
  }
  if (lineCount > 20) {
    scores.complex += 1;
    signals.push('many_lines');
  }

  // --- Determine winner ---
  const entries = Object.entries(scores) as Array<[TaskType, number]>;
  entries.sort((a, b) => b[1] - a[1]);

  const [topType, topScore] = entries[0];
  const [, secondScore] = entries[1];

  // Confidence: how much the top score dominates
  const totalScore = entries.reduce((sum, [, s]) => sum + s, 0);
  const confidence = totalScore > 0 ? topScore / totalScore : 0;

  // If scores are too close, lower confidence
  if (topScore - secondScore <= 1 && topScore < 4) {
    return {
      taskType: topScore >= 2 ? topType : 'unknown',
      confidence: Math.min(confidence, 0.4),
      signals,
    };
  }

  // Default to intermediate if no strong signal
  if (topScore < 3) {
    return { taskType: 'intermediate', confidence: 0.5, signals };
  }

  return { taskType: topType, confidence: Math.min(confidence, 1.0), signals };
}

/**
 * Quick classification from token count only (for cases where we don't have prompt text).
 */
export function classifyByTokenCount(tokenCount: number): TaskType {
  if (!isClassificationEnabled()) return 'unknown';
  if (tokenCount <= 100) return 'simple';
  if (tokenCount <= 600) return 'intermediate';
  if (tokenCount <= 2000) return 'complex';
  return 'complex'; // Very long prompts are complex, not critical (critical needs keyword signals)
}
