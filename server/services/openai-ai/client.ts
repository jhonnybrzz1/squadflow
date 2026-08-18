/**
 * Demanda 10209 — Fase 1: client/retry/timeout extraídos do god object.
 *
 * O módulo delega ao llmClientManager e llm-completion-service existentes,
 * evitando duplicação de lógica de provider/timeout/retry.
 */
import { llmClientManager, type AIProvider } from '../llm-client-manager';

export { AIProvider };

export function getLLMClient(provider: AIProvider) {
  return llmClientManager.getClient(provider);
}

export function hasLLMClient(provider: AIProvider): boolean {
  return llmClientManager.hasClient(provider);
}
