/**
 * DbStorage — persistência via Drizzle ORM (SQLite local + Postgres prod).
 *
 * Substitui `MemStorage` para que demands/users/files persistam entre restarts.
 * Funciona com ambos os dialetos via schemas espelhados em `schema.ts` e
 * `schema-pg.ts`.
 *
 * Phase 2 of architecture refactor (docs/architecture-refactor-prd.md).
 */

import { eq, desc } from 'drizzle-orm';
import { db, dbTransaction } from './db';
import {
  demands,
  users,
  files,
  documentSnapshots,
  approvalComments,
  documentLifecycleEvents,
  operationAttempts,
  modelRoutingStageRuns,
  agentDecisionRecords,
  domainExecutionRecords,
  progressiveRefinementRecords,
  telemetry,
  humanFeedback,
  feedbackRefinamento,
  agentInterventions,
  orchestrationRuns,
  agentTurns,
  agentToolCalls,
  orchestrationEvents,
} from '@shared/schema-unified';
import type { IStorage } from './storage';
import type { User, InsertUser, Demand, File, InsertFile, ChatMessage } from '@shared/schema';
import { logger } from './utils/logger';
import { demandArchiveService } from './services/demand-archive';

export class DbStorage implements IStorage {
  // ---------- Users ----------
  async getUser(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return rows[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  // ---------- Demands ----------
  async createDemand(insertDemand: typeof demands.$inferInsert): Promise<Demand> {
    return this.createDemandWithFiles(insertDemand, {});
  }

  async createDemandWithFiles(
    insertDemand: typeof demands.$inferInsert,
    options: {
      files?: (typeof files.$inferInsert)[];
      roundtableConfig?: Record<string, unknown>;
    } = {},
  ): Promise<Demand> {
    logger.debug('Criando nova demanda (DbStorage)', {
      context: { title: insertDemand.title },
    });

    if (!options.files?.length && !options.roundtableConfig) {
      const [demand] = await db
        .insert(demands)
        .values({
          ...insertDemand,
          domain: insertDemand.domain ?? 'padrao',
          refinementType: insertDemand.refinementType ?? null,
        } as typeof demands.$inferInsert)
        .returning();
      return demand as Demand;
    }

    return dbTransaction(async (tx) => {
      const [inserted] = await tx
        .insert(demands)
        .values({
          ...insertDemand,
          domain: insertDemand.domain ?? 'padrao',
          refinementType: insertDemand.refinementType ?? null,
        } as typeof demands.$inferInsert)
        .returning();

      if (options.files && options.files.length > 0) {
        for (const file of options.files) {
          await tx.insert(files).values({
            ...file,
            size: file.size ?? 0,
            demandId: file.demandId ?? inserted.id,
          } as typeof files.$inferInsert);
        }
      }

      if (options.roundtableConfig) {
        await tx
          .update(demands)
          .set({ roundtableConfig: options.roundtableConfig } as Partial<
            typeof demands.$inferInsert
          >)
          .where(eq(demands.id, inserted.id));
      }

      const [demand] = await tx.select().from(demands).where(eq(demands.id, inserted.id)).limit(1);
      return demand as Demand;
    });
  }

  async getDemand(id: number): Promise<Demand | undefined> {
    const rows = await db.select().from(demands).where(eq(demands.id, id)).limit(1);
    return rows[0] as Demand | undefined;
  }

  async getAllDemands(): Promise<Demand[]> {
    const rows = await db.select().from(demands).orderBy(desc(demands.createdAt));
    return rows as Demand[];
  }

  async updateDemand(id: number, updates: Partial<Demand>): Promise<Demand | undefined> {
    const normalizedUpdates = this.normalizeDemandTimestampUpdates(updates);
    const [updated] = await db
      .update(demands)
      .set({ ...normalizedUpdates, updatedAt: new Date() } as Partial<typeof demands.$inferInsert>)
      .where(eq(demands.id, id))
      .returning();
    return updated as Demand | undefined;
  }

  async updateDemandChat(id: number, messages: ChatMessage[]): Promise<void> {
    await db
      .update(demands)
      .set({ chatMessages: messages, updatedAt: new Date() })
      .where(eq(demands.id, id));
  }

  /**
   * Spec 10013 (FR-004): remove UMA demanda e seus registros filhos por `demandId`.
   * Hard delete (consistente com clearDemands). FKs não têm cascade habilitado
   * (PRAGMA foreign_keys off), então deletamos as filhas explicitamente. Tabelas de
   * auditoria keyed por run/execution (orchestrationRuns/Events/agentTurns) não têm
   * `demandId` e são toleráveis como órfãs — não bloqueiam nem aparecem no histórico.
   */
  async deleteDemand(id: number): Promise<boolean> {
    const [existing] = await db.select().from(demands).where(eq(demands.id, id));
    if (!existing) return false;

    // MÉDIO-04: retém o snapshot mínimo ANTES de apagar. `llm_audit_logs`,
    // `demand_generation_jobs` e `orchestration_runs` sobrevivem ao delete de
    // propósito (são trilha de auditoria), mas sem este registro elas ficam
    // apontando para uma demanda que não existe mais — foi como 10.517 logs
    // LLM perderam a correlação e a pergunta "quanto custou uma demanda útil?"
    // ficou sem resposta. Nunca lança: não pode impedir o delete.
    await demandArchiveService.archive({
      demandId: id,
      title: existing.title,
      type: existing.type,
      finalStatus: existing.status,
      qualityGateStatus: existing.qualityGateStatus,
      requiresHumanReview: existing.requiresHumanReview,
    });

    // CRIT-11: 12 DELETEs sequenciais sem transação — um crash no meio deixava
    // registros filhos órfãos (ex.: files/documentSnapshots apagados mas a
    // própria demanda ainda presente, ou vice-versa). `dbTransaction` garante
    // que todas as tabelas mudam atomicamente ou nenhuma muda.
    await dbTransaction(async (tx) => {
      await tx.delete(agentInterventions).where(eq(agentInterventions.demandId, id));
      await tx.delete(humanFeedback).where(eq(humanFeedback.demandId, id));
      await tx.delete(telemetry).where(eq(telemetry.demandId, id));
      await tx
        .delete(progressiveRefinementRecords)
        .where(eq(progressiveRefinementRecords.demandId, id));
      await tx.delete(domainExecutionRecords).where(eq(domainExecutionRecords.demandId, id));
      await tx.delete(agentDecisionRecords).where(eq(agentDecisionRecords.demandId, id));
      await tx.delete(modelRoutingStageRuns).where(eq(modelRoutingStageRuns.demandId, id));
      await tx.delete(operationAttempts).where(eq(operationAttempts.demandId, id));
      await tx.delete(documentLifecycleEvents).where(eq(documentLifecycleEvents.demandId, id));
      await tx.delete(approvalComments).where(eq(approvalComments.demandId, id));
      await tx.delete(documentSnapshots).where(eq(documentSnapshots.demandId, id));
      await tx.delete(files).where(eq(files.demandId, id));
      await tx.delete(demands).where(eq(demands.id, id));
    });
    return true;
  }

  async clearDemands(): Promise<number> {
    const existing = await db.select({ id: demands.id }).from(demands);

    // CRIT-11: mesma proteção transacional de deleteDemand — evita órfãos se
    // o processo crashar entre um DELETE e outro durante a limpeza completa.
    await dbTransaction(async (tx) => {
      await tx.delete(agentToolCalls);
      await tx.delete(orchestrationEvents);
      await tx.delete(agentTurns);
      await tx.delete(orchestrationRuns);
      await tx.delete(agentInterventions);
      await tx.delete(feedbackRefinamento);
      await tx.delete(humanFeedback);
      await tx.delete(telemetry);
      await tx.delete(progressiveRefinementRecords);
      await tx.delete(domainExecutionRecords);
      await tx.delete(agentDecisionRecords);
      await tx.delete(modelRoutingStageRuns);
      await tx.delete(operationAttempts);
      await tx.delete(documentLifecycleEvents);
      await tx.delete(approvalComments);
      await tx.delete(documentSnapshots);
      await tx.delete(files);
      await tx.delete(demands);
    });
    return existing.length;
  }

  // ---------- Files ----------
  async createFile(insertFile: InsertFile): Promise<File> {
    const [file] = await db
      .insert(files)
      .values({
        ...insertFile,
        size: insertFile.size ?? 0,
        demandId: insertFile.demandId ?? null,
      } as typeof files.$inferInsert)
      .returning();
    return file;
  }

  async getFilesByDemandId(demandId: number): Promise<File[]> {
    return db.select().from(files).where(eq(files.demandId, demandId));
  }

  async getFile(id: number): Promise<File | undefined> {
    const rows = await db.select().from(files).where(eq(files.id, id)).limit(1);
    return rows[0];
  }

  private normalizeDemandTimestampUpdates(updates: Partial<Demand>): Partial<Demand> {
    const normalized = { ...updates } as Record<string, unknown>;

    delete normalized.createdAt;
    delete normalized.updatedAt;

    for (const field of ['completedAt', 'reviewRequestedAt', 'approvedAt']) {
      if (field in normalized) {
        normalized[field] = this.toDateOrNull(normalized[field]);
      }
    }

    return normalized as Partial<Demand>;
  }

  private toDateOrNull(value: unknown): Date | null | undefined {
    if (value == null) return value as null | undefined;
    if (value instanceof Date) return value;

    const parsed = new Date(value as string | number);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
