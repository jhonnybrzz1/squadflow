/**
 * Contratos puros de SpecKitConformance.
 *
 * `prependNeedsReviewBanner` é uma função pura usada tanto pelo gerador de
 * documentos (ai-squad) quanto por enforcers; por isso foi extraída para cá.
 */

import type { SpecValidationIssue } from '@shared/spec-schemas';

export interface SpecConformanceOptions {
  maxAttempts?: number;
  demandId?: number;
}

export interface SpecConformanceResult {
  content: string;
  ok: boolean;
  needsReview: boolean;
  attempts: number;
  issues: SpecValidationIssue[];
  durationMs: number;
}

export function prependNeedsReviewBanner(result: SpecConformanceResult): string {
  const pendencias = result.issues.map((i) => `> - [${i.field}] ${i.message}`).join('\n');
  return `> ⚠️ **needs_review: true** — documento não ficou conforme o template do SpecKit após ${result.attempts} tentativa(s). Pendências:\n${pendencias}\n\n${result.content}`;
}
