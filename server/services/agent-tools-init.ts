/**
 * Agent Tools Initialization
 *
 * Registra todas as ferramentas dos agentes no startup.
 * Deve ser chamado uma única vez durante a inicialização do servidor.
 */
import { logger } from '../utils/logger';
import { registerTechLeadTools } from './tech-lead-tools';
import { registerProductManagerTools } from './product-manager-tools';
import { registerQATools } from './qa-tools';
import { registerScrumMasterTools } from './scrum-master-tools';
import { registerFormTools } from './form-tools';
import { registerDevOpsTools } from './devops-tools';
import { getAllRegisteredTools } from './agent-tools-registry';

let initialized = false;
// Tracks how many times initialization was attempted after the first call.
// A value > 0 means the calling code likely creates multiple AISquadService
// instances — acceptable, but worth knowing about.
let extraCallCount = 0;

/**
 * Inicializa todas as ferramentas dos agentes.
 * Seguro para chamar múltiplas vezes (idempotente): o registro usa um Map
 * por nome, então re-registrar a mesma tool é uma operação nula.
 */
export function initializeAgentTools(): void {
  if (initialized) {
    extraCallCount++;
    if (extraCallCount === 1) {
      // Log only once to avoid noise
      logger.debug('Agent tools já inicializadas — chamada extra ignorada', {
        context: { extraCallCount },
      });
    }
    return;
  }

  logger.info('Inicializando agent tools...');

  // Registrar tools de cada agente
  registerTechLeadTools();
  registerProductManagerTools();
  registerQATools();
  registerScrumMasterTools();
  registerFormTools();
  registerDevOpsTools();

  initialized = true;

  // Log resumo
  const allTools = getAllRegisteredTools();
  const byAgent: Record<string, string[]> = {};

  for (const tool of allTools) {
    for (const agent of tool.agentAccess) {
      if (!byAgent[agent]) byAgent[agent] = [];
      byAgent[agent].push(tool.name);
    }
  }

  logger.info('Agent tools inicializadas', {
    context: {
      totalTools: allTools.length,
      toolsByAgent: Object.fromEntries(
        Object.entries(byAgent).map(([agent, tools]) => [agent, tools.length]),
      ),
    },
  });
}

/**
 * Retorna se as tools foram inicializadas.
 */
export function areAgentToolsInitialized(): boolean {
  return initialized;
}

/**
 * Reset para testes.
 */
export function resetAgentToolsInit(): void {
  initialized = false;
  extraCallCount = 0;
}
