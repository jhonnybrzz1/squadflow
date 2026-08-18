import type { AIChatMessage } from './openai-ai';
import { estimateTextTokens } from './ai-usage-tracker';

const DEFAULT_HISTORY_TURNS = 10;

/**
 * Prepares messages for LLM processing by normalizing, filtering, and trimming.
 *
 * @param messages - Original messages
 * @param options - Generation options
 * @returns Prepared messages
 */
export function prepareMessages(
  messages: AIChatMessage[],
  options: { maxHistoryTurns?: number; summaryMemory?: string },
): AIChatMessage[] {
  const normalizedMessages = messages
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (normalizedMessages.length === 0) {
    throw new Error('At least one chat message is required.');
  }

  const instructionMessages: AIChatMessage[] = [];
  let conversationStartIndex = 0;

  while (
    conversationStartIndex < normalizedMessages.length &&
    isInstructionRole(normalizedMessages[conversationStartIndex].role)
  ) {
    instructionMessages.push(normalizedMessages[conversationStartIndex]);
    conversationStartIndex += 1;
  }

  const conversationMessages = normalizedMessages.slice(conversationStartIndex);
  const historyTurns = options.maxHistoryTurns ?? DEFAULT_HISTORY_TURNS;
  const trimmedConversation = trimConversationHistory(conversationMessages, historyTurns);
  const summaryMemory = options.summaryMemory?.trim();
  const summaryMessage: AIChatMessage[] = summaryMemory
    ? [
        {
          role: 'system',
          content: `Resumo persistente da conversa:\n${summaryMemory}`,
        },
      ]
    : [];

  return [...instructionMessages, ...summaryMessage, ...trimmedConversation];
}

/**
 * Trims conversation history to a specified number of user turns.
 *
 * @param messages - Conversation messages
 * @param maxHistoryTurns - Maximum number of user turns to keep
 * @returns Trimmed conversation
 */
export function trimConversationHistory(
  messages: AIChatMessage[],
  maxHistoryTurns: number,
): AIChatMessage[] {
  if (maxHistoryTurns <= 0) {
    return messages;
  }

  let userTurns = 0;
  let startIndex = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userTurns += 1;

      if (userTurns > maxHistoryTurns) {
        break;
      }
    }

    startIndex = index;
  }

  return messages.slice(startIndex);
}

/**
 * Estimates the number of tokens in a message array.
 *
 * @param messages - Messages to estimate
 * @returns Estimated token count
 */
export function estimateMessagesTokens(messages: AIChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content), 0);
}

/**
 * Canonicalizes messages for cache stability by normalizing dynamic values.
 *
 * @param messages - Messages to canonicalize
 * @returns Canonicalized messages
 */
export function canonicalizeMessages(messages: AIChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    name: message.name || null,
    content: canonicalizeText(message.content),
  }));
}

/**
 * Canonicalizes a cache value recursively.
 *
 * @param value - Value to canonicalize
 * @returns Canonicalized value
 */
export function canonicalizeCacheValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return canonicalizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeCacheValue(item));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const canonicalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record)) {
      canonicalized[key] = canonicalizeCacheValue(nestedValue);
    }
    return canonicalized;
  }

  return value;
}

/**
 * Canonicalizes text for cache key computation.
 *
 * H-13: Previously this function replaced UUIDs, timestamps, and hashes with
 * placeholders (`<uuid>`, `<datetime>`, `<hash>`). This was intended for cache
 * stability, but it made the cache TOO aggressive: two demands with different
 * UUIDs or timestamps in their prompts would produce the same cache key,
 * causing a cache hit and returning the wrong response. UUIDs and timestamps
 * are meaningful distinctions in prompt content and must be preserved.
 *
 * What remains:
 * - API key redaction (`sk-...`): security — never let a raw API key enter
 *   the cache key hash.
 * - Request/session/user ID redaction: these are runtime metadata that
 *   should not affect cache identity.
 *
 * @param text - Text to canonicalize
 * @returns Canonicalized text with only security-sensitive values redacted
 */
export function canonicalizeText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '<api-key>')
    .replace(/requestId\s*[:=]\s*[a-zA-Z0-9_-]+/gi, 'requestId=<id>')
    .replace(/user_id\s*[:=]\s*\d+/gi, 'user_id=<id>')
    .replace(/session_id\s*[:=]\s*[a-zA-Z0-9_-]+/gi, 'session_id=<id>');
}

/**
 * Checks if a role is an instruction role (system or developer).
 *
 * @param role - Role to check
 * @returns true if the role is an instruction role
 */
export function isInstructionRole(role: string): boolean {
  return role === 'system' || role === 'developer';
}
