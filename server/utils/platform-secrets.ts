/**
 * Demanda #10358 — validação dos segredos da plataforma pública
 * (`JWT_SECRET`, `GIT_TOKEN_SECRET`), no mesmo padrão de
 * `server/utils/admin-api-key.ts`: comprimento mínimo + rejeição de
 * placeholders conhecidos, sem regex.
 */
import { AppError } from '../middleware/error-handler';

const KNOWN_PLACEHOLDERS = [
  'your_jwt_secret_here',
  'your_git_token_secret_here',
  'change_me',
  'secret',
  'password',
  '123456',
  '00000000',
  // Valores publicados em `.env.example`. Aceita-los permitiria a qualquer leitor
  // do repositorio forjar JWT de sessao, forjar o `state` do OAuth e derivar a
  // chave AES que cifra tokens do GitHub e credenciais de banco em repouso.
  'change_this_to_a_long_random_dev_only_secret',
  'change_this_to_a_long_random_dev_only_secret_too',
];

export interface PlatformSecretValidation {
  ok: boolean;
  reason?: 'missing' | 'too_short' | 'placeholder';
}

export function validatePlatformSecret(value: string | undefined): PlatformSecretValidation {
  if (!value) return { ok: false, reason: 'missing' };
  if (value.length < 16) return { ok: false, reason: 'too_short' };
  if (KNOWN_PLACEHOLDERS.includes(value.toLowerCase())) {
    return { ok: false, reason: 'placeholder' };
  }
  return { ok: true };
}

function requireSecret(envVar: 'JWT_SECRET' | 'GIT_TOKEN_SECRET'): string {
  const value = process.env[envVar];
  const check = validatePlatformSecret(value);
  if (!check.ok) {
    throw new AppError(
      `${envVar} não configurado ou inválido (${check.reason}). Configure um valor forte em .env antes de usar a plataforma pública.`,
      500,
      'CONFIG_ERROR',
      { envVar, reason: check.reason },
    );
  }
  return value as string;
}

export function getJwtSecret(): string {
  return requireSecret('JWT_SECRET');
}

export function getGitTokenSecret(): string {
  return requireSecret('GIT_TOKEN_SECRET');
}
