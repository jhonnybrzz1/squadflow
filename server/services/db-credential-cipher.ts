/**
 * Demanda #10365 T1 — cipher genérico para credenciais de banco (Fatia 2B).
 *
 * Reaproveita `git-token-cipher.ts` (AES-256-GCM com IV aleatório por registro,
 * formato `iv:authTag:ciphertext`). O cipher original já é seguro para strings
 * longas com caracteres especiais — esta auditoria confirma:
 * - Cada encrypt() gera IV próprio via `randomBytes(12)` ✓
 * - Formato `iv:authTag:ciphertext` (3 partes separadas por ':') ✓
 * - decrypt() extrai IV do próprio registro, não de estado global ✓
 * - Valida 3 partes no split antes de prosseguir ✓
 *
 * Este wrapper existe para separar semanticamente credenciais de banco de
 * tokens Git, permitindo chaves diferentes no futuro se necessário.
 */
import { getGitTokenSecret } from '../utils/platform-secrets';
import { encryptGitToken, decryptGitToken } from './git-token-cipher';

/**
 * Cifra credenciais de banco (string de conexão ou JSON com host/port/user/pass).
 * Reaproveita o mesmo cipher do Git token — AES-256-GCM com IV por registro.
 */
export function encryptDbCredentials(plain: string): string {
  return encryptGitToken(plain);
}

/**
 * Descriptografa credenciais de banco. Deve ser chamado apenas no momento
 * da conexão e o resultado descartado imediatamente (nunca manter em memória
 * estática).
 */
export function decryptDbCredentials(stored: string): string {
  return decryptGitToken(stored);
}
