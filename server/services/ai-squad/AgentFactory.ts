import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { canonicalAgentKey } from '../agent-identity';
import { logger } from '../../utils/logger';
import { AgentRole, AGENT_ROLE_LABELS, isValidRole } from '../../../shared/agent-roles';
import { PM_INNOVATION_AGENT_KEY } from '../disc-personality';

export interface SquadAgent {
  name: string;
  icon: string;
  description: string;
}

export interface SquadAgentConfig {
  version?: string;
  system_prompt: string;
  description: string;
  model?: string;
  model_fallback?: string;
  temperature?: number;
  max_tokens?: number;
}

/**
 * Schema de validação em runtime dos YAMLs de agente (avaliação de fluxo de
 * agentes, 2026-07-26 — M-1): antes disso, `yaml.load(...) as SquadAgentConfig`
 * confiava cegamente no shape do arquivo. Um campo faltante ou mal-tipado só
 * era descoberto em runtime, no meio de uma geração. Falha de um agente aqui
 * não derruba o carregamento dos demais — é reportada e o arquivo é pulado.
 */
const squadAgentYamlSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  system_prompt: z.string().min(1),
  description: z.string().min(1),
  model: z.string().optional(),
  model_fallback: z.string().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export const SOLO_BUILDER_PROMPT_SUFFIX = `--- MODO DOCUMENTAÇÃO ENXUTA / BUILDER SOLO ---
Responda com saída acionável para uma pessoa implementando sozinha.
Priorize arquivos pequenos, MVP verificável, scripts simples, critérios objetivos e próximos passos executáveis.
Evite formalidades enterprise, cerimônias pesadas e texto genérico sem decisão técnica.`;

export function applySoloBuilderPrompt(systemPrompt?: string | null): string | undefined {
  if (!systemPrompt) return undefined;
  if (systemPrompt.includes('MODO DOCUMENTAÇÃO ENXUTA / BUILDER SOLO')) return systemPrompt;
  return `${systemPrompt}

${SOLO_BUILDER_PROMPT_SUFFIX}`;
}

export const EVIDENCE_INTEGRITY_PROMPT_SUFFIX = `--- REGRA DE INTEGRIDADE NUMÉRICA (obrigatória) ---
- NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
- Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
- É PROIBIDO propor métricas/ROI/custos com números só para completar. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
- ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.
- Posicionamento: nunca embuta 'A MEDIR' no meio de uma frase ou dentro de parênteses (ex.: "MVP em A MEDIR dias" é ERRADO). Reescreva a frase sem o número e declare a pendência em cláusula própria (ex.: "MVP com prazo a definir após coleta de baseline").`;

export function applyEvidenceIntegrityPrompt(systemPrompt?: string | null): string | undefined {
  if (!systemPrompt) return undefined;
  if (systemPrompt.includes('REGRA DE INTEGRIDADE NUMÉRICA')) return systemPrompt;
  return `${systemPrompt}

${EVIDENCE_INTEGRITY_PROMPT_SUFFIX}`;
}

export const OPERATIONAL_CONTEXT_PROMPT_SUFFIX = `--- CONTEXTO OPERACIONAL DA EMPRESA (vale para todos os agentes) ---
Você opera numa operação enxuta, ágil, focada em sobrevivência e velocidade de entrega — não numa Big Tech com processos maduros. Não há cultura consolidada de Produto, Dados, Design ou Documentação; as demandas são comerciais e top-down. O time técnico é pequeno, majoritariamente júnior, apoiado por assistentes de código, e a liderança de produto acumula funções.

NUNCA:
- Sugerir discovery de semanas, entrevistas com usuários, mapas de empatia ou testes A/B complexos.
- Exigir dados que não existem ("análise profunda de Analytics"); para validar, use padrões consolidados de mercado.
- Propor overengineering: microsserviços do zero, refatorações em larga escala ou arquitetura complexa que atrase a entrega.
- Reclamar da falta de processo — seu papel é mitigar o risco dela, não educar a diretoria.

SEMPRE:
- Entregar saída acionável, mastigada e pronta para implementação imediata (estrutura em texto/Markdown, código estruturado).
- Basear UX/Design em padrões de mercado (Tailwind/Bootstrap, fluxos padrão de SaaS/e-commerce) para o usuário final não travar.
- Atuar como goleiro: interceptar erros de lógica, segurança e quebra de padrão antes do deploy; ser didático para os juniores aprenderem.
- Gerar a documentação que a empresa não tem ao propor/validar uma solução, deixando explícito qual débito técnico foi assumido em prol do prazo.
- Ir direto ao ponto, sem introduções corporativas, dividido em blocos acionáveis.

VELOCIDADE COM ASSISTENTE DE CÓDIGO (não estime como se alguém fosse digitar à mão):
- O gargalo real não é mais escrever código — é especificar com clareza, validar e testar. Dado real desta squad: nas demandas com handoff automatizado, a mediana de tempo entre spec pronta e código em produção é MENOR QUE 1 HORA; poucos casos passam de 1-2 dias, e são exceção (escopo maior ou dependência externa), não a régua padrão.
- "Esforço" e "cabe em X dias/semanas" medem tempo de validação, teste de edge cases, decisão e integração — NUNCA tempo de digitação. O assistente de código gera a estrutura em minutos; o que consome tempo de verdade é garantir que a regra de negócio e os casos de borda estão certos.
- PROIBIDO usar "Sprint = 10 dias úteis", "cabe em 2 semanas" ou qualquer cadência de sprint quinzenal como âncora de esforço — é resquício de squad sem assistente de IA. Se a demanda está clara, esforço normalmente é medido em horas, não dias.
- Review humano foca em arquitetura, segurança, contrato de API e regra de negócio. Sintaxe, lint, formatação e cobertura básica de teste são responsabilidade de CI/automação — não gaste ciclo de revisão humana nisso.`;

