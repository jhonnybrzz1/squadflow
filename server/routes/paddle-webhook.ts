/**
 * Demanda #10364 T2 — webhook handler do Paddle (Fatia 2A).
 *
 * Verificação HMAC-SHA256 da assinatura (`paddle-signature`) usando
 * `PADDLE_WEBHOOK_SECRET`. Idempotência via `onConflictDoUpdate` em
 * `paddle_subscription_id` (unique). Trata eventos:
 * - subscription.created / subscription.updated → upsert Pro
 * - subscription.canceled → status='canceled' + mantém current_period_end (grace)
 *
 * Sem SDK: usa `crypto` nativo do Node. Zero dados de cartão trafegam aqui —
 * Paddle é Merchant of Record e tokeniza tudo.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { asyncHandler, UnauthorizedError } from '../middleware/error-handler';
import { subscriptionService } from '../services/subscription-service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Verifica a assinatura HMAC-SHA256 do Paddle.
 * Paddle envia o header `paddle-signature` com o HMAC do body.
 */
function verifyPaddleSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extrai o user_id do `custom_data` que enviamos no checkout do Paddle.
 * Paddle inclui `custom_data` no payload do webhook.
 */
function extractUserIdFromPayload(data: any): number | null {
  const userId = data?.custom_data?.user_id ?? data?.customData?.user_id;
  if (typeof userId === 'number' && Number.isInteger(userId) && userId > 0) return userId;
  if (typeof userId === 'string') {
    const parsed = parseInt(userId, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** Converte o period end do Paddle (ISO string ou timestamp) para Date. */
function parsePeriodEnd(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'number') {
    // Paddle usa segundos (unix), JS usa milissegundos
    return new Date(value * 1000);
  }
  return null;
}

router.post(
  '/webhooks/paddle',
  asyncHandler(async (req: Request, res: Response) => {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) {
      logger.error('PADDLE_WEBHOOK_SECRET não configurado — webhook rejeitado');
      throw new UnauthorizedError('Webhook secret não configurado.');
    }

    // Express com JSON parser popula req.body, mas precisamos do raw body para
    // verificar a assinatura. Usamos req.rawBody se disponível (express.json
    // com verify), senão fallback para JSON.stringify(req.body).
    const rawBody =
      (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const signature = req.headers['paddle-signature'] as string | undefined;

    if (!verifyPaddleSignature(rawBody, signature, secret)) {
      logger.warn('Paddle webhook: assinatura inválida', {
        context: { hasSignature: !!signature, bodyLength: rawBody.length },
      });
      throw new UnauthorizedError('Assinatura inválida.');
    }

    const { event_type, data } = req.body ?? {};
    if (!event_type || !data) {
      res.status(400).json({ error: 'Payload inválido: event_type ou data ausente.' });
      return;
    }

    const paddleSubscriptionId = data.id;
    if (!paddleSubscriptionId) {
      res.status(400).json({ error: 'Payload inválido: subscription id ausente.' });
      return;
    }

    const userId = extractUserIdFromPayload(data);
    if (!userId) {
      logger.error('Paddle webhook: user_id ausente em custom_data', {
        context: { paddleSubscriptionId, eventType: event_type },
      });
      res.status(400).json({ error: 'user_id ausente em custom_data.' });
      return;
    }

    logger.info('Paddle webhook recebido', {
      context: { eventType: event_type, paddleSubscriptionId, userId },
    });

    switch (event_type) {
      case 'subscription.created':
      case 'subscription.updated': {
        await subscriptionService.upsertFromWebhook({
          paddleSubscriptionId,
          paddleCustomerId: data.customer_id ?? null,
          userId,
          status: data.status ?? 'active',
          currentPeriodEnd: parsePeriodEnd(
            data.current_billing_period?.ends_at ?? data.next_billed_at,
          ),
          cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel',
        });
        break;
      }
      case 'subscription.canceled': {
        await subscriptionService.upsertFromWebhook({
          paddleSubscriptionId,
          paddleCustomerId: data.customer_id ?? null,
          userId,
          status: 'canceled',
          // Mantém current_period_end para grace period
          currentPeriodEnd: parsePeriodEnd(
            data.canceled_effective_date ?? data.current_billing_period?.ends_at,
          ),
          cancelAtPeriodEnd: true,
        });
        break;
      }
      default:
        // Eventos não tratados (ex: payment.succeeded) — 200 OK silencioso
        logger.debug('Paddle webhook: evento não tratado (ack silencioso)', {
          context: { eventType: event_type },
        });
    }

    res.status(200).json({ received: true });
  }),
);

export default router;
