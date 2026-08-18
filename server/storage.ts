import { demands } from '@shared/schema';
import {
  type User,
  type InsertUser,
  type Demand,
  type InsertDemand,
  type File,
  type InsertFile,
  type ChatMessage,
} from '@shared/schema';
import { logger } from './utils/logger';
import { DbStorage } from './storage-db';
import { resolveDatabasePolicy } from '@shared/database-policy';

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createDemand(demand: InsertDemand | typeof demands.$inferInsert): Promise<Demand>;
  createDemandWithFiles(
    demand: InsertDemand | typeof demands.$inferInsert,
    options: { files?: InsertFile[]; roundtableConfig?: Record<string, unknown> },
  ): Promise<Demand>;
  getDemand(id: number): Promise<Demand | undefined>;
  getAllDemands(): Promise<Demand[]>;
  updateDemand(id: number, updates: Partial<Demand>): Promise<Demand | undefined>;
  updateDemandChat(id: number, messages: ChatMessage[]): Promise<void>;
  clearDemands(): Promise<number>;
  deleteDemand(id: number): Promise<boolean>;

  createFile(file: InsertFile): Promise<File>;
  getFilesByDemandId(demandId: number): Promise<File[]>;
  getFile(id: number): Promise<File | undefined>;
}

class MemStorage implements IStorage {
  private users: Map<number, User>;
  private demands: Map<number, Demand>;
  private files: Map<number, File>;
  private currentUserId: number;
  private currentDemandId: number;
  private currentFileId: number;

