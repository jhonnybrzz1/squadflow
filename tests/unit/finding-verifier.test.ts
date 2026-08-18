import { describe, expect, it } from 'vitest';

import {
  LINE_TOLERANCE,
  runFindingGate,
  verifyFinding,
  type Finding,
} from '../../server/services/ai-squad/finding-verifier';

/**
 * O verificador roda contra o repositório real, então os casos "verdadeiros"
 * apontam para código estável e para um termo que existe de fato. Se algum
 * desses arquivos for renomeado, o teste falha — que é o comportamento certo:
 * o gate depende de o caminho alegado existir.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    skill: 'avaliar-fluxo-agentes',
    summary: 'achado de teste',
    evidenceFile: 'server/services/ai-squad/finding-verifier.ts',
    evidenceLine: 1,
    verificationCommand: 'Verificador de achados',
    ...overrides,
  };
}

describe('finding-verifier', () => {
  describe('verifyFinding', () => {
    it('confirma achado cuja evidência existe no arquivo e linha alegados', () => {
      const result = verifyFinding(finding());
      expect(result.verdict).toBe('verified');
      expect(result.verified).toBe(true);
      expect(result.matchedLine).toBeGreaterThan(0);
    });

    it(`aceita desvio de até ${LINE_TOLERANCE} linhas no ponto alegado`, () => {
      const exact = verifyFinding(finding());
      const shifted = verifyFinding(
        finding({ evidenceLine: (exact.matchedLine ?? 1) + LINE_TOLERANCE }),
      );
      expect(shifted.verdict).toBe('verified');
    });

    it(`rejeita desvio maior que ${LINE_TOLERANCE} linhas`, () => {
      const exact = verifyFinding(finding());
      const tooFar = verifyFinding(
        finding({ evidenceLine: (exact.matchedLine ?? 1) + LINE_TOLERANCE + 20 }),
      );
      expect(tooFar.verdict).toBe('term_not_found');
      expect(tooFar.verified).toBe(false);
    });

    it('encontra o arquivo pelo basename quando a skill omite o diretório', () => {
      const result = verifyFinding(finding({ evidenceFile: 'finding-verifier.ts' }));
      expect(result.verdict).toBe('verified');
    });

    it('rejeita achado que aponta arquivo inexistente — o falso positivo mais comum', () => {
      const result = verifyFinding(
        finding({ evidenceFile: 'server/services/dashboard-que-nunca-existiu.ts' }),
      );
      expect(result.verdict).toBe('file_not_found');
      expect(result.verified).toBe(false);
    });

    it('rejeita linha além do fim do arquivo', () => {
      const result = verifyFinding(finding({ evidenceLine: 999_999 }));
      expect(result.verdict).toBe('line_out_of_range');
    });

    it('rejeita achado cujo termo não aparece no trecho alegado', () => {
      const result = verifyFinding(
        finding({ verificationCommand: 'kubernetes horizontal pod autoscaler' }),
      );
      expect(result.verdict).toBe('term_not_found');
    });

    it.each([
      ['sem arquivo', { evidenceFile: '' }],
      ['sem termo', { verificationCommand: '' }],
      ['linha zero', { evidenceLine: 0 }],
      ['linha fracionária', { evidenceLine: 1.5 }],
    ])('trata evidência malformada (%s) sem estourar', (_label, overrides) => {
      const result = verifyFinding(finding(overrides as Partial<Finding>));
      expect(result.verdict).toBe('malformed_evidence');
      expect(result.verified).toBe(false);
    });

    it('ignora diferenças de espaçamento e caixa', () => {
      const result = verifyFinding(
        finding({ verificationCommand: '  VERIFICADOR   de    ACHADOS  ' }),
      );
      expect(result.verdict).toBe('verified');
    });
  });

  describe('runFindingGate', () => {
    const good = finding();
    const bad = finding({ evidenceFile: 'server/services/inexistente.ts', patternId: 'P-42' });

    it('em warn deixa todos passarem, mas contabiliza os não verificados', () => {
      const gate = runFindingGate([good, bad], 'warn');
      expect(gate.accepted).toHaveLength(2);
      expect(gate.rejected).toHaveLength(1);
      expect(gate.verifiedCount).toBe(1);
      expect(gate.totalCount).toBe(2);
    });

    it('em enforce descarta o achado sem evidência', () => {
      const gate = runFindingGate([good, bad], 'enforce');
      expect(gate.accepted).toHaveLength(1);
      expect(gate.accepted[0].evidenceFile).toBe(good.evidenceFile);
      expect(gate.rejected[0].finding.patternId).toBe('P-42');
    });

    it('não altera a contagem de verificados entre os modos — só o que passa', () => {
      const warn = runFindingGate([good, bad], 'warn');
      const enforce = runFindingGate([good, bad], 'enforce');
      expect(warn.verifiedCount).toBe(enforce.verifiedCount);
      expect(warn.accepted.length).toBeGreaterThan(enforce.accepted.length);
    });

    it('lida com lote vazio', () => {
      const gate = runFindingGate([], 'enforce');
      expect(gate.totalCount).toBe(0);
      expect(gate.accepted).toEqual([]);
    });
  });
});
