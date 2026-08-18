/**
 * Verificador de achados de autoavaliação (demanda 10268).
 *
 * As três skills de autoavaliação (`avaliar-fluxo-agentes`, `evaluate-rag`,
 * `llm-evaluation`) produziram 23 achados marcados como "confirmado" dos quais
 * apenas 8 sobreviveram à verificação manual contra o código — 65% de falsos
 * positivos ("o dashboard já existe", "os prompts já são versionados"). Um
 * achado confirmado que ninguém consegue reproduzir custa mais caro que achado
 * nenhum, porque consome triagem e corrói a confiança no processo inteiro.
 *
 * Este módulo transforma "confirmado" em algo checável: todo achado precisa
 * apontar arquivo, linha e um termo que realmente esteja lá. O verificador não
 * julga se o achado é relevante — só se a evidência que ele alega existe.
 *
 * Em `warn` o achado sobrevive marcado como não verificado; em `enforce` ele é
 * rejeitado. O default é `warn`, para medir a taxa real antes de bloquear.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolvePath } from '@shared/utils/paths';

import { logger } from '../../utils/logger';

/** Tolerância de linhas para cima e para baixo do ponto alegado. */
export const LINE_TOLERANCE = 5;

export type FindingVerifierMode = 'warn' | 'enforce';

export interface FindingEvidence {
  /** Caminho do arquivo, relativo à raiz do repositório. */
  evidenceFile: string;
  /** Linha 1-indexada onde o achado alega estar. */
  evidenceLine: number;
  /** Termo que deve aparecer perto dessa linha (o "comando de verificação"). */
  verificationCommand: string;
}

export interface Finding extends FindingEvidence {
  /** Skill que produziu o achado. */
  skill: string;
  /** Identificador do padrão/achado, quando a skill fornece. */
  patternId?: string;
  summary: string;
}

export type FindingVerdict =
  'verified' | 'file_not_found' | 'line_out_of_range' | 'term_not_found' | 'malformed_evidence';

export interface VerificationResult {
  finding: Finding;
  verdict: FindingVerdict;
  verified: boolean;
  /** Linha onde o termo foi de fato encontrado (1-indexada), quando houver. */
  matchedLine?: number;
  reason: string;
}

/**
 * Lê o modo do verificador em `config/feature-flags.json`.
 *
 * Falha de IO não pode derrubar a avaliação nem, silenciosamente, ligar o modo
 * bloqueante: qualquer problema de leitura cai em `warn`.
 */
export function getFindingVerifierMode(): FindingVerifierMode {
  const flagsPath = resolvePath('config/feature-flags.json');
  try {
    if (!fs.existsSync(flagsPath)) return 'warn';
    const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8')) as Record<string, unknown>;
    return flags.findingVerifierMode === 'enforce' ? 'enforce' : 'warn';
  } catch (error) {
    logger.warn('[finding-verifier] falha ao ler feature-flags.json; assumindo modo warn', {
      error: error instanceof Error ? error : undefined,
      context: { flagsPath },
    });
    return 'warn';
  }
}

/**
 * Resolve o arquivo alegado. Skills frequentemente citam o caminho sem o
 * prefixo do pacote (`openai-ai.ts` em vez de `server/services/openai-ai.ts`),
 * então cai para uma busca por basename antes de desistir.
 */
function resolveEvidenceFile(evidenceFile: string): string | null {
  const direct = resolvePath(evidenceFile);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const basename = path.basename(evidenceFile);
  const roots = ['server', 'shared', 'client/src', 'scripts'].map((dir) => resolvePath(dir));
  for (const root of roots) {
    const found = findByBasename(root, basename);
    if (found) return found;
  }
  return null;
}

function findByBasename(dir: string, basename: string, depth = 0): string | null {
  if (depth > 6 || !fs.existsSync(dir)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) return full;
    if (entry.isDirectory()) {
      const nested = findByBasename(full, basename, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Normaliza para comparação tolerante a espaçamento e caixa. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Verifica um único achado contra o código real.
 *
 * Puro no sentido que importa: não muta nada e não depende do modo — o modo só
 * decide o que o chamador faz com o veredito.
 */
export function verifyFinding(finding: Finding): VerificationResult {
  const { evidenceFile, evidenceLine, verificationCommand } = finding;

  if (
    !evidenceFile ||
    !verificationCommand ||
    !Number.isInteger(evidenceLine) ||
    evidenceLine < 1
  ) {
    return {
      finding,
      verdict: 'malformed_evidence',
      verified: false,
      reason: 'achado sem evidence_file, evidence_line (inteiro >= 1) ou verification_command',
    };
  }

  const resolved = resolveEvidenceFile(evidenceFile);
  if (!resolved) {
    return {
      finding,
      verdict: 'file_not_found',
      verified: false,
      reason: `arquivo não encontrado: ${evidenceFile}`,
    };
  }

  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  if (evidenceLine > lines.length) {
    return {
      finding,
      verdict: 'line_out_of_range',
      verified: false,
      reason: `linha ${evidenceLine} além do fim do arquivo (${lines.length} linhas)`,
    };
  }

  const needle = normalize(verificationCommand);
  const from = Math.max(0, evidenceLine - 1 - LINE_TOLERANCE);
  const to = Math.min(lines.length, evidenceLine + LINE_TOLERANCE);

  for (let i = from; i < to; i++) {
    if (normalize(lines[i]).includes(needle)) {
      return {
        finding,
        verdict: 'verified',
        verified: true,
        matchedLine: i + 1,
        reason: `termo encontrado na linha ${i + 1} (±${LINE_TOLERANCE} de ${evidenceLine})`,
      };
    }
  }

  return {
    finding,
    verdict: 'term_not_found',
    verified: false,
    reason: `termo "${verificationCommand}" ausente em ${evidenceFile}:${evidenceLine}±${LINE_TOLERANCE}`,
  };
}

export interface GateResult {
  mode: FindingVerifierMode;
  results: VerificationResult[];
  /** Achados que seguem adiante: todos em `warn`, só os verificados em `enforce`. */
  accepted: Finding[];
  rejected: VerificationResult[];
  verifiedCount: number;
  totalCount: number;
}

/**
 * Aplica o gate a um lote de achados e registra o resultado.
 *
 * Em `warn` nada é barrado — o log existe para medir a taxa de falso positivo
 * real antes de alguém decidir ligar o `enforce`.
 */
export function runFindingGate(findings: Finding[], mode = getFindingVerifierMode()): GateResult {
  const results = findings.map(verifyFinding);
  const rejected = results.filter((r) => !r.verified);
  const accepted =
    mode === 'enforce' ? results.filter((r) => r.verified).map((r) => r.finding) : findings;

  for (const result of rejected) {
    logger.warn('[finding-verifier] achado sem evidência reproduzível', {
      context: {
        mode,
        skill: result.finding.skill,
        patternId: result.finding.patternId,
        verdict: result.verdict,
        reason: result.reason,
        evidenceFile: result.finding.evidenceFile,
        evidenceLine: result.finding.evidenceLine,
        blocked: mode === 'enforce',
      },
    });
  }

  return {
    mode,
    results,
    accepted,
    rejected,
    verifiedCount: results.length - rejected.length,
    totalCount: results.length,
  };
}
