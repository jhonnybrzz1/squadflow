import { logger } from '../utils/logger';
import { z } from 'zod';
import type { AgentInsight } from './context-builder';
import { openAIService } from './openai-ai';

const StructuredSummaryPayloadSchema = z.object({
  decisions: z.array(z.string()).max(5),
  requirements: z.array(z.string()).max(8),
  risks: z
    .array(
      z.object({
        risk: z.string(),
        mitigation: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
      }),
    )
    .max(5),
  estimates: z.object({
    effort: z.string(),
    roi: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  openQuestions: z.array(z.string()).max(5),
  technicalConsiderations: z.array(z.string()).max(5),
  uxConsiderations: z.array(z.string()).max(5),
  dataConsiderations: z.array(z.string()).max(5),
});

/**
 * Structured summary of agent insights
 * Replaces full conversation history with compact, actionable information
 */
export interface StructuredSummary {
  decisions: string[]; // Key decisions made
  requirements: string[]; // Requirements identified
  risks: RiskItem[]; // Risks and mitigations
  estimates: EstimateItem; // Effort and ROI estimates
  openQuestions: string[]; // Questions that need answers
  technicalConsiderations: string[]; // Technical points to consider
  uxConsiderations: string[]; // UX/design points
  dataConsiderations: string[]; // Data/integration points
  metadata: {
    agentsContributed: string[];
    totalInsights: number;
    compressionRatio: number; // Original tokens / summary tokens
    originalTokens: number;
    compressedTokens: number;
    timestamp: string;
  };
}

interface RiskItem {
  risk: string;
  mitigation: string;
  priority: 'high' | 'medium' | 'low';
}

interface EstimateItem {
  effort: string;
  roi: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Summary Builder - Creates structured summaries from agent insights
 * Compresses conversation history into actionable information
 */
export class SummaryBuilder {
  private readonly maxSummaryTokens = 500;

  /**
   * Builds a structured summary from agent insights
   * @param insights - Array of agent insights to summarize
   * @param useAI - Whether to use AI for summarization (default: false for speed)
   * @returns Structured summary
   */
  async buildStructuredSummary(
    insights: AgentInsight[],
    useAI: boolean = false,
  ): Promise<StructuredSummary> {
    if (insights.length === 0) {
      return this.createEmptySummary();
    }

    // Calculate original token count
    const originalTokens = insights.reduce(
      (sum, insight) => sum + this.estimateTokens(insight.insight),
      0,
    );

    // Use rule-based extraction for speed, AI for complex cases
    const summary = useAI ? await this.aiBasedSummary(insights) : this.ruleBasedSummary(insights);

    // Calculate compression ratio
    const summaryTokens = this.estimateTokens(JSON.stringify(summary));
    summary.metadata.compressionRatio = originalTokens / summaryTokens;

    logger.info(
      `Summary created: ${originalTokens} tokens → ${summaryTokens} tokens (${summary.metadata.compressionRatio.toFixed(1)}x compression)`,
    );

    return summary;
  }

  /**
   * Rule-based summary extraction (fast, no AI calls)
   */
  private ruleBasedSummary(insights: AgentInsight[]): StructuredSummary {
    // Calculate original token count
    const originalTokens = insights.reduce(
      (sum, insight) => sum + this.estimateTokens(insight.insight),
      0,
    );

    const summary: StructuredSummary = {
      decisions: [],
      requirements: [],
      risks: [],
      estimates: {
        effort: 'não estimado',
        roi: 'não calculado',
        confidence: 'medium',
      },
      openQuestions: [],
      technicalConsiderations: [],
      uxConsiderations: [],
      dataConsiderations: [],
      metadata: {
        agentsContributed: insights.map((i) => i.agentName),
        totalInsights: insights.length,
        compressionRatio: 1,
        originalTokens: originalTokens,
        compressedTokens: 0, // Will be calculated after summary is built
        timestamp: new Date().toISOString(),
      },
    };

    for (const insight of insights) {
      const text = insight.insight;
      const agent = insight.agentName;

      // Extract decisions
      const decisionMatches = text.match(/\*\*Decisão:\*\*\s*[^\n]+/gi);
      if (decisionMatches) {
        decisionMatches.forEach((match: string) => {
          const decision = match.replace(/\*\*Decisão:\*\*\s*/i, '').trim();
          if (decision && !summary.decisions.includes(decision)) {
            summary.decisions.push(decision);
          }
        });
      }

      // Extract requirements
      const reqMatches = text.match(/\*\*Requisito:\*\*\s*[^\n]+/gi);
      if (reqMatches) {
        reqMatches.forEach((match: string) => {
          const req = match.replace(/\*\*Requisito:\*\*\s*/i, '').trim();
          if (req && !summary.requirements.includes(req)) {
            summary.requirements.push(req);
          }
        });
      }

      // Extract risks
      const riskMatches = text.match(/\*\*Risco:\*\*\s*[^\n]+/gi);
      if (riskMatches) {
        riskMatches.forEach((match: string) => {
          const risk = match.replace(/\*\*Risco:\*\*\s*/i, '').trim();
          const mitigationMatch = text.match(/\*\*Mitigação:\*\*\s*([^\n]+)/i);
          const mitigation = mitigationMatch ? mitigationMatch[1].trim() : 'não especificada';

          summary.risks.push({
            risk,
            mitigation,
            priority: this.inferRiskPriority(risk),
          });
        });
      }

      // Extract effort estimates
      const effortMatch = text.match(/\*\*Esforço:\*\*\s*([^\n]+)/i);
      if (effortMatch) {
        summary.estimates.effort = effortMatch[1].trim();
      }

      // Extract ROI
      const roiMatch = text.match(/\*\*ROI:\*\*\s*([^\n]+)/i);
      if (roiMatch) {
        summary.estimates.roi = roiMatch[1].trim();
      }

      // Extract open questions
      const questionMatches = text.match(/\?[^\n]+/g);
      if (questionMatches) {
        questionMatches.forEach((q: string) => {
          const question = q.trim();
          if (question.length > 10 && !summary.openQuestions.includes(question)) {
            summary.openQuestions.push(question);
          }
        });
      }

      // Categorize by agent type
      if (agent === 'tech_lead') {
        const techPoints = this.extractKeyPoints(text, [
          'arquitetura',
          'técnico',
          'implementação',
          'código',
        ]);
        summary.technicalConsiderations.push(...techPoints);
      } else if (agent === 'ux') {
        const uxPoints = this.extractKeyPoints(text, [
          'usuário',
          'interface',
          'experiência',
          'fluxo',
        ]);
        summary.uxConsiderations.push(...uxPoints);
      } else if (agent === 'analista_de_dados') {
        const dataPoints = this.extractKeyPoints(text, ['dados', 'integração', 'api', 'banco']);
        summary.dataConsiderations.push(...dataPoints);
      }
    }

    // Limit array sizes to prevent bloat
    summary.decisions = summary.decisions.slice(0, 5);
    summary.requirements = summary.requirements.slice(0, 8);
    summary.risks = summary.risks.slice(0, 5);
    summary.openQuestions = summary.openQuestions.slice(0, 5);
    summary.technicalConsiderations = summary.technicalConsiderations.slice(0, 5);
    summary.uxConsiderations = summary.uxConsiderations.slice(0, 5);
    summary.dataConsiderations = summary.dataConsiderations.slice(0, 5);

    // Calculate compressed tokens
    const compressedTokens = this.estimateTokens(JSON.stringify(summary));
    summary.metadata.compressedTokens = compressedTokens;
    summary.metadata.compressionRatio = summary.metadata.originalTokens / compressedTokens;

    return summary;
  }

  /**
   * AI-based summary for complex cases
   */
  private async aiBasedSummary(insights: AgentInsight[]): Promise<StructuredSummary> {
    const conversationText = insights.map((i) => `[${i.agentName}]: ${i.insight}`).join('\n\n');

    const systemPrompt = `Você é um especialista em extrair informações estruturadas de conversas técnicas.

Analise a conversa abaixo e extraia:
1. Decisões chave tomadas
2. Requisitos identificados
3. Riscos e mitigações
4. Estimativas de esforço e ROI
5. Perguntas em aberto
6. Considerações técnicas, UX e dados

Responda APENAS com JSON válido no formato:
{
  "decisions": ["decisão 1", "decisão 2"],
  "requirements": ["req 1", "req 2"],
  "risks": [{"risk": "risco", "mitigation": "mitigação", "priority": "high|medium|low"}],
  "estimates": {"effort": "X dias", "roi": "Y:1", "confidence": "high|medium|low"},
  "openQuestions": ["pergunta 1"],
  "technicalConsiderations": ["ponto técnico 1"],
  "uxConsiderations": ["ponto ux 1"],
  "dataConsiderations": ["ponto dados 1"]
}

Seja conciso. Máximo 5 itens por array.`;

    const userPrompt = `Extraia informações estruturadas desta conversa:\n\n${conversationText}`;

    try {
      const response = await openAIService.generateChatCompletion(systemPrompt, userPrompt, {
        temperature: 0.3,
        maxTokens: 800,
        model: process.env.CONTEXT_SUMMARIZATION_MODEL || 'deepseek/deepseek-v4-flash',
        taskType: 'classification',
        operation: 'summary_extraction',
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid JSON response');
      }

      const parsed = StructuredSummaryPayloadSchema.parse(JSON.parse(jsonMatch[0]));
      const inputHadDecisions = insights.some((insight) =>
        /\*\*\s*Decis[aã]o\b/i.test(insight.insight),
      );
      if (inputHadDecisions && parsed.decisions.length === 0) {
        throw new Error('AI summary dropped decisions present in the source insights');
      }

      // Calculate tokens for compression tracking
      const originalTokens = insights.reduce(
        (sum, insight) => sum + this.estimateTokens(insight.insight),
        0,
      );
      const compressedTokens = this.estimateTokens(JSON.stringify(parsed));

      return {
        ...parsed,
        metadata: {
          agentsContributed: insights.map((i) => i.agentName),
          totalInsights: insights.length,
          compressionRatio: originalTokens / compressedTokens,
          originalTokens,
          compressedTokens,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error('AI summary failed, falling back to rule-based:', error);
      return this.ruleBasedSummary(insights);
    }
  }

  /**
   * Extracts key points containing specific keywords
   */
  private extractKeyPoints(text: string, keywords: string[]): string[] {
    const points: string[] = [];
    const sentences = text.split(/[.!?]\s+/);

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      if (keywords.some((keyword) => lowerSentence.includes(keyword))) {
        const cleaned = sentence.trim();
        if (cleaned.length > 20 && cleaned.length < 200) {
          points.push(cleaned);
        }
      }
    }

    return points.slice(0, 3); // Max 3 points per category
  }

  /**
   * Infers risk priority from risk description
   */
  private inferRiskPriority(risk: string): 'high' | 'medium' | 'low' {
    const lowerRisk = risk.toLowerCase();

    if (
      lowerRisk.includes('crítico') ||
      lowerRisk.includes('bloqueador') ||
      lowerRisk.includes('segurança') ||
      lowerRisk.includes('perda de dados')
    ) {
      return 'high';
    }

    if (
      lowerRisk.includes('importante') ||
      lowerRisk.includes('performance') ||
      lowerRisk.includes('complexidade')
    ) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Formats summary as markdown for display
   */
  formatAsMarkdown(summary: StructuredSummary): string {
    let md = '## Resumo Estruturado\n\n';

    if (summary.decisions.length > 0) {
      md += '### Decisões\n';
      summary.decisions.forEach((d) => (md += `- ${d}\n`));
      md += '\n';
    }

    if (summary.requirements.length > 0) {
      md += '### Requisitos\n';
      summary.requirements.forEach((r) => (md += `- ${r}\n`));
      md += '\n';
    }

    if (summary.risks.length > 0) {
      md += '### Riscos\n';
      summary.risks.forEach((r) => {
        const emoji = r.priority === 'high' ? '🔴' : r.priority === 'medium' ? '🟡' : '🟢';
        md += `- ${emoji} **${r.risk}**: ${r.mitigation}\n`;
      });
      md += '\n';
    }

    if (summary.estimates.effort !== 'não estimado') {
      md += '### Estimativas\n';
      md += `- **Esforço**: ${summary.estimates.effort}\n`;
      md += `- **ROI**: ${summary.estimates.roi}\n`;
      md += `- **Confiança**: ${summary.estimates.confidence}\n\n`;
    }

    if (summary.technicalConsiderations.length > 0) {
      md += '### Considerações Técnicas\n';
      summary.technicalConsiderations.forEach((c) => (md += `- ${c}\n`));
      md += '\n';
    }

    if (summary.uxConsiderations.length > 0) {
      md += '### Considerações de UX\n';
      summary.uxConsiderations.forEach((c) => (md += `- ${c}\n`));
      md += '\n';
    }

    if (summary.dataConsiderations.length > 0) {
      md += '### Considerações de Dados\n';
      summary.dataConsiderations.forEach((c) => (md += `- ${c}\n`));
      md += '\n';
    }

    if (summary.openQuestions.length > 0) {
      md += '### Perguntas em Aberto\n';
      summary.openQuestions.forEach((q) => (md += `- ${q}\n`));
      md += '\n';
    }

    md += `\n*Resumo gerado de ${summary.metadata.totalInsights} insights (compressão ${summary.metadata.compressionRatio.toFixed(1)}x)*`;

    return md;
  }

  /**
   * Formats summary as compact text for context
   */
  formatAsCompactText(summary: StructuredSummary): string {
    let text = '';

    if (summary.decisions.length > 0) {
      text += `Decisões: ${summary.decisions.join('; ')}\n`;
    }

    if (summary.requirements.length > 0) {
      text += `Requisitos: ${summary.requirements.join('; ')}\n`;
    }

    if (summary.risks.length > 0) {
      text += `Riscos: ${summary.risks.map((r) => `${r.risk} (${r.mitigation})`).join('; ')}\n`;
    }

    if (summary.estimates.effort !== 'não estimado') {
      text += `Esforço: ${summary.estimates.effort}, ROI: ${summary.estimates.roi}\n`;
    }

    if (summary.technicalConsiderations.length > 0) {
      text += `Técnico: ${summary.technicalConsiderations.join('; ')}\n`;
    }
    if (summary.uxConsiderations.length > 0) {
      text += `UX: ${summary.uxConsiderations.join('; ')}\n`;
    }
    if (summary.dataConsiderations.length > 0) {
      text += `Dados: ${summary.dataConsiderations.join('; ')}\n`;
    }
    if (summary.openQuestions.length > 0) {
      text += `Perguntas em aberto: ${summary.openQuestions.join('; ')}\n`;
    }

    return text.trim();
  }

  /**
   * Creates an empty summary
   */
  private createEmptySummary(): StructuredSummary {
    return {
      decisions: [],
      requirements: [],
      risks: [],
      estimates: {
        effort: 'não estimado',
        roi: 'não calculado',
        confidence: 'medium',
      },
      openQuestions: [],
      technicalConsiderations: [],
      uxConsiderations: [],
      dataConsiderations: [],
      metadata: {
        agentsContributed: [],
        totalInsights: 0,
        compressionRatio: 1,
        originalTokens: 0,
        compressedTokens: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Estimates tokens in text
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Merges multiple summaries into one
   */
  mergeSummaries(summaries: StructuredSummary[]): StructuredSummary {
    if (summaries.length === 0) {
      return this.createEmptySummary();
    }

    if (summaries.length === 1) {
      return summaries[0];
    }

    const merged: StructuredSummary = {
      decisions: [],
      requirements: [],
      risks: [],
      estimates: summaries[summaries.length - 1].estimates, // Use latest estimates
      openQuestions: [],
      technicalConsiderations: [],
      uxConsiderations: [],
      dataConsiderations: [],
      metadata: {
        agentsContributed: [],
        totalInsights: 0,
        compressionRatio: 1,
        originalTokens: 0,
        compressedTokens: 0,
        timestamp: new Date().toISOString(),
      },
    };

    // Merge all arrays, removing duplicates
    for (const summary of summaries) {
      merged.decisions.push(...summary.decisions);
      merged.requirements.push(...summary.requirements);
      merged.risks.push(...summary.risks);
      merged.openQuestions.push(...summary.openQuestions);
      merged.technicalConsiderations.push(...summary.technicalConsiderations);
      merged.uxConsiderations.push(...summary.uxConsiderations);
      merged.dataConsiderations.push(...summary.dataConsiderations);
      merged.metadata.agentsContributed.push(...summary.metadata.agentsContributed);
      merged.metadata.totalInsights += summary.metadata.totalInsights;
    }

    // Remove duplicates and limit sizes
    merged.decisions = [...new Set(merged.decisions)].slice(0, 8);
    merged.requirements = [...new Set(merged.requirements)].slice(0, 10);
    merged.risks = this.deduplicateRisks(merged.risks).slice(0, 8);
    merged.openQuestions = [...new Set(merged.openQuestions)].slice(0, 8);
    merged.technicalConsiderations = [...new Set(merged.technicalConsiderations)].slice(0, 8);
    merged.uxConsiderations = [...new Set(merged.uxConsiderations)].slice(0, 8);
    merged.dataConsiderations = [...new Set(merged.dataConsiderations)].slice(0, 8);
    merged.metadata.agentsContributed = [...new Set(merged.metadata.agentsContributed)];

    return merged;
  }

  /**
   * Removes duplicate risks
   */
  private deduplicateRisks(risks: RiskItem[]): RiskItem[] {
    const seen = new Set<string>();
    const unique: RiskItem[] = [];

    for (const risk of risks) {
      const key = risk.risk.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(risk);
      }
    }

    return unique;
  }
}

export const summaryBuilder = new SummaryBuilder();
