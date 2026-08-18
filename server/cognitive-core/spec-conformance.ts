/**
 * Conformidade com o SpecKit — validação SÍNCRONA com retry e flag needs_review.
 *
 * Os contratos puros (`SpecConformanceOptions`, `SpecConformanceResult` e
 * `prependNeedsReviewBanner`) foram movidos para `server/orchestration-contracts`
 * para que ai-squad possa consumi-los sem importar do cognitive-core.
 * Este arquivo mantém a lógica de enforce.
 */

import {
  validateSpecKitDocument,
  type SpecDocumentKind,
  type SpecValidationIssue,
} from '@shared/spec-schemas';
import {
  type SpecConformanceOptions,
  type SpecConformanceResult,
  prependNeedsReviewBanner,
} from '../orchestration-contracts';

export { SpecConformanceOptions, SpecConformanceResult, prependNeedsReviewBanner };

/** Formata as issues como feedback acionável para a próxima tentativa. */
function buildFeedback(issues: SpecValidationIssue[]): string {
  return [
    'O documento gerado NÃO está conforme o template do SpecKit. Corrija estritamente:',
    ...issues.map((issue) => `- [${issue.field}] ${issue.message}`),
  ].join('\n');
}

/**
 * Envolve a geração de um documento com validação síncrona conforme o SpecKit.
 *
 * @param kind      'prd' | 'tasks'
 * @param generate  função que gera o markdown; recebe o feedback dos erros da
 *                  tentativa anterior (undefined na primeira) para autocorreção.
 */
export async function enforceSpecConformance(
  kind: SpecDocumentKind,
  generate: (feedback?: string) => Promise<string>,
  options: SpecConformanceOptions = {},
): Promise<SpecConformanceResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const start = Date.now();

  let bestContent = '';
  let bestIssues: SpecValidationIssue[] = [];
  let bestIssueCount = Number.POSITIVE_INFINITY;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const feedback = attempts > 0 ? buildFeedback(bestIssues) : undefined;
    const content = await generate(feedback);
    attempts += 1;

    const validation = validateSpecKitDocument(kind, content);
    const issueCount = validation.issues.length;

    if (issueCount < bestIssueCount) {
      bestContent = content;
      bestIssues = validation.issues;
      bestIssueCount = issueCount;
    }

    if (validation.ok) {
      return {
        content: bestContent,
        ok: true,
        needsReview: false,
        attempts,
        issues: bestIssues,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    content: bestContent,
    ok: false,
    needsReview: true,
    attempts,
    issues: bestIssues,
    durationMs: Date.now() - start,
  };
}