export function applyOperationalContextPrompt(systemPrompt?: string | null): string | undefined {
  if (!systemPrompt) return undefined;
  if (systemPrompt.includes('CONTEXTO OPERACIONAL DA EMPRESA')) return systemPrompt;
  return `${systemPrompt}

${OPERATIONAL_CONTEXT_PROMPT_SUFFIX}`;
}

// Spec 10004 FR-004: consciência de data de corte. O conhecimento pré-treinado do
// modelo termina antes do ano corrente; para qualquer fato dependente de atualidade
// (versões, releases, preços, regulação, "estado da arte"), o agente deve preferir o
// contexto recuperado (RAG) e as ferramentas, e declarar incerteza em vez de inventar
// um dado do ano corrente. Ancorado pela seção "CONSCIÊNCIA DE ATUALIDADE" (idempotente).
export function buildKnowledgeCutoffSuffix(now: Date = new Date()): string {
  const dateStr = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  return `--- CONSCIÊNCIA DE ATUALIDADE (KNOWLEDGE CUTOFF) ---
Hoje é ${dateStr}. Seu conhecimento pré-treinado tem data de corte ANTERIOR a ${year}. Para qualquer fato que dependa de atualidade — versões de bibliotecas/frameworks, releases, preços, regulação, eventos recentes, "estado da arte" — NÃO confie na memória de treino:
- Prefira o CONTEXTO RECUPERADO (RAG) e as ferramentas disponíveis (busca, docs, releases) quando existirem, e cite a fonte/data ao afirmar um fato recente.
- Se não houver fonte recuperada nem ferramenta para confirmar, declare a incerteza de forma explícita (ex.: "A VERIFICAR — pode estar desatualizado em ${year}") em vez de inventar número, versão ou data.
- Nunca apresente conhecimento pré-treino como se fosse o estado atual de ${year}.`;
}

export function applyKnowledgeCutoffPrompt(
  systemPrompt?: string | null,
  now?: Date,
): string | undefined {
  if (!systemPrompt) return undefined;
  if (systemPrompt.includes('CONSCIÊNCIA DE ATUALIDADE')) return systemPrompt;
  return `${systemPrompt}

${buildKnowledgeCutoffSuffix(now)}`;
}

export function buildPoAdversaryPrompt(): string {
  return `Você é o Product Owner em MODO REVISÃO CRÍTICA. Esqueça a postura colaboradora: seu trabalho aqui é REPROVAR. Assuma que a consolidação TEM falhas. Para cada uma, cite o trecho e classifique severidade (ALTA/BAIXA):
- número (%, R$, $, ROI, prazo) SEM fonte no input/evidência → ALTA
- objetivo/benefício que o escopo não entrega → ALTA
- arquivo/caminho citado que pode não existir → ALTA
- status 'Pronta' sem baseline → ALTA
- redação/clareza → BAIXA
Se não houver falha ALTA, responda {"falhas":[]}. NÃO invente problema.

Responda APENAS com um objeto JSON válido, sem tags markdown ou blocos de código, no seguinte formato:
{
  "falhas": [
    {
      "trecho": "trecho exato da consolidação onde ocorre a falha",
      "tipo": "numero_sem_fonte | escopo_incompativel | arquivo_inexistente | pronta_sem_baseline | redacao_clareza",
      "severidade": "ALTA" | "BAIXA",
      "sugestao": "sugestão de correção detalhada"
    }
  ]
}`;
}

