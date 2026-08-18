import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import { AISquadService } from '../ai-squad';
import { Demand, ChatMessage } from '@shared/schema';
import { logger } from '../../utils/logger';
import { getDemandTypeConfig } from '@shared/demand-types';
import path from 'path';
import { eventBus } from '../../events/event-bus';
import { contextBuilder } from '../context-builder';
import { documentVersioningService } from '../document-versioning';
import { validateContract } from '../model-governance';
import { MODEL_MINI } from '../model-routing';
import { openAIService } from '../openai-ai';
import { documentEvidenceMetrics } from '../document-evidence-metrics';
import { PromptParser } from './prompt-parser';
import { buildPdfFilename, type PdfDocType } from '../../utils/pdf-filename';
import { NumericIntegrityValidator } from '../numeric-integrity-validator';
import { CitedPathValidator, summarizeGrounding } from '../cited-path-validator';
import { resolveKnownRepoPaths } from '../cited-path-resolver';
import { resolveDemandRepoFullName } from '../../utils/repo-context';
import { numericProvenanceMetrics } from '../numeric-provenance-metrics';
import { GovernanceGatingService } from '../governance-gating-service';
import { improvementExecutionService } from '../improvement-execution';
import { featureFlags } from '../feature-flags';
import { AppError } from '../../middleware/error-handler';
import {
  NUMERIC_PROVENANCE_INSTRUCTION,
  PRODUCT_MANAGER_DOCUMENT_MODEL,
  SYNTHESIS_INSTRUCTION,
} from './document-generation-prompts';
import { documentHallucinationTotal, prdGroundingDegradedTotal } from '../../metrics';
import { GroundednessValidator } from '../groundedness-validator';
import { prependNeedsReviewBanner } from '../../orchestration-contracts';
import { QualityIndexService } from '../quality-index-service';

export class DocumentGenerator {
  private parent: AISquadService;

  constructor(parent: AISquadService) {
    this.parent = parent;
  }

