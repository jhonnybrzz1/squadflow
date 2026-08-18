import { describe, expect, it } from 'vitest';
import type { Demand } from '../shared/schema';
import { improvementExecutionService } from '../server/services/improvement-execution';
import { canonicalAgentKey, canonicalizeAgentConfigMap } from '../server/services/agent-identity';

const demand: Demand = {
  id: 1,
  title: 'Melhorar plano gerado',
  description: 'Quero reduzir retrabalho no plano de melhoria.',
  type: 'melhoria',
  priority: 'media',
  refinementType: 'business',
  domain: 'padrao',
  status: 'processing',
  progress: 0,
  chatMessages: [],
  prdUrl: null,
  tasksUrl: null,
  classification: null,
  orchestration: null,
  currentAgent: null,
  errorMessage: null,
  validationNotes: null,
  typeAdherence: null,
  completedAt: null,
  requiresApproval: false,
  requiresHumanReview: false,
  documentState: 'DRAFT',
  reviewSnapshotId: null,
  approvedSnapshotId: null,
  approvedSnapshotHash: null,
  finalSnapshotId: null,
  finalizedFromHash: null,
  approvalSessionId: null,
  revisionNumber: 0,
  reviewRequestedAt: null,
  approvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// PRD completo que deve passar em todos os critérios do novo contrato
const FULL_VALID_PRD = `
## 3. Problema e Oportunidade
### 3.1 Contexto do Problema
Contexto aqui.
### 3.2 Impacto Atual
Impacto aqui.
### 3.3 Oportunidade
Oportunidade aqui.
## 4. Objetivo e Benefícios
### 4.1 Objetivo Principal
Objetivo aqui.
### 4.2 Benefícios Esperados
Benefícios aqui.
## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1
### 5.2 Fazer Depois
- Item futuro
### 5.3 Não Fazer
- Item fora de escopo
## 6. Experiência Esperada
### 6.1 Jornada do Usuário
Jornada do usuario descrita aqui.
### 6.2 Critérios de Sucesso do Usuário
- O usuário consegue X sem Y.
## 7. Regras de Negócio e Premissas
### 7.1 Regras de Negócio
- Se X então Y.
### 7.2 Premissas
- Assumimos que Z.
## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Retrabalho | 40% | 20% | Contagem manual |
## 9. Prioridade e Justificativa
- Prioridade: Alta
## 10. Riscos e Mitigações
| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Risco X | Média | Alto | Mitigar assim |
## 11. Critérios de Aceite
- [ ] Critério verificável 1
- [ ] Critério verificável 2
## 12. Plano de Execução
1. Passo 1 — Semana 1
2. Passo 2 — Semana 1
## 13. Casos de Borda
- Caso de borda 1: comportamento esperado.
`;

describe('ImprovementExecutionService', () => {
  it('renders a domain prompt without fallback for supported domains', () => {
    const result = improvementExecutionService.resolveDomainPrompt('padrao', demand, 'qa');

    expect(result.fallbackUsed).toBe(false);
    expect(result.prompt).toContain('padrao');
    expect(result.prompt).toContain('qa');
    expect(result.prompt).toContain('melhoria');
  });

  it('selects only the fixed improvement template agents', () => {
    const result = improvementExecutionService.getImprovementAgentConfigs(
      {
        product_owner: { system_prompt: 'base', description: 'Refina' },
        scrum_master: { system_prompt: 'base', description: 'Scrum' },
        qa: { system_prompt: 'base', description: 'QA' },
        ux: { system_prompt: 'base', description: 'UX' },
        analista_de_dados: { system_prompt: 'base', description: 'Dados' },
        tech_lead: { system_prompt: 'base', description: 'Tech' },
        product_manager: { system_prompt: 'base', description: 'PM' },
      },
      demand,
    );

    expect(Object.keys(result.configs)).toEqual([
      'product_owner',
      'scrum_master',
      'qa',
      'ux',
      'analista_de_dados',
      'tech_lead',
    ]);
  });

  it('canonicalizes agent display names used by YAML files', () => {
    expect(canonicalAgentKey('Scrum Master Agent')).toBe('scrum_master');
    expect(canonicalAgentKey('UX Designer Agent')).toBe('ux');
    expect(canonicalAgentKey('Analista de Dados Agent')).toBe('analista_de_dados');
    expect(canonicalAgentKey('Tech Lead Agent')).toBe('tech_lead');
    expect(canonicalAgentKey('Product Owner Agent')).toBe('product_owner');
    expect(canonicalAgentKey('Product Manager Agent')).toBe('product_manager');
  });

  it('selects the real squad when configs use YAML display names', () => {
    const configs = canonicalizeAgentConfigMap({
      'Product Owner Agent': { system_prompt: 'base', description: 'Refina' },
      'Scrum Master Agent': { system_prompt: 'base', description: 'Scrum' },
      'QA Agent': { system_prompt: 'base', description: 'QA' },
      'UX Designer Agent': { system_prompt: 'base', description: 'UX' },
      'Analista de Dados Agent': { system_prompt: 'base', description: 'Dados' },
      'Tech Lead Agent': { system_prompt: 'base', description: 'Tech' },
      'Product Manager Agent': { system_prompt: 'base', description: 'PM' },
    });

    const result = improvementExecutionService.getImprovementAgentConfigs(configs, demand);

    expect(Object.keys(result.configs)).toEqual([
      'product_owner',
      'scrum_master',
      'qa',
      'ux',
      'analista_de_dados',
      'tech_lead',
    ]);
  });

  // ===== validateImprovementPlan — tiered validation system =====

  describe('Level 3 (Completo) validation', () => {
    it('passes when PRD contains all required sections with complete metrics table', () => {
      const result = improvementExecutionService.validateImprovementPlan(FULL_VALID_PRD, {
        level: 3,
      });

      expect(result.qualityPassed).toBe(true);
      expect(result.level).toBe(3);
      expect(result.qualityScore).toBeGreaterThanOrEqual(80);
      expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    });

    it('fails (hard block) when §5.1 Fazer Agora is missing', () => {
      const content = FULL_VALID_PRD.replace('### 5.1 Fazer Agora\n- Item 1\n', '');
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 3 });

      expect(result.qualityPassed).toBe(false);
      expect(result.hardBlockReason).toContain('Fazer Agora');
      expect(result.issues.some((i) => i.severity === 'error' && i.section.includes('5.1'))).toBe(
        true,
      );
    });

    it('fails (hard block) when §4 Objetivo is missing', () => {
      const content = FULL_VALID_PRD.replace('## 4. Objetivo e Benefícios', '')
        .replace('### 4.1 Objetivo Principal', '')
        .replace('Objetivo aqui.', '')
        .replace('### 4.2 Benefícios Esperados', '')
        .replace('Benefícios aqui.', '');
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 3 });

      expect(result.qualityPassed).toBe(false);
      expect(
        result.issues.some((i) => i.severity === 'error' && i.section.includes('Objetivo')),
      ).toBe(true);
    });

    it('fails when §12 Plano de Execução is missing at Level 3', () => {
      const content = FULL_VALID_PRD.replace(
        '## 12. Plano de Execução\n1. Passo 1 — Semana 1\n2. Passo 2 — Semana 1\n',
        '',
      );
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 3 });

      expect(result.qualityPassed).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error' && i.section.includes('12'))).toBe(
        true,
      );
    });

    it('fails when complete metrics table is missing at Level 3', () => {
      const content = FULL_VALID_PRD.replace(
        '| Métrica | Baseline Atual | Meta | Como Medir |\n|---------|----------------|------|------------|\n| Retrabalho | 40% | 20% | Contagem manual |',
        '## 8. Métricas de Sucesso\n- Reduzir retrabalho',
      );
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 3 });

      expect(result.qualityPassed).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error' && i.category === 'metrics')).toBe(
        true,
      );
    });
  });

  describe('Level 2 (Funcional) validation', () => {
    it('passes with simpler requirements than Level 3', () => {
      // Level 2 doesn't require complete metrics table, just baseline OR meta
      const simpleContent = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1

## 8. Métricas de Sucesso
Meta: 20% redução

## 10. Riscos e Mitigações
| Risco | Mitigação |
|-------|-----------|
| Risco X | Mitigar assim |

## 11. Critérios de Aceite
- [ ] Critério 1
      `;
      const result = improvementExecutionService.validateImprovementPlan(simpleContent, {
        level: 2,
      });

      expect(result.qualityPassed).toBe(true);
      expect(result.level).toBe(2);
    });

    it('fails when Risks and Mitigations are missing at Level 2', () => {
      const content = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1

## 8. Métricas de Sucesso
Meta: 20%

## 11. Critérios de Aceite
- [ ] Critério 1
      `;
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 2 });

      expect(result.qualityPassed).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error' && i.section.includes('Risco'))).toBe(
        true,
      );
    });
  });

  describe('Level 1 (Rápido) validation', () => {
    it('passes with minimal content: Objetivo + Fazer Agora + 1 criterion', () => {
      const minimalContent = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1

- [ ] Critério verificável
      `;
      const result = improvementExecutionService.validateImprovementPlan(minimalContent, {
        level: 1,
      });

      expect(result.qualityPassed).toBe(true);
      expect(result.level).toBe(1);
    });

    it('fails when acceptance criteria are missing at Level 1', () => {
      const content = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1
      `;
      const result = improvementExecutionService.validateImprovementPlan(content, { level: 1 });

      expect(result.qualityPassed).toBe(false);
      expect(
        result.issues.some((i) => i.severity === 'error' && i.section.includes('Critério')),
      ).toBe(true);
    });

    it('warns about missing optional sections without blocking', () => {
      const minimalContent = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item 1

- [ ] Critério verificável
      `;
      const result = improvementExecutionService.validateImprovementPlan(minimalContent, {
        level: 1,
      });

      expect(result.qualityPassed).toBe(true);
      expect(result.qualityScore).toBeLessThan(100); // Should have warnings
      expect(result.issues.filter((i) => i.severity === 'warning').length).toBeGreaterThan(0);
    });
  });

  describe('Hard blocks vs soft warnings', () => {
    it('blocks when forbidden technology is used without justification', () => {
      // Use a PRD without "Não Fazer" section to ensure we catch the forbidden tech
      const contentWithForbiddenTech = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar o sistema usando Kubernetes para deploy.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Implementar deploy com Kubernetes

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Deploy time | 30min | 5min | CI/CD |

## 10. Riscos e Mitigações
| Risco | Mitigação |
|-------|-----------|
| Risco X | Mitigar |

## 11. Critérios de Aceite
- [ ] Deploy funciona

## 12. Plano de Execução
1. Configurar Kubernetes

## 13. Casos de Borda
- Caso 1: OK
      `;
      const result = improvementExecutionService.validateImprovementPlan(contentWithForbiddenTech, {
        level: 3,
        forbiddenTechnologies: ['kubernetes'],
      });

      expect(result.qualityPassed).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error' && i.category === 'semantic')).toBe(
        true,
      );
    });

    it('blocks when scope exceeds maxEffortDays', () => {
      const content = FULL_VALID_PRD + '\n\nEsforço estimado: 30 dias.';
      const result = improvementExecutionService.validateImprovementPlan(content, {
        level: 3,
        maxEffortDays: 14,
      });

      expect(result.qualityPassed).toBe(false);
      expect(
        result.issues.some((i) => i.severity === 'error' && i.section.includes('Escopo')),
      ).toBe(true);
    });

    it('warns (soft) when ROI is missing', () => {
      // Using a PRD without ROI mention
      const contentWithoutROI = FULL_VALID_PRD.replace('ROI', 'benefício');
      const result = improvementExecutionService.validateImprovementPlan(contentWithoutROI, {
        level: 3,
      });

      const roiWarning = result.issues.find((i) => i.section === 'ROI');
      expect(roiWarning).toBeDefined();
      expect(roiWarning?.severity).toBe('warning');
    });
  });

  describe('Quality score calculation', () => {
    it('starts at 100 and decreases with warnings', () => {
      const result = improvementExecutionService.validateImprovementPlan(FULL_VALID_PRD, {
        level: 3,
      });
      expect(result.qualityScore).toBeLessThanOrEqual(100);
    });

    it('returns 0 or positive score even with many warnings', () => {
      const minimalContent = `
## 4. Objetivo
### 4.1 Objetivo Principal
Melhorar.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Item

- [ ] Critério
      `;
      const result = improvementExecutionService.validateImprovementPlan(minimalContent, {
        level: 1,
      });
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Backwards compatibility', () => {
    it('defaults to Level 3 when no options provided', () => {
      const result = improvementExecutionService.validateImprovementPlan(FULL_VALID_PRD);
      expect(result.level).toBe(3);
    });

    it('still populates missingSections for backwards compatibility', () => {
      const content = FULL_VALID_PRD.replace('### 5.1 Fazer Agora\n- Item 1\n', '');
      const result = improvementExecutionService.validateImprovementPlan(content);

      expect(result.missingSections.length).toBeGreaterThan(0);
      expect(result.missingSections.some((s) => s.includes('5.1'))).toBe(true);
    });
  });
});

