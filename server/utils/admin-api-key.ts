/**
 * CRIT-1 (10099 Fase 0): validação mínima da ADMIN_API_KEY no startup.
 * Demanda 10217: verificação constant-time de requisições admin.
 *
 * Evita expor a API admin (auth ainda é stub) com chave ausente, curta ou
 * placeholder conhecido. Não usa regex (acordo do PRD: length + placeholder).
 */

const KNOWN_PLACEHOLDERS = [
  'your_admin_api_key_here',
  'change_me',
  'admin',
  'password',
  '123456',
  '00000000',
];

export interface AdminApiKeyValidation {
  ok: boolean;
  reason?: 'missing' | 'too_short' | 'placeholder';
}

export function validateAdminApiKey(value: string | undefined): AdminApiKeyValidation {
  if (!value) return { ok: false, reason: 'missing' };
  if (value.length < 16) return { ok: false, reason: 'too_short' };
  if (KNOWN_PLACEHOLDERS.includes(value.toLowerCase())) {
    return { ok: false, reason: 'placeholder' };
  }
  return { ok: true };
}

import { timingSafeEqual } from 'node:crypto';

/**
 * Verifica se o header `Authorization: Bearer <chave>` confere com a
 * `ADMIN_API_KEY` configurada, usando comparação constant-time.
 * Rejeita chaves com tamanhos diferentes antes de comparar buffers.
 */
export function verifyAdminApiKey(headerValue: string | undefined): boolean {
  const configured = process.env.ADMIN_API_KEY?.trim();
  if (!configured || configured.length < 16) return false;

  const prefix = 'Bearer ';
  if (!headerValue || !headerValue.startsWith(prefix)) return false;

  const provided = headerValue.slice(prefix.length).trim();
  if (provided.length < 16) return false;

  if (provided.length !== configured.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
  } catch {
    return false;
  }
}
