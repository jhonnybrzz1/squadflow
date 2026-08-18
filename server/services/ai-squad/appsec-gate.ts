/**
 * Spec 10176 — Gate AppSec real para demandas de security e infraestrutura.
 *
 * Roda sobre o prompt final pós-assembler (internalContext) ANTES da consolidação.
 * Retorna `passed` quando não detecta riscos, `blocked` quando detecta segredos
 * hardcoded ou padrões de injeção, e `skipped` quando `requireAppSecReview` é false.
 */

import { logger } from '../../utils/logger';

export type AppSecGateStatus = 'passed' | 'blocked' | 'skipped';

export interface AppSecGateCheck {
  name: string;
  status: 'passed' | 'blocked';
  details?: string;
}

export interface AppSecGateResult {
  status: AppSecGateStatus;
  checks: AppSecGateCheck[];
  reason?: string;
  demandId: number;
  timestamp: string;
}

export interface AppSecGateInput {
  demandId: number;
  requireAppSecReview: boolean;
  promptText: string;
  agentOrder?: string[];
}

// Patterns simples e conservadores: detectam strings suspeitas no prompt final.
const SECRET_PATTERNS = [
  { name: 'api_key', regex: /(?:api[_\s-]?key|apikey)\s*[:=]\s*['"`][a-zA-Z0-9_\-]{16,}['"`]/i },
  { name: 'password_plain', regex: /password\s*[:=]\s*['"`][^'"`\n]{4,}['"`]/i },
  { name: 'token_bearer', regex: /bearer\s+[a-zA-Z0-9_\-\.]{20,}/i },
  { name: 'private_key', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i },
];

const INJECTION_PATTERNS = [
  {
    name: 'sqli',
    // As alternativas soltas `--`, `/*` e `';` bloqueavam qualquer texto em
    // prosa e mataram o refinamento da demanda #10318: casaram o separador
    // markdown `---` que o PRÓPRIO template "Contrato Inteligente de Início"
    // injeta na descrição, e a flag `npm run db:migrate -- --dry-run` citada
    // no chat. Um gate que bloqueia o texto que ele mesmo gera é ruído puro.
    //
    // Agora todo padrão exige contexto de SQL: DML com FROM, tautologia após
    // aspas, aspas seguida de comentário (o clássico `' --`), query empilhada
    // e UNION SELECT.
    regex: new RegExp(
      [
        // SELECT ... FROM, INSERT ... FROM, etc.
        /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE)\s+[\w\s*_,()]+\s+FROM\b/.source,
        // ' OR 1=1 / " AND '2'='2
        /['"]\s*(?:OR|AND)\s+['"]?\w+['"]?\s*=\s*['"]?\w+/.source,
        // ' --   ' #   ' /*  (aspas fechando string seguida de comentário)
        /['"]\s*(?:--|#|\/\*)/.source,
        // ; DROP TABLE ...  (stacked query)
        /;\s*(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE)\s+\w/.source,
        // UNION SELECT / UNION ALL SELECT
        /\bUNION\s+(?:ALL\s+)?SELECT\b/.source,
      ].join('|'),
      'i',
    ),
  },
  {
    name: 'prompt_injection',
    regex:
      /(ignore\s+(previous|above|instructions)|you\s+are\s+now|new\s+instruction\s*:|system\s*:\s*override|disregard\s+all)/i,
  },
];

function runPatternChecks(
  text: string,
  patterns: { name: string; regex: RegExp }[],
): AppSecGateCheck[] {
  return patterns.map((pattern) => ({
    name: pattern.name,
    status: pattern.regex.test(text) ? 'blocked' : 'passed',
  }));
}

export function evaluateAppSecGate(input: AppSecGateInput): AppSecGateResult {
  const timestamp = new Date().toISOString();

  if (!input.requireAppSecReview) {
    return {
      status: 'skipped',
      checks: [],
      demandId: input.demandId,
      timestamp,
    };
  }

  const secretChecks = runPatternChecks(input.promptText, SECRET_PATTERNS);
  const injectionChecks = runPatternChecks(input.promptText, INJECTION_PATTERNS);
  const checks = [...secretChecks, ...injectionChecks];

  const blockedChecks = checks.filter((c) => c.status === 'blocked');
  const status: AppSecGateStatus = blockedChecks.length > 0 ? 'blocked' : 'passed';

  const reason =
    status === 'blocked'
      ? `AppSec gate blocked by checks: ${blockedChecks.map((c) => c.name).join(', ')}`
      : 'No AppSec risks detected in prompt';

  logger.info('AppSec gate evaluated', {
    context: {
      demandId: input.demandId,
      appsecStatus: status,
      appsecChecks: checks,
      timestamp,
    },
  });

  return { status, checks, reason, demandId: input.demandId, timestamp };
}
