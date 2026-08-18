import { PDFDocument, PDFPage, PDFFont, rgb, StandardFonts } from 'pdf-lib';
import {
  validatePRDDocument,
  validateTDDDocument,
  validateTasksDocument,
  formatValidationErrors,
} from '../utils/validateDocuments';
import { logger } from '../utils/logger';
import { professionalLayout, designTokens } from './pdf-styles';
import { wrapText, wrapTextByFontMetrics, breakLongWord } from './pdf-layout';
import {
  removeUnsupportedPdfGlyphs,
  sanitizePdfContent,
  stripMarkdownForPdfText,
} from './pdf-content-utils';
import {
  drawProfessionalFooter,
  drawProfessionalHeader,
  drawSimpleFooter,
  drawSimpleHeader,
} from './pdf-page-chrome';

export interface PRDData {
  title: string;
  overview: {
    objective: string;
    problem: string;
    solution: string;
  };
  functionalRequirements: Array<{
    id: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
  }>;
  nonFunctionalRequirements: Array<{
    id: string;
    description: string;
    metric: string;
  }>;
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  acceptanceCriteria: string[];
  dependencies: {
    internal: string[];
    external: string[];
  };
  risks: Array<{
    description: string;
    impact: string;
    probability: string;
    mitigation: string;
  }>;
  metrics: {
    primary: string[];
    secondary: string[];
  };
  timeline: {
    mvpDate: string;
    phases: string[];
  };
  version: string;
}

export interface TasksData {
  title: string;
  metadata: {
    priority: string;
    responsible: string;
    status: string;
    version: string;
  };
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    category: string;
    acceptanceCriteria: string[];
    responsible: string;
    priority: string;
    estimate: string;
    linkedRequirements: string[];
    status: string;
  }>;
  successMetrics: string[];
}

export class PDFGenerator {
  private readonly professionalLayout = professionalLayout;

  /**
   * Sanitiza o conteúdo para evitar erros de codificação no PDF (ex: caracteres não-WinAnsi)
   */
  private sanitizeContent(content: string): string {
    return sanitizePdfContent(content);
  }