// ===== validateImprovementTasks tests =====
describe('validateImprovementTasks', () => {
  const VALID_TASKS = `
# Checklist De Execução - Melhorar plano

## Agora

- **T1:** [DIAGNÓSTICO] Medir baseline atual
  Critérios de aceite: Baseline registrado
  **Dependências:** Nenhuma
  **Vinculado ao PRD:** §8 Métricas

- **T2:** [IMPLEMENTAÇÃO] Aplicar mudança no sistema
  Critérios de aceite: Mudança aplicada
  **Dependências:** T1
  **Vinculado ao PRD:** §5.1 Fazer Agora

- **T3:** [VALIDAÇÃO] Comparar resultado com baseline
  Critérios de aceite: Meta atingida
  **Dependências:** T2
  **Vinculado ao PRD:** §11 Critérios

## Depois
- Refinamento futuro

## Não Fazer
- Item fora de escopo

## Métricas de Sucesso
- Baseline 40% → Meta 20%
  `;

  it('passes when tasks contain [IMPLEMENTAÇÃO] tag', () => {
    const result = improvementExecutionService.validateImprovementTasks(VALID_TASKS, { level: 3 });

    expect(result.qualityPassed).toBe(true);
    expect(result.level).toBe(3);
  });

  it('fails (hard block) when no [IMPLEMENTAÇÃO] task exists', () => {
    const content = VALID_TASKS.replace('[IMPLEMENTAÇÃO]', '[DIAGNÓSTICO]');
    const result = improvementExecutionService.validateImprovementTasks(content, { level: 3 });

    expect(result.qualityPassed).toBe(false);
    expect(result.hardBlockReason).toContain('IMPLEMENTAÇÃO');
    expect(result.issues.some((i) => i.severity === 'error' && i.category === 'semantic')).toBe(
      true,
    );
  });

  it('fails when ## Agora section is missing', () => {
    // Create content without any "Agora" section at all
    const contentWithoutAgora = `
# Checklist De Execução - Melhorar plano

## Tarefas

- **T1:** [IMPLEMENTAÇÃO] Fazer algo
  **Vinculado ao PRD:** §5.1

## Depois
- Refinamento futuro

## Não Fazer
- Item fora de escopo

## Métricas de Sucesso
- Métrica 1
    `;
    const result = improvementExecutionService.validateImprovementTasks(contentWithoutAgora, {
      level: 3,
    });

    expect(result.qualityPassed).toBe(false);
    expect(result.issues.some((i) => i.severity === 'error' && i.section.includes('Agora'))).toBe(
      true,
    );
  });

  it('requires task IDs (T1, T2...) at Level 2+', () => {
    const contentWithoutIds = `
## Agora
- [IMPLEMENTAÇÃO] Aplicar mudança
  **Vinculado ao PRD:** §5.1

## Depois
- Item futuro

## Não Fazer
- Item fora

## Métricas de Sucesso
- Métrica 1
    `;
    const result = improvementExecutionService.validateImprovementTasks(contentWithoutIds, {
      level: 2,
    });

    expect(result.qualityPassed).toBe(false);
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('T1'))).toBe(
      true,
    );
  });

  it('warns when PRD link is missing', () => {
    const contentWithoutLink = VALID_TASKS.replace(/\*\*Vinculado ao PRD:\*\*.*/g, '');
    const result = improvementExecutionService.validateImprovementTasks(contentWithoutLink, {
      level: 3,
    });

    const warning = result.issues.find(
      (i) => i.severity === 'warning' && i.message.includes('PRD'),
    );
    expect(warning).toBeDefined();
    expect(result.qualityScore).toBeLessThan(100);
  });

  it('Level 1 only requires [IMPLEMENTAÇÃO] and ## Agora', () => {
    const minimalTasks = `
## Agora
- **T1:** [IMPLEMENTAÇÃO] Fazer a mudança
    `;
    const result = improvementExecutionService.validateImprovementTasks(minimalTasks, { level: 1 });

    expect(result.qualityPassed).toBe(true);
    expect(result.level).toBe(1);
  });
});
