/**
 * Demanda #10358 T4 — criptografia do access token do GitHub em repouso.
 *
 * AES-256-GCM com `node:crypto` builtin (sem dependência nova), chave de
 * `GIT_TOKEN_SECRET` (32 bytes derivados via SHA-256 do segredo configurado).
 * Formato armazenado: `iv:authTag:ciphertext` (hex), tudo em uma única coluna
 * TEXT — simples de migrar/inspecionar sem expor o token em claro.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getGitTokenSecret } from '../utils/platform-secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM

function deriveKey(): Buffer {
  return createHash('sha256').update(getGitTokenSecret()).digest();
}

export function encryptGitToken(plainToken: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptGitToken(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Formato de token criptografado inválido.');
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
