/**
 * Demanda #10358 T5 — contadores de uso do Free Tier (por usuário/mês).
 * Demanda #10364 T5 — contadores respeitam o plano ativo (Free vs Pro).
 *
 * Incremento atômico via upsert (`onConflictDoUpdate`) para não perder
 * contagem sob concorrência — "incrementados atomicamente após operação
 * bem-sucedida (não antes)", conforme Tasks.md.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { usageCounters } from '@shared/schema-unified';
import type { UsageCounter } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { currentPeriod, getTierLimits, type PlanType } from '../config/free-tier';

export interface UsageSnapshot {
  refinementsUsed: number;
  refinementsLimit: number;
  reposUsed: number;
  reposLimit: number;
  hasFullHistory: boolean;
  plan: PlanType;
}

class UsageCounterService {
  private async findCounter(userId: number, period: string): Promise<UsageCounter | undefined> {
    await ensureVibePlatformSchema();
    const [row] = await db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.period, period)))
      .limit(1);
    return row;
  }

  async getUsage(
    userId: number,
    plan: PlanType = 'free',
    now: Date = new Date(),
  ): Promise<UsageSnapshot> {
    const limits = getTierLimits(plan);
    const counter = await this.findCounter(userId, currentPeriod(now));
    return {
      refinementsUsed: counter?.refinementsCount ?? 0,
      refinementsLimit: limits.maxRefinementsPerMonth,
      reposUsed: counter?.connectedRepos ?? 0,
      // 0 = ilimitado (convention for Pro); report as -1 for "unlimited" semantics
      reposLimit: limits.maxConnectedRepos === 0 ? -1 : limits.maxConnectedRepos,
      hasFullHistory: limits.hasFullHistory,
      plan,
    };
  }

  async hasRefinementsRemaining(
    userId: number,
    plan: PlanType = 'free',
    now: Date = new Date(),
  ): Promise<boolean> {
    if (plan === 'pro') {
      // Pro: 30/mês — ainda contamos, mas limite é maior
      const usage = await this.getUsage(userId, plan, now);
      return usage.refinementsUsed < usage.refinementsLimit;
    }
    const usage = await this.getUsage(userId, plan, now);
    return usage.refinementsUsed < usage.refinementsLimit;
  }

  async hasRepoSlotRemaining(
    userId: number,
    plan: PlanType = 'free',
    now: Date = new Date(),
  ): Promise<boolean> {
    if (plan === 'pro') {
      // Pro: repos ilimitados — sempre true
      return true;
    }
    const usage = await this.getUsage(userId, plan, now);
    return usage.reposUsed < usage.reposLimit;
  }

  async incrementRefinements(userId: number, now: Date = new Date()): Promise<void> {
    await ensureVibePlatformSchema();
    const period = currentPeriod(now);
    await db
      .insert(usageCounters)
      .values({ userId, period, refinementsCount: 1, connectedRepos: 0 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.period],
        set: { refinementsCount: sql`${usageCounters.refinementsCount} + 1` },
      });
  }

  /** Só chamado quando a conexão Git é NOVA (não numa troca/refresh de token). */
  async incrementConnectedRepos(userId: number, now: Date = new Date()): Promise<void> {
    await ensureVibePlatformSchema();
    const period = currentPeriod(now);
    await db
      .insert(usageCounters)
      .values({ userId, period, refinementsCount: 0, connectedRepos: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.period],
        set: { connectedRepos: sql`${usageCounters.connectedRepos} + 1` },
      });
  }
}

export const usageCounterService = new UsageCounterService();
