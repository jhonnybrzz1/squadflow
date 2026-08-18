/**
 * M-1: migra o prompt inline do tech_lead.yaml para a tabela prompt_versions.
 *
 * Uso: npx tsx scripts/migrate-techlead-prompt.ts
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { resolvePath } from '@shared/utils/paths';
import { promptVersionService } from '../server/services/prompt-version';
import { logger } from '../server/utils/logger';

interface AgentYaml {
  version?: string;
  system_prompt?: string;
  [key: string]: unknown;
}

async function main() {
  const agentId = 'tech_lead';
  const yamlPath = resolvePath(path.join('agents', `${agentId}.yaml`));

  if (!fs.existsSync(yamlPath)) {
    logger.error('M-1: agents/tech_lead.yaml não encontrado');
    process.exit(1);
  }

  const raw = fs.readFileSync(yamlPath, 'utf8');
  const parsed = yaml.load(raw) as AgentYaml;
  const content = parsed.system_prompt?.trim();

  if (!content || content.length <= 10) {
    logger.error('M-1: system_prompt de tech_lead vazio ou malformado');
    process.exit(1);
  }

  const version = parsed.version ?? '1.0.0';
  const existing = await promptVersionService.getActiveVersion(agentId);

  if (existing) {
    logger.info('M-1: tech_lead já possui versão ativa no banco', {
      version: existing.version,
    });
    return;
  }

  const created = await promptVersionService.createVersion({
    promptName: agentId,
    version,
    content,
    author: 'migration',
    description: 'Migração do system_prompt inline do agents/tech_lead.yaml',
  });

  if (!created) {
    logger.error('M-1: falha ao criar versão do tech_lead');
    process.exit(1);
  }

  await promptVersionService.activateVersion(agentId, version);
  logger.info('M-1: tech_lead migrado para prompt_versions', { version });
}

main().catch((err) => {
  logger.error('M-1: erro na migração do tech_lead', { error: err });
  process.exit(1);
});
