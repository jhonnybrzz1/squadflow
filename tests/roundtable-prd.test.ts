import { describe, expect, it } from 'vitest';
import { buildRoundtablePRDContent } from '../server/services/ai-squad/roundtable-prd';
import { validatePRDDocument } from '../server/utils/validateDocuments';

describe('roundtable PRD rendering', () => {
  it('renders diagnostic consolidation as a business PRD accepted by PDF validation', () => {
    const content = buildRoundtablePRDContent({
      problema:
        'A demanda alega gargalos de performance e bundle size sem apresentar métricas concretas de profiling ou medição de runtime.',
      objetivo:
        'Validar se existem gargalos reais por meio de Lighthouse, bundle analyzer, flame graphs e tempos de resposta de endpoints críticos.',
      escopo:
        '- Análise de Lighthouse para a aplicação frontend.\n- Execução de bundle analyzer.\n- Profiling de runtime para endpoints de documentos e demandas.',
      criterios_de_aceite: [
        'Relatório com Lighthouse maior que 90, bundle menor que 500KB gzipped e geração de PDF abaixo de 150ms.',
        'Proposta priorizada de otimização quando gargalo for confirmado.',
      ],
      riscos: [
        'Falta de acesso a ferramentas de profiling. Mitigação: registrar limitação e usar métricas disponíveis.',
      ],
      dependencias: ['Permissão para executar Lighthouse CI no ambiente de staging.'],
      divergencias: [
        'A demanda alega gargalos, mas os logs mostram respostas rápidas nos endpoints observados.',
      ],
      consolidacao:
        'A mesa redonda recomenda diagnóstico técnico completo antes de qualquer alteração de código.',
    });

    const validation = validatePRDDocument(content);

    // Current format uses structured contract sections
    expect(content).toContain('## Objetivo');
    expect(content).toContain('## Escopo');
    expect(content).toContain('## Criterios de Aceite');
    expect(content).toContain('## Sintese');
    // Objective text is rendered
    expect(content).toContain('Validar se existem gargalos reais');
    // Consolidation text is rendered
    expect(content).toContain('diagnóstico técnico completo');
    expect(validation.errors).toEqual([]);
    expect(validation.isValid).toBe(true);
  });

  it('renders implementation consolidation without adding diagnostic-only assumptions', () => {
    const content = buildRoundtablePRDContent({
      problema:
        'Três gargalos foram medidos: bundle JS de 2.064 kB, payload de demandas de 450 kB e latência de 1.800ms no GitHub.',
      objetivo:
        'Reduzir bundle size, payload da API de demandas e latência da integração GitHub mantendo navegação estável.',
      escopo:
        '- Frontend com code-splitting.\n- Backend sem chatMessages inline em /api/demands.\n- Cache para chamadas da API do GitHub.',
      criterios_de_aceite: [
        'LCP menor que 2.5s em rede 3G simulada.',
        'Payload de /api/demands menor que 100 kB bruto.',
        'Fallback visual aparece quando /api/github/repos falha.',
      ],
      riscos: ['Remover chatMessages inline pode afetar funcionalidades dependentes desse dado.'],
      dependencias: ['Stack atual sem novas bibliotecas.'],
      divergencias: [],
      consolidacao:
        'A mesa redonda priorizou payload de /api/demands, cache GitHub e bundle splitting.',
    });

    const validation = validatePRDDocument(content);

    expect(content).toContain('Payload de /api/demands menor que 100 kB bruto.');
    expect(content).not.toContain('antes de existir diagnóstico');
    expect(validation.errors).toEqual([]);
    expect(validation.isValid).toBe(true);
  });

  it('renders mandatory type requirements section when provided', () => {
    const content = buildRoundtablePRDContent(
      {
        problema: 'A demanda descreve uma vulnerabilidade de seguranca sem modelagem de ameacas.',
        objetivo: 'Documentar a funcionalidade com threat model e mitigacoes.',
        escopo: '- Threat model do fluxo afetado.\n- Mitigacoes mapeadas.',
        criterios_de_aceite: ['Threat model revisado pelo time de seguranca.'],
        riscos: ['Modelagem incompleta pode deixar vetores de ataque nao cobertos.'],
        dependencias: ['Acesso ao diagrama de arquitetura atual.'],
        divergencias: [],
        consolidacao: 'A mesa redonda recomenda threat model completo antes da implementacao.',
      },
      {
        demandTitle: 'Modelar ameacas do checkout',
        demandType: 'security',
        typeRequirements: ['Threat Model', 'Root Cause Analysis'],
      },
    );

    expect(content).toContain('## Secoes Obrigatorias');
    expect(content).toContain('Threat Model');
    expect(content).toContain('Root Cause Analysis');
    expect(content).not.toMatch(/## Secoes Obrigatorias[\s\S]*## Secoes Obrigatorias/);
  });

  it('renders smart contract demand summary and synchronous refinement option', () => {
    const content = buildRoundtablePRDContent(
      {
        problema:
          'A demanda chegou como melhoria, mas descreve queda de conversao sem baseline suficiente.',
        objetivo:
          'Transformar a discussao em contrato de demanda com tipo, lacunas e proximo refinamento claro.',
        escopo:
          '- Classificar a demanda.\n- Registrar campos contratuais disponiveis.\n- Decidir se precisa refinamento sincrono.',
        criterios_de_aceite: [
          'PRD mostra tipo definido, resumo, campos do contrato e opcao de refinamento sincrono.',
        ],
        riscos: ['Executar como melhoria sem baseline pode gerar solucao errada.'],
        dependencias: ['Campos do contrato inteligente preenchidos no formulario.'],
        divergencias: ['PM sugeriu discovery antes de implementacao.'],
        consolidacao:
          'A mesa redonda recomenda tratar a demanda como contrato inteligente antes da execucao.',
      },
      {
        demandTitle: 'Validar queda de conversao',
        demandType: 'melhoria',
        refinementType: 'business',
        demandDescription: `Validar queda de conversao no onboarding.

---
**Contrato Inteligente de Início**
Tipo avaliado: MELHORIA
Status: Precisa dados
Score de prontidão: 50%
Próximo passo: Pode enviar para refinamento. Lacunas registradas: Informe baseline atual, métrica alvo, restrições e compatibilidade antes de tratar como melhoria pronta.
Sugestão de tipo: DISCOVERY (75%)
Sugestão aceita: Não

Campos do contrato:
- Baseline atual: Nao informado
- Métrica alvo: Aumentar ativacao de 42% para 55%
- Restrições: Nao alterar fluxo de pagamento
- Compatibilidade: Nao quebrar onboarding atual`,
      },
    );

    const validation = validatePRDDocument(content);

    // Current format: structured contract table + sections
    expect(content).toContain('# Demanda - Validar queda de conversao');
    expect(content).toContain('## Contrato');
    expect(content).toContain('| Tipo | MELHORIA |');
    expect(content).toContain('| Refinamento | Negocio |');
    expect(content).toContain('## Objetivo');
    expect(content).toContain('Transformar a discussao em contrato de demanda');
    expect(content).toContain('## Divergencias');
    expect(content).toContain('PM sugeriu discovery antes de implementacao.');
    expect(content).toContain('## Sintese');
    expect(content).toContain('contrato inteligente antes da execucao');
    expect(validation.errors).toEqual([]);
    expect(validation.isValid).toBe(true);
  });
});
