import { type Demand } from '@shared/schema';
import { logger } from '../../utils/logger';
import { contextBuilder } from '../context-builder';
import { resolveDemandRepoFullName } from '../../utils/repo-context';
import { refinementRAGService } from '../refinement-rag';
import { domainKnowledgeRAGService } from '../domain-knowledge-rag';
import { shouldSkipStage, logSkippedStages } from './evaluation-gate';
import type { CognitiveCoreOutput, IRealityBasedRefinement } from '../../orchestration-contracts';

export class ContextAssembler {
  /**
   * Extrai nomes de repositórios referenciados na descrição.
   */
  public extractReferencedRepositories(description: string): string[] {
    const repos: string[] = [];
    const repoRegex = /Reposit[oó]rio:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = repoRegex.exec(description)) !== null) {
      repos.push(match[1].toLowerCase());
    }
    return [...new Set(repos)];
  }

  /**
   * Constrói o contexto interno base utilizando RAG de refinamentos anteriores e Repo Lock.
   *
   * Paralelizado: `contextBuilder.buildContext()` e `refinementRAGService.buildContext()`
   * são independentes (o repoLock é síncrono, derivado de `demand`). Antes eram
   * sequenciais (~2× latência). Agora rodam em paralelo via Promise.allSettled,
   * preservando o fallback degradado (RAG falha → continua com base context).
   */
  public async assembleInternalContext(
    demand: Demand,
    cognitiveOutput?: CognitiveCoreOutput,
    realityBasedRefinement?: IRealityBasedRefinement,
  ): Promise<string> {
    contextBuilder.clearEvolvingContext(demand.id);

    const repoFullName = resolveDemandRepoFullName(demand);
    const repoLock = repoFullName
      ? `\n\n--- REPO LOCK (MANDATÓRIO) ---\nVocê está refinando uma demanda do repositório \`${repoFullName}\`. Use APENAS o histórico, PRDs, Tasks e chats referentes a este repositório. Se o bloco RAG abaixo trouxer qualquer item de outro repo (apesar do filtro), IGNORE-O explicitamente — qualquer evidência precisa apontar para \`${repoFullName}\`.`
      : '';

    // Spec 10015: em go-live, pula o enriquecimento RAG (etapa não crítica e cara).
    // O base context — que é crítico e já degrada bem sem RAG — continua rodando.
    const skipRag = shouldSkipStage('rag_quality', demand.goLiveMode);
    if (skipRag) {
      logSkippedStages(demand.id, ['rag_quality']);
    }

    // Paraleliza os 2 context builds independentes. allSettled preserva o
    // fallback: se o RAG falhar, usamos só o base context (comportamento anterior).
    const [baseResult, ragResult, domainResult] = await Promise.allSettled([
      contextBuilder.buildContext(demand),
      skipRag
        ? Promise.resolve('')
        : (async () => {
            await refinementRAGService.ingestFromDocuments();
            // Incidente 2026-07-17: descrições de infra com logs/dumps chegavam a
            // 21k tokens e eram pagas inteiras no rerank. Título + abertura da
            // descrição carregam o sinal de relevância; o resto é ruído caro.
            const ragQuery = `${demand.title} ${(demand.description || '').slice(0, 1500)}`;
            return refinementRAGService.buildContext(ragQuery, 4, {
              repoFullName,
              includeGlobal: false,
              demandId: demand.id,
              agentName: 'context_assembler',
            });
          })(),
      skipRag
        ? Promise.resolve('')
        : Promise.resolve(
            domainKnowledgeRAGService.buildContext(
              demand.domain || 'padrao',
              `${demand.title} ${demand.description}`,
            ),
          ),
    ]);

    if (baseResult.status === 'rejected') {
      // base context é crítico — se falhou, propaga.
      throw baseResult.reason;
    }

    const base = baseResult.value;

    // CRIT-4: além do base context (já registrado em `evolvingContexts` por
    // contextBuilder.buildContext), o Repo Lock e os dois RAGs precisam ser
    // persistidos como "external context" — é isso que `getEvolvedContext`
    // devolve para CADA agente do caminho cognitivo (executeAgent). Sem este
    // passo, RAG e conhecimento de domínio eram descartados silenciosamente.
    const ragParts: string[] = [];
    if (ragResult.status === 'fulfilled' && ragResult.value) {
      ragParts.push(`--- CONTEXTO RAG DE REFINAMENTOS ANTERIORES ---\n${ragResult.value}`);
    } else if (ragResult.status === 'rejected') {
      logger.warn('Refinement RAG unavailable, continuing with base context', {
        error: ragResult.reason instanceof Error ? ragResult.reason : undefined,
      });
    }

    if (domainResult.status === 'fulfilled' && domainResult.value) {
      ragParts.push(`--- CONTEXTO RAG DO DOMÍNIO ---\n${domainResult.value}`);
    } else if (domainResult.status === 'rejected') {
      logger.warn('Domain RAG unavailable, continuing without domain corpus', {
        error: domainResult.reason instanceof Error ? domainResult.reason : undefined,
      });
    }

    const enrichmentParts = repoLock ? [repoLock.trim(), ...ragParts] : ragParts;
    contextBuilder.setExternalContext(demand.id, enrichmentParts.join('\n\n'));

    // Spec 10145: injetar RealityConstraints no caminho roundtable.
    // Chamada DEPOIS de buildContext (ctx existe) e DEPOIS de
    // clearEvolvingContext (para não ser apagada).
    if (realityBasedRefinement) {
      try {
        const realityConstraints = await realityBasedRefinement.getConstraintsForDemandType(
          demand.type,
        );
        contextBuilder.setRealityConstraints(demand.id, {
          maturityLevel: realityConstraints.maturityLevel || 'MVP',
          demandType: realityConstraints.demandType || demand.type,
          canonicalDemandType: realityConstraints.canonicalDemandType,
          allowedTechnologies: realityConstraints.allowedTechnologies || [
            'TypeScript',
            'React',
            'Node.js',
            'Vite',
            'SQLite',
          ],
          forbiddenTechnologies: realityConstraints.forbiddenTechnologies || [
            'kubernetes',
            'microservices',
            'blockchain',
          ],
          maxEffortDays: realityConstraints.maxEffortDays || 14,
          minROI: realityConstraints.minROI || '3:1',
          outputType: realityConstraints.outputType,
          typeRequirements: [...(realityConstraints.typeRequirements || [])],
        });
      } catch (error) {
        // Spec P1 (auditoria 2026-07-26): NUNCA fabricar tecnologias/esforço/ROI
        // plausíveis aqui — isso instruiria a squad com premissas erradas sem
        // sinal visível. Marca o bloco como indisponível; getRealityConstraintsText
        // renderiza um marcador explícito em vez destes valores.
        logger.warn(
          '[ContextAssembler] Reality check falhou, marcando constraints como indisponíveis',
          {
            error: error instanceof Error ? error : undefined,
            context: { demandId: demand.id },
          },
        );
        contextBuilder.setRealityConstraints(demand.id, {
          maturityLevel: 'MVP',
          allowedTechnologies: [],
          forbiddenTechnologies: [],
          maxEffortDays: 0,
          minROI: '[A DEFINIR]',
          demandType: demand.type,
          outputType: 'standard refinement',
          typeRequirements: [],
          unavailable: true,
        });
      }
    }

    const contextParts = [`${base}${repoLock}`, ...ragParts];

    // Spec 10145: garante que RealityConstraints cheguem ao texto do roundtable.
    const realityConstraintsText = contextBuilder.getRealityConstraintsText(demand.id);
    if (realityConstraintsText) {
      contextParts.push(realityConstraintsText);
    }

    // Spec 10144: injeta configurações ricas do cognitive-core no contexto,
    // quando o adapter as fornece.
    if (cognitiveOutput) {
      const constraintLines = cognitiveOutput.constraints
        .map((c) => `- ${c.name} (${c.severity}): ${c.description || ''}`)
        .join('\n');
      const specialistLines = cognitiveOutput.specialists
        .map((s) => `- ${s.agentId} (prioridade ${s.priority})`)
        .join('\n');

      contextParts.push(
        `--- CONFIGURAÇÃO COGNITIVA ---\n` +
          `Tipo: ${cognitiveOutput.classification.type}\n` +
          `Confiança: ${cognitiveOutput.classification.confidence}\n` +
          `Framework: ${cognitiveOutput.framework}\n` +
          `Esforço máximo: ${cognitiveOutput.numericFields.maxEffortDays} dias\n` +
          `Restrições:\n${constraintLines}\n` +
          `Especialistas:\n${specialistLines}`,
      );
    }

    return contextBuilder.capContext(contextParts.join('\n\n'));
  }
}

export const contextAssembler = new ContextAssembler();
