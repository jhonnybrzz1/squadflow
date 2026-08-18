import { z } from 'zod';

const finiteNonNegativeNumber = z.number().finite().nonnegative();

// Saldo REAL da conta vem de `GET /api/v1/credits` — `total_credits`/`total_usage`,
// o mesmo par que o dashboard do OpenRouter mostra. NÃO usar `/auth/key`: o `limit`
// de lá é o teto DA CHAVE (ex.: $60), não os créditos da conta, então `limit - usage`
// dava um valor errado (remaining do teto da chave em vez do saldo).
export const openRouterCreditsPayloadSchema = z.object({
  data: z.object({
    total_credits: finiteNonNegativeNumber,
    total_usage: finiteNonNegativeNumber,
  }),
});

export const balanceStatusSchema = z.enum(['ok', 'low', 'empty', 'error']);

export const balanceSnapshotSchema = z.object({
  usage: finiteNonNegativeNumber,
  limit: finiteNonNegativeNumber.nullable(),
  balance: z.number().finite().nullable(),
  currency: z.literal('USD'),
  cachedAt: z.string().datetime(),
  status: balanceStatusSchema.exclude(['error']),
});

export const balanceResponseSchema = balanceSnapshotSchema.omit({ status: true }).extend({
  stale: z.boolean(),
  status: balanceStatusSchema,
});

export type OpenRouterCreditsPayload = z.infer<typeof openRouterCreditsPayloadSchema>;
export type BalanceStatus = z.infer<typeof balanceStatusSchema>;
export type BalanceSnapshot = z.infer<typeof balanceSnapshotSchema>;
export type BalanceResponse = z.infer<typeof balanceResponseSchema>;

export function classifyBalance(
  balance: number | null,
  lowBalanceThreshold: number,
): Exclude<BalanceStatus, 'error'> {
  if (balance === null) return 'ok';
  if (balance <= 0) return 'empty';
  if (balance <= lowBalanceThreshold) return 'low';
  return 'ok';
}
