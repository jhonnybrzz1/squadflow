import { AGENT_ROLE_ALIASES, isValidRole } from '../../shared/agent-roles';
import { logger } from '../utils/logger';

export { AGENT_ROLE_ALIASES };

/** @deprecated Use AGENT_ROLE_ALIASES from shared/agent-roles.ts. */
export const AGENT_KEY_ALIASES = AGENT_ROLE_ALIASES;

export function canonicalAgentKey(value: string): string {
  const withoutAgentSuffix = value.replace(/\s+agent$/i, '');
  const normalized = withoutAgentSuffix
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  const alias = AGENT_KEY_ALIASES[normalized];
  if (alias) return alias;

  const snakeCase = normalized.replace(/\s+/g, '_');
  const resolved = AGENT_KEY_ALIASES[snakeCase] || snakeCase;

  // 10210: shim de retrocompatibilidade — loga warning para chaves não registradas.
  if (!isValidRole(resolved)) {
    logger.warn('Agent key not registered in AgentRole registry', {
      context: { raw: value, resolved, timestamp: new Date().toISOString() },
    });
  }

  return resolved;
}

export function canonicalizeAgentConfigMap<T>(configs: Record<string, T>): Record<string, T> {
  const canonicalConfigs: Record<string, T> = {};

  for (const [agentName, config] of Object.entries(configs)) {
    canonicalConfigs[canonicalAgentKey(agentName)] = config;
  }

  return canonicalConfigs;
}
