import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { resolvePath } from '@shared/utils/paths';
import { logger } from '../utils/logger';
import { promptVersionService } from './prompt-version';

const PROMPTS_DIR = 'prompts/system';

export interface LoadedSystemPrompt {
  content: string;
  promptHash: string;
  sourcePath: string;
}

/**
 * Carrega o system prompt de um arquivo externo e calcula o SHA-256 do conteúdo
 * BRUTO (não renderizado). O hash é usado na cache key para invalidação segura
 * quando o arquivo muda.
 *
 * @param agentId Identificador do agente (ex: product_manager, tech_lead).
 * @returns Objeto com conteúdo, hash e caminho, ou null se não encontrado.
 */
export function loadSystemPrompt(agentId: string): LoadedSystemPrompt | null {
  const filePath = resolvePath(path.join(PROMPTS_DIR, `${agentId}.md`));
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const promptHash = crypto.createHash('sha256').update(content).digest('hex');
    return { content, promptHash, sourcePath: filePath };
  } catch (err) {
    logger.warn('Falha ao carregar system prompt externo', {
      error: err instanceof Error ? err : undefined,
      context: { agentId, filePath },
    });
    return null;
  }
}

interface AgentYamlConfig {
  system_prompt?: string;
  [key: string]: unknown;
}

/**
 * M-1: carrega o prompt de um agente com versionamento em SQLite e fallback
 * inline do YAML / arquivo .md. A lógica de A/B (weight) e cache de 5 min
 * fica no promptVersionService.
 */
function isValidPrompt(content: unknown): content is string {
  return typeof content === 'string' && content.trim().length > 10;
}

export async function getPromptForAgent(
  agentId: string,
  sessionId?: string,
): Promise<LoadedSystemPrompt | null> {
  const versioned = await promptVersionService.resolveVersion(agentId, sessionId);
  if (versioned && isValidPrompt(versioned.content)) {
    const promptHash = crypto.createHash('sha256').update(versioned.content).digest('hex');
    return {
      content: versioned.content,
      promptHash,
      sourcePath: `prompt_version:${agentId}:${versioned.version}`,
    };
  }

  // Fallback 1: prompt inline no arquivo agents/{agentId}.yaml
  const yamlPath = resolvePath(path.join('agents', `${agentId}.yaml`));
  if (fs.existsSync(yamlPath)) {
    try {
      const raw = fs.readFileSync(yamlPath, 'utf8');
      const parsed = yaml.load(raw) as AgentYamlConfig;
      if (
        parsed.system_prompt &&
        typeof parsed.system_prompt === 'string' &&
        parsed.system_prompt.trim().length > 10
      ) {
        const promptHash = crypto.createHash('sha256').update(parsed.system_prompt).digest('hex');
        return { content: parsed.system_prompt, promptHash, sourcePath: yamlPath };
      }
    } catch (err) {
      logger.warn('M-1: falha ao carregar system prompt do YAML', {
        error: err instanceof Error ? err : undefined,
        context: { agentId, yamlPath },
      });
    }
  }

  // Fallback 2: arquivo prompts/system/{agentId}.md
  return loadSystemPrompt(agentId);
}

/**
 * Retorna apenas o SHA-256 do conteúdo bruto do arquivo de system prompt.
 * Útil para compor cache key sem carregar o conteúdo em memória.
 */
export function getPromptHash(agentId: string): string | null {
  const filePath = resolvePath(path.join(PROMPTS_DIR, `${agentId}.md`));
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    logger.warn('Falha ao calcular hash do system prompt', {
      error: err instanceof Error ? err : undefined,
      context: { agentId, filePath },
    });
    return null;
  }
}
