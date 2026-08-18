import {
  type ChatMessage,
  type Demand,
  type RefinementType,
  type EvidenceBlock,
} from '@shared/schema';
import { getDemandTypeConfig } from '@shared/demand-types';
import { typeContractValidator } from '../../utils/typeContractValidator';

export class PromptParser {
  static buildRefinementDigest(refinementMessages: ChatMessage[]): string {
    const AGENT_INSIGHT_MIN_LENGTH = 30;
    // Exclude 'system' agent (original demand context) and empty/trivial messages from the digest
    const completed = refinementMessages.filter(
      (msg) =>
        msg.type === 'completed' &&
        msg.agent !== 'system' &&
        msg.message.trim().length >= AGENT_INSIGHT_MIN_LENGTH,
    );
    if (completed.length === 0) {
      return '- Sem mensagens concluídas para resumir.';
    }

    const perAgent = new Map<string, string[]>();
    for (const message of completed) {
      const bucket = perAgent.get(message.agent) || [];
      bucket.push(PromptParser.extractKeyEvidence(message.message));
      perAgent.set(message.agent, bucket);
    }

    const lines: string[] = [];
    for (const [agent, evidences] of perAgent.entries()) {
      const compact = evidences
        .filter(Boolean)
        .slice(0, 2)
        .map((item) => `- ${item}`)
        .join('\n');
      if (compact) {
        lines.push(`### ${agent}\n${compact}`);
      }
    }

    return lines.join('\n\n') || '- Sem evidências estruturadas.';
  }

  static extractKeyEvidence(message: string): string {
    const sanitized = message.replace(/\s+/g, ' ').trim();
    const recommendation = sanitized.match(/\*\*Recomenda[cç][aã]o:\*\*\s*([^*]+)/i)?.[1]?.trim();
    const problem = sanitized.match(/\*\*Problema Identificado:\*\*\s*([^*]+)/i)?.[1]?.trim();
    const impact = sanitized.match(/\*\*Impacto:\*\*\s*([^*]+)/i)?.[1]?.trim();
    const analysis = sanitized.match(/\*\*An[aá]lise:\*\*\s*([^*]+)/i)?.[1]?.trim();

    return recommendation || problem || impact || analysis || sanitized.slice(0, 220);
  }

  static appendDocumentEvidenceNote(
    documentBody: string,
    evidence: EvidenceBlock | undefined,
    issues: string[],
  ): string {
    if (!evidence) {
      if (issues.length === 0) return documentBody;
      return `${documentBody}

## Validação de Evidências
> ⚠️ Este documento foi gerado sem evidências verificáveis declaradas (arquivos, integrações ou dados confirmados no repositório). Não foi possível confirmar automaticamente se as referências citadas no corpo do documento existem de fato — trate-as como provisórias até verificação manual.`;
    }

    if (evidence.sourceType === 'blocked') {
      return `${documentBody}

## Validação de Evidências
> ⚠️ **Evidência marcada como BLOCKED.** Os arquivos citados pela squad não puderam ser verificados no repositório${
        evidence.evidenceNotes ? `: ${evidence.evidenceNotes}` : '.'
      } As decisões deste documento devem ser confirmadas antes da execução.`;
    }

    if (evidence.evidenceNotes) {
      return `${documentBody}

## Validação de Evidências
- **Tipo:** ${evidence.sourceType}
- **Arquivos verificados (${evidence.evidenceFiles.length}):** ${
        evidence.evidenceFiles.join(', ') || '_nenhum_'
      }
- **Aviso:** ${evidence.evidenceNotes}`;
    }

    return documentBody;
  }

  static ensurePrdContainsDemandType(prdContent: string, demand: Demand): string {
    const normalized = prdContent
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const demandTypeLabel = getDemandTypeConfig(demand.type)
      .label.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const alreadyContainsType =
      normalized.includes(demand.type) ||
      normalized.includes(demandTypeLabel) ||
      normalized.includes('tipo de demanda');

    if (alreadyContainsType) {
      return prdContent;
    }

    return `**Tipo de Demanda:** ${demand.type}\n\n${prdContent}`;
  }

  static ensurePrdReflectsRefinement(prdContent: string, refinementDigest: string): string {
    const normalized = prdContent
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (
      normalized.includes('evidencias do refinamento') ||
      normalized.includes('aprendizados do refinamento')
    ) {
      return prdContent;
    }

    return `${prdContent}

## Evidências do Refinamento
${refinementDigest}`;
  }

  static ensurePrdHasOperationalOrientation(prdContent: string, orientation: string): string {
    const normalized = prdContent
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (normalized.includes('orientacoes operacionais')) {
      return prdContent;
    }

    return `${prdContent}

## Orientações Operacionais
${orientation}`;
  }

