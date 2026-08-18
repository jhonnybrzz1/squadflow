/**
 * DemandRepository — Fase 2 (Repository Pattern)
 *
 * Abstração sobre o storage de demandas, centralizando todo acesso a dados
 * e eliminando dependências diretas do `storage` em rotas e serviços.
 *
 * Referência: docs/architecture-analysis-legacy-modernization.md §5.1
 */

import { getDb } from '../db';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { demands } from '@shared/schema';
import type { Demand, InsertDemand, ChatMessage, InsertFile, File } from '@shared/schema';

// Spec 014 S4 (M-04): o union fechado vive em shared/ como fonte única.
export type { DemandStatus } from '@shared/demand-status';
import type { DemandStatus } from '@shared/demand-status';

export interface DemandFilter {
  status?: DemandStatus;
  domain?: string;
  type?: string;
}

export interface DemandWithFiles extends Demand {
  files: File[];
}

export interface DemandUpdatePayload {
  status?: DemandStatus;
  progress?: number;
  prdUrl?: string | null;
  tasksUrl?: string | null;
  errorMessage?: string | null;
  currentAgent?: string | null;
  completedAt?: Date | null;
  [key: string]: unknown;
}

export interface CreateDemandOptions {
  files?: InsertFile[];
  roundtableConfig?: Record<string, unknown>;
}

export class DemandRepository {
  /**
   * Cria uma nova demanda. Quando `options.files` ou `options.roundtableConfig`
   * são fornecidos, TODAS as operações (insert da demanda, arquivos e update de
   * config) rodam dentro de uma transação atômica.
   */
  async create(
    data: InsertDemand | typeof demands.$inferInsert,
    options: CreateDemandOptions = {},
  ): Promise<Demand> {
    const demand = await storage.createDemandWithFiles(data as typeof demands.$inferInsert, {
      files: options.files as InsertFile[] | undefined,
      roundtableConfig: options.roundtableConfig,
    });

    logger.info(
      options.files?.length || options.roundtableConfig
        ? 'Demanda criada (transação atômica)'
        : 'Demanda criada',
      {
        context: { demandId: demand.id, title: demand.title, type: demand.type },
      },
    );

    return demand;
  }

  /**
   * Busca uma demanda pelo ID. Lança NotFoundError se não existir.
   */
  async findById(id: number): Promise<Demand> {
    const demand = await storage.getDemand(id);
    if (!demand) {
      throw new DemandNotFoundError(id);
    }
    return demand;
  }

  /**
   * Busca uma demanda pelo ID, retornando undefined se não existir.
   */
  async findByIdOrNull(id: number): Promise<Demand | undefined> {
    return storage.getDemand(id);
  }

  /**
   * Retorna todas as demandas, com filtro opcional.
   */
  async findAll(filter?: DemandFilter): Promise<Demand[]> {
    const all = await storage.getAllDemands();

    if (!filter) return all;

    return all.filter((d) => {
      if (filter.status && d.status !== filter.status) return false;
      if (filter.domain && d.domain !== filter.domain) return false;
      if (filter.type && d.type !== filter.type) return false;
      return true;
    });
  }

  /**
   * Spec 10192: lista demandas com arquivos relacionados via Drizzle relations.
   * Funciona tanto em SQLite quanto Postgres via getDb().
   */
  async listWithRelations(filter?: DemandFilter): Promise<DemandWithFiles[]> {
    const client = getDb();
    const rows = await client.query.demands.findMany({
      with: { files: true },
      orderBy: (demandsTable, { desc }) => [desc(demandsTable.createdAt)],
    });

    if (!filter) return rows as DemandWithFiles[];

    return (rows as DemandWithFiles[]).filter((d) => {
      if (filter.status && d.status !== filter.status) return false;
      if (filter.domain && d.domain !== filter.domain) return false;
      if (filter.type && d.type !== filter.type) return false;
      return true;
    });
  }

  /**
   * Atualiza campos de uma demanda.
   */
  async update(id: number, updates: DemandUpdatePayload): Promise<Demand> {
    const updated = await storage.updateDemand(id, updates as Partial<Demand>);
    if (!updated) {
      throw new DemandNotFoundError(id);
    }
    logger.debug('Demanda atualizada', { context: { demandId: id, fields: Object.keys(updates) } });
    return updated;
  }

  /**
   * Atualiza o status de processamento com progresso opcional.
   */
  async updateStatus(id: number, status: DemandStatus, progress?: number): Promise<Demand> {
    const updates: DemandUpdatePayload = { status };
    if (progress !== undefined) {
      updates.progress = Math.max(0, Math.min(100, progress));
    }
    if (status === 'completed') {
      updates.completedAt = new Date();
    }
    return this.update(id, updates);
  }

  /**
   * Atualiza as mensagens do chat de uma demanda.
   */
  async updateChat(id: number, messages: ChatMessage[]): Promise<void> {
    await storage.updateDemandChat(id, messages);
    logger.debug('Chat da demanda atualizado', {
      context: { demandId: id, messageCount: messages.length },
    });
  }

  /**
   * Remove o historico de demandas exibido no front.
   */
  async clearHistory(): Promise<{ deleted: number }> {
    const deleted = await storage.clearDemands();
    logger.warn('Historico de demandas limpo', { context: { deleted } });
    return { deleted };
  }

  /**
   * Spec 10013 (FR-004): remove UMA demanda (hard delete + filhas). Retorna
   * `false` se a demanda não existir.
   */
  async deleteById(id: number): Promise<boolean> {
    const removed = await storage.deleteDemand(id);
    if (removed) {
      logger.warn('Demanda removida do histórico', { context: { demandId: id } });
    }
    return removed;
  }

  /**
   * Marca demanda como erro com mensagem descritiva.
   */
  async markAsError(id: number, errorMessage: string): Promise<void> {
    await storage.updateDemand(id, { status: 'error', errorMessage });
    logger.warn('Demanda marcada como erro', { context: { demandId: id, errorMessage } });
  }

  /**
   * Retorna métricas agregadas das demandas.
   */
  async getMetricsSummary(): Promise<{
    total: number;
    completed: number;
    processing: number;
    error: number;
    completionRate: number;
  }> {
    const all = await storage.getAllDemands();
    const total = all.length;
    const completed = all.filter((d) => d.status === 'completed').length;
    const processing = all.filter((d) => d.status === 'processing').length;
    const error = all.filter((d) => d.status === 'error').length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, processing, error, completionRate };
  }
}

/**
 * Erro tipado para demandas não encontradas — elimina uso de res.status(404) espalhado pelas rotas.
 */
export class DemandNotFoundError extends Error {
  readonly demandId: number;
  readonly statusCode = 404;

  constructor(demandId: number) {
    super(`Demanda #${demandId} não encontrada`);
    this.name = 'DemandNotFoundError';
    this.demandId = demandId;
  }
}

export const demandRepository = new DemandRepository();
