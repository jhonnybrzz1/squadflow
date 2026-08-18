import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db as defaultDb, isPostgres, type DbClient } from '../db';
import { logger } from '../utils/logger';
import { dbRun, dbAll } from '../utils/db-utils';
import { domainExecutionRecords } from '@shared/schema-unified';
import { type DemandDomain } from '@shared/schema';

export interface DomainExecutionData {
  executionId: string;
  demandId: number;
  domain: string;
  domainTriggered: boolean;
  domainUsableReturned: boolean;
  domainUsedInFinal: boolean;
  outputSource: string;
  fallbackOrReprocess: boolean;
  latencyMs: number;
}

export type DomainClassification =
  | 'NEVER_ELIGIBLE'
  | 'ELIGIBLE_NOT_VALID'
  | 'VALID_NOT_CONSOLIDATED'
  | 'VALID_AND_CONSOLIDATED';

export interface DomainMetricsReport {
  domain: string;
  classification: DomainClassification;
  totalExecutions: number;
  triggerRate: number; // percentage (0-100)
  usableReturnRate: number; // percentage of triggered
  impactRate: number; // percentage of usable that made to final
  errorRate: number; // percentage of fallback
  latencyP95: number;
  recommendedAction: string;
}

export class DomainTelemetryService {
  private initPromise: Promise<void>;

  private async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  constructor(private readonly database: DbClient = defaultDb) {
    this.initPromise = this.initialize();
  }

  async persistExecutionRecord(data: DomainExecutionData): Promise<void> {
    await this.initPromise;
    try {
      const createdAt = isPostgres ? Math.floor(Date.now() / 1000) : new Date();
      await (this.database as any).insert(domainExecutionRecords).values({
        executionId: data.executionId || `exec_${Date.now()}_${randomUUID().slice(0, 8)}`,
        demandId: data.demandId,
        domain: data.domain,
        domainTriggered: data.domainTriggered ? 1 : 0,
        domainUsableReturned: data.domainUsableReturned ? 1 : 0,
        domainUsedInFinal: data.domainUsedInFinal ? 1 : 0,
        outputSource: data.outputSource,
        fallbackOrReprocess: data.fallbackOrReprocess ? 1 : 0,
        latencyMs: data.latencyMs,
        createdAt,
      });

      logger.logBusinessEvent('domain_execution_recorded', data.domain, data.executionId, {
        domainTriggered: data.domainTriggered,
        domainUsedInFinal: data.domainUsedInFinal,
      });
    } catch (error) {
      logger.warn('Failed to persist domain execution record:', error);
    }
  }

