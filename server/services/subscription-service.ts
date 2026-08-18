/**
 * Demanda #10364 T2/T3 — serviço de assinaturas Paddle (Fatia 2A).
 *
 * Fonte canônica do estado de assinatura. `platform_users.plan` é cache
 * derivado (atualizado pelo webhook); esta tabela é a fonte de verdade.
 * Grace period: status='canceled' + current_period_end > now = ainda Pro.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { subscriptions, platformUsers } from '@shared/schema-unified';
import type { Subscription } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import type { PlanType } from '../config/free-tier';

export interface ActivePlan {
  plan: PlanType;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

class SubscriptionService {
  private async ensure(): Promise<void> {
    await ensureVibePlatformSchema();
  }

  /**
   * Retorna o plano ativo do usuário. Lógica de grace period:
   * - status='active' → Pro
   * - status='canceled' + current_period_end > now → Pro (grace)
   * - status='canceled' + current_period_end <= now → Free
   * - sem assinatura → Free
   */
  async getActivePlan(userId: number, now: Date = new Date()): Promise<ActivePlan> {
    await this.ensure();
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) {
      return { plan: 'free', status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false };
    }

    const isPro = this.isSubscriptionActive(sub, now);
    return {
      plan: isPro ? 'pro' : 'free',
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }

  /** Verifica se a assinatura concede acesso Pro (incluindo grace period). */
  private isSubscriptionActive(sub: Subscription, now: Date): boolean {
    if (sub.status === 'active') return true;
    if (sub.status === 'canceled' && sub.currentPeriodEnd) {
      return sub.currentPeriodEnd > now;
    }
    return false;
  }

  /** Upsert idempotente via paddle_subscription_id (unique). */
  async upsertFromWebhook(payload: {
    paddleSubscriptionId: string;
    paddleCustomerId?: string | null;
    userId: number;
    status: string;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  }): Promise<Subscription> {
    await this.ensure();
    const [row] = await db
      .insert(subscriptions)
      .values({
        userId: payload.userId,
        plan: 'pro',
        status: payload.status,
        paddleSubscriptionId: payload.paddleSubscriptionId,
        paddleCustomerId: payload.paddleCustomerId ?? null,
        currentPeriodEnd: payload.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: payload.cancelAtPeriodEnd ?? false,
      })
      .onConflictDoUpdate({
        target: subscriptions.paddleSubscriptionId,
        set: {
          status: payload.status,
          currentPeriodEnd: payload.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: payload.cancelAtPeriodEnd ?? false,
          paddleCustomerId: payload.paddleCustomerId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Atualiza cache `platform_users.plan` derivado do estado da assinatura.
    const now = new Date();
    const isPro = this.isSubscriptionActive(row, now);
    await db
      .update(platformUsers)
      .set({ plan: isPro ? 'pro' : 'free' })
      .where(eq(platformUsers.id, payload.userId));

    return row;
  }

  /** Lista assinaturas do usuário (para dashboard). */
  async listByUser(userId: number): Promise<Subscription[]> {
    await this.ensure();
    return db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt));
  }
}

export const subscriptionService = new SubscriptionService();
