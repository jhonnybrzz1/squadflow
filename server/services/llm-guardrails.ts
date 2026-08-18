/**
 * LLM Security Guardrails
 *
 * Three-layer protection for LLM interactions:
 * 1. Prompt Injection Detection — blocks jailbreak/context extraction attacks
 * 2. PII Masking — masks CPF and email in input before LLM (never blocks)
 * 3. Semantic Injection Classifier — 2ª camada (shadow/enforce, atrás de flag)
 *
 * Spec 10015 US2: go-live pode pular APENAS a passada semântica em modo SHADOW
 * (telemetria não-bloqueante). Camadas 1 e 2, e o enforce da camada 3, NUNCA são
 * puladas — a decisão vem do `go-live-scope` lido pelo `demandId` do contexto.
 *
 * Design rules:
 * - All checks are sync/fast (<200ms total, regex-based)
 * - Fail-closed by default: if detector errors, block unless explicitly opted in
 * - PII is masked, never blocked
 * - Every action is logged with structured JSON
 * - LLM_GUARDRAILS_ENABLED env var controls on/off (default: true)
 */

import { createHash } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { dbHelper } from '../db';
import { guardrailDegradedTotal } from '../metrics';
import { recordAuditLoss } from './audit-loss-tracker';
import { logger } from '../utils/logger';
import { featureFlags } from './feature-flags';
import { classifyInjectionSemantic } from './semantic-injection-classifier';
import { isDemandGoLive } from './go-live-scope';

// ============================================
// Types
// ============================================

export type GuardrailType = 'prompt_injection' | 'pii_masking' | 'content_moderation';
export type GuardrailAction =
  | 'blocked'
  | 'masked'
  | 'masked_multiple'
  | 'allowed'
  | 'error'
  | 'error_blocked'
  /** Camada semântica em modo shadow: detectou, registrou, mas NÃO bloqueou. */
  | 'flagged';
export type InjectionConfidence = 'low' | 'medium' | 'high';

/**
 * Spec 012 (H-07/FR-008): distingue conteúdo aprovado de proteção indisponível.
 * `unavailable` NUNCA deve ser tratado como sinônimo de aprovação — a decisão
 * fica com a política do call-site (fail-closed para operações sensíveis).
 */
export type GuardrailVerdict = 'benign' | 'blocked' | 'unavailable';

export interface GuardrailResult {
  allowed: boolean;
  action: GuardrailAction;
  guardrailType: GuardrailType | null;
  reason: string | null;
  /** The (possibly masked) message to forward to the LLM */
  sanitizedContent: string;
  /** Details about what was detected */
  detections: string[];
  latencyMs: number;
  /** User-facing message when blocked */
  userMessage: string | null;
  /** Confidence level for prompt injection detection */
  confidence: InjectionConfidence | null;
  verdict: GuardrailVerdict;
}

export interface GuardrailLogEntry {
  id?: number;
  timestamp: number;
  guardrailType: GuardrailType;
  action: GuardrailAction;
  confidence: InjectionConfidence | null;
  reason: string | null;
  inputHash: string; // SHA256 of original input
  detections: string;
  latencyMs: number;
  userId?: string | null;
  demandId?: number | null;
  requestId?: string | null;
}

export interface GuardrailContext {
  userId?: string | null;
  demandId?: number | null;
  requestId?: string | null;
  /**
   * Spec 10064: rebaixa o BLOQUEIO de injection para SHADOW (registra na
   * auditoria, mas NÃO bloqueia) quando a entrada é DADO de autoria do próprio
   * usuário — ex.: o rascunho do botão "Reformular demanda", já delimitado como
   * dado no prompt (spotlighting). PII masking e fail-closed continuam ativos.
   * Só o call-site de autoria liga isto; todos os demais fluxos bloqueiam.
   */
  injectionShadow?: boolean;
  /**
   * Bug #10224: pula inteiramente a Camada 1 (regex de prompt injection) para
   * este conteúdo. Uso restrito a fluxos internos da squad que re-circulam
   * conteúdo já ingerido (descrição da demanda, PRD, histórico da mesa
   * redonda, tasks) — texto que pode legitimamente CITAR um exemplo de prompt
   * injection (ex.: doc anexado sobre testes de segurança) sem ser um ataque
   * real, e que em produto local/single-user (spec 012) não representa o
   * mesmo risco de um chat humano ao vivo. PII masking e fail-closed para
   * operações sensíveis continuam ativos sempre. NÃO usar para input humano
   * ao vivo (chat direto) nem para conteúdo obtido de fontes externas não
   * confiáveis (páginas web, repositórios de terceiros).
   */
  skipInjectionCheck?: boolean;
  /** Opt-in explícito para fluxos não sensíveis que podem seguir quando o guardrail falha. */
  failOpenOnError?: boolean;
  /** Operações sensíveis nunca aplicam fail-open enquanto a flag fail-closed estiver ativa. */
  sensitiveOperation?: boolean;
}

function canFailOpenOnGuardrailError(context: GuardrailContext): boolean {
  const failClosedEnabled = featureFlags.getFlags().guardrailsFailClosedSensitiveOps !== false;
  return (
    context.failOpenOnError === true && !(context.sensitiveOperation === true && failClosedEnabled)
  );
}

interface SafetyLogRow {
  id: number;
  timestamp: number;
  action: string;
  confidence: number | null;
  original_text_hash: string;
  user_id: string | null;
  demand_id: number | null;
  detections: string;
  latency_ms: number;
  guardrail_log_id: number | null;
}