  static ensurePrdMatchesRefinementType(
    prdContent: string,
    refinementType: RefinementType,
    refinementDigest: string,
  ): string {
    if (refinementType !== 'technical') {
      return prdContent;
    }

    const adherence = typeContractValidator.validateTypeAdherence(prdContent, refinementType);
    if (adherence.isAdherent) {
      return prdContent;
    }

    const normalized = prdContent
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const technicalSections = [
      {
        heading: '## 2. Arquitetura Proposta',
        aliases: ['arquitetura'],
        body: 'Arquitetura inicial baseada no fluxo já discutido no refinamento. Confirmar componentes afetados, pontos de integração e responsabilidades antes da implementação.',
      },
      {
        heading: '## 4. Definição de APIs (Contratos)',
        aliases: ['definicao de apis', 'api', 'contratos'],
        body: 'Descrever endpoints, payloads, contratos de entrada/saída e campos com confidence quando aplicável. Se algum contrato ainda estiver em aberto, registrar explicitamente como premissa.',
      },
      {
        heading: '## 6. Considerações de Performance e Segurança',
        aliases: ['performance e seguranca', 'performance', 'seguranca', 'risco'],
        body: 'Listar riscos técnicos, limites operacionais, tratamento de falhas, timeouts, idempotência e mitigação para rollout controlado.',
      },
      {
        heading: '## 7. Plano de Rollout e Monitoramento',
        aliases: ['rollout e monitoramento', 'rollout', 'monitoramento'],
        body: 'Definir estratégia de ativação, validação assistida, métricas observáveis e critérios de rollback ou go/no-go durante a POC.',
      },
    ];

    const missingBlocks = technicalSections.filter(
      (section) => !section.aliases.some((alias) => normalized.includes(alias)),
    );

    if (missingBlocks.length === 0) {
      return prdContent;
    }

    const synthesizedSections = missingBlocks
      .map((section) => `${section.heading}\n${section.body}`)
      .join('\n\n');

    return `${prdContent}

## Complementos Técnicos Mínimos
Trechos adicionados automaticamente para manter aderência estrutural do TDD quando o modelo não retorna todas as seções exigidas.

${synthesizedSections}

## Notas de Aderência Técnica
Baseado nas evidências e discussões já registradas no refinamento:
${refinementDigest}`;
  }

  static normalizeTitle(title: string): string {
    return title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  static extractH1(content: string): string | null {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  static enforceReadinessGate(prdContent: string, removedCount: number): string {
    const lines = prdContent.split('\n');
    let hasAMedirWithInstrumentation = false;
    let hasAMedirWithoutInstrumentation = false;
    let openQuestionsText = '';

    // Procura por Perguntas abertas na seção 2. Prontidão Da Demanda
    let inReadinessSection = false;
    for (const line of lines) {
      if (line.includes('## 2. Prontidão Da Demanda') || line.includes('## Prontidão Da Demanda')) {
        inReadinessSection = true;
        continue;
      }
      if (inReadinessSection && line.startsWith('##')) {
        inReadinessSection = false;
      }

      if (inReadinessSection) {
        if (line.toLowerCase().includes('perguntas abertas')) {
          openQuestionsText = line;
        }
      }
    }

    // Verificar se há decisões de design ou marcações de pendência no corpo
    const hasOpenDecisions =
      /\[A DEFINIR\]/i.test(prdContent) ||
      /\[PENDENTE\]/i.test(prdContent) ||
      (openQuestionsText !== '' &&
        !/Nenhuma que bloqueie a execução imediata|Nenhuma/i.test(openQuestionsText));

    for (const line of lines) {
      if (line.includes('|')) {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length >= 5) {
          for (let i = 1; i < parts.length - 1; i++) {
            if (/a medir/i.test(parts[i])) {
              const howToMeasure = parts[parts.length - 2];
              const isMissingInstrumentation =
                !howToMeasure ||
                howToMeasure === '' ||
                /a definir|tbd|não definido|nao definido|pendente|n\/a|--/i.test(howToMeasure);

              if (isMissingInstrumentation) {
                hasAMedirWithoutInstrumentation = true;
              } else {
                hasAMedirWithInstrumentation = true;
              }
            }
          }
        }
      }
    }

    // Determinar o status correto com base nas prioridades de rebaixamento
    let targetStatus = '';
    if (hasAMedirWithoutInstrumentation) {
      targetStatus = 'Pronta para instrumentar';
    } else if (hasAMedirWithInstrumentation) {
      targetStatus = 'Pronta após baseline';
    } else if (hasOpenDecisions || removedCount > 0) {
      targetStatus = 'Pronta para detalhar';
    }

    if (targetStatus !== '') {
      const statusRegex = /(-\s*\*\*Status:\*\*\s*)Pronta(\b)/gi;
      const statusRegex2 = /(-\s*Status:\s*)Pronta(\b)/gi;

      let updated = prdContent;
      if (statusRegex.test(updated)) {
        updated = updated.replace(statusRegex, `$1${targetStatus}$2`);
      } else if (statusRegex2.test(updated)) {
        updated = updated.replace(statusRegex2, `$1${targetStatus}$2`);
      }
      return updated;
    }

    return prdContent;
  }
}
