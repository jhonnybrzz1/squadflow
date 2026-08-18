import { resolvePath } from '@shared/utils/paths';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { canonicalAgentKey } from './agent-identity';
import { PRO_TIER_FALLBACK_MODEL } from './llm-model-router';
import type { GenerateOptions } from './openai-ai';

/**
 * H-35: Agent model allocation.
 *
 * Previously the agent→model mapping was defined in 4 places:
 *   1. AGENT_MODEL_TABLE constant (this file) — hardcoded, manually mirrored
 *   2. agents/*.yaml — `model` and `model_fallback` fields
 *   3. modelAliases Drizzle table (SQLite schema)
 *   4. modelAliases Drizzle table (Postgres schema)
 *
 * (3) and (4) are mirrors of the same table for the dual-dialect DB setup —
 * that's expected. The real duplication was (1) vs (2): the constant had to
 * be manually kept in sync with the YAML files, and the audit found 6 agents
 * where the YAML was silently ignored because the constant diverged.
 *
 * Now AGENT_MODEL_TABLE is built FROM the YAML files at module load time,
 * making `agents/*.yaml` the single source of truth. The parity test
 * (tests/unit/agent-model-policy-parity.test.ts) still runs to catch any
 * future regressions in the YAML loading logic.
 */

interface AgentYaml {
  name?: string;
  model?: string;
  model_fallback?: string;
}

const AGENTS_DIR = resolvePath('agents');

/**
 * Builds the agent→model table from agents/*.yaml files.
 * Falls back to an empty table if the directory doesn't exist (e.g., in
 * some test environments), in which case applyAgentModelPolicy uses
 * DEFAULT_ALLOCATION for all agents.
 */
function buildAgentModelTableFromYamls(): Record<string, { model: string; modelFallback: string }> {
  const table: Record<string, { model: string; modelFallback: string }> = {};

  if (!existsSync(AGENTS_DIR)) {
    return table;
  }

  const yamlFiles = readdirSync(AGENTS_DIR).filter(
    (f) => f.endsWith('.yaml') && !f.startsWith('EXAMPLE-'),
  );

  for (const file of yamlFiles) {
    try {
      const content = readFileSync(resolve(AGENTS_DIR, file), 'utf8');
      const config = load(content) as AgentYaml;
      const key = canonicalAgentKey(config.name ?? file.replace(/\.yaml$/, ''));
      if (config.model) {
        table[key] = {
          model: config.model,
          modelFallback: config.model_fallback ?? PRO_TIER_FALLBACK_MODEL,
        };
      }
    } catch (_) {
      // Skip malformed YAML files — the parity test will catch these.
    }
  }

  return table;
}

export const AGENT_MODEL_TABLE: Record<string, { model: string; modelFallback: string }> =
  buildAgentModelTableFromYamls();

const DEFAULT_ALLOCATION = {
  model: 'deepseek/deepseek-v4-flash',
  modelFallback: 'mistral-medium-3.5',
} as const;

export function applyAgentModelPolicy<T>(options: GenerateOptions<T>): GenerateOptions<T> {
  if (!options.agentName) {
    return { ...options, ...DEFAULT_ALLOCATION };
  }

  const allocation = AGENT_MODEL_TABLE[canonicalAgentKey(options.agentName)] ?? DEFAULT_ALLOCATION;
  return { ...options, ...allocation };
}