  /**
   * Extrai dados estruturados de um documento PRD em Markdown
   * para validação com schema Zod
   */
  private extractPRDDataFromMarkdown(content: string): PRDData {
    const data: PRDData = {
      title: '',
      overview: { objective: '', problem: '', solution: '' },
      functionalRequirements: [],
      nonFunctionalRequirements: [],
      scope: { inScope: [], outOfScope: [] },
      acceptanceCriteria: [],
      dependencies: { internal: [], external: [] },
      risks: [],
      metrics: { primary: [], secondary: [] },
      timeline: { mvpDate: '', phases: [] },
      version: '1.0.0',
    };

    // Extrai título
    const titleMatch = content.match(/^#\s+PRD\s*-\s*(.+)$/m);
    if (titleMatch) data.title = titleMatch[1].trim();

    // Extrai versão
    const versionMatch = content.match(/\*\*Versão:\*\*\s*\[?(\d+\.\d+\.\d+)\]?/);
    if (versionMatch) data.version = versionMatch[1];

    // Extrai overview
    const overviewObjectiveMatch = content.match(
      /## 📋 Visão Geral\n\n\*\*Objetivo:\*\*\s*([^\n]+)/m,
    );
    if (overviewObjectiveMatch) data.overview.objective = overviewObjectiveMatch[1].trim();
    const overviewProblemMatch = content.match(/\*\*Problema:\*\*\s*([^\n]+)/m);
    if (overviewProblemMatch) data.overview.problem = overviewProblemMatch[1].trim();
    const overviewSolutionMatch = content.match(/\*\*Solução:\*\*\s*([^\n]+)/m);
    if (overviewSolutionMatch) data.overview.solution = overviewSolutionMatch[1].trim();

    // Extrai functional requirements
    const functionalRequirementsMatch = content.match(/## 🎯 Requisitos Funcionais([\s\S]*?)##/m);
    if (functionalRequirementsMatch) {
      const requirements = functionalRequirementsMatch[1].match(
        /- RF\d+:[\s\S]*?(?=- RF\d+:|##|$)/g,
      );
      if (requirements) {
        data.functionalRequirements = requirements.map((req) => ({
          id: req.match(/- RF(\d+):/)?.[1] || '',
          description: req.match(/\*\*Descrição:\*\*\s*([^\n]+)/)?.[1].trim() || '',
          acceptanceCriteria:
            req
              .match(/\*\*Critérios de Aceite:\*\*\s*([\s\S]*?)(?=\*\*Prioridade|$)/)?.[1]
              .trim() || '',
          priority: req.match(/\*\*Prioridade:\*\*\s*([^\n]+)/)?.[1].trim() || '',
        }));
      }
    }

    // Extrai non-functional requirements
    const nonFunctionalRequirementsMatch = content.match(
      /## 🛠️ Requisitos Não Funcionais([\s\S]*?)##/m,
    );
    if (nonFunctionalRequirementsMatch) {
      const requirements = nonFunctionalRequirementsMatch[1].match(
        /- RNF\d+:[\s\S]*?(?=- RNF\d+:|##|$)/g,
      );
      if (requirements) {
        data.nonFunctionalRequirements = requirements.map((req) => ({
          id: req.match(/- RNF(\d+):/)?.[1] || '',
          description: req.match(/\*\*Descrição:\*\*\s*([^\n]+)/)?.[1].trim() || '',
          metric: req.match(/\*\*Métrica:\*\*\s*([^\n]+)/)?.[1].trim() || '',
        }));
      }
    }

    // Extrai scope
    const inScopeMatch = content.match(/### In Scope([\s\S]*?)###/m);
    if (inScopeMatch) {
      data.scope.inScope =
        inScopeMatch[1].match(/- [^\n]+/g)?.map((item) => item.replace(/- /, '').trim()) || [];
    }
    const outOfScopeMatch = content.match(/### Out of Scope([\s\S]*?)##/m);
    if (outOfScopeMatch) {
      data.scope.outOfScope =
        outOfScopeMatch[1].match(/- [^\n]+/g)?.map((item) => item.replace(/- /, '').trim()) || [];
    }

    // Extrai acceptance criteria
    const acceptanceCriteriaMatch = content.match(
      /## ✅ Critérios de Aceitação Gerais([\s\S]*?)##/m,
    );
    if (acceptanceCriteriaMatch) {
      data.acceptanceCriteria =
        acceptanceCriteriaMatch[1]
          .match(/- [^\n]+/g)
          ?.map((item) => item.replace(/- /, '').trim()) || [];
    }

    // Extrai risks
    const risksMatch = content.match(/## ⚠️ Riscos e Mitigações([\s\S]*?)##/m);
    if (risksMatch) {
      data.risks =
        risksMatch[1]
          .match(/- \*\*Risco \d+:\*\*[\s\S]*?(?=- \*\*Risco \d+:|##|$)/g)
          ?.map((risk) => ({
            description: risk.match(/- \*\*Risco \d+:\*\*\s*([^\n]+)/)?.[1].trim() || '',
            impact: risk.match(/\*\*Impacto:\*\*\s*([^\n]+)/)?.[1].trim() || '',
            probability: risk.match(/\*\*Probabilidade:\*\*\s*([^\n]+)/)?.[1].trim() || '',
            mitigation: risk.match(/\*\*Mitigação:\*\*\s*([^\n]+)/)?.[1].trim() || '',
          })) || [];
    }

    // Extrai metrics
    const primaryMetricsMatch = content.match(/### KPIs Primários([\s\S]*?)###/m);
    if (primaryMetricsMatch) {
      data.metrics.primary =
        primaryMetricsMatch[1].match(/- [^\n]+/g)?.map((item) => item.replace(/- /, '').trim()) ||
        [];
    }
    const secondaryMetricsMatch = content.match(/### KPIs Secundários([\s\S]*?)##/m);
    if (secondaryMetricsMatch) {
      data.metrics.secondary =
        secondaryMetricsMatch[1].match(/- [^\n]+/g)?.map((item) => item.replace(/- /, '').trim()) ||
        [];
    }

    // Extrai timeline
    const timelineMatch = content.match(/## 📅 Cronograma Estimado([\s\S]*?)##/m);
    if (timelineMatch) {
      data.timeline.mvpDate =
        timelineMatch[1].match(/\*\*Data de Lançamento \(MVP\):\*\*\s*([^\n]+)/)?.[1].trim() || '';
    }

    // Log summary
    logger.debug('[PDF-GENERATOR] Extracted PRD data for validation', {
      context: {
        title: data.title,
        version: data.version,
        hasTitle: !!data.title,
        contentLength: content.length,
        functionalReqCount: data.functionalRequirements.length,
        nonFunctionalReqCount: data.nonFunctionalRequirements.length,
        risksCount: data.risks.length,
      },
    });

    return data;
  }

  /**
   * Extrai dados estruturados de um documento Tasks em Markdown
   * para validação com schema Zod
   */
  private extractTasksDataFromMarkdown(content: string): TasksData {
    const data: TasksData = {
      title: '',
      metadata: {
        priority: 'Média',
        responsible: '@produto-pessoal',
        status: 'Não Iniciado',
        version: '1.0.0',
      },
      tasks: [],
      successMetrics: [],
    };

    // Extrai título (Suporta "Tasks Document - Title" e "Checklist De Execução - Title")
    const titleMatch = content.match(/^#\s+(?:Tasks Document|Checklist De Execução)\s*-\s*(.+)$/m);
    if (titleMatch) data.title = titleMatch[1].trim();

    // Extrai versão
    const versionMatch = content.match(/\*\*Versão:\*\*\s*\[?(\d+\.\d+\.\d+)\]?/);
    if (versionMatch) data.metadata.version = versionMatch[1];

    // Extrai metadata
    const priorityMatch = content.match(/\*\*Prioridade:?\*\*:?\s*([^\n]+)/i);
    if (priorityMatch) {
      const p = priorityMatch[1].trim();
      if (['Alta', 'Média', 'Baixa'].includes(p)) {
        data.metadata.priority = p;
      }
    }
    const responsibleMatch = content.match(/\*\*Responsável:?\*\*:?\s*([^\n]+)/i);
    if (responsibleMatch) {
      const resp = responsibleMatch[1].trim();
      data.metadata.responsible = resp.startsWith('@') ? resp : `@${resp.replace(/\s+/g, '-')}`;
    }
    const statusMatch = content.match(/\*\*Status:?\*\*:?\s*([^\n]+)/i);
    if (statusMatch) {
      const s = statusMatch[1].trim();
      if (['Não Iniciado', 'Em Progresso', 'Concluído'].includes(s)) {
        data.metadata.status = s;
      }
    }

    // Extrai tasks (Suporta "## Tarefas", "## Agora", "## 12. Plano de Execução")
    const tasksMatch = content.match(
      /## (?:(?:\d+\.\s*)?(?:Tarefas|Agora|Plano de Execução))([\s\S]*?)(##|$)/i,
    );
    if (tasksMatch) {
      data.tasks =
        tasksMatch[1]
          .match(/- \*\*T\d+:?\*\*[:\s]*[\s\S]*?(?=- \*\*T\d+:?\*\*[:\s]*|##|$)/g)
          ?.map((task) => {
            const idMatch = task.match(/- \*\*T(\d+):?\*\*/);
            const descMatch = task.match(/- \*\*T\d+:?\*\*[:\s]*(?:\s*\[[A-Z]+\])?\s*([^\n]+)/);

            return {
              id: idMatch ? `T${idMatch[1]}` : '',
              title: descMatch ? descMatch[1].trim().substring(0, 100) : 'Tarefa sem título',
              description: descMatch ? descMatch[1].trim() : '',
              category: 'Backend', // Default para conformidade com schema
              acceptanceCriteria: [
                task.match(/Critérios de aceite:\s*([^\n]+)/i)?.[1].trim() || 'Critério padrão',
              ],
              responsible: data.metadata.responsible,
              priority: data.metadata.priority,
              estimate: '1 SP', // Default para conformidade com schema
              linkedRequirements: ['RF1'], // Default para conformidade com schema
              status: data.metadata.status === 'Concluído' ? 'Concluído' : 'Não Iniciado',
            };
          }) || [];
    }

    // Extrai success metrics
    const successMetricsMatch = content.match(
      /## (?:(?:\d+\.\s*)?Métricas de Sucesso)([\s\S]*?)(##|$)/i,
    );
    if (successMetricsMatch) {
      data.successMetrics =
        successMetricsMatch[1].match(/- [^\n]+/g)?.map((item) => item.replace(/- /, '').trim()) ||
        [];
    }

    // Log summary
    logger.debug('[PDF-GENERATOR] Extracted Tasks data for validation', {
      context: {
        title: data.title,
        tasksCount: data.tasks.length,
        successMetricsCount: data.successMetrics.length,
        contentLength: content.length,
      },
    });

    return data;
  }

  /**
   * Remove emojis and other non-WinAnsi characters from text
   * WinAnsi (used by Helvetica) only supports basic Latin characters
   */
  private removeEmojis(text: string): string {
    return removeUnsupportedPdfGlyphs(text);
  }

  private hasMarkdownHeadings(content: string): boolean {
    return (content.match(/^##\s+/gm)?.length || 0) >= 2;
  }

  private isBusinessPRDContent(content: string): boolean {
    const businessSections = [
      'resumo executivo',
      'decisão de produto',
      'contexto e problema',
      'problema e oportunidade',
      'publico impactado',
      'público impactado',
      'objetivo e benefícios',
      'objetivos de negocio',
      'objetivos de negócio',
      'escopo da entrega',
      'escopo',
      'experiencia esperada',
      'experiência esperada',
      'metricas de sucesso',
      'métricas de sucesso',
    ];

    return businessSections.some((section) => {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Suporta: "## Seção", "## 1. Seção", "## 🎯 Seção", "## 1. 🎯 Seção"
      const regex = new RegExp(
        `^##\\s+(?:\\d+\\.\\s*)?(?:[\\u2700-\\u27BF]|[\\uE000-\\uF8FF]|\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|[\\u2011-\\u26FF]|\\uD83E[\\uDD10-\\uDDFF])?\\s*${escaped}`,
        'im',
      );
      return regex.test(content);
    });
  }

  private isTDDContent(content: string): boolean {
    // Detecta TSD (novo) ou TDD (legado) pelo título
    const hasTSDTitle = /^#\s+TSD\s*[-–—]/im.test(content);
    const hasTDDTitle = /^#\s+TDD\s*[-–—]/im.test(content);
    if (hasTSDTitle || hasTDDTitle) return true;

    const tddSections = [
      // TSD novo
      'contexto técnico',
      'decisões de design',
      'arquitetura e componentes',
      'contratos de api',
      'requisitos não-funcionais',
      'tratamento de erros',
      'checklist de implementação',
      // TDD legado
      'visão geral',
      'abstract',
      'arquitetura proposta',
      'arquitetura',
      'modelo de dados',
      'data schema',
      'definição de apis',
      'contratos',
      'fluxo de sequência',
      'considerações de performance',
      'plano de rollout',
      'alternativas consideradas',
    ];

    // Se tem pelo menos 3 seções técnicas, é TDD
    let matchCount = 0;
    for (const section of tddSections) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `^##\\s+(?:\\d+\\.\\s*)?(?:[\\u2700-\\u27BF]|[\\uE000-\\uF8FF]|\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|[\\u2011-\\u26FF]|\\uD83E[\\uDD10-\\uDDFF])?\\s*${escaped}`,
        'im',
      );
      if (regex.test(content)) {
        matchCount++;
        if (matchCount >= 3) return true;
      }
    }

    return false;
  }

  private stripMarkdownForPdf(text: string): string {
    return stripMarkdownForPdfText(text);
  }

  async generatePRDDocument(content: string, demandId: number): Promise<Buffer> {
    const sanitizedContent = this.sanitizeContent(content);
    const isTDD = this.isTDDContent(sanitizedContent);
    const docType = isTDD ? 'TDD' : 'PRD';

    logger.debug(`[PDF-GENERATOR] Starting ${docType} document generation`, {
      context: {
        demandId,
        contentLength: sanitizedContent.length,
        isTDD,
        timestamp: new Date().toISOString(),
      },
    });

    // FASE 1: Validação de estrutura Markdown (usa validação específica para TDD ou PRD)
    const markdownValidation = isTDD
      ? validateTDDDocument(sanitizedContent)
      : validatePRDDocument(sanitizedContent);

    if (!markdownValidation.isValid) {
      logger.error(`[PDF-GENERATOR] ${docType} Markdown validation failed:`, {
        context: {
          demandId,
          errors: markdownValidation.errors,
          timestamp: new Date().toISOString(),
        },
      });
      logger.error(formatValidationErrors(markdownValidation, docType as 'PRD'));
    }

    if (markdownValidation.warnings.length > 0) {
      logger.warn(`[PDF-GENERATOR] ${docType} Markdown validation warnings:`, {
        context: {
          demandId,
          warnings: markdownValidation.warnings,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // FASE 2: Validação de schema Zod legado (somente para PRD técnico RF/RNF, não para TDD ou Business PRD)
    if (!isTDD && !this.isBusinessPRDContent(content)) {
      try {
        const schemaValidation = validatePRDDocument(content);

        if (!schemaValidation.isValid && schemaValidation.errors.length > 0) {
          const formattedErrors = formatValidationErrors(schemaValidation, 'PRD');
          logger.error('[PDF-GENERATOR] PRD Zod schema validation failed:', {
            context: {
              demandId,
              errors: formattedErrors,
              timestamp: new Date().toISOString(),
            },
          });

          // Log cada erro individualmente para facilitar debugging
          schemaValidation.errors.forEach((error, index) => {
            logger.error(
              `[PDF-GENERATOR] PRD Schema Error ${index + 1}: [${error.field}] ${error.message}`,
            );
          });
        } else {
          logger.debug('[PDF-GENERATOR] PRD Zod schema validation passed', {
            context: {
              demandId,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } catch (error) {
        logger.error('[PDF-GENERATOR] Error during Zod validation:', {
          context: {
            demandId,
            timestamp: new Date().toISOString(),
          },
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } else {
      logger.debug(
        '[PDF-GENERATOR] Business PRD detected; skipping legacy RF/RNF schema validation',
        {
          context: {
            demandId,
            timestamp: new Date().toISOString(),
          },
        },
      );
    }

    // Format content to follow standard PRD structure
    const formattedContent = this.formatPRDContent(content);

    // Extract document title for header & metadata
    const h1Match = content.match(/^#\s+(.+)$/m);
    const docTitle = h1Match
      ? h1Match[1].trim().replace(/^PRD\s*[-–]\s*/i, '')
      : `Demanda #${demandId}`;
    const brandName: string = designTokens?.brand?.displayName ?? 'AICHATflow';
    const dateStr = new Date().toISOString().slice(0, 10);

    // Create a new PDFDocument
    const pdfDoc = await PDFDocument.create();

    // Set PDF metadata
    pdfDoc.setTitle(`PRD - ${docTitle}`);
    pdfDoc.setAuthor(designTokens?.pdf?.author ?? `${brandName} Platform`);
    pdfDoc.setSubject(`PRD Executivo - Demanda #${demandId}`);
    pdfDoc.setCreator(designTokens?.pdf?.creator ?? `${brandName} PDF Engine v2`);
    pdfDoc.setProducer(designTokens?.pdf?.producer ?? `${brandName} PDF Engine v2`);
    pdfDoc.setKeywords(
      (designTokens?.pdf?.keywords ?? ['AICHATflow', 'PRD', 'Product Requirements']) as string[],
    );
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setModificationDate(new Date());

    // Embed the Helvetica font
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBoldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Draw PRD with the professional layout contract. This changes presentation
    // only: content order and text are preserved from formattedContent.
    await this.drawProfessionalPRDContent(
      pdfDoc,
      helveticaFont,
      helveticaBoldFont,
      formattedContent,
      demandId,
      `PRD Executivo`,
    );

    logger.debug('[PDF-GENERATOR] PRD metadata set', {
      context: { demandId, docTitle, dateStr },
    });

    // Serialize the PDFDocument to bytes
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  async generateTasksDocument(content: string, demandId: number): Promise<Buffer> {
    const sanitizedContent = this.sanitizeContent(content);

    logger.debug('[PDF-GENERATOR] Starting Tasks document generation', {
      context: {
        demandId,
        contentLength: sanitizedContent.length,
        timestamp: new Date().toISOString(),
      },
    });

    // FASE 1: Validação de estrutura Markdown (validação existente)
    const markdownValidation = validateTasksDocument(sanitizedContent);

    if (!markdownValidation.isValid) {
      logger.error('[PDF-GENERATOR] Tasks Markdown validation failed:', {
        context: {
          demandId,
          errors: markdownValidation.errors,
          timestamp: new Date().toISOString(),
        },
      });
      logger.error(formatValidationErrors(markdownValidation, 'Tasks'));
    }

    if (markdownValidation.warnings.length > 0) {
      logger.warn('[PDF-GENERATOR] Tasks Markdown validation warnings:', {
        context: {
          demandId,
          warnings: markdownValidation.warnings,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // FASE 2: Validação de schema Zod (nova validação estrutural)
    try {
      const schemaValidation = validateTasksDocument(content);

      if (!schemaValidation.isValid && schemaValidation.errors.length > 0) {
        const formattedErrors = formatValidationErrors(schemaValidation, 'Tasks');
        logger.error('[PDF-GENERATOR] Tasks Zod schema validation failed:', {
          context: {
            demandId,
            errors: formattedErrors,
            timestamp: new Date().toISOString(),
          },
        });

        // Log cada erro individualmente para facilitar debugging
        schemaValidation.errors.forEach((error, index) => {
          logger.error(
            `[PDF-GENERATOR] Tasks Schema Error ${index + 1}: [${error.field}] ${error.message}`,
          );
        });
      } else {
        logger.debug('[PDF-GENERATOR] Tasks Zod schema validation passed', {
          context: {
            demandId,
            timestamp: new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      logger.error('[PDF-GENERATOR] Error during Zod validation:', {
        context: {
          demandId,
          timestamp: new Date().toISOString(),
        },
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    // Format content to follow standard Tasks structure
    const formattedContent = this.formatTasksContent(content);

    const h1MatchTasks = content.match(/^#\s+(.+)$/m);
    const docTitleTasks = h1MatchTasks ? h1MatchTasks[1].trim() : `Tasks - Demanda #${demandId}`;
    const brandNameTasks: string = designTokens?.brand?.displayName ?? 'AICHATflow';

    // Create a new PDFDocument
    const pdfDoc = await PDFDocument.create();

    // Set PDF metadata
    pdfDoc.setTitle(docTitleTasks);
    pdfDoc.setAuthor(designTokens?.pdf?.author ?? `${brandNameTasks} Platform`);
    pdfDoc.setSubject(`Tasks Document - Demanda #${demandId}`);
    pdfDoc.setCreator(designTokens?.pdf?.creator ?? `${brandNameTasks} PDF Engine v2`);
    pdfDoc.setProducer(designTokens?.pdf?.producer ?? `${brandNameTasks} PDF Engine v2`);
    pdfDoc.setKeywords((designTokens?.pdf?.keywords ?? ['AICHATflow', 'Tasks']) as string[]);
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setModificationDate(new Date());

    // Embed the Helvetica font
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBoldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Draw content across multiple pages
    await this.drawMultiPageContent(
      pdfDoc,
      helveticaFont,
      helveticaBoldFont,
      formattedContent,
      demandId,
      'Tasks',
    );

    // Serialize the PDFDocument to bytes
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  /**
   * Format content to follow standard Tasks structure
   */
  private formatTasksContent(content: string): string {
    // Check if content already has standard structure
    if (
      content.includes('## 1. Project Overview') ||
      content.includes('## 2. Task Categories') ||
      content.includes('## Tarefas') ||
      this.hasMarkdownHeadings(content)
    ) {
      return content.trim();
    }

    // Extract summarized content if available
    const summaryMatch = content.match(
      /Resumo das discussões dos agentes:([\s\S]*?)Detalhes dos agentes:/,
    );
    const summaryContent = summaryMatch ? summaryMatch[1].trim() : '';

    // Format content into standard Tasks structure
    const formattedContent = `
# Tasks Document

## 1. Project Overview

**Project Name:** [Project Name]
**Date:** ${new Date().toLocaleDateString()}
**Version:** 1.0

## 2. Task Categories

${this.extractTaskCategories(content)}

## 3. Task Priorities

${this.extractTaskPriorities(content)}

## 4. Dependencies

${this.extractSection(content, 'dependencies', 'depends on')}

## 5. Approvals

- **Project Manager:** [Name]
- **Tech Lead:** [Name]
- **Stakeholders:** [Names]

## 6. Summary of Agent Discussions

${summaryContent || 'No summary available.'}
`;

    return formattedContent.trim();
  }

  /**
   * Extract task categories from content
   */
  private extractTaskCategories(content: string): string {
    const lines = content.split('\n');
    const categories: {
      backend: string[];
      frontend: string[];
      qa: string[];
      devops: string[];
      other: string[];
    } = {
      backend: [],
      frontend: [],
      qa: [],
      devops: [],
      other: [],
    };

    for (const line of lines) {
      if (line.includes('Backend') || line.includes('backend')) {
        categories.backend.push(line);
      } else if (line.includes('Frontend') || line.includes('frontend')) {
        categories.frontend.push(line);
      } else if (line.includes('QA') || line.includes('qa')) {
        categories.qa.push(line);
      } else if (line.includes('DevOps') || line.includes('devops')) {
        categories.devops.push(line);
      } else if (line.trim().startsWith('-')) {
        categories.other.push(line);
      }
    }

    // Format categories
    let result = '';

    if (categories.backend.length > 0) {
      result += '### 2.1 Backend Tasks\n\n';
      result += categories.backend
        .map((task) => `- [ ] ${this.removeEmojis(task.replace(/^- [ \ ]\s*/, '').trim())}`)
        .join('\n');
    }

    if (categories.frontend.length > 0) {
      result += '\n### 2.2 Frontend Tasks\n\n';
      result += categories.frontend
        .map((task) => `- [ ] ${this.removeEmojis(task.replace(/^- [ \ ]\s*/, '').trim())}`)
        .join('\n');
    }

    if (categories.qa.length > 0) {
      result += '\n### 2.3 QA Tasks\n\n';
      result += categories.qa
        .map((task) => `- [ ] ${this.removeEmojis(task.replace(/^- [ \ ]\s*/, '').trim())}`)
        .join('\n');
    }

    if (categories.devops.length > 0) {
      result += '\n### 2.4 DevOps Tasks\n\n';
      result += categories.devops
        .map((task) => `- [ ] ${this.removeEmojis(task.replace(/^- [ \ ]\s*/, '').trim())}`)
        .join('\n');
    }

    if (categories.other.length > 0) {
      result += '\n### 2.5 Other Tasks\n\n';
      result += categories.other
        .map((task) => `- [ ] ${this.removeEmojis(task.replace(/^- [ \ ]\s*/, '').trim())}`)
        .join('\n');
    }

    return result || '- [No tasks provided]';
  }

  /**
   * Extract task priorities from content
   */
  private extractTaskPriorities(content: string): string {
    const lines = content.split('\n');
    const priorities = [];

    for (const line of lines) {
      if (line.includes('priority') || line.includes('Priority')) {
        priorities.push(line);
      }
    }

    if (priorities.length > 0) {
      return priorities.join('\n');
    }

    return `| Task ID | Task Name | Priority | Assigned To | Due Date | Status |
|--------|-----------|----------|-------------|----------|--------|
| T1 | Implement main API | High | [Developer] | [Date] | Not Started |
| T2 | Design UI | Medium | [Designer] | [Date] | Not Started |
| T3 | Write tests | High | [QA] | [Date] | Not Started |`;
  }

  /**
   * Format content to follow standard PRD structure
   */
  private formatPRDContent(content: string): string {
    logger.debug('[PDF-GENERATOR] formatPRDContent called', {
      context: { contentLength: content.length },
    });

    // Check if content already has standard structure
    if (
      content.includes('## 1. Visão Geral') ||
      content.includes('## 2. Requisitos Funcionais') ||
      this.isBusinessPRDContent(content) ||
      this.hasMarkdownHeadings(content)
    ) {
      logger.debug('[PDF-GENERATOR] Content already has standard structure, returning as-is');
      return content.trim();
    }

    // Extract summarized content if available
    const summaryMatch = content.match(
      /Resumo das discussões dos agentes:([\s\S]*?)Detalhes dos agentes:/,
    );
    const summaryContent = summaryMatch ? summaryMatch[1].trim() : '';

    // Format unstructured content into a business-oriented PRD structure
    const section1 = this.extractSection(content, 'overview', 'objectives', 'scope');
    const section2 = this.extractSection(content, 'problem', 'problema', 'pain', 'dor');
    const section3 = this.extractSection(
      content,
      'users',
      'usuarios',
      'usuários',
      'customer',
      'cliente',
    );
    const section4 = this.extractSection(content, 'success metrics', 'metricas', 'métricas', 'kpi');
    const section5 = this.extractSection(
      content,
      'dependencies',
      'risks',
      'dependencias',
      'dependências',
      'riscos',
    );
    const section6 = this.extractSection(
      content,
      'timeline',
      'schedule',
      'milestones',
      'cronograma',
      'prazo',
    );
    const section7 = this.extractSection(
      content,
      'approvals',
      'stakeholders',
      'aprovacao',
      'aprovação',
    );

    logger.debug('[PDF-GENERATOR] Extracted sections:', {
      context: {
        section1Length: section1.length,
        section2Length: section2.length,
        section3Length: section3.length,
        section4Length: section4.length,
        section5Length: section5.length,
        section6Length: section6.length,
        section7Length: section7.length,
        summaryContentLength: summaryContent?.length || 0,
      },
    });

    const formattedContent = `
# PRD Executivo

## Resumo Executivo

${section1}

## Contexto e Problema

${section2}

## Público Impactado

${section3}

## Métricas de Sucesso

${section4}

## Riscos e Dependências

${section5}

## Plano de Entrega

${section6}

## Aprovações Necessárias

${section7}

## Resumo das Discussões da Squad

${summaryContent || 'Nenhum resumo disponível.'}
`;

    logger.debug('[PDF-GENERATOR] Formatted content', {
      context: { formattedContentLength: formattedContent.length },
    });
    return formattedContent.trim();
  }

  /**
   * Extract section content based on keywords
   */
  private extractSection(content: string, ...keywords: string[]): string {
    const lines = content.split('\n');
    const resultLines = [];
    const lowerCaseKeywords = keywords.map((k) => k.toLowerCase());

    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      if (lowerCaseKeywords.some((keyword) => lowerLine.includes(keyword))) {
        resultLines.push(line);
      }
    }

    return resultLines.length > 0 ? resultLines.join('\n') : '- [Content not provided]';
  }

  /**
   * Draw content across multiple pages
   */
  private async drawMultiPageContent(
    pdfDoc: PDFDocument,
    font: PDFFont,
    boldFont: PDFFont,
    content: string,
    demandId: number,
    docType: string,
  ): Promise<void> {
    logger.debug('[PDF-GENERATOR] Starting drawMultiPageContent', {
      context: {
        demandId,
        contentLength: content.length,
        docType,
        timestamp: new Date().toISOString(),
      },
    });

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    const lineHeight = 14;
    const headerHeight = 180;
    const footerHeight = 70;

    // Remove emojis from content
    const cleanContent = this.removeEmojis(content);
    const lines = cleanContent.split('\n');

    logger.debug('[PDF-GENERATOR] Content split into lines', {
      context: {
        demandId,
        lineCount: lines.length,
        firstLine: lines[0]?.substring(0, 50),
        timestamp: new Date().toISOString(),
      },
    });

    // Create first page
    let currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    let pageNumber = 1;
    drawSimpleHeader(currentPage, boldFont, demandId, docType);
    let yPosition = pageHeight - headerHeight;

    for (const line of lines) {
      if (line.trim() === '') {
        yPosition -= 8;
        continue;
      }

      let wrappedLines: string[] = [];
      let fontSize = 12;
      let currentFont = font;
      let color = rgb(0, 0, 0);
      let indent = 0;
      const trimmedLine = line.trim();

      // Check line type and set properties
      if (trimmedLine.startsWith('#')) {
        const headingText = this.stripMarkdownForPdf(trimmedLine.replace(/^#+\s*/, ''));
        wrappedLines = this.wrapText(headingText, maxWidth, boldFont, 16);
        fontSize = 16;
        currentFont = boldFont;
        color = rgb(0.2, 0.4, 0.6);
      } else if (/^-\s+\[[ xX]\]\s*/.test(trimmedLine)) {
        const taskText = this.stripMarkdownForPdf(trimmedLine.replace(/^-\s+\[[ xX]\]\s*/, ''));
        wrappedLines = this.wrapText('- ' + taskText, maxWidth - 20, font, 12);
        indent = 10;
      } else if (/^\d+\.\s+/.test(trimmedLine)) {
        const listText = this.stripMarkdownForPdf(trimmedLine);
        wrappedLines = this.wrapText(listText, maxWidth - 20, font, 12);
        indent = 10;
      } else if (trimmedLine.startsWith('-')) {
        const listText = this.stripMarkdownForPdf(trimmedLine.replace(/^-\s*/, ''));
        wrappedLines = this.wrapText('- ' + listText, maxWidth - 20, font, 12);
        indent = 10;
      } else {
        wrappedLines = this.wrapText(this.stripMarkdownForPdf(line), maxWidth, font, 12);
      }

      // Draw each wrapped line
      for (const wrappedLine of wrappedLines) {
        // Check if we need a new page
        if (yPosition < footerHeight + 20) {
          // Draw footer on current page
          drawSimpleFooter(currentPage, font, pageNumber);

          // Create new page
          pageNumber++;
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          drawSimpleHeader(currentPage, boldFont, demandId, docType);
          yPosition = pageHeight - headerHeight;
        }

        // Draw the line
        currentPage.drawText(wrappedLine, {
          x: margin + indent,
          y: yPosition,
          size: fontSize,
          font: currentFont,
          color: color,
        });

        yPosition -= fontSize === 16 ? 20 : lineHeight;
      }
    }

    // Draw footer on last page
    drawSimpleFooter(currentPage, font, pageNumber);
  }

  private async drawProfessionalPRDContent(
    pdfDoc: PDFDocument,
    font: PDFFont,
    boldFont: PDFFont,
    content: string,
    demandId: number,
    docTitle?: string,
  ): Promise<void> {
    const layout = this.professionalLayout;
    const maxWidth = layout.pageWidth - layout.marginX * 2;
    const cleanContent = this.removeEmojis(content);
    const rawLines = cleanContent.split('\n');
    const generatedAt = new Date();
    const reportTitle = docTitle ?? 'PRD Executivo';

    logger.debug('[PDF-GENERATOR] Drawing PRD with professional layout', {
      context: {
        demandId,
        lineCount: rawLines.length,
        timestamp: generatedAt.toISOString(),
      },
    });

    // --- Pass 1: page estimation for TOC ---
    const tocEntries = this.extractTocEntries(rawLines);
    const needsToc = tocEntries.length >= layout.tocMinPages;

    // Rough page estimate: ~50 lines per page content area
    const linesPerPage = 50;
    const contentStartPage = needsToc ? 3 : 1;
    const tocWithPages = tocEntries.map((entry) => ({
      title: entry.title,
      pageEstimate: contentStartPage + Math.floor(entry.lineIndex / linesPerPage),
    }));

    // --- First content page (page 1 always) ---
    let currentPage = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
    // Page 1 number: 1 if no TOC, else 1 (title/cover behavior — content pages start at 3)
    let pageNumber = contentStartPage;
    drawProfessionalHeader(currentPage, boldFont, font, demandId, generatedAt, reportTitle);
    let yPosition = layout.pageHeight - layout.headerHeight;

    // Collect all content pages so we can patch "X de Y" at the end
    const contentPages: { page: ReturnType<PDFDocument['addPage']>; pageNum: number }[] = [
      { page: currentPage, pageNum: pageNumber },
    ];

    const ensureSpace = (requiredHeight: number) => {
      if (yPosition >= layout.footerHeight + requiredHeight) return;

      drawProfessionalFooter(currentPage, font, pageNumber);
      pageNumber++;
      currentPage = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
      drawProfessionalHeader(currentPage, boldFont, font, demandId, generatedAt, reportTitle);
      yPosition = layout.pageHeight - layout.headerHeight;
      contentPages.push({ page: currentPage, pageNum: pageNumber });
    };

    // --- Table accumulator ---
    let tableRows: string[][] | null = null;

    const flushTable = () => {
      if (!tableRows || tableRows.length === 0) return;
      const tableHeight = tableRows.length * 16 + 8;
      ensureSpace(tableHeight);
      yPosition = this.drawZebraTable(currentPage, font, boldFont, tableRows, yPosition);
      tableRows = null;
    };

    for (const line of rawLines) {
      const trimmedLine = line.trim();

      // Markdown table row detection: | col1 | col2 |
      const isTableRow = /^\|.+\|/.test(trimmedLine);
      // Table separator row: |---|---|
      const isSeparator = /^\|[\s|:-]+\|$/.test(trimmedLine);

      if (isTableRow && !isSeparator) {
        const cells = trimmedLine
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        if (!tableRows) tableRows = [];
        tableRows.push(cells);
        continue;
      }

      if (isSeparator) continue; // skip separator lines between header and body

      // Flush pending table before rendering regular line
      flushTable();

      if (!trimmedLine) {
        yPosition -= layout.paragraphGap;
        continue;
      }

      const style = this.getProfessionalLineStyle(trimmedLine, font, boldFont);
      const availableWidth = maxWidth - style.indent;
      const text = this.getProfessionalLineText(trimmedLine, style.prefix);
      const wrappedLines = this.wrapTextByFontMetrics(
        text,
        availableWidth,
        style.font,
        style.fontSize,
      );
      const blockHeight = wrappedLines.length * style.lineHeight + style.afterGap + style.beforeGap;

      ensureSpace(blockHeight);
      yPosition -= style.beforeGap;

      if (style.drawRule) {
        // Executive Section Bar
        currentPage.drawRectangle({
          x: layout.marginX - 6,
          y: yPosition - style.lineHeight + 4,
          width: layout.pageWidth - layout.marginX * 2 + 12,
          height: style.lineHeight + 2,
          color: layout.headerFill,
        });

        currentPage.drawRectangle({
          x: layout.marginX - 6,
          y: yPosition - style.lineHeight + 4,
          width: 3,
          height: style.lineHeight + 2,
          color: layout.accentColor,
        });
      }
      for (let index = 0; index < wrappedLines.length; index++) {
        ensureSpace(style.lineHeight + layout.paragraphGap);

        const linePrefix = index === 0 ? style.prefix : style.continuationPrefix;
        const prefixWidth = linePrefix
          ? style.font.widthOfTextAtSize(linePrefix, style.fontSize)
          : 0;
        const x = layout.marginX + style.indent;

        if (linePrefix) {
          currentPage.drawText(linePrefix, {
            x,
            y: yPosition,
            size: style.fontSize,
            font: style.prefixFont,
            color: style.color,
          });
        }

        currentPage.drawText(wrappedLines[index], {
          x: x + prefixWidth,
          y: yPosition,
          size: style.fontSize,
          font: style.font,
          color: style.color,
        });

        yPosition -= style.lineHeight;
      }

      yPosition -= style.afterGap;
    }

    // Flush any remaining table
    flushTable();

    drawProfessionalFooter(currentPage, font, pageNumber);

    // --- Insert TOC page after page 1 if needed ---
    if (needsToc && tocWithPages.length > 0) {
      this.drawTocPage(pdfDoc, font, boldFont, tocWithPages, demandId, generatedAt, reportTitle);
      // Move TOC page (last added) to position index 1 (after the first content page)
      const pages = pdfDoc.getPages();
      const tocPageObj = pages[pages.length - 1];
      pdfDoc.removePage(pages.length - 1);
      pdfDoc.insertPage(1, tocPageObj);
    }
  }

  /**
   * Draws a markdown pipe table in "Clean Zebra" style (no heavy borders, alternating row tint).
   * Returns the y position after the table.
   */
  private drawZebraTable(
    page: PDFPage,
    font: PDFFont,
    boldFont: PDFFont,
    rows: string[][],
    yStart: number,
  ): number {
    const layout = this.professionalLayout;
    const totalWidth = layout.pageWidth - layout.marginX * 2;
    const fontSize = 9;
    const rowHeight = 16;
    const cellPadX = 4;
    const cellPadY = 4;

    // Compute column widths (equal distribution)
    const colCount = rows[0]?.length ?? 1;
    const colWidth = totalWidth / colCount;

    let y = yStart;

    rows.forEach((row, rowIndex) => {
      const isHeader = rowIndex === 0;
      const isOdd = rowIndex % 2 === 1;
      const bgColor = isHeader ? layout.tableHeader : isOdd ? layout.zebraOdd : layout.zebraEven;

      // Row background
      page.drawRectangle({
        x: layout.marginX,
        y: y - rowHeight,
        width: totalWidth,
        height: rowHeight,
        color: bgColor,
      });

      row.forEach((cell, colIndex) => {
        const x = layout.marginX + colIndex * colWidth + cellPadX;
        const textColor = isHeader ? layout.tableHeaderText : layout.bodyColor;
        const cellFont = isHeader ? boldFont : font;
        const sanitized = this.stripMarkdownForPdf(cell.trim());
        // Truncate cell text to fit column
        let displayText = sanitized;
        while (
          displayText.length > 1 &&
          cellFont.widthOfTextAtSize(displayText, fontSize) > colWidth - cellPadX * 2
        ) {
          displayText = displayText.slice(0, -1);
        }

        page.drawText(displayText, {
          x,
          y: y - rowHeight + cellPadY,
          size: fontSize,
          font: cellFont,
          color: textColor,
        });
      });

      y -= rowHeight;
    });

    return y - 4; // a small gap after table
  }

  /**
   * Extracts H2 headings from content for TOC generation.
   * Returns array of { title, pageHint } (pageHint is an estimate — exact page requires two-pass render).
   */
  private extractTocEntries(lines: string[]): { title: string; lineIndex: number }[] {
    const entries: { title: string; lineIndex: number }[] = [];
    lines.forEach((line, idx) => {
      if (/^##\s+/.test(line.trim())) {
        entries.push({ title: line.trim().replace(/^##\s+/, ''), lineIndex: idx });
      }
    });
    return entries;
  }

  /**
   * Draws a Table of Contents page (inserted as page 2 after header page).
   */
  private drawTocPage(
    pdfDoc: PDFDocument,
    font: PDFFont,
    boldFont: PDFFont,
    tocEntries: { title: string; pageEstimate: number }[],
    demandId: number,
    generatedAt: Date,
    docTitle: string,
  ): PDFPage {
    const layout = this.professionalLayout;
    const tocPage = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
    drawProfessionalHeader(tocPage, boldFont, font, demandId, generatedAt, docTitle);

    let y = layout.pageHeight - layout.headerHeight - 10;

    tocPage.drawText('SUMARIO', {
      x: layout.marginX,
      y,
      size: 14,
      font: boldFont,
      color: layout.primaryColor,
    });
    y -= 6;
    tocPage.drawLine({
      start: { x: layout.marginX, y },
      end: { x: layout.pageWidth - layout.marginX, y },
      thickness: 0.7,
      color: layout.borderColor,
    });
    y -= 16;

    const dotWidth = layout.pageWidth - layout.marginX * 2;
    for (const entry of tocEntries) {
      const titleText = this.stripMarkdownForPdf(entry.title);
      const pageText = `${entry.pageEstimate}`;
      const titleW = font.widthOfTextAtSize(titleText, 10.5);
      const pageW = font.widthOfTextAtSize(pageText, 10.5);
      const dotsCount = Math.max(
        3,
        Math.floor((dotWidth - titleW - pageW - 8) / font.widthOfTextAtSize('.', 10.5)),
      );
      const dots = '.'.repeat(dotsCount);

      tocPage.drawText(titleText, {
        x: layout.marginX,
        y,
        size: 10.5,
        font,
        color: layout.bodyColor,
      });
      tocPage.drawText(dots, {
        x: layout.marginX + titleW + 4,
        y,
        size: 10.5,
        font,
        color: layout.mutedColor,
      });
      tocPage.drawText(pageText, {
        x: layout.pageWidth - layout.marginX - pageW,
        y,
        size: 10.5,
        font,
        color: layout.accentColor,
      });
      y -= 18;
      if (y < layout.footerHeight + 20) break;
    }

    drawProfessionalFooter(tocPage, font, 2);
    return tocPage;
  }

  private getProfessionalLineStyle(trimmedLine: string, font: PDFFont, boldFont: PDFFont) {
    const layout = this.professionalLayout;

    if (/^#\s+/.test(trimmedLine)) {
      return {
        font: boldFont,
        prefixFont: boldFont,
        fontSize: 20,
        lineHeight: 25,
        beforeGap: 4,
        afterGap: 12,
        indent: 0,
        prefix: '',
        continuationPrefix: '',
        color: layout.primaryColor,
        drawRule: false,
      };
    }

    if (/^##\s+/.test(trimmedLine)) {
      return {
        font: boldFont,
        prefixFont: boldFont,
        fontSize: 13,
        lineHeight: 18,
        beforeGap: layout.sectionGap,
        afterGap: 6,
        indent: 0,
        prefix: '',
        continuationPrefix: '',
        color: layout.accentColor,
        drawRule: true,
      };
    }

    if (/^###\s+/.test(trimmedLine)) {
      return {
        font: boldFont,
        prefixFont: boldFont,
        fontSize: 11.5,
        lineHeight: 16,
        beforeGap: 8,
        afterGap: 3,
        indent: 0,
        prefix: '',
        continuationPrefix: '',
        color: layout.primaryColor,
        drawRule: false,
      };
    }

    if (/^-\s+\[[ xX]\]\s*/.test(trimmedLine)) {
      return {
        font,
        prefixFont: boldFont,
        fontSize: layout.bodyFontSize,
        lineHeight: layout.bodyLineHeight,
        beforeGap: 1,
        afterGap: 2,
        indent: layout.bulletIndent,
        prefix: '[ ] ',
        continuationPrefix: '    ',
        color: layout.bodyColor,
        drawRule: false,
      };
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const numberPrefix = trimmedLine.match(/^(\d+\.\s+)/)?.[1] || '';
      return {
        font,
        prefixFont: boldFont,
        fontSize: layout.bodyFontSize,
        lineHeight: layout.bodyLineHeight,
        beforeGap: 1,
        afterGap: 2,
        indent: layout.bulletIndent,
        prefix: numberPrefix,
        continuationPrefix: ' '.repeat(numberPrefix.length),
        color: layout.bodyColor,
        drawRule: false,
      };
    }

    if (/^-\s+/.test(trimmedLine)) {
      return {
        font,
        prefixFont: boldFont,
        fontSize: layout.bodyFontSize,
        lineHeight: layout.bodyLineHeight,
        beforeGap: 1,
        afterGap: 2,
        indent: layout.bulletIndent,
        prefix: '* ',
        continuationPrefix: '  ',
        color: layout.bodyColor,
        drawRule: false,
      };
    }

    return {
      font,
      prefixFont: boldFont,
      fontSize: layout.bodyFontSize,
      lineHeight: layout.bodyLineHeight,
      beforeGap: 0,
      afterGap: layout.paragraphGap,
      indent: 0,
      prefix: '',
      continuationPrefix: '',
      color: layout.bodyColor,
      drawRule: false,
    };
  }

  private getProfessionalLineText(trimmedLine: string, prefix: string): string {
    let text = trimmedLine
      .replace(/^#{1,6}\s*/, '')
      .replace(/^-\s+\[[ xX]\]\s*/, '')
      .replace(/^-\s+/, '');

    if (prefix && /^\d+\.\s+/.test(text)) {
      text = text.replace(/^\d+\.\s+/, '');
    }

    return this.stripMarkdownForPdf(text);
  }

  private wrapTextByFontMetrics(
    text: string,
    maxWidth: number,
    font: PDFFont,
    fontSize: number,
  ): string[] {
    return wrapTextByFontMetrics(text, maxWidth, font, fontSize);
  }

  private breakLongWord(word: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    return breakLongWord(word, maxWidth, font, fontSize);
  }

  private wrapText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    return wrapText(text, maxWidth, font, fontSize);
  }
}

export const pdfGenerator = new PDFGenerator();
