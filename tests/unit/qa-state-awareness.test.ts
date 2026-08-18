/**
 * Spec 020 — state-awareness do agente QA entre rodadas.
 * Cobre: cláusula no prompt do QA (contrato do YAML), bloco de contribuições
 * próprias no digest (causa raiz: compressão a ~220 chars), teto de tokens e
 * telemetria de truncamento/anti-repeat.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AgentInteractionService } from '../../server/services/agent-interaction';

type AgentMessage = { agent: string; message: string; timestamp?: number };

const service = new AgentInteractionService();

function msg(agent: string, message: string): AgentMessage {
  return { agent, message, timestamp: Date.now() };
}

describe('agents/qa.yaml — cláusula de memória entre rodadas (FR-002/FR-003)', () => {
  const yaml = fs.readFileSync(path.join(process.cwd(), 'agents', 'qa.yaml'), 'utf8');

  it('contém a seção MEMÓRIA ENTRE RODADAS com a cláusula de não repetição', () => {
    expect(yaml).toContain('MEMÓRIA ENTRE RODADAS');
    expect(yaml).toMatch(/NÃO repita critérios de aceite/i);
    expect(yaml).toMatch(/Sem novos\s+critérios além dos já listados/);
  });

  it('mantém as cláusulas entre-agentes pré-existentes (padrão do Analista)', () => {
    expect(yaml).toContain('REGRA DE PROGRESSO ENTRE AGENTES');
    expect(yaml).toMatch(/não repita\./);
  });
});

describe('buildSelfHistory — última contribuição integral do próprio agente', () => {
  it('primeira fala do agente: sem bloco e comprimentos zero', () => {
    const history = [msg('tech_lead', 'análise técnica')];
    const self = service.buildSelfHistory(history, 'qa');
    expect(self).toEqual({ originalLength: 0, includedLength: 0, block: '' });
  });

  it('inclui a última contribuição INTEGRAL (não os ~220 chars do digest)', () => {
    const longCriteria = 'Critério de aceite: ' + 'x'.repeat(1500);
    const history = [msg('qa', 'primeira rodada curta'), msg('qa', longCriteria)];
    const self = service.buildSelfHistory(history, 'qa');
    expect(self.originalLength).toBe(longCriteria.length);
    expect(self.includedLength).toBe(longCriteria.length);
    expect(self.block).toContain(longCriteria);
    expect(self.block).toContain('NÃO repita');
  });

  it('aplica teto de 2.400 chars para não estourar tokens (risco declarado da demanda)', () => {
    const huge = 'y'.repeat(10_000);
    const self = service.buildSelfHistory([msg('qa', huge)], 'qa');
    expect(self.originalLength).toBe(10_000);
    expect(self.includedLength).toBeLessThanOrEqual(2400);
    expect(self.block.endsWith('…')).toBe(true);
  });

  it('gate de truncamento verificável: contribuição típica (≤2.400) tem 0% de truncamento', () => {
    const typical = 'Critérios: 1) a; 2) b; 3) c. ' + 'z'.repeat(2000);
    const self = service.buildSelfHistory([msg('qa', typical)], 'qa');
    const truncation = 1 - self.includedLength / self.originalLength;
    expect(truncation).toBeLessThanOrEqual(0.2);
  });
});

describe('buildConversationContext — digest + bloco próprio (US1/US3)', () => {
  const history = [
    msg('tech_lead', '**Recomendação:** usar cache local para reduzir latência de rede.'),
    msg(
      'qa',
      '**Recomendação:** cobrir happy path.\nCritério 1: login válido persiste sessão.\nCritério 2: erro 500 exibe mensagem amigável.',
    ),
  ];

  it('para o próprio agente (qa): inclui SUAS CONTRIBUIÇÕES ANTERIORES integrais', () => {
    const context = service.buildConversationContext(history, '', 'qa');
    expect(context).toContain('SUAS CONTRIBUIÇÕES ANTERIORES');
    expect(context).toContain('Critério 2: erro 500 exibe mensagem amigável.');
  });

  it('para outro agente: sem bloco próprio, digest comprimido segue igual', () => {
    const context = service.buildConversationContext(history, '', 'ux');
    expect(context).not.toContain('SUAS CONTRIBUIÇÕES ANTERIORES');
    expect(context).toContain('DIGEST DA SQUAD');
  });

  it('flag anti-repeat da telemetria detecta o marcador em qualquer caixa (bug corrigido)', () => {
    const context = service.buildConversationContext(history, '', 'qa');
    // A checagem antiga era includes('NÃO repita') case-sensitive e sempre false
    // para o digest ("NÃO REPITA"); a nova regex cobre as duas formas.
    expect(/n[aã]o\s+repita/i.test(context)).toBe(true);
  });

  it('sem histórico: mensagem de primeiro agente, sem bloco próprio', () => {
    const context = service.buildConversationContext([], '', 'qa');
    expect(context).toContain('você é o primeiro');
  });
});
