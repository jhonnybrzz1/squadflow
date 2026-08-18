import type { ValidationIssue } from './improvement-execution';

interface AgentResponseScoringResult {
  scoreDelta: number;
  structuredIssues: ValidationIssue[];
}

export function scoreAgentResponseStructure(response: string): AgentResponseScoringResult {
  const structuredIssues: ValidationIssue[] = [];
  let scoreDelta = 0;

  const addWarning = (
    section: string,
    message: string,
    category: ValidationIssue['category'],
    penalty: number,
  ) => {
    structuredIssues.push({
      section,
      message,
      severity: 'warning',
      category,
    });
    scoreDelta -= penalty;
  };

  const hasAnalysis = response.includes('**Análise:**') || /análise:/i.test(response);
  const hasRecommendation =
    response.includes('**Recomendação:**') || /recomendação:/i.test(response);
  if (!hasAnalysis && !hasRecommendation) {
    addWarning(
      'Formato de resposta',
      'Formato de resposta: considere incluir Análise e/ou Recomendação',
      'structural',
      15,
    );
  }

  const roiPattern = /(\d+[:\s]*\d+|ROI\s*[>~≈]?\s*\d+|retorno.*\d+|~\d+:\d+)/i;
  if (!roiPattern.test(response)) {
    addWarning(
      'ROI',
      'ROI: considere estimar retorno (aceita formatos como 3:1, ~4:1, ROI > 2)',
      'metrics',
      10,
    );
  }

  const effortPattern = /\d+\s*(dia|semana|sprint|iteração|hora|h\b|d\b|sem\b)/i;
  if (!effortPattern.test(response)) {
    addWarning(
      'Esforço',
      'Esforço: considere estimar tempo (aceita dias, semanas, sprints, horas)',
      'actionable',
      10,
    );
  }

  const priorityPattern =
    /(crítico|importante|desejável|alta|média|baixa|p[0-3]|urgente|essencial)/i;
  if (!priorityPattern.test(response)) {
    addWarning(
      'Prioridade',
      'Prioridade: considere indicar (aceita crítico/importante/desejável ou alta/média/baixa)',
      'actionable',
      8,
    );
  }

  const concretePattern =
    /(\d+\s*(linha|arquivo|módulo|serviço|componente|endpoint|função|classe|método)|[a-z_-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb))/i;
  if (!concretePattern.test(response)) {
    addWarning(
      'Dados concretos',
      'Dados concretos: referências a arquivos/linhas/componentes ajudam na clareza',
      'semantic',
      7,
    );
  }

  return { scoreDelta, structuredIssues };
}
