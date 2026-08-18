/**
 * Demanda #10358 T1 — captura de demanda na landing page (waitlist).
 *
 * Reaproveita o padrão `ensureSchema()` + Drizzle tipado descrito em
 * `server/services/vibe-platform-schema.ts` / `backlog-activity-service.ts`.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { waitlist } from '@shared/schema-unified';
import type { WaitlistEntry } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';

class WaitlistService {
  async add(email: string, source?: string): Promise<{ entry: WaitlistEntry; created: boolean }> {
    await ensureVibePlatformSchema();
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await db
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, normalizedEmail))
      .limit(1);
    if (existing[0]) {
      return { entry: existing[0], created: false };
    }

    const [entry] = await db
      .insert(waitlist)
      .values({ email: normalizedEmail, source: source?.trim() || 'landing' })
      .returning();
    return { entry, created: true };
  }

  async count(): Promise<number> {
    await ensureVibePlatformSchema();
    const rows = await db.select().from(waitlist);
    return rows.length;
  }
}

export const waitlistService = new WaitlistService();
