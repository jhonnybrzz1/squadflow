import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { qualityScores } from '@shared/schema';
import { db } from '../db';
import { logger } from '../utils/logger';

export interface QualityIndexScores {
  groundednessScore: number | null;
  numericIntegrityScore: number | null;
  citedPathScore: number | null;
  overallScore: number | null;
}

export interface QualityIndexInput extends QualityIndexScores {
  demandId: number;
  documentType: 'prd' | 'tsd';
  metadata?: Record<string, unknown>;
}

/**
 * Spec 10093 Fase 2 — Quality Index.
 * Persiste scores dos validadores (groundedness, numeric-integrity, cited-path)
 * para análise de qualidade real no dashboard.
 */
export class QualityIndexService {
  /**
   * Calcula um score overall como média dos scores disponíveis.
   * Campos null são ignorados.
   */
  static computeOverall(scores: QualityIndexScores): number | null {
    const values = [
      scores.groundednessScore,
      scores.numericIntegrityScore,
      scores.citedPathScore,
    ].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return Number((sum / values.length).toFixed(3));
  }

  static async save(input: QualityIndexInput): Promise<void> {
    const overallScore = input.overallScore ?? this.computeOverall(input);
    try {
      await db.insert(qualityScores).values({
        id: randomUUID(),
        demandId: input.demandId,
        documentType: input.documentType,
        groundednessScore: input.groundednessScore,
        numericIntegrityScore: input.numericIntegrityScore,
        citedPathScore: input.citedPathScore,
        overallScore,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      logger.error('[QualityIndexService] Falha ao persistir quality score', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: input.demandId, documentType: input.documentType },
      });
    }
  }

  static async getLatestByDemand(demandId: number): Promise<QualityIndexInput | null> {
    const rows = await db
      .select()
      .from(qualityScores)
      .where(eq(qualityScores.demandId, demandId))
      .orderBy(desc(qualityScores.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      demandId: row.demandId,
      documentType: row.documentType as 'prd' | 'tsd',
      groundednessScore: row.groundednessScore,
      numericIntegrityScore: row.numericIntegrityScore,
      citedPathScore: row.citedPathScore,
      overallScore: row.overallScore,
    };
  }
}