// ============================================
// Configuration
// ============================================

function isGuardrailsEnabled(): boolean {
  const envVal = process.env.LLM_GUARDRAILS_ENABLED;
  if (envVal === undefined || envVal === '') return true;
  return envVal !== 'false' && envVal !== '0';
}

/**
 * Camada 2 (classificador semântico de injection). Off por padrão — rollout
 * conservador. Controlada por feature-flag para ligar/desligar sem deploy.
 */
function isSemanticClassifierEnabled(): boolean {
  return featureFlags.getFlags().semanticInjectionClassifierEnabled === true;
}

/**
 * C1: enforcement da camada 2. Quando ligado (E o classificador também), uma
 * detecção semântica passa a BLOQUEAR em vez de só registrar em shadow. Flag
 * separada de propósito: liga-se o classificador primeiro (shadow), calibra-se
 * o falso-positivo, e só então liga-se o enforce — sem novo deploy.
 */
function isSemanticEnforceEnabled(): boolean {
  return (
    featureFlags.getFlags().semanticInjectionEnforceEnabled === true &&
    isSemanticClassifierEnabled()
  );
}

// ============================================
// Prompt Injection Detection
// ============================================

interface InjectionPattern {
  id: string;
  pattern: RegExp;
  description: string;
  severity: 'critical' | 'high' | 'medium';
}