  constructor() {
    this.users = new Map();
    this.demands = new Map();
    this.files = new Map();
    this.currentUserId = 1;
    this.currentDemandId = 1;
    this.currentFileId = 1;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((user) => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async createDemand(insertDemand: InsertDemand | typeof demands.$inferInsert): Promise<Demand> {
    return this.createDemandWithFiles(insertDemand, {});
  }

  async createDemandWithFiles(
    insertDemand: InsertDemand | typeof demands.$inferInsert,
    options: { files?: InsertFile[]; roundtableConfig?: Record<string, unknown> } = {},
  ): Promise<Demand> {
    logger.debug('Criando nova demanda', { context: { title: insertDemand.title } });
    const id = this.currentDemandId++;
    const now = new Date();
    const demand: Demand = {
      ...insertDemand,
      id,
      status: 'processing',
      progress: 0,
      chatMessages: [],
      prdUrl: null,
      tddUrl: null,
      tasksUrl: null,
      skillRawUrl: null,
      domain: insertDemand.domain ?? 'padrao',
      executionId: null,
      executionConfig: null,
      qualityPassed: null,
      missingSections: null,
      fallbackUsed: false,
      fallbackReason: null,
      refinementType: insertDemand.refinementType ?? null,
      classification: null,
      orchestration: null,
      currentAgent: null,
      errorMessage: null,
      validationNotes: null,
      typeAdherence: null,
      completedAt: null,

      // Mesa Redonda (PRD #5)
      roundtableConfig: (insertDemand.roundtableConfig as
        { agentIds: string[]; maxRounds: number } | undefined) ?? { agentIds: [], maxRounds: 3 },
      roundtableSummary: null,

      // Go-Live (spec 10015)
      goLiveMode: insertDemand.goLiveMode ?? false,

      // Demanda 10196: origem Discovery → Refinement.
      origin: (insertDemand as { origin?: string | null }).origin ?? null,
      originMetadata:
        (insertDemand as { originMetadata?: Record<string, unknown> | null }).originMetadata ?? {},

      // Governance fields
      requiresApproval: insertDemand.requiresApproval ?? false,
      requiresHumanReview:
        insertDemand.requiresHumanReview ?? insertDemand.requiresApproval ?? false,
      documentState: 'DRAFT',
      reviewSnapshotId: null,
      approvedSnapshotId: null,
      approvedSnapshotHash: null,
      finalSnapshotId: null,
      finalizedFromHash: null,
      approvalSessionId: null,
      revisionNumber: 0,
      reviewRequestedAt: null,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      returnedToDraftAt: null,

      // Advanced Governance
      sectionChecklist: {},
      refinementInteractions: [],
      coverageAnalysis: null,
      learningLog: [],
      qaEvidence: null,
      size: insertDemand.size ?? null,
      documentVersions: {},
      overrideJustification: null,
      overrideBy: null,

      // Performance & Cost Telemetry
      runId: null,
      qualityGateStatus: null,
      finalDocHash: null,
      promptTokens: 0,
      completionTokens: 0,
      custoEstimado: 0,

      // Anti-overengineering effort override
      maxEffortOverrideDias: null,
      maxEffortOverrideBy: null,
      maxEffortOverrideJustification: null,

      // Departmentalização — pode vir já preenchido em InsertDemand quando a
      // rota tiver resolvido o repo via getOrCreateRepo. Nullable por padrão.
      repoFullName: (insertDemand as { repoFullName?: string | null }).repoFullName ?? null,

      // CRIT-16: descrição original do usuário antes do enriquecimento.
      originalDescription:
        (insertDemand as { originalDescription?: string | null }).originalDescription ?? null,

      createdAt: now,
      updatedAt: now,
    };

    if (options.roundtableConfig) {
      (demand as Demand).roundtableConfig = options.roundtableConfig as {
        agentIds: string[];
        maxRounds: number;
      };
    }

    this.demands.set(id, demand);

    if (options.files) {
      for (const file of options.files) {
        const fileId = this.currentFileId++;
        const createdFile: File = {
          ...file,
          id: fileId,
          demandId: id,
          size: file.size || 0,
          createdAt: new Date(),
        };
        this.files.set(fileId, createdFile);
      }
    }

    return demand;
  }

  async getDemand(id: number): Promise<Demand | undefined> {
    return this.demands.get(id);
  }

  async getAllDemands(): Promise<Demand[]> {
    return Array.from(this.demands.values()).sort(
      (a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime(),
    );
  }

  async updateDemand(id: number, updates: Partial<Demand>): Promise<Demand | undefined> {
    const demand = this.demands.get(id);
    if (!demand) return undefined;

    const updated = { ...demand, ...updates, updatedAt: new Date() };
    this.demands.set(id, updated);
    return updated;
  }

  async updateDemandChat(id: number, messages: ChatMessage[]): Promise<void> {
    const demand = this.demands.get(id);
    if (demand) {
      demand.chatMessages = messages;
      demand.updatedAt = new Date();
    }
  }

  async clearDemands(): Promise<number> {
    const deleted = this.demands.size;
    this.demands.clear();
    this.files.clear();
    return deleted;
  }

  async deleteDemand(id: number): Promise<boolean> {
    if (!this.demands.has(id)) return false;
    this.demands.delete(id);
    for (const [fileId, file] of this.files) {
      if (file.demandId === id) this.files.delete(fileId);
    }
    return true;
  }

  async createFile(insertFile: InsertFile): Promise<File> {
    const id = this.currentFileId++;
    const file: File = {
      ...insertFile,
      id,
      size: insertFile.size || 0,
      demandId: insertFile.demandId || 0,
      createdAt: new Date(),
    };
    this.files.set(id, file);
    return file;
  }

  async getFilesByDemandId(demandId: number): Promise<File[]> {
    return Array.from(this.files.values()).filter((file) => file.demandId === demandId);
  }

  async getFile(id: number): Promise<File | undefined> {
    return this.files.get(id);
  }
}

/**
 * Storage selector.
 *
 * Default: MemStorage (volatile, RAM) — preserves existing test behavior.
 * Set STORAGE=db to use DbStorage (Drizzle, persists to SQLite/Postgres).
 *
 * Phase 2 of architecture refactor (docs/architecture-refactor-prd.md).
 * Will be flipped to default `db` once schema is in sync across envs.
 */
function selectStorage(): IStorage {
  // Spec 016 B1 (M-08/FR-003): a política única decide; memória implícita só
  // em testes — fora deles, o default é durável e memória exige STORAGE=memory.
  const { storage: storageKind } = resolveDatabasePolicy();
  if (storageKind === 'db') {
    logger.info('Using DbStorage (persistent via Drizzle)');
    return new DbStorage();
  }
  logger.info('Using MemStorage (volátil — STORAGE=memory ou ambiente de teste)');
  return new MemStorage();
}

export const storage: IStorage = selectStorage();