  public async generatePRDWithPM(
    demand: Demand,
    refinementMessages: ChatMessage[],
    model?: string,
    forceIsTechnical?: boolean, // When set, overrides refinementType-based detection
  ): Promise<string> {
    const RAW_REFINEMENT_SUMMARY_CHAR_LIMIT = 20_000; // ~5k tokens — headroom for system + other prompt sections
    // Exclude 'system' messages (original demand context, not agent analysis) and empty/trivial messages
    const AGENT_INSIGHT_MIN_LENGTH = 30;
    // Demanda 10110: descrições longas lotam o contexto e induzem o modelo a
    // fazer dump de conteúdo bruto. Limitamos a ~20% do budget do prompt.
    const RAW_DESCRIPTION_CHAR_LIMIT = 4_000;
    const truncatedDescription =
      (demand.description || '').length > RAW_DESCRIPTION_CHAR_LIMIT
        ? `${(demand.description || '').slice(0, RAW_DESCRIPTION_CHAR_LIMIT * 0.7)}\n\n[...descrição truncada — priorize o refinamento da squad abaixo...]\n${(demand.description || '').slice(-RAW_DESCRIPTION_CHAR_LIMIT * 0.3)}`
        : demand.description || '';
    const rawRefinementSummary = refinementMessages
      .filter((msg) => msg.type === 'completed')
      .filter((msg) => msg.agent !== 'system')
      .filter((msg) => msg.message.trim().length >= AGENT_INSIGHT_MIN_LENGTH)
      .map((msg) => `**${msg.agent}**: ${msg.message}`)
      .join('\n\n');
    const refinementSummary =
      rawRefinementSummary.length > RAW_REFINEMENT_SUMMARY_CHAR_LIMIT
        ? rawRefinementSummary.slice(0, RAW_REFINEMENT_SUMMARY_CHAR_LIMIT) +
          '\n\n[...refinamento truncado por limite de contexto — evidências completas disponíveis no digest abaixo]'
        : rawRefinementSummary;
    const refinementDigest = PromptParser.buildRefinementDigest(refinementMessages);

    // Get insights from evolved context for richer PRD
    const insightsSummary = contextBuilder.getInsightsSummary(demand.id);

    // Retrieve the cumulative list of file paths verified by the squad during
    // refinement. The PM is constrained to citing ONLY these paths.
    const verifiedEvidenceFiles = contextBuilder.getVerifiedEvidenceFiles(demand.id);
    const allowedFilePathsSection =
      verifiedEvidenceFiles.length > 0
        ? `=== ARQUIVOS VERIFICADOS PELA SQUAD (ALLOWED_FILE_PATHS) ===
Os seguintes arquivos foram verificados durante o refinamento:
${verifiedEvidenceFiles.map((f) => `- ${f}`).join('\n')}

REGRA ABSOLUTA: Você SÓ pode citar arquivos desta lista no Evidence Block. Se nenhum arquivo foi verificado, use sourceType "blocked" com evidenceFiles vazio.
`
        : `=== ARQUIVOS VERIFICADOS PELA SQUAD (ALLOWED_FILE_PATHS) ===
Nenhum arquivo foi verificado durante o refinamento. Use sourceType "blocked" com evidenceFiles vazio no Evidence Block.
`;

    // Determinar tipo de refinamento com fallback robusto para demandas legadas.
    const refinementType = this.parent.resolveDemandRefinementType(demand);
    const isImprovement = demand.type === 'melhoria';
    // forceIsTechnical overrides refinementType detection (used when generating both PRD and TSD separately)
    const isTechnical =
      forceIsTechnical !== undefined ? forceIsTechnical : refinementType === 'technical';
    const demandTypeGuidance = this.parent.getDemandTypePrdGuidance(demand.type);
    const operationalOrientation = this.parent.buildOperationalOrientation(demand.description);
    const documentModel = this.parent.resolveDocumentGenerationModel(model, isTechnical);
    const documentModelFallback = this.parent.resolveDocumentGenerationFallback(model, isTechnical);

    // Sistema de prompts diferenciados por tipo
    // Refinamento técnico deve usar contrato técnico mesmo quando a demanda é "melhoria".
    const baseSystemPrompt = isTechnical
      ? this.parent.getTechnicalPRDPrompt(insightsSummary)
      : isImprovement
        ? this.parent.getImprovementPRDPrompt(insightsSummary, false)
        : this.parent.getBusinessPRDPrompt(insightsSummary);

    // Slice 5: provenance numérica declarada na emissão, atrás de flag (default off).
    const numericProvenanceEmission =
      featureFlags.getFlags().numericProvenanceEmissionEnabled === true;
    let systemPrompt = `${baseSystemPrompt}\n\n${SYNTHESIS_INSTRUCTION}`;
    if (numericProvenanceEmission) {
      systemPrompt += `\n\n${NUMERIC_PROVENANCE_INSTRUCTION}`;
    }

    const typeLabel = isImprovement
      ? isTechnical
        ? 'MELHORIA TÉCNICA'
        : 'MELHORIA'
      : isTechnical
        ? 'TÉCNICO'
        : 'NEGÓCIOS';
    const userPrompt = `Demanda Original: ${demand.title}
Descrição (sintetizada; priorize o refinamento da squad): ${truncatedDescription}
Tipo: ${demand.type}
Prioridade: ${demand.priority}
Tipo de Refinamento: ${typeLabel}

=== REFINAMENTO DA SQUAD (FONTE PRINCIPAL PARA O DOCUMENTO) ===
${refinementSummary}

=== EVIDÊNCIAS ESTRUTURADAS DO REFINAMENTO (OBRIGATÓRIO REFLETIR NO ${isTechnical ? 'TSD' : 'PRD'}) ===
${refinementDigest}

=== CONTRATO DO TIPO DE DEMANDA ===
${demandTypeGuidance}

${allowedFilePathsSection}
=== SUA TAREFA ===
Com base em TODAS as análises acima, crie um documento ${isTechnical ? 'técnico' : 'de negócio'} enxuto em Markdown seguindo o formato especificado.
${
  isTechnical
    ? 'O documento deve ser um TSD (Technical Specification Document) que desenvolvedores consigam usar diretamente para implementação — contratos de API tipados, schema Drizzle, diagrama de sequência Mermaid e checklist de implementação. Responde "Como vamos implementar isso?".'
    : 'O documento deve ser um artefato de decisão (PRD) focado no usuário e negócio, respondendo "Por que estamos fazendo isso?".'
}

IMPORTANTE:
- Não invente arquivos, métricas, integrações, bibliotecas ou decisões. Use apenas a demanda original e o refinamento da squad; quando faltar evidência, marque como [A DEFINIR] com uma pergunta objetiva.
- Use as informações do refinamento dos agentes para preencher os campos do ${isTechnical ? 'TSD' : 'PRD'}
- Respeite o contrato do tipo de demanda e inclua as seções/requisitos obrigatórios quando aplicável
${
  isTechnical
    ? '- OBRIGATÓRIO: Siga o formato exato do TSD (seções 1-10). Não misture seções de negócio (ROI, métricas de produto, jornada do usuário).'
    : '- Traduza sugestões técnicas dos agentes para impacto de negócio, experiência do usuário, risco, escopo ou métrica'
}
- Certifique-se de que o conteúdo do ${isTechnical ? 'TSD' : 'PRD'} reflita fielmente as discussões realizadas
- Traga explicitamente no ${isTechnical ? 'TSD' : 'PRD'} os principais aprendizados do refinamento (lacunas, riscos, decisões e recomendações)
- Inclua um trecho curto com "Evidências do refinamento" citando ATÉ 3 arquivos da lista ALLOWED_FILE_PATHS acima. Se a lista estiver vazia, escreva explicitamente "Sem evidências verificáveis até o momento" — NÃO complete com palpites ou invente paths.
- Inclua uma seção "Orientações Operacionais" com instruções de uso de ferramentas/documentos e como isso deve entrar no fluxo
- Não escreva em formato RF/RNF
- Não use linguagem de startup enterprise; mantenha foco em produto pessoal e execução
- OBRIGATÓRIO: ao final do documento, anexe o **Evidence Block** em JSON listando APENAS arquivos da lista ALLOWED_FILE_PATHS acima. Se a lista estiver vazia, use sourceType "blocked" com evidenceFiles vazio — NUNCA invente paths.`;

    const generateAndProcess = async (
      feedbackAnterior?: string,
      docAnterior?: string,
    ): Promise<string> => {
      let finalUserPrompt = userPrompt;
      if (feedbackAnterior && docAnterior) {
        finalUserPrompt = `${userPrompt}

=== FEEDBACK DE AUTO-CORREÇÃO (REFLEXION) ===
O documento gerado na iteração anterior falhou nas validações do gate de governança. Ajuste e corrija o documento com base no feedback abaixo:

${feedbackAnterior}

=== DOCUMENTO DA ITERAÇÃO ANTERIOR (A SER CORRIGIDO) ===
${docAnterior}`;
      }

      const response = await openAIService.generateChatCompletion(systemPrompt, finalUserPrompt, {
        demandId: demand.id,
        demandDescription: demand.description,
        temperature: 0.5,
        maxTokens: 4000,
        // Auditoria 2026-08-03: PRD/TDD truncado é tão inaceitável quanto
        // checklist truncado — melhor falhar e reprocessar do que versionar
        // um documento que termina no meio de uma frase.
        failOnTruncation: true,
        model: documentModel,
        modelFallback: documentModelFallback,
        taskType: isTechnical ? 'technical' : 'document',
        operation: isTechnical ? 'document:tdd' : 'document:prd',
        agentName: isTechnical ? 'tech_lead' : 'product_manager',
        cache: false,
        retryAttempts: 3,
        retryDelayMs: 1000,
        // Conteúdo já refinado pela squad (não input bruto de usuário) — mesma
        // convenção de roundtable-orchestrator.ts: guardrail indisponível não
        // deve derrubar a geração do documento.
        failOpenOnError: true,
        // Bug #10224: userPrompt embute descrição da demanda + refinamento
        // completo da squad; um doc anexado pode legitimamente citar um
        // exemplo de prompt injection sem ser um ataque real.
        skipInjectionCheck: true,
      });

      // Bug 1 (falha de LLM → PRD falso): NUNCA substituir uma resposta vazia
      // por um documento-stub. Se a LLM falhar ou devolver conteúdo vazio,
      // lançamos e deixamos o caller abortar sem persistir nada.
      if (!response || !response.trim()) {
        throw new AppError(
          `Geração de ${isTechnical ? 'TSD' : 'PRD'} retornou conteúdo vazio da LLM`,
          502,
          'DOCUMENT_GENERATION_EMPTY',
        );
      }
      const rawDocument = response;

      // Verify evidence block against the real repo BEFORE running the
      // string-matching ensure* helpers. This catches hallucinated file
      // paths in the aggregated PRD/TDD — the agent-level handshake only
      // runs on individual agent messages and doesn't reach the PM output.
      const demandRepoFullName = resolveDemandRepoFullName(demand);
      const repositoryContext = contextBuilder.getRepositoryValidationContext(demand.id);
      const evidenceValidation = await contextBuilder.validateDocumentEvidence(rawDocument, {
        demandType: demand.type,
        // Demandas legadas podem não ter repoFullName, mas uma lista não vazia
        // só existe depois de a própria rodada verificar arquivos reais.
        repoAvailable:
          verifiedEvidenceFiles.length > 0
            ? true
            : (repositoryContext?.repoAvailable ?? demandRepoFullName !== null),
        repoId: repositoryContext?.repoId ?? demandRepoFullName ?? 'none',
        demandId: demand.id,
      });
      const documentBody = evidenceValidation.cleanMessage;

      // Server-side enforcement: filter evidenceFiles against the allowed list
      // to catch any paths the LLM hallucinated despite the prompt instructions.
      const allowedSet = new Set(verifiedEvidenceFiles);
      if (evidenceValidation.evidence?.evidenceFiles) {
        const originalFiles = evidenceValidation.evidence.evidenceFiles;
        const filteredFiles = originalFiles.filter((f) => allowedSet.has(f));
        const hallucinatedFiles = originalFiles.filter((f) => !allowedSet.has(f));

        if (hallucinatedFiles.length > 0) {
          evidenceValidation.issues.push(
            `Evidence Block: Arquivos ALUCINADOS removidos (não estavam em ALLOWED_FILE_PATHS): ${hallucinatedFiles.join(', ')}`,
          );
          evidenceValidation.evidence.evidenceFiles = filteredFiles;

          if (filteredFiles.length === 0) {
            evidenceValidation.evidence.sourceType = 'blocked';
            evidenceValidation.evidence.evidenceNotes =
              'ATENÇÃO: Todos os arquivos citados foram removidos por não constarem na lista de arquivos verificados pela squad.';
          } else {
            evidenceValidation.evidence.evidenceNotes = `ATENÇÃO: ${hallucinatedFiles.length} arquivo(s) alucinado(s) removido(s) por não constarem na lista de arquivos verificados.`;
          }

          logger.warn('Arquivos alucinados detectados e filtrados do PRD/TSD', {
            context: {
              demandId: demand.id,
              isTechnical,
              hallucinatedFiles,
              remainingFiles: filteredFiles,
              allowedCount: verifiedEvidenceFiles.length,
            },
          });
        }
      }

      if (evidenceValidation.issues.length > 0) {
        documentEvidenceMetrics.recordValidation({
          demandId: demand.id,
          issues: evidenceValidation.issues,
        });

        logger.warn('Validação de evidência do PRD/TSD encontrou problemas', {
          context: {
            demandId: demand.id,
            isTechnical,
            sourceType: evidenceValidation.evidence?.sourceType,
            issues: evidenceValidation.issues,
            verifiedFiles: evidenceValidation.evidence?.evidenceFiles,
          },
        });
      }

      // Structured hallucination metric for monitoring and baseline collection
      const citedPaths = evidenceValidation.evidence?.evidenceFiles ?? [];
      const hasHallucination = evidenceValidation.issues.some((issue) =>
        issue.includes('ALUCINADOS'),
      );
      documentHallucinationTotal
        .labels(hasHallucination ? 'hallucinated' : 'clean', isTechnical ? 'TSD' : 'PRD')
        .inc();
      logger.info('PRD/TSD evidence hallucination metric', {
        context: {
          demandId: demand.id,
          allowedFilePaths: verifiedEvidenceFiles,
          citedPaths,
          hasHallucination,
          isTechnical,
        },
      });

      const documentWithEvidenceNote = PromptParser.appendDocumentEvidenceNote(
        documentBody,
        evidenceValidation.evidence,
        evidenceValidation.issues,
      );

      const withDemandType = PromptParser.ensurePrdContainsDemandType(
        documentWithEvidenceNote,
        demand,
      );

      const withRefinement = PromptParser.ensurePrdReflectsRefinement(
        withDemandType,
        refinementDigest,
      );
      const finalPrd = PromptParser.ensurePrdHasOperationalOrientation(
        withRefinement,
        operationalOrientation,
      );
      const typeAlignedPrd = PromptParser.ensurePrdMatchesRefinementType(
        finalPrd,
        refinementType,
        refinementDigest,
      );

      // Validação de integridade numérica (grounding)
      const integrityResult = NumericIntegrityValidator.validate(
        typeAlignedPrd,
        demand,
        refinementMessages,
      );
      let groundedPrd = integrityResult.cleanPrd;

      // Spec 10012 US1/US3: banner de grounding no topo do documento quando houver
      // claims não verificados. Preenchido a partir das estatísticas do validador abaixo.
      let groundingBanner = '';

      // Validação determinística de arquivos citados (grounding de paths): marca
      // caminhos que não existem no repositório-alvo. Complementa o check
      // `arquivo_inexistente` do red-team (que é julgamento de LLM) com uma checagem
      // factual contra a árvore real. Fail-safe: sem índice confiável, não marca nada.
      if (featureFlags.getFlags().citedPathValidationEnabled === true) {
        try {
          const sourceLabel = isTechnical ? 'TSD' : 'PRD';
          const repoFullName = resolveDemandRepoFullName(demand);
          const knownPaths = repoFullName ? await resolveKnownRepoPaths(repoFullName) : null;
          const pathResult = CitedPathValidator.validate(groundedPrd, knownPaths, {
            sourceLabel,
            demandId: demand.id,
          });
          groundedPrd = pathResult.cleanContent;

          // Spec 10009 US2: além de paths, marca componentes/hooks citados como
          // existentes que não têm arquivo no repo (fecha o buraco do "AssistenteDeCodigo").
          const entityResult = CitedPathValidator.validateEntities(groundedPrd, knownPaths, {
            sourceLabel,
            demandId: demand.id,
          });
          groundedPrd = entityResult.cleanContent;

          // Spec 10012 FR-005/006/007: agrega o grounding (só há claims verificáveis
          // quando o índice do repo existe, knownPaths !== null).
          const { totalClaims, verified, unverified, unverifiedClaimsRatio, degraded } =
            summarizeGrounding([pathResult, entityResult]);

          if (totalClaims > 0) {
            // FR-006: log estruturado de grounding a cada geração.
            logger.info('Grounding do documento gerado', {
              context: {
                demandId: demand.id,
                sourceLabel,
                totalClaims,
                verified,
                unverified,
                unverifiedClaimsRatio: Number(unverifiedClaimsRatio.toFixed(3)),
                degraded,
                indexAvailable: knownPaths !== null,
              },
            });
          }

          if (unverified > 0) {
            if (degraded) {
              prdGroundingDegradedTotal.labels(sourceLabel).inc();
            }
            // FR-007: banner no TOPO (o disclaimer antigo de rodapé era ignorado).
            const estado = degraded ? '⚠️ degraded' : 'normal';
            groundingBanner = `> ⚠️ **Grounding parcial:** ${unverified} de ${totalClaims} referências (caminhos/componentes) não verificadas no repositório-alvo. Estado: **${estado}**. Trechos marcados com \`⚠️\` não puderam ser confirmados contra o código.\n\n`;
          }
        } catch (err) {
          logger.warn('Validação de caminhos citados falhou — continuando sem ela', {
            error: err instanceof Error ? err : undefined,
            context: { demandId: demand.id },
          });
        }
      }

      // Telemetria de provenance numérica (observabilidade do grounding por claim)
      numericProvenanceMetrics.record({
        demandId: demand.id,
        sourceLabel: isTechnical ? 'TSD' : 'PRD',
        ledger: integrityResult.ledger,
      });

      const gatedPrd = PromptParser.enforceReadinessGate(groundedPrd, integrityResult.removedCount);

      // Validar contrato mínimo de saída (T3)
      const isMarkdown = gatedPrd.includes('#') && gatedPrd.length > 200;
      // We import validateContract from model-governance.ts
      validateContract(
        isMarkdown,
        'ai-squad.generatePRDWithPM',
        'document:prd',
        documentModel,
        'O PRD gerado não atende ao formato Markdown mínimo esperado',
      );

      // Spec 10012 FR-007: banner de grounding no topo (após o gate para garantir a
      // primeira linha). Vazio quando não há claims não verificados.
      return groundingBanner + gatedPrd;
    };

    try {
      let prdContent = await generateAndProcess();

      // Quality gate UNIFICADO: combina a governança estrutural/cobertura com o
      // validador tiered de improvement-execution (semântico/actionable/métricas),
      // que antes existia apenas em teste. Só se aplica a demandas de melhoria
      // não-técnicas, pois é o único caso em que o documento gerado
      // (getImprovementPRDPrompt) segue as seções numeradas que o validador espera.
      const applyImprovementQualityGate = isImprovement && !isTechnical;
      const assessDocumentQuality = async (content: string) => {
        const structuralGate = GovernanceGatingService.validateStructuralGate(demand, content);
        const coverageResult = GovernanceGatingService.analyzeCoverage(demand.description, content);
        const qualityResult = applyImprovementQualityGate
          ? improvementExecutionService.validateImprovementPlan(content, { level: 3 })
          : null;
        const qualityErrors = qualityResult
          ? qualityResult.issues.filter((issue) => issue.severity === 'error')
          : [];

        // RAG Groundedness check (LLM-as-judge)
        let groundednessErrors: string[] = [];
        let groundednessScore: number | null = null;
        try {
          const groundedness = await GroundednessValidator.validate(
            content,
            refinementSummary + '\n\n' + refinementDigest,
            { demandId: demand.id },
          );
          groundednessScore = groundedness.score;
          // Spec 10259 T6: fallback determinístico quando o juiz não é
          // calculável libera o documento (isGrounded: true), mas sinaliza
          // validationError/fallback para auditoria. Só bloqueia quando o juiz
          // retorna score < 0.85 sem fallback.
          if (!groundedness.isGrounded && groundedness.issues.length > 0) {
            groundednessErrors = groundedness.issues.map(
              (issue) => `[CITAÇÃO/ALUCINAÇÃO] ${issue}`,
            );
          }
        } catch (err) {
          // Uma exceção inesperada aqui também é fail-closed: registra um erro
          // de groundedness em vez de deixar o documento passar silenciosamente.
          logger.warn('Groundedness validation failed in assessment loop', { error: err });
          groundednessErrors = [
            '[CITAÇÃO/ALUCINAÇÃO] Erro inesperado na validação de groundedness — conteúdo bloqueado (fail-closed).',
          ];
        }

        const totalErrors = [...structuralGate.errors, ...groundednessErrors];
        const failures =
          totalErrors.length + coverageResult.omittedItems.length + qualityErrors.length;
        const valid =
          structuralGate.valid &&
          groundednessErrors.length === 0 &&
          (qualityResult ? qualityResult.qualityPassed : true);

        return {
          structuralGate: {
            ...structuralGate,
            errors: totalErrors,
            valid: structuralGate.valid && groundednessErrors.length === 0,
          },
          coverageResult,
          qualityResult,
          qualityErrors,
          failures,
          valid,
          groundednessScore,
        };
      };

      // Executar validação inicial unificada (governança + qualidade tiered)
      let assessment = await assessDocumentQuality(prdContent);

      let bestPrd = prdContent;
      let bestFailures = assessment.failures;

      let iteration = 0;
      const maxIterations = 2;

      logger.info('[Reflexion] Validando primeira versão do documento', {
        context: {
          demandId: demand.id,
          valid: assessment.valid,
          errorsCount: assessment.structuralGate.errors.length,
          omissionsCount: assessment.coverageResult.omittedItems.length,
          qualityErrorsCount: assessment.qualityErrors.length,
          totalFailures: bestFailures,
        },
      });

      while (!assessment.valid && iteration < maxIterations) {
        // Stop do usuário: encerra a reflexão entre iterações (cada iteração é
        // uma chamada LLM longa). Mantém a melhor versão gerada até aqui.
        if (this.parent.stopRequests.has(demand.id)) {
          logger.info(
            '[Reflexion] Interrompido pelo usuário — encerrando refinamento do documento',
            {
              context: { demandId: demand.id, iteration },
            },
          );
          break;
        }

        iteration++;

        logger.info(`[Reflexion] Iniciando iteração de refinamento ${iteration}/${maxIterations}`, {
          context: {
            demandId: demand.id,
            errors: assessment.structuralGate.errors,
            omissions: assessment.coverageResult.omittedItems.map((o) => o.item),
            qualityErrors: assessment.qualityErrors.map((q) => `[${q.category}] ${q.message}`),
          },
        });

        const feedbackAnterior = `Erros Estruturais Detectados:
${assessment.structuralGate.errors.map((e) => `- [ERRO ESTRUTURAL] ${e}`).join('\n') || '- Nenhum.'}

Omissões de Conteúdo Detectadas (em relação à demanda original):
${assessment.coverageResult.omittedItems.map((o) => `- [OMISSÃO] [${o.category}] ${o.item}`).join('\n') || '- Nenhuma.'}

Falhas de Qualidade Detectadas (validação tiered):
${assessment.qualityErrors.map((q) => `- [QUALIDADE] [${q.section} · ${q.category}] ${q.message}`).join('\n') || '- Nenhuma.'}

INSTRUÇÕES DE CORREÇÃO:
1. Certifique-se de adicionar todas as seções obrigatórias ausentes e corrigir os erros estruturais relatados acima.
2. Certifique-se de integrar as informações omitidas no documento final para garantir a cobertura completa dos requisitos.
3. Resolva as falhas de qualidade tiered (objetivo, entrega "Fazer Agora", tabela de métricas com Baseline + Meta + Como Medir, critérios de aceite, plano de execução, casos de borda) — sem inventar números: use baseline real ou marque "A MEDIR".
4. Não remova as seções existentes que já estão corretas.`;

        try {
          const refinedPrd = await generateAndProcess(feedbackAnterior, prdContent);

          const newAssessment = await assessDocumentQuality(refinedPrd);

          logger.info(`[Reflexion] Resultado da iteração ${iteration}/${maxIterations}`, {
            context: {
              demandId: demand.id,
              valid: newAssessment.valid,
              errorsCount: newAssessment.structuralGate.errors.length,
              omissionsCount: newAssessment.coverageResult.omittedItems.length,
              qualityErrorsCount: newAssessment.qualityErrors.length,
              totalFailures: newAssessment.failures,
            },
          });

          // Guarda "keep best": se a versão refinada for pior (tiver mais falhas),
          // descartamos e mantemos a melhor. Caso contrário, atualizamos o melhor candidato.
          if (newAssessment.failures < bestFailures) {
            bestPrd = refinedPrd;
            bestFailures = newAssessment.failures;
            logger.info(
              `[Reflexion] A versão refinada melhorou o documento (falhas: ${bestFailures}). Atualizando melhor versão.`,
            );
          } else {
            logger.info(
              `[Reflexion] A versão refinada NÃO melhorou o documento (falhas: ${newAssessment.failures} vs melhor anterior: ${bestFailures}). Descartando refinamento.`,
            );
          }

          // Atualizar referências para a próxima iteração
          prdContent = refinedPrd;
          assessment = newAssessment;

          if (assessment.valid) {
            logger.info(
              '[Reflexion] Documento passou no gate unificado (governança + qualidade tiered). Encerrando o loop de autocrítica.',
            );
            break;
          }
        } catch (err) {
          logger.error(`[Reflexion] Erro durante a iteração ${iteration}`, {
            error: err instanceof Error ? err : undefined,
            context: { demandId: demand.id },
          });
          break;
        }
      }

      // SpecKit conformance (flag OFF por default): validação síncrona contra o
      // schema Zod (shared/spec-schemas.ts) com retry (max 2) e needs_review. A
      // 1ª "tentativa" reaproveita o melhor documento já gerado — só regenera se
      // não estiver conforme, evitando chamada de LLM extra no caminho feliz.
      if (featureFlags.getFlags().specKitConformanceEnabled) {
        const { enforceSpecConformance } = await import('../../cognitive-core/spec-conformance');
        let firstPass = true;
        const conformance = await enforceSpecConformance(
          'prd',
          async (feedback) => {
            if (firstPass) {
              firstPass = false;
              return bestPrd;
            }
            return generateAndProcess(feedback, bestPrd);
          },
          { maxAttempts: 2, demandId: demand.id },
        );
        bestPrd = conformance.needsReview
          ? prependNeedsReviewBanner(conformance)
          : conformance.content;
      }

      // Slice 5: verifica a provenance declarada na emissão e remove o bloco do PRD
      // final. Não-bloqueante nesta fatia — discrepâncias são logadas para auditoria.
      if (numericProvenanceEmission) {
        const provenance = NumericIntegrityValidator.verifyDeclaredProvenance(
          bestPrd,
          demand,
          refinementMessages,
        );
        if (!provenance.valid) {
          logger.warn('[Numeric Provenance] Provenance declarada inválida na emissão', {
            context: {
              demandId: demand.id,
              issues: provenance.issues.map((i) => i.message),
            },
          });
        }
        return provenance.cleanContent;
      }

      // Spec 10093 Fase 2 — Quality Index: persistir scores dos validadores.
      try {
        const finalIntegrity = NumericIntegrityValidator.validate(
          bestPrd,
          demand,
          refinementMessages,
          isTechnical ? 'TSD' : 'PRD',
          'remove',
        );
        const numericIntegrityScore =
          finalIntegrity.ledger.length > 0
            ? Number(
                (
                  finalIntegrity.ledger.filter((c) => c.anchored).length /
                  finalIntegrity.ledger.length
                ).toFixed(3),
              )
            : null;

        const repoFullName = resolveDemandRepoFullName(demand);
        const knownPaths = repoFullName ? await resolveKnownRepoPaths(repoFullName) : null;
        const pathResult = CitedPathValidator.validate(bestPrd, knownPaths, {
          sourceLabel: isTechnical ? 'TSD' : 'PRD',
          demandId: demand.id,
        });
        const entityResult = CitedPathValidator.validateEntities(bestPrd, knownPaths, {
          sourceLabel: isTechnical ? 'TSD' : 'PRD',
          demandId: demand.id,
        });
        const citedTotal = pathResult.ledger.length + entityResult.ledger.length;
        const citedVerified =
          pathResult.ledger.filter((l) => l.exists === true).length +
          entityResult.ledger.filter((l) => l.exists === true).length;
        const citedPathScore =
          knownPaths && citedTotal > 0 ? Number((citedVerified / citedTotal).toFixed(3)) : null;

        await QualityIndexService.save({
          demandId: demand.id,
          documentType: isTechnical ? 'tsd' : 'prd',
          groundednessScore: assessment.groundednessScore,
          numericIntegrityScore,
          citedPathScore,
          overallScore: null,
          metadata: {
            sourceLabel: isTechnical ? 'TSD' : 'PRD',
            removedCount: finalIntegrity.removedCount,
            citedTotal,
            citedVerified,
          },
        });
      } catch (qualityErr) {
        logger.warn('[QualityIndex] Falha ao calcular/persistir quality score', {
          error: qualityErr instanceof Error ? qualityErr : undefined,
          context: { demandId: demand.id },
        });
      }

      return bestPrd;
    } catch (error) {
      logger.error('Erro ao gerar PRD com PM', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: demand.id },
      });
      throw new AppError(
        'Falha na geração do PRD. Os dados de refinamento foram preservados. Tente novamente mais tarde.',
        502,
        'PRD_GENERATION_FAILED',
      );
    }
  }

  public async generateTasksWithPM(
    demand: Demand,
    prdContent: string,
    model?: string,
  ): Promise<string> {
    // Determinar tipo de refinamento
    const refinementType = this.parent.resolveDemandRefinementType(demand);
    const isTechnical = refinementType === 'technical';
    const documentModel = this.parent.resolveDocumentGenerationModel(model, isTechnical);
    const documentModelFallback = this.parent.resolveDocumentGenerationFallback(model, isTechnical);
    // Get insights from evolved context
    const insightsSummary = contextBuilder.getInsightsSummary(demand.id);
    const isImprovement = demand.type === 'melhoria';

    // Melhoria usa prompt dedicado que impõe regra de task [IMPLEMENTAÇÃO]
    const systemPrompt = isImprovement
      ? this.parent.getImprovementTasksPrompt(insightsSummary)
      : `Você é um Product Manager experiente criando um checklist de execução para um produto pessoal.

--- ANTI-OVERENGINEERING CONSTRAINTS (OBRIGATÓRIO) ---
1. NÃO sugira tecnologias fora do stack atual (TypeScript, React, Node.js, Vite, SQLite)
2. NÃO proponha refatoração arquitetural ou troca de frameworks
3. TODAS as estimativas devem ser realistas (< 2 semanas para features, < 3 dias para bugs)
4. As tasks devem ser INCREMENTAIS e PRÁTICAS
5. Foque no que pode ser feito AGORA com a stack atual
6. Não force Backend, Frontend, Database e DevOps se a demanda não precisar

${insightsSummary ? `--- INSIGHTS DA SQUAD ---\n${insightsSummary}\n\n` : ''}
Crie um documento de tasks baseado no PRD seguindo EXATAMENTE este formato:

# Checklist De Execução - [Título da Demanda]

**Versão:** 1.0.0
**Prioridade:** [Alta/Média/Baixa]
**Responsável:** @produto-pessoal
**Status:** Não Iniciado

## Agora

- **T1:** [Descrição concisa da tarefa 1]
  Critérios de aceite: [Critérios específicos de aceite]
  **Dependências:** [Tarefas ou recursos necessários]
  **Vinculado ao PRD:** [Seção relevante]

- **T2:** [Descrição concisa da tarefa 2]
  Critérios de aceite: [Critérios específicos de aceite]
  **Dependências:** T1
  **Vinculado ao PRD:** [Seção relevante]

- **T3:** [Descrição concisa da tarefa 3]
  Critérios de aceite: [Critérios específicos de aceite]
  **Dependências:** Nenhuma
  **Vinculado ao PRD:** [Seção relevante]

## Depois
- [Melhoria futura que não deve bloquear a entrega atual]

## Não Fazer
- [Item fora de escopo para evitar overengineering]

## Métricas de Sucesso
- [Tempo economizado ou fricção removida]
- [Como saber que o plano foi reaproveitado na execução]
- [Indicador simples de qualidade]

## Notas de Implementação
[Observações técnicas importantes, boas práticas, ou considerações de arquitetura]

IMPORTANTE:
- Siga EXATAMENTE este formato
- Gere entre 3 e 7 tasks; use menos tasks quando a demanda for simples
- Cada task deve ter ID sequencial (T1, T2, T3, etc.)
- Vincule cada task a uma seção, entrega ou métrica do PRD
- Cubra somente as áreas realmente necessárias
- Seja específico e técnico nas descrições

Gere o documento em português brasileiro.`;

    // Para melhoria: passa demanda original + PRD para recuperar a intenção real
    // Para outros tipos: passa apenas o PRD (comportamento original)
    const userPrompt = isImprovement
      ? `Demanda Original:
Título: ${demand.title}
Descrição: ${demand.description}
Tipo: ${demand.type}
Prioridade: ${demand.priority}

PRD Gerado:
${prdContent}

=== SUA TAREFA ===
Com base na demanda original e no PRD acima, crie um checklist de execução.
Lembre-se: a demanda promete uma MELHORIA REAL. O checklist deve entregar isso, não só planejar ou medir.

IMPORTANTE:
- OBRIGATÓRIO: inclua ao menos uma task [IMPLEMENTAÇÃO] que aplique a mudança real prometida na demanda
- Vincule cada task a seções do PRD (§4.1, §5.1, §8, §11, §12)
- Se houver meta numérica no objetivo, gere diagnóstico → implementação → validação
- Separe com rigor o que fazer agora, o que fazer depois e o que não fazer`
      : `PRD:
${prdContent}

=== SUA TAREFA ===
Com base no PRD acima, crie um checklist de execução pessoal.
As tasks devem cobrir apenas os aspectos necessários para implementar a menor entrega útil.

IMPORTANTE:
- As tasks devem refletir diretamente o escopo, a experiência esperada, as regras de negócio e as métricas do PRD
- Use informações técnicas e insights específicos mencionados durante o refinamento da squad
- Crie tarefas que estejam claramente alinhadas com as sugestões dos agentes do refinamento
- Separe com rigor o que fazer agora, o que fazer depois e o que não fazer`;

    try {
      const generateTasks = async (feedback?: string): Promise<string> => {
        const promptWithFeedback = feedback
          ? `${userPrompt}

=== FEEDBACK DE AUTO-CORREÇÃO (REFLEXION) ===
O checklist anterior falhou na validação de qualidade. Corrija as pendências abaixo sem remover as tasks que já estão corretas:
${feedback}`
          : userPrompt;

        const response = await openAIService.generateChatCompletion(
          systemPrompt,
          promptWithFeedback,
          {
            demandId: demand.id,
            demandDescription: demand.description,
            temperature: 0.5,
            // Auditoria 2026-08-03: com 2000, 7 das 8 últimas gerações bateram
            // exatamente no teto e o checklist saiu cortado no meio de uma
            // frase — inclusive nos handoffs já materializados. Alinhado ao
            // teto do PRD (4000); `failOnTruncation` cobre o caso de ainda
            // assim estourar, em vez de persistir documento pela metade.
            maxTokens: 4000,
            failOnTruncation: true,
            model: documentModel,
            modelFallback: documentModelFallback,
            taskType: isTechnical ? 'technical' : 'document',
            operation: 'document:tasks',
            agentName: 'product_manager',
            cache: false,
            // Conteúdo já refinado pela squad (não input bruto de usuário) — mesma
            // convenção de roundtable-orchestrator.ts: guardrail indisponível não
            // deve derrubar a geração do documento.
            failOpenOnError: true,
            // Bug #10224: userPrompt embute a demanda original + PRD gerado
            // pela squad; conteúdo interno já ingerido, não input humano ao vivo.
            skipInjectionCheck: true,
          },
        );

        // Bug 1: resposta vazia da LLM não vira checklist-stub; aborta.
        if (!response || !response.trim()) {
          throw new AppError(
            'Geração de tasks retornou conteúdo vazio da LLM',
            502,
            'DOCUMENT_GENERATION_EMPTY',
          );
        }
        return response;
      };

      // SpecKit conformance (flag OFF por default): validação síncrona do
      // checklist contra o schema Zod, retry (max 2) e needs_review. A 1ª
      // "tentativa" reaproveita o conteúdo já gerado; só regenera se não conforme.
      const finalizeTasks = async (content: string): Promise<string> => {
        if (!featureFlags.getFlags().specKitConformanceEnabled) return content;
        const { enforceSpecConformance } = await import('../../cognitive-core/spec-conformance');
        let firstPass = true;
        const conformance = await enforceSpecConformance(
          'tasks',
          async (feedback) => {
            if (firstPass) {
              firstPass = false;
              return content;
            }
            return generateTasks(feedback);
          },
          { maxAttempts: 2, demandId: demand.id },
        );
        return conformance.needsReview
          ? prependNeedsReviewBanner(conformance)
          : conformance.content;
      };

      // Demandas que não são de melhoria mantêm a geração única (sem gate tiered):
      // o validateImprovementTasks exige task [IMPLEMENTAÇÃO], regra exclusiva do
      // checklist de melhoria (getImprovementTasksPrompt).
      if (!isImprovement) {
        return finalizeTasks(await generateTasks());
      }

      // Quality gate do checklist de melhoria: o validateImprovementTasks (validador
      // tiered, antes usado apenas em testes) passa a bloquear e a alimentar um loop
      // de reparo — exige task [IMPLEMENTAÇÃO], seção "## Agora", IDs de task e as
      // seções Depois / Não Fazer / Métricas de Sucesso (nível 3).
      const countErrors = (result: { issues: Array<{ severity: string }> }): number =>
        result.issues.filter((issue) => issue.severity === 'error').length;

      let tasksContent = await generateTasks();
      let assessment = improvementExecutionService.validateImprovementTasks(tasksContent, {
        level: 3,
      });
      let bestTasks = tasksContent;
      let bestErrors = countErrors(assessment);

      let iteration = 0;
      const maxIterations = 2;

      logger.info('[Reflexion] Validando primeira versão do checklist de tasks', {
        context: { demandId: demand.id, valid: assessment.qualityPassed, errorsCount: bestErrors },
      });

      while (!assessment.qualityPassed && iteration < maxIterations) {
        if (this.parent.stopRequests.has(demand.id)) {
          logger.info(
            '[Reflexion] Interrompido pelo usuário — encerrando refinamento do checklist',
            { context: { demandId: demand.id, iteration } },
          );
          break;
        }
        iteration++;

        const errorIssues = assessment.issues.filter((issue) => issue.severity === 'error');
        const feedback =
          errorIssues
            .map((issue) => `- [QUALIDADE] [${issue.section} · ${issue.category}] ${issue.message}`)
            .join('\n') || '- Garanta ao menos uma task [IMPLEMENTAÇÃO] e as seções obrigatórias.';

        logger.info(`[Reflexion] Refinando checklist de tasks ${iteration}/${maxIterations}`, {
          context: { demandId: demand.id, errors: errorIssues.map((issue) => issue.message) },
        });

        try {
          const refined = await generateTasks(feedback);
          const newAssessment = improvementExecutionService.validateImprovementTasks(refined, {
            level: 3,
          });
          const newErrors = countErrors(newAssessment);

          // Keep-best: só promove o refinamento se reduziu os erros bloqueantes.
          if (newErrors < bestErrors) {
            bestTasks = refined;
            bestErrors = newErrors;
          }

          tasksContent = refined;
          assessment = newAssessment;

          if (assessment.qualityPassed) {
            logger.info(
              '[Reflexion] Checklist de tasks passou no gate de qualidade tiered. Encerrando o loop.',
              { context: { demandId: demand.id, iteration } },
            );
            break;
          }
        } catch (err) {
          logger.error(`[Reflexion] Erro durante o refinamento do checklist ${iteration}`, {
            error: err instanceof Error ? err : undefined,
            context: { demandId: demand.id },
          });
          break;
        }
      }

      return finalizeTasks(bestTasks);
    } catch (error) {
      logger.error('Erro ao gerar tasks com PM', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: demand.id },
      });
      // Bug 1 (falha de LLM → documento falso): em vez de devolver um checklist
      // placeholder que seria persistido como se fosse real, propagamos a falha.
      // O caller aborta e o usuário vê um erro claro; nenhum documento é gravado.
      throw new AppError(
        'Falha na geração das tasks. Os dados de refinamento foram preservados. Tente novamente mais tarde.',
        502,
        'TASKS_GENERATION_FAILED',
      );
    }
  }

  public validatePilotQualityInvariants(
    demand: Demand,
    prdContent: string,
    templatePassed: boolean,
  ): {
    qaPassed: boolean;
    blockers: string[];
    invariants: Record<string, boolean>;
  } {
    const normalized = prdContent
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const demandTypeLabel = getDemandTypeConfig(demand.type)
      .label.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const technicalSignals = [
      'arquitetura',
      'componente',
      'dependenc',
      'api',
      'contrato',
      'sequencia',
      'performance',
      'seguranca',
      'rollout',
      'monitoramento',
      'risco',
      'mitig',
    ];
    const technicalSignalCount = technicalSignals.filter((signal) =>
      normalized.includes(signal),
    ).length;

    const invariants = {
      prd_reflects_extracted_fields:
        normalized.includes(demand.type) ||
        normalized.includes(demandTypeLabel) ||
        normalized.includes('tipo de demanda'),
      tags_do_not_contradict_area_type:
        !normalized.includes('bug') || demand.type === 'bug' || normalized.includes('nao fazer'),
      risk_complexity_coherent:
        demand.refinementType === 'technical'
          ? technicalSignalCount >= 2
          : normalized.includes('risco') &&
            (normalized.includes('escopo') ||
              normalized.includes('complexidade') ||
              normalized.includes('mitigacao')),
      template_validator_passed: templatePassed,
    };

    const blockers = Object.entries(invariants)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    return {
      qaPassed: blockers.length === 0,
      blockers,
      invariants,
    };
  }

  public async saveDocument(demandId: number, type: string, content: string): Promise<string> {
    const documentsDir = resolvePath('documents');
    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }

    // Spec 019: nome legível e ESTÁVEL por demanda+tipo — o H1 do documento é o
    // nome da solução; sem data nem contador de colisão, cada re-refinamento
    // sobrescreve o PDF anterior (exatamente 1 por demanda+tipo na pasta).
    const extractedTitle = PromptParser.extractH1(content);
    const pdfFilename = buildPdfFilename(extractedTitle, demandId, type as PdfDocType);

    const pdfFilepath = path.join(documentsDir, pdfFilename);

    // Sincronizar com o sistema de versionamento para garantir que o DocumentViewer
    // sempre carregue a versão mais recente (corrige bug de PRD desatualizado)
    const docType = type.toLowerCase() as 'prd' | 'tasks';
    if (docType === 'prd' || docType === 'tasks') {
      try {
        // Carregar versão atual para obter o ifMatchVersion
        const currentDoc = await documentVersioningService.load(demandId, docType);
        // Salvar nova versão (force=true para evitar conflitos durante refinement)
        await documentVersioningService.save(demandId, docType, content, currentDoc.version, true);
        logger.debug('Documento sincronizado com sistema de versionamento', {
          context: { demandId, type: docType },
        });
      } catch (err) {
        // Log mas não falhar - o arquivo já foi salvo no disco
        logger.warn('Falha ao sincronizar com sistema de versionamento', {
          error: err instanceof Error ? err : undefined,
          context: { demandId, type: docType },
        });
      }
    }

    // Desacoplamento via EventBus (Microservice Extraction Pattern)
    // O worker irá rodar assincronamente e criar o .pdf no filepath designado
    eventBus.publish('DOCUMENT_GENERATION_REQUESTED', {
      demandId,
      type,
      content,
      targetFilepath: pdfFilepath,
    });

    // Retorna a rota do PDF para o banco de dados (que será atendida quando a geração assíncrona finalizar)
    // ou pela rota de download se o frontend preferir.
    return `/api/documents/${pdfFilename}`;
  }

  public buildOperationalOrientation(description: string): string {
    const text = description || '';
    const urls = Array.from(text.matchAll(/https?:\/\/\S+/g)).map((match) => match[0]);
    const hasAttachmentSignal = /anex|documenta[cç][aã]o|arquivo/i.test(text);
    const hasToolSignal = /ferramenta|onboard/i.test(text);

    const lines: string[] = [];
    if (hasToolSignal) {
      lines.push('- Validar ferramenta citada na demanda e mapear ponto exato de uso no fluxo.');
      lines.push(
        '- Evitar perguntar novamente pela ferramenta se ela já estiver explícita no contexto/anexo.',
      );
    }
    if (hasAttachmentSignal) {
      lines.push(
        '- Tratar documentação anexada como fonte primária de regras e campos obrigatórios.',
      );
      lines.push('- Converter evidência do anexo em critérios de aceite verificáveis.');
    }
    if (urls.length > 0) {
      lines.push(`- Referências externas informadas: ${urls.slice(0, 3).join(', ')}`);
    }
    if (lines.length === 0) {
      lines.push('- Sem orientação operacional adicional explícita na demanda.');
    }

    return lines.join('\n');
  }

  public buildOperationalOrientationForAgent(description: string): string {
    const text = description || '';

    // Detect tool signals with specific tool name extraction
    const toolPatterns = [/ferramenta[:\s]+([^\n,.]+)/i, /(onboard|portal\s+\w+)/i];
    let detectedTool: string | null = null;
    for (const pattern of toolPatterns) {
      const match = text.match(pattern);
      if (match) {
        detectedTool = match[1]?.trim() || match[0]?.trim();
        break;
      }
    }

    // Detect attachment signals
    const hasAttachmentSignal =
      /anex|documenta[cç][aã]o|arquivo|EXTRAÍD[OA]\s+PARA\s+REFINAMENTO/i.test(text);

    // Detect document content (from refinement-input.ts extraction)
    const hasExtractedDocument = text.includes('DOCUMENTAÇÃO ANEXADA (EXTRAÍDA PARA REFINAMENTO)');

    const lines: string[] = [];

    if (detectedTool) {
      lines.push(
        `FERRAMENTA CONFIRMADA: "${detectedTool}" — NÃO pergunte qual ferramenta será usada.`,
      );
      lines.push(`Use "${detectedTool}" como contexto para mapear campos, fluxos e integrações.`);
    }

    if (hasExtractedDocument) {
      lines.push(
        'DOCUMENTAÇÃO ANEXADA PRESENTE — Extraia regras, campos obrigatórios e fluxos diretamente do anexo.',
      );
      lines.push('NÃO pergunte por documentação adicional. Trate o anexo como fonte primária.');
    } else if (hasAttachmentSignal) {
      lines.push('SINAL DE ANEXO DETECTADO — Verifique se há conteúdo extraído no contexto.');
      lines.push('Se houver, use como fonte primária. Se não, solicite o documento específico.');
    }

    // Return empty string if no signals (agent proceeds with normal questioning)
    return lines.length > 0 ? lines.join('\n') : '';
  }

  public getImprovementPRDPrompt(insightsSummary: string, isTechnical: boolean): string {
    const technicalAddon = isTechnical
      ? `

--- MODO TÉCNICO ATIVO (para melhoria) ---
O refinamento técnico foi solicitado. Aprofunde os detalhes do plano de execução e dos entregáveis com informações de implementação concretas (arquivos, módulos, passos técnicos), mas NUNCA remova as seções acionáveis: Critérios de Aceite, Plano de Execução e Casos de Borda são obrigatórios mesmo em modo técnico.`
      : '';

    return `Você é um Product Manager experiente criando um PRD de MELHORIA orientado à execução.

--- REGRA DE INTEGRIDADE NUMÉRICA (obrigatória) ---
- NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
- Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
- É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
- ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.

--- ANTI-OVERENGINEERING CONSTRAINTS (OBRIGATÓRIO) ---
1. NÃO entre em detalhes técnicos que não ajudem a executar
2. Foque no que muda, como validar e o que entregar
3. Mantenha linguagem prática — o usuário lê uma vez e age
4. Priorize clareza sobre completude; evite texto decorativo
5. Não use TAM, ARR, MRR, SSO ou compliance pesado

--- MODO PRODUTO PESSOAL (OBRIGATÓRIO) ---
1. Escreva para um builder solo que precisa executar, não para comitê
2. Separe com rigor: fazer agora, fazer depois e não fazer
3. Critérios de aceite devem ser verificáveis (checkbox), não vagos
4. Plano de execução deve ser uma lista ordenada de passos concretos
5. Métricas devem ter baseline + meta + forma de medir${technicalAddon}

${insightsSummary ? `--- INSIGHTS DA SQUAD ---\n${insightsSummary}\n\n` : ''}
--- REGRAS PARA DETERMINAR STATUS DE PRONTIDÃO (OBRIGATÓRIO) ---
IMPORTANTE: Avalie o status APÓS considerar os insights da squad, não apenas a demanda original.

Use **Pronta** quando:
1. Os insights dos agentes responderam as principais perguntas sobre escopo, viabilidade e critérios
2. Há evidência técnica suficiente (arquivos analisados, gaps identificados, solução proposta)
3. Existem critérios de aceite verificáveis definidos nos insights
4. O escopo está claro e fatiado em incrementos executáveis
5. Todas as métricas sem baseline possuem passo de instrumentação definido. Se houver alguma métrica marcada como "A MEDIR" sem passo de instrumentação claro, o status deve ser obrigatoriamente definido como **Pronta para instrumentar**.

Use **Precisa refinar** quando:
1. Há perguntas críticas SEM resposta nos insights dos agentes
2. Falta evidência técnica para validar a abordagem proposta
3. O escopo ainda é muito amplo ou ambíguo MESMO após o refinamento da squad

Use **Bloqueada** quando:
1. Há dependências externas não resolvidas (aprovação pendente, acesso negado, terceiros)
2. Requisito técnico impossível com stack atual identificado pelos agentes

REGRA DE OURO: Se um insight de agente (Tech Lead, QA, Refinador, Scrum Master, etc.) já respondeu uma pergunta, NÃO a liste como "aberta". Perguntas abertas são APENAS as que permanecem sem resposta APÓS o refinamento. Se a squad analisou código, identificou gaps e propôs solução, a demanda provavelmente está PRONTA.

Crie um PRD de MELHORIA em Markdown seguindo EXATAMENTE este formato:

# PRD - [Título]

## 1. Decisão De Produto
[3-5 linhas: o que será feito, por que agora e qual o menor resultado útil]

## 2. Prontidão Da Demanda
- **Status:** [Pronta / Precisa refinar / Bloqueada] (avalie com base nos insights da squad, não na demanda original)
- **Por que:** [Justificativa objetiva baseada no que a squad descobriu]
- **Perguntas abertas:** [Somente perguntas que AINDA bloqueiam execução após o refinamento. Se os insights responderam as perguntas principais, escreva: Nenhuma que bloqueie a execução imediata.]

## 3. Problema e Oportunidade
### 3.1 Contexto do Problema
[Qual dor concreta estamos resolvendo? Quem sente e quando?]

### 3.2 Impacto Atual
[O que fica pior ou continua travado se não resolver agora?]

### 3.3 Oportunidade
[Qual ganho prático e mensurável ao resolver?]

## 4. Objetivo e Benefícios
### 4.1 Objetivo Principal
[Uma frase: "Permitir que [usuário] consiga [ação] para [benefício]"]

### 4.2 Benefícios Esperados
- **Para o Usuário:** [Como melhora a vida do usuário]
- **Para o Produto Pessoal:** [Como reduz tempo, melhora clareza ou acelera execução]
- **Para a Operação:** [Redução de custo/suporte/retrabalho]

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- [Entrega concreta 1]
- [Entrega concreta 2]

### 5.2 Fazer Depois
- [Melhoria futura 1]

### 5.3 Não Fazer
- [Item explicitamente excluído e motivo]

## 6. Experiência Esperada
### 6.1 Jornada do Usuário
[Descreva passo a passo como o usuário vai perceber a melhoria]

### 6.2 Critérios de Sucesso do Usuário
- [O usuário consegue X sem precisar de Y]
- [O tempo para Z é menor do que antes]

## 7. Regras de Negócio e Premissas
### 7.1 Regras de Negócio
- [Regra 1: "Se X, então Y"]
- [Regra 2: "Nunca permitir Z quando W"]

### 7.2 Premissas
- [Premissa 1: Assumimos que...]
- [Premissa 2: Dependemos de...]

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| [Métrica 1] | [Valor atual ou "não medido"] | [Valor alvo] | [Método/ferramenta] |
| [Métrica 2] | [Valor atual ou "não medido"] | [Valor alvo] | [Método/ferramenta] |

## 9. Prioridade e Justificativa
- **Prioridade:** [Alta/Média/Baixa]
- **Justificativa:** [Por que essa prioridade? Impacto vs Esforço]
- **Custo de Atraso:** [O que perdemos se não fizermos agora?]

## 10. Riscos e Mitigações
| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| [Risco 1] | Alta/Média/Baixa | Alto/Médio/Baixo | [Como evitar] |

## 11. Critérios de Aceite
- [ ] [Critério verificável e objetivo 1]
- [ ] [Critério verificável e objetivo 2]
- [ ] [Critério verificável e objetivo 3]

## 12. Plano de Execução
1. [Passo concreto 1] — [Prazo ou ordem sugerida]
2. [Passo concreto 2] — [Prazo ou ordem sugerida]
3. [Passo concreto 3] — [Prazo ou ordem sugerida]

## 13. Casos de Borda
- [Caso de borda 1]: [Comportamento esperado]
- [Caso de borda 2]: [Comportamento esperado]

IMPORTANTE:
- Este é um documento de MELHORIA orientado à execução
- As seções 11 (Critérios de Aceite), 12 (Plano de Execução) e 13 (Casos de Borda) são OBRIGATÓRIAS
- O usuário deve conseguir ler uma vez e saber exatamente o que fazer
- Não crie documento burocrático: cada seção deve servir para decidir ou executar
- Métricas devem ter baseline + meta + forma de medir — nunca deixe em branco${this.parent.getDocumentEvidenceTrailer()}`;
  }

  public getTechnicalPRDPrompt(insightsSummary: string): string {
    return `Você é um Tech Lead/Arquiteto de Software sênior criando um TSD (Technical Specification Document) — o artefato técnico que desenvolvedores usam para implementar a solução.

--- REGRA DE INTEGRIDADE NUMÉRICA (obrigatória) ---
- NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
- Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
- É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
- ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.

--- PRINCÍPIOS DO TSD (OBRIGATÓRIO) ---
1. Responde APENAS "Como vamos implementar isso?" — não "Por que estamos fazendo isso?" (isso é o PRD).
2. Stack permitida: TypeScript, React, Node.js, Vite, SQLite/Drizzle. NÃO sugira nada fora.
3. Soluções SIMPLES e INCREMENTAIS: prefira código existente a novas abstrações.
4. Estimativas realistas: features ≤ 2 semanas, bugs/ajustes ≤ 3 dias.
5. Cada seção deve ser IMPLEMENTÁVEL — não especulativa. Se não houver dado suficiente, marque como [A DEFINIR] com uma pergunta objetiva.
6. NÃO repita seções de negócio do PRD (objetivo do usuário, métricas de produto, ROI).

--- REGRAS DE QUALIDADE ---
- Contratos de API: sempre incluir método HTTP, path, tipos TypeScript do request/response e códigos de status.
- Schema de banco: sempre em Drizzle ORM ou SQL DDL explícito — nunca descrição textual vaga.
- Diagrama de sequência: use ASCII simples ou Mermaid sequenceDiagram — nunca prosa descritiva.
- NFRs: cada item deve ter threshold numérico (ex: p95 < 300ms, disponibilidade ≥ 99,5%).
- Rollout: especifique a feature flag, percentual de exposição inicial e critério de promoção.

${insightsSummary ? `--- INSIGHTS DA SQUAD ---\n${insightsSummary}\n\n` : ''}
Crie o TSD em Markdown seguindo EXATAMENTE este formato:

# TSD - [Título da Demanda]

| Campo | Valor |
|-------|-------|
| Autor | Tech Lead |
| Data | [DD/MM/YYYY] |
| Status | Rascunho |
| Versão | 1.0 |

## 1. Contexto Técnico
[2-4 frases: qual problema de engenharia está sendo resolvido e quais são as restrições técnicas relevantes. NÃO descreva valor de negócio.]

## 2. Decisões de Design
[Liste as principais decisões técnicas tomadas e o motivo. Use o padrão:]
- **[Decisão]:** [Escolha feita] — [Motivo / alternativa descartada]

## 3. Arquitetura e Componentes Afetados
[Descreva quais módulos/serviços/arquivos são criados ou modificados. Use lista com caminhos:]
- \`caminho/do/arquivo.ts\` — [O que muda e por quê]
[Se aplicável, adicione diagrama de blocos ASCII:]
\`\`\`
[ComponenteA] --> [ServiçoB] --> [BancoC]
\`\`\`

## 4. Modelo de Dados
[Schema Drizzle ORM ou SQL DDL. Se não há mudança de schema, escreva "Sem alteração de schema".]
\`\`\`typescript
// Drizzle schema — server/db/schema.ts
export const nomeTabela = sqliteTable('nome_tabela', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // ...campos
});
\`\`\`

## 5. Contratos de API
[Para cada endpoint novo ou modificado:]
\`\`\`
POST /api/recurso
Request:  { campo: string; valor: number }
Response 200: { id: number; criado: string }
Response 400: { error: string; field?: string }
Response 500: { error: 'internal' }
\`\`\`

## 6. Fluxo de Sequência
[Diagrama Mermaid ou ASCII mostrando a sequência de chamadas para o fluxo principal:]
\`\`\`mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  participant D as Database
  C->>S: POST /api/recurso
  S->>D: INSERT INTO ...
  D-->>S: id
  S-->>C: 200 { id }
\`\`\`

## 7. Requisitos Não-Funcionais (NFR)
| NFR | Threshold | Como Medir |
|-----|-----------|------------|
| Latência p95 | < [Xms] | Logs do openAIService |
| Disponibilidade | ≥ [Y]% | Health check endpoint |
| Tamanho do payload | < [ZKB] | Teste de carga manual |

## 8. Tratamento de Erros e Edge Cases
- [Cenário de erro 1]: [comportamento esperado + código HTTP]
- [Cenário de edge case]: [como o sistema deve se comportar]
[Se há retry/fallback, descreva a política: ex: 2 tentativas com backoff de 500ms]

## 9. Plano de Rollout
- **Feature flag:** \`FEATURE_[NOME]_ENABLED\` (padrão: \`false\`)
- **Exposição inicial:** [X]% dos usuários ou ambiente de staging
- **Critério de promoção:** [Métrica que autoriza ativar para 100%]
- **Critério de rollback:** [Métrica ou erro que aciona rollback]

## 10. Checklist de Implementação
- [ ] Schema migrado e testado localmente
- [ ] Endpoints cobertos por testes de integração
- [ ] Feature flag configurada no .env.example
- [ ] Logs estruturados adicionados nos pontos críticos
- [ ] PR revisado pelo Tech Lead antes do merge
${this.parent.getDocumentEvidenceTrailer()}`;
  }

  public getBusinessPRDPrompt(insightsSummary: string): string {
    return `Você é um Product Manager experiente criando um documento de requisitos de negócio.

--- REGRA DE INTEGRIDADE NUMÉRICA (obrigatória) ---
- NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
- Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
- É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
- ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.

--- ANTI-OVERENGINEERING CONSTRAINTS (OBRIGATÓRIO) ---
1. NÃO entre em detalhes técnicos de implementação
2. Foque no VALOR para o usuário e para o negócio
3. Mantenha linguagem acessível para stakeholders não-técnicos
4. Priorize clareza sobre completude

--- MODO PRODUTO PESSOAL (OBRIGATÓRIO) ---
1. Escreva para um builder solo decidindo o que fazer agora
2. Troque linguagem corporativa por decisão prática
3. Separe claramente: fazer agora, fazer depois e não fazer
4. Não use TAM, ARR, MRR, enterprise sales, SSO ou compliance pesado
5. O documento deve ajudar a executar, não impressionar stakeholders

${insightsSummary ? `--- INSIGHTS DA SQUAD ---\n${insightsSummary}\n\n` : ''}
--- REGRAS PARA DETERMINAR STATUS DE PRONTIDÃO (OBRIGATÓRIO) ---
IMPORTANTE: Avalie o status APÓS considerar os insights da squad, não apenas a demanda original.

Use **Pronta** quando:
1. Os insights dos agentes responderam as principais perguntas sobre escopo, viabilidade e critérios
2. Há evidência técnica suficiente (arquivos analisados, gaps identificados, solução proposta)
3. Existem critérios de aceite verificáveis definidos nos insights
4. O escopo está claro e fatiado em incrementos executáveis
5. Todas as métricas sem baseline possuem passo de instrumentação definido. Se houver alguma métrica marcada como "A MEDIR" sem passo de instrumentação claro, o status deve ser obrigatoriamente definido como **Pronta para instrumentar**.

Use **Precisa refinar** quando:
1. Há perguntas críticas SEM resposta nos insights dos agentes
2. Falta evidência técnica para validar a abordagem proposta
3. O escopo ainda é muito amplo ou ambíguo MESMO após o refinamento da squad

Use **Bloqueada** quando:
1. Há dependências externas não resolvidas (aprovação pendente, acesso negado, terceiros)
2. Requisito técnico impossível com stack atual identificado pelos agentes

REGRA DE OURO: Se um insight de agente (Tech Lead, QA, Refinador, Scrum Master, etc.) já respondeu uma pergunta, NÃO a liste como "aberta". Perguntas abertas são APENAS as que permanecem sem resposta APÓS o refinamento. Se a squad analisou código, identificou gaps e propôs solução, a demanda provavelmente está PRONTA.

Crie um PRD de NEGÓCIOS em Markdown seguindo EXATAMENTE este formato:

# PRD - [Título]

## 1. Decisão De Produto
[3-5 linhas: o que fazer, por que agora e qual menor resultado útil]

## 2. Prontidão Da Demanda
- **Status:** [Pronta / Precisa refinar / Bloqueada] (avalie com base nos insights da squad, não na demanda original)
- **Por que:** [Justificativa objetiva baseada no que a squad descobriu]
- **Perguntas abertas:** [Somente perguntas que AINDA bloqueiam execução após o refinamento. Se os insights responderam as perguntas principais, escreva: Nenhuma que bloqueie a execução imediata.]

## 3. Problema e Oportunidade
### 3.1 Contexto do Problema
[Qual dor do usuário/negócio estamos resolvendo?]

### 3.2 Impacto Atual
[O que fica pior se não resolver agora?]

### 3.3 Oportunidade
[Qual ganho prático ao resolver?]

## 4. Objetivo e Benefícios
### 4.1 Objetivo Principal
[Uma frase clara: "Permitir que [usuário] consiga [ação] para [benefício]"]

### 4.2 Benefícios Esperados
- **Para o Usuário:** [Como melhora a vida do usuário]
- **Para o Produto Pessoal:** [Como reduz tempo, melhora clareza ou acelera execução]
- **Para a Operação:** [Redução de custo/suporte/tempo]

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- [Funcionalidade/entrega 1]
- [Funcionalidade/entrega 2]

### 5.2 Fazer Depois
- [Melhoria futura 1]

### 5.3 Não Fazer
- [Item explicitamente excluído 1]
- [Item explicitamente excluído 2]

## 6. Experiência Esperada
### 6.1 Jornada do Usuário
[Descreva passo a passo como o usuário vai interagir com a funcionalidade]

### 6.2 Critérios de Sucesso do Usuário
- [O usuário consegue fazer X em Y cliques]
- [O tempo para completar a tarefa é menor que Z]

## 7. Regras de Negócio e Premissas
### 7.1 Regras de Negócio
- [Regra 1: "Se X, então Y"]
- [Regra 2: "Nunca permitir Z quando W"]

### 7.2 Premissas
- [Premissa 1: Assumimos que...]
- [Premissa 2: Dependemos de...]

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Tempo economizado | [Valor atual] | [Valor esperado] | [Ferramenta/método] |
| Reaproveitamento do plano | [Valor atual] | [Valor esperado] | [Ferramenta/método] |

## 9. Prioridade e Justificativa
- **Prioridade:** [Alta/Média/Baixa]
- **Justificativa:** [Por que essa prioridade? Impacto vs Esforço]
- **Custo de Atraso:** [O que perdemos se não fizermos agora?]

## 10. Riscos e Mitigações
| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| [Risco 1] | Alta/Média/Baixa | Alto/Médio/Baixo | [Como evitar] |

IMPORTANTE:
- Este é um documento de produto pessoal para decisão e execução
- Evite jargão técnico quando não ajudar a decidir
- Mantenha seções de objetivo, valor, impacto e prioridade
- O documento deve ser compreensível em uma leitura${this.parent.getDocumentEvidenceTrailer()}`;
  }

  public getImprovementTasksPrompt(insightsSummary: string): string {
    return `Você é um Product Manager experiente criando um checklist de execução para uma demanda de MELHORIA.

--- REGRAS OBRIGATÓRIAS PARA MELHORIA (NUNCA IGNORE) ---
1. Toda demanda de melhoria DEVE ter ao menos uma task marcada como [IMPLEMENTAÇÃO].
   Uma task [IMPLEMENTAÇÃO] é aquela que aplica a mudança real: altera código, comportamento, prompt, configuração ou fluxo.
   Tarefas de diagnóstico, medição, relatório ou decisão NÃO contam como [IMPLEMENTAÇÃO].
2. Se o objetivo da melhoria tiver uma meta numérica (ex: "reduzir de X para Y", "aumentar de A para B"),
   o checklist DEVE conter: uma task de diagnóstico (medir baseline), uma task [IMPLEMENTAÇÃO] e uma task de validação (comparar depois vs. antes).
3. Cada task do ## Agora DEVE estar vinculada a: Objetivo Principal (§4.1) OU Fazer Agora (§5.1) OU Critérios de Aceite (§11) OU Métricas de Sucesso (§8).
4. Nunca gere um checklist onde todas as tasks são só diagnóstico, medição ou decisão. Isso é um plano de análise, não de entrega.

--- ANTI-OVERENGINEERING CONSTRAINTS (OBRIGATÓRIO) ---
1. NÃO sugira tecnologias fora do stack atual (TypeScript, React, Node.js, Vite, SQLite)
2. NÃO proponha refatoração arquitetural ou troca de frameworks
3. TODAS as estimativas devem ser realistas (< 2 semanas)
4. As tasks devem ser INCREMENTAIS e PRÁTICAS
5. Foque no que pode ser feito AGORA com a stack atual

${insightsSummary ? `--- INSIGHTS DA SQUAD ---\n${insightsSummary}\n\n` : ''}
Crie um checklist de execução para MELHORIA em Markdown seguindo EXATAMENTE este formato:

# Checklist De Execução - [Título da Demanda]

**Versão:** 1.0.0
**Prioridade:** [Alta/Média/Baixa]
**Responsável:** @produto-pessoal
**Status:** Não Iniciado

## Agora

- **T1:** [DIAGNÓSTICO] [Descrição — medir ou mapear o estado atual antes de mudar]
  Critérios de aceite: [Baseline registrado e disponível para comparação]
  **Dependências:** Nenhuma
  **Vinculado ao PRD:** §8 Métricas de Sucesso

- **T2:** [IMPLEMENTAÇÃO] [Descrição — aplicar a mudança cirúrgica real]
  Critérios de aceite: [Critério verificável de que a mudança foi feita e funciona]
  **Dependências:** T1
  **Vinculado ao PRD:** §5.1 Fazer Agora

- **T3:** [VALIDAÇÃO] [Descrição — comparar resultado atual com baseline de T1]
  Critérios de aceite: [Métrica atingiu a meta definida em §8 e §11]
  **Dependências:** T2
  **Vinculado ao PRD:** §11 Critérios de Aceite

## Depois
- [Refinamento futuro que não bloqueia a entrega atual]

## Não Fazer
- [Item explicitamente fora de escopo e motivo]

## Métricas de Sucesso
- [Métrica com baseline → meta — igual ao §8 do PRD]
- [Indicador de que a task [IMPLEMENTAÇÃO] funcionou]

## Notas de Implementação
[Observações técnicas mínimas e necessárias para executar]

IMPORTANTE:
- Siga EXATAMENTE este formato
- Gere entre 3 e 7 tasks
- Cada task deve ter ID sequencial (T1, T2, T3...) e prefixo [DIAGNÓSTICO], [IMPLEMENTAÇÃO] ou [VALIDAÇÃO]
- Nunca termine o checklist sem ao menos uma task [IMPLEMENTAÇÃO]
- Vincule cada task a uma seção do PRD
- Gere o documento em português brasileiro`;
  }

  public resolveDocumentGenerationModel(model?: string, isTechnical?: boolean): string {
    // TDD/Technical refinements must use the technical-specialized code model,
    // not a generalist model. Env overrides: CODE_MODEL > OPENAI_MODEL_TECHNICAL > default.
    if (isTechnical) {
      const technicalModel =
        process.env.CODE_MODEL || process.env.OPENAI_MODEL_TECHNICAL || 'qwen/qwen3-coder-next';
      return technicalModel;
    }

    // Honor explicit model param (including openrouter free models like nemotron)
    if (model && model !== MODEL_MINI) {
      return model;
    }

    // Default to the PM agent's configured YAML model when caller did not pin one
    const pmAgentModel = this.parent.agentConfigs['product_manager']?.model;
    if (!model && pmAgentModel) {
      return pmAgentModel;
    }

    return PRODUCT_MANAGER_DOCUMENT_MODEL;
  }

  public resolveDocumentGenerationFallback(
    model?: string,
    isTechnical?: boolean,
  ): string | undefined {
    // TDD needs a fallback too - use tech_lead's fallback or a reliable default
    if (isTechnical) {
      const techLeadAgent = this.parent.agentConfigs['tech_lead'];
      return techLeadAgent?.model_fallback || 'codestral-latest';
    }

    // PRD fallback: use PM agent's configured fallback
    const pmAgent = this.parent.agentConfigs['product_manager'];
    if (!pmAgent) return undefined;
    if (!model || model === pmAgent.model) {
      return pmAgent.model_fallback;
    }
    return undefined;
  }
}
