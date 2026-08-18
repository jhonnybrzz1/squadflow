/**
 * Derivados do registry de papéis de agente.
 *
 * Centraliza squads, aliases, acesso e filtros sem importar módulos de agentes,
 * evitando ciclos de dependência.
 */
import { AgentRole } from './agent-roles';

/** Squad padrão de refinamento/mesa redonda (7 agentes). */
export const DEFAULT_REFINEMENT_SQUAD: AgentRole[] = [
  AgentRole.product_owner,
  AgentRole.product_manager,
  AgentRole.architect,
  AgentRole.tech_lead,
  AgentRole.qa,
  AgentRole.scrum_master,
  AgentRole.anti_overengineering,
];

/** Papéis com acesso a ferramentas DevOps. */
export const DEVOPS_ACCESS_ROLES: AgentRole[] = [AgentRole.devops, AgentRole.security_specialist];

/** Papéis considerados críticos para validação de demanda. */
export const CRITICAL_REVIEW_ROLES: AgentRole[] = [
  AgentRole.product_owner,
  AgentRole.qa,
  AgentRole.tech_lead,
];

/** Aliases legados → papel canônico. */
export const LEGACY_AGENT_ALIASES: Record<string, AgentRole> = {
  pm: AgentRole.product_manager,
  po: AgentRole.product_owner,
  tl: AgentRole.tech_lead,
  sm: AgentRole.scrum_master,
};
