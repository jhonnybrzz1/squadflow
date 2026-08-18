/**
 * Spec 019 RF-04 — buildPdfFilename: nome válido, caracteres especiais, vazio.
 */
import { describe, expect, it } from 'vitest';
import { buildPdfFilename, sanitizePdfBaseName } from '../../server/utils/pdf-filename';

describe('sanitizePdfBaseName', () => {
  it('nome válido vira base legível com underscores', () => {
    expect(sanitizePdfBaseName('Dashboard Vendas Q3')).toBe('Dashboard_Vendas_Q3');
  });

  it('remove acentos e caracteres especiais sem perder legibilidade', () => {
    expect(sanitizePdfBaseName('Relatório: Análise & Métricas (v2)!')).toBe(
      'Relatorio_Analise_Metricas_v2',
    );
  });

  it('neutraliza tentativas de path traversal e separadores', () => {
    expect(sanitizePdfBaseName('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizePdfBaseName('a/b\\c..d')).toBe('a_b_c_d');
  });

  it('string vazia, null e undefined retornam vazio', () => {
    expect(sanitizePdfBaseName('')).toBe('');
    expect(sanitizePdfBaseName(null)).toBe('');
    expect(sanitizePdfBaseName(undefined)).toBe('');
  });

  it('nome só de caracteres especiais não deixa nada aproveitável', () => {
    expect(sanitizePdfBaseName('!!! ??? ***')).toBe('');
  });

  it('limita o comprimento a 60 caracteres sem underscore pendurado', () => {
    const long = 'Palavra '.repeat(20);
    const base = sanitizePdfBaseName(long);
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base.endsWith('_')).toBe(false);
  });
});

describe('buildPdfFilename', () => {
  it('cenário 1 — nome válido: usa a solução no filename (RF-01)', () => {
    expect(buildPdfFilename('Dashboard Vendas Q3', 42, 'PRD')).toBe('Dashboard_Vendas_Q3_PRD.pdf');
  });

  it('cenário 2 — caracteres especiais: sanitiza mantendo legibilidade', () => {
    expect(buildPdfFilename('Geração do PIX: automática!', 42, 'Tasks')).toBe(
      'Geracao_do_PIX_automatica_Tasks.pdf',
    );
  });

  it('cenário 3 — vazio/null: fallback para os 8 primeiros caracteres do ID (RF-02)', () => {
    expect(buildPdfFilename('', 123456789, 'PRD')).toBe('12345678_PRD.pdf');
    expect(buildPdfFilename(null, 42, 'PRD')).toBe('42_PRD.pdf');
    expect(buildPdfFilename('***', 'a1b2c3d4e5f6', 'Tasks')).toBe('a1b2c3d4_Tasks.pdf');
  });

  it('é determinística: mesma entrada, mesmo nome (sem data/contador)', () => {
    expect(buildPdfFilename('Solução X', 7, 'PRD')).toBe(buildPdfFilename('Solução X', 7, 'PRD'));
  });
});