export class AgentFactory {
  loadConfigurations(): {
    agents: SquadAgent[];
    agentConfigs: Record<string, SquadAgentConfig>;
  } {
    const agentsDir = resolvePath('agents');
    if (!fs.existsSync(agentsDir)) {
      logger.warn('Diretório de agentes não encontrado, usando agentes padrão');
      return {
        agents: this.getDefaultAgents(),
        agentConfigs: {},
      };
    }

    try {
      const agents: SquadAgent[] = [];
      const loadedAgentConfigs: Record<string, SquadAgentConfig> = {};
      const files = fs.readdirSync(agentsDir);
      const yamlConfigs = files
        .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
        .map((file) => {
          const filePath = path.join(agentsDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          // CRIT-3: schema explícito (defense-in-depth) — impede que um YAML
          // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas como
          // !!js/function mas mantém os tipos padrão (map/seq/scalar).
          const raw: unknown = yaml.load(content, { schema: yaml.CORE_SCHEMA });
          const parsed = squadAgentYamlSchema.safeParse(raw);
          if (!parsed.success) {
            logger.error('YAML de agente com shape inválido — arquivo ignorado', {
              context: {
                file,
                issues: parsed.error.issues.map((i) => ({
                  path: i.path.join('.'),
                  message: i.message,
                })),
              },
            });
            return null;
          }
          return parsed.data as SquadAgentConfig & { name: string };
        })
        .filter((config): config is SquadAgentConfig & { name: string } => config !== null);

      yamlConfigs.forEach((config) => {
        const agentName = canonicalAgentKey(config.name);
        const soloPrompt = applySoloBuilderPrompt(config.system_prompt) || config.system_prompt;
        const evidencePrompt = applyEvidenceIntegrityPrompt(soloPrompt) || soloPrompt;
        const operationalPrompt = applyOperationalContextPrompt(evidencePrompt) || evidencePrompt;
        loadedAgentConfigs[agentName] = {
          version: config.version,
          system_prompt: applyKnowledgeCutoffPrompt(operationalPrompt) || operationalPrompt,
          description: config.description,
          model: config.model,
          model_fallback: config.model_fallback,
          temperature: config.temperature,
          max_tokens: config.max_tokens,
        };

        agents.push({
          name: agentName,
          icon: this.getIconForAgent(agentName),
          description: config.description || `${agentName} processando...`,
        });
      });

      const poIndex = agents.findIndex((agent) => agent.name === AgentRole.product_owner);
      if (poIndex > 0) {
        const po = agents.splice(poIndex, 1)[0];
        agents.unshift(po);
      } else if (poIndex === -1) {
        agents.unshift({
          name: AgentRole.product_owner,
          icon: '👑',
          description: AGENT_ROLE_LABELS[AgentRole.product_owner],
        });
      }

      const filteredAgents = agents.filter((agent) => agent.name !== PM_INNOVATION_AGENT_KEY);

      logger.info('Configurações de agentes carregadas', {
        context: {
          agents: filteredAgents.map((agent) => ({
            name: agent.name,
            version: loadedAgentConfigs[agent.name]?.version ?? '0.0.0',
          })),
          configs: Object.keys(loadedAgentConfigs),
        },
      });

      return {
        agents: filteredAgents,
        agentConfigs: loadedAgentConfigs,
      };
    } catch (error) {
      logger.error('Erro ao carregar configurações de agentes', {
        error: error instanceof Error ? error : undefined,
      });
      return {
        agents: this.getDefaultAgents(),
        agentConfigs: {},
      };
    }
  }

  getIconForAgent(agentName: string): string {
    // Demanda 10210: usar registry central quando a chave for canônica.
    if (isValidRole(agentName)) {
      switch (agentName) {
        case AgentRole.scrum_master:
          return '🧝';
        case AgentRole.qa:
          return '✅';
        case AgentRole.ux:
          return '🎨';
        case AgentRole.analista_de_dados:
          return '📈';
        case AgentRole.tech_lead:
          return '💧';
        case AgentRole.security_specialist:
          return '🛡️';
        case AgentRole.architect:
          return '🏗️';
        case AgentRole.financial_analyst:
          return '💰';
        case AgentRole.product_owner:
          return '👑';
        case AgentRole.product_manager:
          return '📋';
        case AgentRole.devops:
          return '🔧';
      }
    }
    if (agentName === PM_INNOVATION_AGENT_KEY) return '💡';
    return '🤖';
  }

  private getDefaultAgents(): SquadAgent[] {
    return [
      {
        name: AgentRole.product_owner,
        icon: '👑',
        description: AGENT_ROLE_LABELS[AgentRole.product_owner],
      },
      {
        name: AgentRole.scrum_master,
        icon: '🧝',
        description: AGENT_ROLE_LABELS[AgentRole.scrum_master],
      },
      {
        name: AgentRole.qa,
        icon: '✅',
        description: AGENT_ROLE_LABELS[AgentRole.qa],
      },
      {
        name: AgentRole.ux,
        icon: '🎨',
        description: AGENT_ROLE_LABELS[AgentRole.ux],
      },
      {
        name: AgentRole.analista_de_dados,
        icon: '📈',
        description: AGENT_ROLE_LABELS[AgentRole.analista_de_dados],
      },
      {
        name: AgentRole.tech_lead,
        icon: '💧',
        description: AGENT_ROLE_LABELS[AgentRole.tech_lead],
      },
    ];
  }
}