// Patterns are case-insensitive and handle common obfuscation
const INJECTION_PATTERNS: InjectionPattern[] = [
  // 1. Ignore previous instructions
  {
    id: 'ignore_instructions',
    pattern:
      /(?:ignore|disregard|forget|skip|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding|initial|original)\s+(?:instructions?|prompts?|rules?|commands?|directions?|guidelines?|context)/i,
    description: 'Attempts to override system instructions',
    severity: 'critical',
  },
  // 2. Role-play / persona hijack
  {
    id: 'roleplay_hijack',
    pattern:
      /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you(?:'re|\s+are))|role[- ]?play\s+(?:as|como)|behave\s+(?:as|like)|assume\s+(?:the\s+)?(?:role|identity|persona)\s+(?:of|de)|(?:finja|finge)\s+(?:ser|que\s+(?:é|voce)))\s+(?:an?\s+)?(?:admin|root|superuser|developer|hacker|jailbroken|unrestricted|DAN|evil|malicious)/i,
    description: 'Attempts to hijack AI persona/role',
    severity: 'critical',
  },
  // 3. System prompt extraction
  {
    id: 'system_prompt_extraction',
    pattern:
      /(?:reveal|show|display|print|output|repeat|echo|tell\s+me|what\s+(?:is|are)|give\s+me|share|expose|leak|dump)\s+(?:your\s+)?(?:system\s+prompt|initial\s+(?:prompt|instructions?)|hidden\s+(?:prompt|instructions?)|(?:secret|internal|private)\s+(?:instructions?|prompt|rules?|context)|instructions?\s+(?:you\s+were\s+given|above))/i,
    description: 'Attempts to extract system prompt',
    severity: 'critical',
  },
  // 4. Context/conversation manipulation
  {
    id: 'context_manipulation',
    pattern:
      /(?:new\s+conversation\s*[.,]?\s*(?:from\s+now|you\s+(?:are|will|must|should)|ignore|disregard))|(?:reset\s+(?:your\s+)?(?:context|memory|conversation))|(?:clear\s+(?:your\s+)?(?:context|memory|history))|(?:(?:from\s+now\s+on|starting\s+now),?\s+(?:you\s+(?:are|will|must|should)|ignore|disregard))|(?:end\s+(?:of\s+)?system\s+(?:prompt|message))/i,
    description: 'Attempts to manipulate conversation context',
    severity: 'high',
  },
  // 5. Jailbreak DAN-style
  {
    id: 'jailbreak_dan',
    pattern:
      /(?:DAN\s+mode|do\s+anything\s+now|jailbreak(?:ed)?|(?:un)?restricted\s+mode|developer\s+mode\s+(?:enabled|on|activated)|DUDE\s+mode|maximum\s+mode|sigma\s+mode|token\s+threat|opposite\s+mode)/i,
    description: 'Known jailbreak technique (DAN/DUDE/etc.)',
    severity: 'critical',
  },
  // 6. Portuguese variants
  {
    id: 'injection_pt',
    pattern:
      /(?:ignore|desconsidere|esqueça)\s+(?:todas?\s+)?(?:as\s+)?(?:instruções?\s+)?(?:anteriores?|iniciais?|acima|prévias?)|(?:revele?|mostre?|exiba|imprima)\s+(?:o\s+)?(?:seu\s+)?(?:prompt\s+(?:do\s+)?sistema|instruções?\s+(?:iniciais?|ocultas?|secretas?))|(?:a\s+partir\s+de\s+agora|de\s+agora\s+em\s+diante)\s*[,.]?\s*(?:você|voce|vc)\s+(?:é|eh|será|sera)\s/i,
    description: 'Prompt injection in Portuguese',
    severity: 'critical',
  },
  // 7. Markdown/delimiter injection
  {
    id: 'delimiter_injection',
    pattern:
      /(?:```(?:system|instructions?|prompt)[\s\S]*?```|<\/?(?:system|instructions?|prompt|im_(?:start|end))>|\[INST\]|\[\/INST\]|<<SYS>>|<\|(?:im_start|im_end|system|endoftext)\|>)/i,
    description: 'Delimiter/markup injection to manipulate message boundaries',
    severity: 'high',
  },
  // 8. Encoded injection (URL encoding detection)
  {
    id: 'encoded_injection',
    pattern: /(?:%69%67%6[eE]%6[fF]%72%65|%73%79%73%74%65%6[dD]|%70%72%6[fF]%6[dD]%70%74)/i,
    description: 'URL-encoded injection attempt (ignore/system/prompt)',
    severity: 'high',
  },
];

/**
 * Compute injection confidence based on match count and severity.
 * - 0 matches → low
 * - 1 match → medium
 * - 2+ matches → high
 * Additionally, any critical severity match bumps to at least medium.
 */
function computeInjectionConfidence(
  matchedIds: string[],
  severities: Array<'critical' | 'high' | 'medium'>,
): InjectionConfidence {
  if (matchedIds.length === 0) return 'low';
  if (matchedIds.length >= 2) return 'high';
  // 1 match: check severity
  if (severities.some((s) => s === 'critical')) return 'high';
  return 'medium';
}

/**
 * Detect prompt injection in user input.
 * Returns detection result with matched patterns and confidence level.
 */
export function detectPromptInjection(input: string): {
  detected: boolean;
  patterns: string[];
  reasons: string[];
  confidence: InjectionConfidence;
} {
  // Normalize: decode URL encoding, collapse whitespace
  let normalized: string;
  try {
    normalized = decodeURIComponent(input).replace(/\s+/g, ' ').trim();
  } catch (_) {
    normalized = input.replace(/\s+/g, ' ').trim();
  }

  const matched: string[] = [];
  const reasons: string[] = [];
  const severities: Array<'critical' | 'high' | 'medium'> = [];

  for (const { id, pattern, description, severity } of INJECTION_PATTERNS) {
    if (id === 'encoded_injection') {
      // Check raw input for encoded patterns (before decoding)
      if (pattern.test(input)) {
        matched.push(id);
        reasons.push(description);
        severities.push(severity);
      }
    } else if (pattern.test(normalized)) {
      matched.push(id);
      reasons.push(description);
      severities.push(severity);
    }
  }

  const confidence = computeInjectionConfidence(matched, severities);

  return {
    detected: matched.length > 0,
    patterns: matched,
    reasons,
    confidence,
  };
}

// ============================================
// PII Masking
// ============================================

interface PiiMaskResult {
  masked: boolean;
  maskedContent: string;
  detections: string[];
  count: number;
}

// Email
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Credit card: 4 groups of 4 digits separated by spaces or dashes
const CREDIT_CARD_PATTERN = /\b(\d{4})[- ]?(\d{4})[- ]?(\d{4})[- ]?(\d{4})\b/g;

// Date of birth: dd/mm/yyyy
const DATE_OF_BIRTH_PATTERN = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;

/**
 * Mask PII in input text.
 * CPF: keeps last 5 chars visible (XXX.XXX.789-00)
 * Email: masks local part (a***@domain.com)
 * Credit card: masks middle digits (1234 **** **** 5678)
 * CEP: masks fully ([REDACTED])
 * Date of birth: masks fully ([REDACTED])
 */
export function maskPii(input: string): PiiMaskResult {
  let content = input;
  const detections: string[] = [];
  let count = 0;

  // Mask credit card first (before CPF to avoid partial overlap on 16-digit sequences)
  content = content.replace(CREDIT_CARD_PATTERN, (_match, g1, _g2, _g3, g4) => {
    count++;
    detections.push('credit_card');
    return `${g1} **** **** ${g4}`;
  });

  // Mask CPF (formatted: ###.###.###-##)
  content = content.replace(
    /\b(\d{3})\.(\d{3})\.(\d{3})-(\d{2})\b/g,
    (_match, _g1, _g2, g3, g4) => {
      count++;
      detections.push('cpf_formatted');
      return `XXX.XXX.${g3}-${g4}`;
    },
  );

  // Mask CPF (unformatted: 11 consecutive digits that could be CPF)
  // Only match standalone 11-digit sequences not already masked
  content = content.replace(/\b(\d{11})\b/g, (match) => {
    // Validate as potential CPF (not all same digit)
    if (/^(\d)\1{10}$/.test(match)) return match; // All same digits, not a CPF
    count++;
    detections.push('cpf_unformatted');
    return `XXXXX${match.slice(5, 8)}${match.slice(8)}`;
  });

  // Mask email
  content = content.replace(EMAIL_PATTERN, (match) => {
    count++;
    detections.push('email');
    const [local, domain] = match.split('@');
    const maskedLocal = local.length <= 2 ? '*'.repeat(local.length) : local[0] + '***';
    return `${maskedLocal}@${domain}`;
  });

  // Mask date of birth (dd/mm/yyyy)
  content = content.replace(DATE_OF_BIRTH_PATTERN, (_match, dd, mm, yyyy) => {
    // Validate as plausible date: day 01-31, month 01-12, year 1900-2099
    const day = parseInt(dd, 10);
    const month = parseInt(mm, 10);
    const year = parseInt(yyyy, 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2099) {
      count++;
      detections.push('date_of_birth');
      return '[REDACTED]';
    }
    return _match; // Not a plausible date, leave as-is
  });

  // Mask CEP (Brazilian postal code: #####-### or ########)
  // Only match 8-digit sequences with optional dash in CEP-like context
  content = content.replace(/\b(\d{5})-(\d{3})\b/g, () => {
    count++;
    detections.push('cep');
    return '[REDACTED]';
  });

  return {
    masked: count > 0,
    maskedContent: content,
    detections,
    count,
  };
}

// ============================================
// Guardrail Log Storage
// ============================================

class GuardrailLogStore {
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS guardrail_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          guardrail_type TEXT NOT NULL,
          action TEXT NOT NULL,
          confidence TEXT,
          reason TEXT,
          input_hash TEXT NOT NULL,
          detections TEXT NOT NULL DEFAULT '[]',
          latency_ms INTEGER NOT NULL DEFAULT 0,
          user_id TEXT,
          demand_id INTEGER,
          request_id TEXT
        )
      `);
      await dbHelper.run(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS idx_guardrail_logs_timestamp ON guardrail_logs(timestamp)',
        ),
      );
      await dbHelper.run(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS idx_guardrail_logs_type ON guardrail_logs(guardrail_type)',
        ),
      );
      await dbHelper.run(
        sql.raw('CREATE INDEX IF NOT EXISTS idx_guardrail_logs_action ON guardrail_logs(action)'),
      );
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create guardrail_logs table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async log(entry: GuardrailLogEntry): Promise<void> {
    try {
      await this.ensureTable();
      if (!this.tableReady) return;

      await dbHelper.run(sql`
        INSERT INTO guardrail_logs (
          timestamp, guardrail_type, action, confidence, reason, input_hash, detections,
          latency_ms, user_id, demand_id, request_id
        ) VALUES (
          ${entry.timestamp},
          ${entry.guardrailType},
          ${entry.action},
          ${entry.confidence ?? null},
          ${entry.reason ?? null},
          ${entry.inputHash},
          ${entry.detections},
          ${entry.latencyMs},
          ${entry.userId ?? null},
          ${entry.demandId ?? null},
          ${entry.requestId ?? null}
        )
      `);
    } catch (error) {
      logger.warn('Failed to write guardrail log', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async query(
    filters: {
      startDate?: string;
      endDate?: string;
      guardrailType?: GuardrailType;
      action?: GuardrailAction;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ logs: GuardrailLogEntry[]; total: number }> {
    await this.ensureTable();

    const limit = Math.min(filters.limit ?? 100, 1000);
    const offset = filters.offset ?? 0;

    // Parametrizado via sql`` — filtros vêm de query params HTTP e precisam
    // ser bind params reais, não texto interpolado na query (ver mesma
    // correção em llm-audit-log.ts).
    const conditions: SQL[] = [];
    if (filters.startDate) {
      const epoch = Math.floor(new Date(filters.startDate).getTime() / 1000);
      conditions.push(sql`timestamp >= ${epoch}`);
    }
    if (filters.endDate) {
      const epoch = Math.floor(new Date(filters.endDate).getTime() / 1000);
      conditions.push(sql`timestamp <= ${epoch}`);
    }
    if (filters.guardrailType) {
      conditions.push(sql`guardrail_type = ${filters.guardrailType}`);
    }
    if (filters.action) {
      conditions.push(sql`action = ${filters.action}`);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    const countResult = await dbHelper.get<{ cnt: number }>(
      sql`SELECT COUNT(*) as cnt FROM guardrail_logs ${whereClause}`,
    );
    const total = countResult?.cnt ?? 0;

    const rows = await dbHelper.all<any>(
      sql`SELECT * FROM guardrail_logs ${whereClause} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
    );

    return {
      logs: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        guardrailType: r.guardrail_type,
        action: r.action,
        confidence: r.confidence ?? null,
        reason: r.reason,
        inputHash: r.input_hash,
        detections: r.detections,
        latencyMs: r.latency_ms,
        userId: r.user_id,
        demandId: r.demand_id,
        requestId: r.request_id,
      })),
      total,
    };
  }

  async getStats(hours: number = 24): Promise<{
    total: number;
    blocked: number;
    masked: number;
    allowed: number;
    errors: number;
    byType: Record<string, number>;
  }> {
    await this.ensureTable();

    const since = Math.floor(Date.now() / 1000) - hours * 3600;

    const stats = await dbHelper.all<{ action: string; guardrail_type: string; cnt: number }>(
      sql`
        SELECT action, guardrail_type, COUNT(*) as cnt
        FROM guardrail_logs
        WHERE timestamp >= ${since}
        GROUP BY action, guardrail_type
      `,
    );

    let total = 0,
      blocked = 0,
      masked = 0,
      allowed = 0,
      errors = 0;
    const byType: Record<string, number> = {};

    for (const row of stats || []) {
      const count = row.cnt;
      total += count;
      if (row.action === 'blocked') blocked += count;
      else if (row.action === 'masked' || row.action === 'masked_multiple') masked += count;
      else if (row.action === 'allowed') allowed += count;
      else if (row.action === 'error') errors += count;

      byType[row.guardrail_type] = (byType[row.guardrail_type] || 0) + count;
    }

    return { total, blocked, masked, allowed, errors, byType };
  }
}

