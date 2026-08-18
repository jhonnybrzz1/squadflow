import { describe, expect, it } from 'vitest';
import { evaluateDemandStartContract } from '../shared/demand-start-contract';

describe('Demand start contract readiness', () => {
  it('marks an improvement ready when baseline, target, constraints, and compatibility are filled', () => {
    const result = evaluateDemandStartContract({
      type: 'melhoria',
      title: 'Melhorar início de demandas',
      description: 'Melhorar o formulário para reduzir retrabalho antes do PRD.',
      fields: {
        improvement_baseline: 'Demandas entram sem baseline e voltam para correção.',
        improvement_target_metric: 'Reduzir retrabalho em 30%.',
        improvement_constraints: 'Não redesenhar todo o fluxo.',
        improvement_compatibility: 'Manter criação atual de demandas e arquivos.',
      },
    });

    expect(result.canSubmit).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.status).toBe('ready_for_development');
    expect(result.score).toBe(100);
  });

  it('does not block an improvement when baseline is absent', () => {
    const result = evaluateDemandStartContract({
      type: 'melhoria',
      title: 'Reduzir retrabalho',
      description: 'Melhorar o fluxo sem inventar uma medição atual.',
      fields: {
        improvement_target_metric: 'Definir após coletar baseline',
        improvement_constraints: 'Manter compatibilidade.',
        improvement_compatibility: 'Não alterar o contrato público.',
      },
    });

    expect(result.isComplete).toBe(true);
    expect(result.missingFields.map((field) => field.id)).not.toContain('improvement_baseline');
  });

  it('keeps a bug submittable but flags missing reproduction details', () => {
    const result = evaluateDemandStartContract({
      type: 'bug',
      title: 'Erro ao salvar demanda',
      description: 'A tela mostra erro 500 ao salvar.',
      fields: {
        bug_expected_actual: 'Esperado salvar, ocorrido erro 500.',
        bug_environment: 'Chrome local.',
      },
    });

    expect(result.canSubmit).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.status).toBe('needs_reproduction');
    expect(result.missingFields.map((field) => field.id)).toContain('bug_reproduction_steps');
  });

  it('suggests bug fix when the selected type is feature but description has strong bug signals', () => {
    const result = evaluateDemandStartContract({
      type: 'nova_funcionalidade',
      title: 'Corrigir erro de login',
      description: 'Bug com erro 500 e exception quando o usuário tenta entrar.',
      fields: {},
    });

    expect(result.suggestedType?.type).toBe('bug');
  });

  it('keeps exploratory analysis submittable but flags missing baseline', () => {
    const result = evaluateDemandStartContract({
      type: 'analise_exploratoria',
      title: 'Analisar queda de conversão',
      description: 'Análise dos dados de conversão por período.',
      fields: {
        analysis_data_source: 'Google Analytics / Mixpanel',
        analysis_question: 'Onde a conversão caiu?',
        analysis_period: 'Últimos 30 dias.',
        analysis_expected_decision: 'Priorizar melhoria no passo com maior perda.',
      },
    });

    expect(result.canSubmit).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.status).toBe('needs_data_baseline');
    expect(result.missingFields.map((field) => field.id)).toContain('analysis_baseline');
  });

  it('keeps discovery submittable but flags missing evidence and validation criteria', () => {
    const result = evaluateDemandStartContract({
      type: 'discovery',
      title: 'Pesquisar novo fluxo de checkout',
      description: 'Validar hipótese de que o checkout atual é confuso.',
      fields: {
        discovery_hypothesis: 'Usuários abandonam porque há muitos campos.',
        discovery_questions: 'Quais campos são mais problemáticos?',
        discovery_method: 'Teste de usabilidade com 5 usuários.',
      },
    });

    expect(result.canSubmit).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.status).toBe('needs_hypothesis_validation');
    const missingIds = result.missingFields.map((f) => f.id);
    expect(missingIds).toContain('discovery_observed_evidence');
    expect(missingIds).toContain('discovery_user_count');
    expect(missingIds).toContain('discovery_validation_criteria');
  });

  it('correctly suggests types with refined signals and avoids generic terms like insights', () => {
    const discoveryResult = evaluateDemandStartContract({
      type: 'nova_funcionalidade',
      title: 'Pesquisa de campo',
      description: 'Vamos fazer uma entrevista e validar hipótese sobre o problema.',
      fields: {},
    });
    expect(discoveryResult.suggestedType?.type).toBe('discovery');

    const analysisResult = evaluateDemandStartContract({
      type: 'nova_funcionalidade',
      title: 'Relatório de dados',
      description: 'Analisar correlação e tendência de uso no dataset.',
      fields: {},
    });
    expect(analysisResult.suggestedType?.type).toBe('analise_exploratoria');
  });
});