  async generateDomainReport(domain: DemandDomain): Promise<DomainMetricsReport | null> {
    await this.initPromise;
    try {
      // Usamos a API raw sql para estatísticas avançadas (percentis, sum, etc.) de forma robusta e performática
      const rows = (await dbAll(
        this.database,
        sql`
        SELECT 
          COUNT(*) as total,
          SUM(domain_triggered) as triggered_count,
          SUM(domain_usable_returned) as usable_count,
          SUM(domain_used_in_final) as used_final_count,
          SUM(fallback_or_reprocess) as error_count
        FROM domain_execution_records
        WHERE domain = ${domain}
      `,
      )) as any[];

      if (!rows || rows.length === 0 || rows[0].total === 0) {
        return null;
      }

      const stats = rows[0];
      const total = Number(stats.total) || 0;
      const triggered = Number(stats.triggered_count) || 0;
      const usable = Number(stats.usable_count) || 0;
      const usedFinal = Number(stats.used_final_count) || 0;
      const errorCount = Number(stats.error_count) || 0;

      // P95 estimation (simplificado no SQLite: média ou fetch all and sort, but we fetch top limit offset)
      const latencies = (await dbAll(
        this.database,
        sql`
        SELECT latency_ms FROM domain_execution_records 
        WHERE domain = ${domain} AND domain_triggered = 1 
        ORDER BY latency_ms ASC
      `,
      )) as any[];

      let p95 = 0;
      if (latencies.length > 0) {
        const p95Index = Math.floor(latencies.length * 0.95);
        p95 = latencies[p95Index]?.latency_ms || latencies[latencies.length - 1]?.latency_ms || 0;
      }

      const triggerRate = total > 0 ? (triggered / total) * 100 : 0;
      const usableReturnRate = triggered > 0 ? (usable / triggered) * 100 : 0;
      const impactRate = usable > 0 ? (usedFinal / usable) * 100 : 0;
      const errorRate = triggered > 0 ? (errorCount / triggered) * 100 : 0;

      let classification: DomainClassification;
      let recommendedAction = '';

      if (triggerRate < 10) {
        classification = 'NEVER_ELIGIBLE';
        recommendedAction =
          'Ajustar gate/roteamento (verificar se a condição de ativação está restrita demais)';
      } else if (usableReturnRate < 50) {
        classification = 'ELIGIBLE_NOT_VALID';
        recommendedAction =
          'Melhorar prompt de domínio (agentes estão ignorando ou falhando ao usar o contexto)';
      } else if (impactRate < 50) {
        classification = 'VALID_NOT_CONSOLIDATED';
        recommendedAction =
          'Ajustar síntese final (o valor é gerado pelos agentes, mas descartado na consolidação)';
      } else {
        classification = 'VALID_AND_CONSOLIDATED';
        recommendedAction = 'Manter em operação e observar (domínio saudável)';
      }

      return {
        domain,
        classification,
        totalExecutions: total,
        triggerRate,
        usableReturnRate,
        impactRate,
        errorRate,
        latencyP95: p95,
        recommendedAction,
      };
    } catch (error) {
      logger.error(`Failed to generate report for domain ${domain}:`, error);
      return null;
    }
  }

  async countDistinctDemands(domain: DemandDomain): Promise<number> {
    await this.initPromise;
    try {
      const rows = (await dbAll(
        this.database,
        sql`SELECT COUNT(DISTINCT demand_id) AS total FROM domain_execution_records WHERE domain = ${domain}`,
      )) as Array<{ total?: number | string }>;
      return Number(rows[0]?.total) || 0;
    } catch (error) {
      logger.warn(`Failed to count distinct demands for domain ${domain}:`, error);
      return 0;
    }
  }

  /**
   * T4: Rule engine to protect decisions (Guardrails)
   */
  evaluateDecisionGuardrails(
    report: DomainMetricsReport,
    minSample: number = 20,
  ): { approved: boolean; reason: string; safeAction: string } {
    if (report.totalExecutions < minSample) {
      return {
        approved: false,
        reason: `Amostra insuficiente (${report.totalExecutions}/${minSample}). Evidência fraca.`,
        safeAction: 'Manter configuração atual (reversível) e aguardar mais dados.',
      };
    }

    if (report.classification === 'NEVER_ELIGIBLE') {
      return {
        approved: true,
        reason: 'Amostra suficiente, domínio nunca é elegível.',
        safeAction: 'Priorizar ajuste de gate/roteamento antes de expandir novas fontes.',
      };
    }

    return {
      approved: true,
      reason: 'Amostra suficiente, dados confiáveis para decisão.',
      safeAction: report.recommendedAction,
    };
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbRun(
        this.database,
        sql`
        CREATE TABLE IF NOT EXISTS domain_execution_records (
          execution_id TEXT PRIMARY KEY NOT NULL,
          demand_id INTEGER NOT NULL,
          domain TEXT NOT NULL,
          domain_triggered INTEGER NOT NULL,
          domain_usable_returned INTEGER NOT NULL,
          domain_used_in_final INTEGER NOT NULL,
          output_source TEXT NOT NULL,
          fallback_or_reprocess INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `,
      );
    } catch (error) {
      logger.warn('Could not ensure domain_execution_records schema:', error);
    }
  }
}

export const domainTelemetryService = new DomainTelemetryService();