export const guardrailLogStore = new GuardrailLogStore();

// ============================================
// Safety Log Store (audit table for /api/safety/logs)
// ============================================

export type SafetyAction =
  | 'PII_REDACTED'
  | 'PROMPT_INJECTION_DETECTED'
  /** Camada de padrões em modo shadow (autoria, 10064): registrada sem bloqueio. */
  | 'PROMPT_INJECTION_SHADOW'
  /**
   * Bug #10224: Camada 1 pulada por `skipInjectionCheck` (fluxo interno da
   * squad) — nenhuma detecção rodou para este conteúdo.
   */
  | 'PROMPT_INJECTION_CHECK_SKIPPED'
  /** Camada semântica (shadow): suspeita registrada sem bloqueio. */
  | 'PROMPT_INJECTION_FLAGGED'
  /** Camada semântica (enforce, C1): suspeita que de fato bloqueou. */
  | 'PROMPT_INJECTION_BLOCKED';

export interface SafetyLogEntry {
  id?: number;
  timestamp: number;
  action: SafetyAction;
  confidence: InjectionConfidence;
  originalTextHash: string | null;
  userId: string | null;
  demandId: number | null;
  detections: string;
  latencyMs: number;
  guardrailLogId?: number | null;
}

class SafetyLogStore {
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS safety_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          action TEXT NOT NULL,
          confidence TEXT NOT NULL,
          original_text_hash TEXT,
          user_id TEXT,
          demand_id INTEGER,
          detections TEXT NOT NULL DEFAULT '[]',
          latency_ms INTEGER NOT NULL DEFAULT 0,
          guardrail_log_id INTEGER
        )
      `);
      await dbHelper.run(
        sql.raw('CREATE INDEX IF NOT EXISTS idx_safety_logs_timestamp ON safety_logs(timestamp)'),
      );
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create safety_logs table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async log(entry: SafetyLogEntry): Promise<void> {
    try {
      await this.ensureTable();
      if (!this.tableReady) return;

      await dbHelper.run(sql`
        INSERT INTO safety_logs (
          timestamp, action, confidence, original_text_hash, user_id,
          demand_id, detections, latency_ms, guardrail_log_id
        ) VALUES (
          ${entry.timestamp},
          ${entry.action},
          ${entry.confidence},
          ${entry.originalTextHash ?? null},
          ${entry.userId ?? null},
          ${entry.demandId ?? null},
          ${entry.detections},
          ${entry.latencyMs},
          ${entry.guardrailLogId ?? null}
        )
      `);
    } catch (error) {
      logger.warn('Failed to write safety log', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async query(limit: number = 100): Promise<SafetyLogEntry[]> {
    await this.ensureTable();
    const rows = await dbHelper.all<SafetyLogRow>(
      sql`SELECT * FROM safety_logs ORDER BY timestamp DESC LIMIT ${Math.min(limit, 100)}`,
    );
    return (rows || []).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      action: r.action as SafetyAction,
      confidence: r.confidence as unknown as InjectionConfidence,
      originalTextHash: r.original_text_hash,
      userId: r.user_id,
      demandId: r.demand_id,
      detections: r.detections,
      latencyMs: r.latency_ms,
      guardrailLogId: r.guardrail_log_id,
    }));
  }
}

export const safetyLogStore = new SafetyLogStore();

// ============================================
// Main Guardrail Pipeline
// ============================================

/**
 * Run all guardrails on user input.
 * Order: injection detection → PII masking
 * If injection detected: block and return user-facing message.
 * If PII found: mask and forward.
 * On error: fail-closed by default. `failOpenOnError` is explicit opt-in for
 * non-sensitive flows and is logged as degraded.
 */
export function runGuardrails(input: string, context: GuardrailContext = {}): GuardrailResult {
  if (!isGuardrailsEnabled()) {
    return {
      allowed: true,
      action: 'allowed',
      guardrailType: null,
      reason: null,
      sanitizedContent: input,
      detections: [],
      latencyMs: 0,
      userMessage: null,
      confidence: null,
      verdict: 'benign',
    };
  }

  const startedAt = Date.now();
  const inputHash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  const skipInjectionCheck = context.skipInjectionCheck === true;

  try {
    // Layer 1: Prompt Injection Detection
    // Bug #10224: pulada inteiramente para fluxos internos da squad que
    // re-circulam conteúdo já ingerido (ver doc de `skipInjectionCheck`).
    // Ainda assim registrado em auditoria para visibilidade.
    const injectionResult = skipInjectionCheck
      ? { detected: false, patterns: [], reasons: [], confidence: 'low' as InjectionConfidence }
      : detectPromptInjection(input);

    if (skipInjectionCheck) {
      const now = Math.floor(Date.now() / 1000);
      safetyLogStore
        .log({
          timestamp: now,
          action: 'PROMPT_INJECTION_CHECK_SKIPPED',
          confidence: 'low',
          originalTextHash: inputHash,
          userId: context.userId ?? null,
          demandId: context.demandId ?? null,
          detections: '[]',
          latencyMs: 0,
        })
        .catch((error) => recordAuditLoss('safety_log', error));
    }

    if (injectionResult.detected) {
      const latencyMs = Date.now() - startedAt;
      // Spec 10064: em modo shadow, a detecção é REGISTRADA mas NÃO bloqueia —
      // a entrada é dado de autoria do próprio usuário (ex.: rascunho do botão
      // Reformular). O caminho cai no mascaramento de PII abaixo (não retorna).
      const shadow = context.injectionShadow === true;
      const now = Math.floor(Date.now() / 1000);
      const reason = injectionResult.reasons.join('; ');

      // Fire-and-forget log (auditoria: 'flagged' em shadow, 'blocked' caso contrário)
      guardrailLogStore
        .log({
          timestamp: now,
          guardrailType: 'prompt_injection',
          action: shadow ? 'flagged' : 'blocked',
          confidence: injectionResult.confidence,
          reason: shadow ? `shadow(authoring): ${reason}` : reason,
          inputHash,
          detections: JSON.stringify(injectionResult.patterns),
          latencyMs,
          userId: context.userId,
          demandId: context.demandId,
          requestId: context.requestId,
        })
        .catch((error) => recordAuditLoss('guardrail_log', error));

      // Safety audit log
      safetyLogStore
        .log({
          timestamp: now,
          action: shadow ? 'PROMPT_INJECTION_SHADOW' : 'PROMPT_INJECTION_DETECTED',
          confidence: injectionResult.confidence,
          originalTextHash: inputHash,
          userId: context.userId ?? null,
          demandId: context.demandId ?? null,
          detections: JSON.stringify(injectionResult.patterns),
          latencyMs,
        })
        .catch((error) => recordAuditLoss('safety_log', error));

      if (!shadow) {
        return {
          allowed: false,
          action: 'blocked',
          guardrailType: 'prompt_injection',
          reason,
          sanitizedContent: '',
          detections: injectionResult.patterns,
          latencyMs,
          userMessage:
            'Sua mensagem não pôde ser processada porque parece tentar alterar o comportamento do assistente. Reformule sua pergunta.',
          confidence: injectionResult.confidence,
          verdict: 'blocked',
        };
      }
      // shadow: segue para a Camada 2 (PII), tratando o rascunho como dado.
    }

    // Layer 2: PII Masking (sempre roda, inclusive quando a Camada 1 foi pulada)
    const piiResult = maskPii(input);
    const latencyMs = Date.now() - startedAt;

    if (piiResult.masked) {
      const action: GuardrailAction = piiResult.count > 1 ? 'masked_multiple' : 'masked';
      const result: GuardrailResult = {
        allowed: true,
        action,
        guardrailType: 'pii_masking',
        reason: `Masked ${piiResult.count} PII occurrence(s): ${piiResult.detections.join(', ')}`,
        sanitizedContent: piiResult.maskedContent,
        detections: piiResult.detections,
        latencyMs,
        userMessage: null, // PII masking is silent
        confidence: 'high', // PII detection is always high confidence
        verdict: 'benign',
      };

      const piiNow = Math.floor(Date.now() / 1000);
      guardrailLogStore
        .log({
          timestamp: piiNow,
          guardrailType: 'pii_masking',
          action,
          confidence: 'high',
          reason: result.reason,
          inputHash,
          detections: JSON.stringify(piiResult.detections),
          latencyMs,
          userId: context.userId,
          demandId: context.demandId,
          requestId: context.requestId,
        })
        .catch((error) => recordAuditLoss('guardrail_log', error));

      // Safety audit log
      safetyLogStore
        .log({
          timestamp: piiNow,
          action: 'PII_REDACTED',
          confidence: 'high',
          originalTextHash: inputHash,
          userId: context.userId ?? null,
          demandId: context.demandId ?? null,
          detections: JSON.stringify(piiResult.detections),
          latencyMs,
        })
        .catch((error) => recordAuditLoss('safety_log', error));

      return result;
    }

    // All clear
    return {
      allowed: true,
      action: 'allowed',
      guardrailType: null,
      reason: null,
      sanitizedContent: input,
      detections: [],
      latencyMs,
      userMessage: null,
      confidence: null,
      verdict: 'benign',
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const failOpenAllowed = canFailOpenOnGuardrailError(context);
    const action: GuardrailAction = failOpenAllowed ? 'error' : 'error_blocked';
    const mode = failOpenAllowed ? 'fail_open_logged' : 'fail_closed';

    markGuardrailDegraded(error instanceof Error ? error.message : 'sync_pipeline_error');
    guardrailDegradedTotal.inc({ mode });

    logger.error(
      `Guardrail pipeline error — ${failOpenAllowed ? 'failing open' : 'failing closed'}`,
      {
        error: error instanceof Error ? error : undefined,
        context: { mode, sensitiveOperation: context.sensitiveOperation === true },
      },
    );

    guardrailLogStore
      .log({
        timestamp: Math.floor(Date.now() / 1000),
        guardrailType: 'prompt_injection',
        action,
        confidence: null,
        reason: error instanceof Error ? error.message : 'Unknown error',
        inputHash,
        detections: '[]',
        latencyMs,
        userId: context.userId,
        demandId: context.demandId,
        requestId: context.requestId,
      })
      .catch((error) => recordAuditLoss('guardrail_log', error));

    return {
      allowed: failOpenAllowed,
      action,
      guardrailType: null,
      reason: 'Guardrail pipeline unavailable',
      sanitizedContent: failOpenAllowed ? input : '',
      detections: [],
      latencyMs,
      userMessage: failOpenAllowed ? null : GUARDRAIL_UNAVAILABLE_MESSAGE,
      confidence: null,
      verdict: 'unavailable',
    };
  }
}

/**
 * Run guardrails on an array of chat messages.
 * Only processes 'user' role messages.
 * Returns processed messages + aggregate result.
 */
export function runGuardrailsOnMessages(
  messages: Array<{ role: string; content: string; name?: string }>,
  context: GuardrailContext = {},
): {
  messages: Array<{ role: string; content: string; name?: string }>;
  blocked: boolean;
  blockReason: string | null;
  userMessage: string | null;
  totalDetections: string[];
  totalLatencyMs: number;
  verdict: GuardrailVerdict;
} {
  let blocked = false;
  let blockReason: string | null = null;
  let userMessage: string | null = null;
  const totalDetections: string[] = [];
  let totalLatencyMs = 0;
  let verdict: GuardrailVerdict = 'benign';

  const processedMessages = messages.map((msg) => {
    if (msg.role !== 'user' || blocked) return msg;

    const result = runGuardrails(msg.content, context);
    totalLatencyMs += result.latencyMs;
    totalDetections.push(...result.detections);
    // Agregação: blocked > unavailable > benign.
    if (result.verdict === 'unavailable' && verdict === 'benign') {
      verdict = 'unavailable';
    }

    if (!result.allowed || result.verdict === 'unavailable') {
      blocked = true;
      blockReason = result.reason;
      userMessage = result.userMessage;
      verdict = result.verdict === 'unavailable' ? 'unavailable' : 'blocked';
      return msg; // Won't be used since blocked=true
    }

    return { ...msg, content: result.sanitizedContent };
  });

  return {
    messages: processedMessages,
    blocked,
    blockReason,
    userMessage,
    totalDetections,
    totalLatencyMs,
    verdict,
  };
}

// ============================================
// Async Pipeline — Camada 2 (Classificador Semântico, modo shadow)
// ============================================

export interface AsyncGuardrailResult {
  messages: Array<{ role: string; content: string; name?: string }>;
  blocked: boolean;
  blockReason: string | null;
  userMessage: string | null;
  totalDetections: string[];
  totalLatencyMs: number;
  /** Camada semântica suspeitou de injection (shadow: NÃO bloqueia). */
  semanticFlagged: boolean;
  /**
   * Spec 10015 US2: a passada semântica em modo SHADOW (telemetria, não-bloqueante)
   * foi pulada por go-live. NUNCA reflete skip de regex/PII/enforce (esses sempre rodam).
   */
  contentGuardrailsSkipped: boolean;
  verdict: GuardrailVerdict;
}

// ============================================
// Spec 012 (H-07): estado de degradação observável
// ============================================

interface GuardrailHealthState {
  degraded: boolean;
  since: number | null;
  lastReason: string | null;
}

const guardrailHealthState: GuardrailHealthState = {
  degraded: false,
  since: null,
  lastReason: null,
};

function markGuardrailDegraded(reason: string): void {
  if (!guardrailHealthState.degraded) {
    guardrailHealthState.since = Date.now();
  }
  guardrailHealthState.degraded = true;
  guardrailHealthState.lastReason = reason;
}

function markGuardrailHealthy(): void {
  guardrailHealthState.degraded = false;
  guardrailHealthState.since = null;
  guardrailHealthState.lastReason = null;
}

/** Consumido pelo health-check (`/api/health`, subsistema `guardrails`). */
export function getGuardrailHealthState(): Readonly<GuardrailHealthState> {
  return guardrailHealthState;
}

/** Reset interno (testes). */
export function resetGuardrailHealthState(): void {
  markGuardrailHealthy();
}

/**
 * Política fail-closed (FR-009): decide se uma operação pode prosseguir
 * quando o verdito é `unavailable`. Operações sensíveis (execução de tools
 * ou marcadas pelo call-site) são bloqueadas quando a flag está ligada.
 * Retorna `true` quando a operação deve ser BLOQUEADA.
 */
export function shouldFailClosed(verdict: GuardrailVerdict, sensitiveOperation: boolean): boolean {
  if (verdict !== 'unavailable') return false;
  const failClosedEnabled = featureFlags.getFlags().guardrailsFailClosedSensitiveOps !== false;
  const mode = sensitiveOperation && failClosedEnabled ? 'fail_closed' : 'fail_open_logged';
  guardrailDegradedTotal.inc({ mode });
  logger.warn('Guardrail indisponível — política de degradação aplicada', {
    context: { mode, sensitiveOperation },
  });
  return mode === 'fail_closed';
}

export const GUARDRAIL_UNAVAILABLE_MESSAGE =
  'A proteção de segurança está temporariamente indisponível. Operações sensíveis foram bloqueadas por precaução; tente novamente em instantes.';

/**
 * Registra (fire-and-forget) uma detecção semântica em modo shadow.
 * Não bloqueia — apenas alimenta guardrail_logs / safety_logs para medir
 * precisão antes de um eventual enforcement.
 */
function logSemanticDetection(
  content: string,
  detection: { confidence: InjectionConfidence; reason: string; latencyMs: number },
  context: GuardrailContext,
  enforced = false,
): void {
  const inputHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const now = Math.floor(Date.now() / 1000);
  const detections = JSON.stringify(['semantic_injection']);
  const mode = enforced ? 'enforce' : 'shadow';

  guardrailLogStore
    .log({
      timestamp: now,
      guardrailType: 'prompt_injection',
      action: enforced ? 'blocked' : 'flagged',
      confidence: detection.confidence,
      reason: `semantic(${mode}): ${detection.reason}`,
      inputHash,
      detections,
      latencyMs: detection.latencyMs,
      userId: context.userId,
      demandId: context.demandId,
      requestId: context.requestId,
    })
    .catch((error) => recordAuditLoss('guardrail_log', error));

  safetyLogStore
    .log({
      timestamp: now,
      action: enforced ? 'PROMPT_INJECTION_BLOCKED' : 'PROMPT_INJECTION_FLAGGED',
      confidence: detection.confidence,
      originalTextHash: inputHash,
      userId: context.userId ?? null,
      demandId: context.demandId ?? null,
      detections,
      latencyMs: detection.latencyMs,
    })
    .catch((error) => recordAuditLoss('safety_log', error));
}

/**
 * Versão assíncrona de `runGuardrailsOnMessages` com a 2ª camada de defesa.
 *
 * Ordem (defesa em profundidade):
 *   1. Regex/PII síncrono (`runGuardrailsOnMessages`). Se BLOQUEIA aqui, o
 *      classificador semântico NEM roda (economia de latência/custo).
 *   2. Classificador semântico — roda só para mensagens de usuário que passaram
 *      no regex. Modo SHADOW: detecções são registradas, mas não bloqueiam.
 *
 * Fail-open por toda parte: se o classificador indisponível/erro/timeout, o
 * resultado é idêntico ao do pipeline síncrono.
 */
export async function runGuardrailsOnMessagesAsync(
  messages: Array<{ role: string; content: string; name?: string }>,
  context: GuardrailContext = {},
): Promise<AsyncGuardrailResult> {
  const base = runGuardrailsOnMessages(messages, context);
  if (base.verdict === 'unavailable') {
    markGuardrailDegraded('sync_pipeline_error');
  }

  const enforce = isSemanticEnforceEnabled();

  // Spec 10015 US2: em go-live, pula APENAS a passada semântica em modo SHADOW —
  // que é telemetria de precisão (loga, NÃO bloqueia). Guardas de segurança:
  //   • `base` (regex de injection + PII) JÁ rodou incondicionalmente acima; se
  //     bloqueou, `base.blocked` é true e o skip nem é considerado.
  //   • `!enforce`: quando o classificador está ENFORCE (proteção ativa que
  //     bloqueia), ele NUNCA é pulado, mesmo em go-live.
  //   • só faz sentido "pular" quando a passada de fato existiria: classificador
  //     ligado e em shadow. Off ⇒ nada a pular (não loga skip enganoso).
  const contentGuardrailsSkippable =
    isGuardrailsEnabled() && isSemanticClassifierEnabled() && !enforce;
  const skipContentGuardrails =
    contentGuardrailsSkippable && !base.blocked && isDemandGoLive(context.demandId);

  if (skipContentGuardrails) {
    logger.info('Go-live: etapa não crítica pulada (guardrails de conteúdo shadow)', {
      context: {
        demandId: context.demandId,
        goLiveMode: true,
        skippedStages: ['content_guardrails'],
      },
    });
  }

  // Pula a camada semântica se: bloqueado pelo regex, guardrails off, flag off,
  // ou go-live pulou a telemetria shadow.
  if (
    base.blocked ||
    !isGuardrailsEnabled() ||
    !isSemanticClassifierEnabled() ||
    skipContentGuardrails
  ) {
    return { ...base, semanticFlagged: false, contentGuardrailsSkipped: skipContentGuardrails };
  }

  let semanticFlagged = false;
  let extraLatency = 0;
  let semanticUnavailable = false;
  let enforcedBlock: { reason: string } | null = null;

  for (const msg of base.messages) {
    if (msg.role !== 'user') continue;
    // Bug #10224: mesmo escopo de skip da Camada 1 — fluxos internos da squad
    // não passam pelo classificador semântico de injection.
    if (context.skipInjectionCheck === true) continue;
    const detection = await classifyInjectionSemantic(msg.content);
    extraLatency += detection.latencyMs;

    // FR-008: 'classificador indisponível' é diferente de 'conteúdo benigno'.
    if (!detection.available) {
      semanticUnavailable = true;
      markGuardrailDegraded('semantic_classifier_unavailable');
    } else if (!semanticUnavailable) {
      markGuardrailHealthy();
    }

    if (detection.available && detection.injection) {
      semanticFlagged = true;
      base.totalDetections.push('semantic_injection');
      logSemanticDetection(msg.content, detection, context, enforce);
      logger.warn(
        `Semantic guardrail (${enforce ? 'enforce' : 'shadow'}) detectou possível prompt injection`,
        {
          context: {
            requestId: context.requestId,
            demandId: context.demandId,
            confidence: detection.confidence,
            reason: detection.reason,
          },
        },
      );

      // C1 enforce: a primeira detecção bloqueia. Em shadow segue só registrando.
      if (enforce) {
        enforcedBlock = { reason: detection.reason };
        break;
      }
    }
  }

  if (enforcedBlock) {
    return {
      ...base,
      blocked: true,
      blockReason: `semantic_injection: ${enforcedBlock.reason}`,
      userMessage:
        'Sua mensagem não pôde ser processada porque parece tentar alterar o comportamento do assistente. Reformule sua pergunta.',
      totalLatencyMs: base.totalLatencyMs + extraLatency,
      semanticFlagged,
      contentGuardrailsSkipped: false,
      verdict: 'blocked',
    };
  }

  if (semanticUnavailable && !canFailOpenOnGuardrailError(context)) {
    guardrailDegradedTotal.inc({ mode: 'fail_closed' });
    return {
      ...base,
      blocked: true,
      blockReason: 'Guardrail pipeline unavailable',
      userMessage: GUARDRAIL_UNAVAILABLE_MESSAGE,
      totalLatencyMs: base.totalLatencyMs + extraLatency,
      semanticFlagged,
      contentGuardrailsSkipped: false,
      verdict: 'unavailable',
    };
  }

  if (semanticUnavailable) {
    guardrailDegradedTotal.inc({ mode: 'fail_open_logged' });
    logger.warn('Guardrail semântico indisponível — fail-open explícito aplicado', {
      context: { demandId: context.demandId, requestId: context.requestId },
    });
  }

  return {
    ...base,
    totalLatencyMs: base.totalLatencyMs + extraLatency,
    semanticFlagged,
    contentGuardrailsSkipped: false,
    verdict: semanticUnavailable ? 'unavailable' : base.verdict,
  };
}
