/**
 * Demanda #10358 T3 — métrica de ativação: tempo entre abrir a plataforma
 * (`abertura_da_plataforma`) e receber o primeiro refinamento
 * (`primeiro_refinamento_recebido`).
 *
 * Cada evento é gravado apenas na primeira ocorrência por usuário — a métrica
 * de ativação é sobre a PRIMEIRA sessão/PRIMEIRO refinamento, e logar toda
 * abertura de página ruidosamente impediria calcular isso de forma limpa.
 */
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { analyticsEvents } from '@shared/schema-unified';
import { ensureVibePlatformSchema } from './vibe-platform-schema';

export const PLATFORM_OPENED_EVENT = 'abertura_da_plataforma';
export const FIRST_REFINEMENT_EVENT = 'primeiro_refinamento_recebido';

class PlatformAnalyticsService {
  private async hasEvent(userId: number, eventType: string): Promise<boolean> {
    await ensureVibePlatformSchema();
    const [row] = await db
      .select()
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.userId, userId), eq(analyticsEvents.eventType, eventType)))
      .orderBy(asc(analyticsEvents.createdAt))
      .limit(1);
    return Boolean(row);
  }

  async logEventOnce(userId: number, eventType: string): Promise<void> {
    await ensureVibePlatformSchema();
    if (await this.hasEvent(userId, eventType)) return;
    await db.insert(analyticsEvents).values({ userId, eventType });
  }

  logPlatformOpenedOnce(userId: number): Promise<void> {
    return this.logEventOnce(userId, PLATFORM_OPENED_EVENT);
  }

  logFirstRefinementOnce(userId: number): Promise<void> {
    return this.logEventOnce(userId, FIRST_REFINEMENT_EVENT);
  }
}

export const platformAnalyticsService = new PlatformAnalyticsService();
