/* eslint-disable no-restricted-syntax -- este arquivo define o registry; os valores string aqui são a fonte canônica. */

/**
 * Registry canônico de papéis de agente.
 *
 * Fonte única da verdade para todos os papéis usados no sistema.
 * Módulo folha — sem imports de shared/schema ou outros módulos shared.
 */

export enum AgentRole {
  product_owner = 'product_owner',
  product_manager = 'product_manager',
  scrum_master = 'scrum_master',
  tech_lead = 'tech_lead',
  qa = 'qa',
  architect = 'architect',
  analista_de_dados = 'analista_de_dados',
  security_specialist = 'security_specialist',
  ux = 'ux',
  anti_overengineering = 'anti_overengineering',
  financial_analyst = 'financial_analyst',
  devops = 'devops',
  pm_innovation = 'pm_innovation',
  pm_discovery = 'pm_discovery',
}

/** Lista de todos os papéis canônicos. */
export const ALL_AGENT_ROLES = Object.values(AgentRole) as AgentRole[];

/** Squad padrão da mesa redonda (7 agentes). */
export const DEFAULT_ROUNDTABLE_AGENTS: AgentRole[] = [
  AgentRole.product_owner,
  AgentRole.product_manager,
  AgentRole.architect,
  AgentRole.tech_lead,
  AgentRole.qa,
  AgentRole.scrum_master,
  AgentRole.anti_overengineering,
];

/**
 * Quórum mínimo da mesa redonda (spec 10081).
 *
 * ALTO-01: esta regra vivia só como literal `3` dentro de
 * `DemandService.enrich()`. A triagem dinâmica não a conhecia e garantia apenas
 * `length > 0`, então uma squad enxuta e legítima (ex.: `product_owner` + 1
 * especialista) era montada pela triagem e depois REJEITADA com 400 no
 * `POST /api/demands`. Quem seleciona agentes deve importar esta constante.
 */
export const MIN_ROUNDTABLE_AGENTS = 3;

/** Labels legíveis para exibição no frontend. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  [AgentRole.product_owner]: 'Product Owner',
  [AgentRole.product_manager]: 'Product Manager',
  [AgentRole.architect]: 'Arquiteto',
  [AgentRole.tech_lead]: 'Tech Lead',
  [AgentRole.qa]: 'QA',
  [AgentRole.scrum_master]: 'Scrum Master',
  [AgentRole.anti_overengineering]: 'Anti-overengineering',
  [AgentRole.analista_de_dados]: 'Analista de Dados',
  [AgentRole.security_specialist]: 'Security Specialist',
  [AgentRole.ux]: 'UX Designer',
  [AgentRole.financial_analyst]: 'Analista Financeiro',
  [AgentRole.devops]: 'DevOps',
  [AgentRole.pm_innovation]: 'PM Inovação',
  [AgentRole.pm_discovery]: 'PM Discovery',
};

/**
 * Aliases de entrada livre → chave canônica do registry.
 * Consolida aliases de agent-identity.ts e outras fontes.
 */
export const AGENT_ROLE_ALIASES: Record<string, AgentRole> = {
  [AgentRole.anti_overengineering]: AgentRole.anti_overengineering,
  'anti-overengineering': AgentRole.anti_overengineering,
  'anti overengineering': AgentRole.anti_overengineering,
  [AgentRole.analista_de_dados]: AgentRole.analista_de_dados,
  'analista de dados': AgentRole.analista_de_dados,
  data_analyst: AgentRole.analista_de_dados,
  'data analyst': AgentRole.analista_de_dados,
  pm: AgentRole.product_manager,
  [AgentRole.pm_innovation]: AgentRole.pm_innovation,
  'pm innovation': AgentRole.pm_innovation,
  'pm inovacao': AgentRole.pm_innovation,
  'pm inovação': AgentRole.pm_innovation,
  [AgentRole.pm_discovery]: AgentRole.pm_discovery,
  'pm discovery': AgentRole.pm_discovery,
  [AgentRole.product_manager]: AgentRole.product_manager,
  'product manager': AgentRole.product_manager,
  [AgentRole.product_owner]: AgentRole.product_owner,
  'product owner': AgentRole.product_owner,
  po: AgentRole.product_owner,
  [AgentRole.qa]: AgentRole.qa,
  [AgentRole.scrum_master]: AgentRole.scrum_master,
  'scrum master': AgentRole.scrum_master,
  sm: AgentRole.scrum_master,
  [AgentRole.security_specialist]: AgentRole.security_specialist,
  'security specialist': AgentRole.security_specialist,
  [AgentRole.architect]: AgentRole.architect,
  arquiteto: AgentRole.architect,
  [AgentRole.financial_analyst]: AgentRole.financial_analyst,
  'financial analyst': AgentRole.financial_analyst,
  'analista financeiro': AgentRole.financial_analyst,
  [AgentRole.tech_lead]: AgentRole.tech_lead,
  'tech lead': AgentRole.tech_lead,
  tl: AgentRole.tech_lead,
  [AgentRole.ux]: AgentRole.ux,
  ux_designer: AgentRole.ux,
  'ux designer': AgentRole.ux,
  [AgentRole.devops]: AgentRole.devops,
};

/**
 * Valida se uma string é um papel canônico registrado.
 */
export function isValidRole(value: string): value is AgentRole {
  return (ALL_AGENT_ROLES as string[]).includes(value);
}

/**
 * @deprecated Use {@link AgentRole} enum diretamente. Mantido para retrocompatibilidade.
 */
export const AGENT_ROLES = ALL_AGENT_ROLES.reduce(
  (acc, role) => {
    acc[role] = role;
    return acc;
  },
  {} as Record<AgentRole, AgentRole>,
);
