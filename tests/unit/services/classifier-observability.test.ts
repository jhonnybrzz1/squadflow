import { describe, expect, it } from 'vitest';
import { getClassifierSubmissionEvents } from '../../../server/services/classifier-observability';

describe('classifier observability', () => {
  it('registra aceite quando seleção e sugestão conclusiva coincidem', () => {
    expect(
      getClassifierSubmissionEvents({
        title: 'Vulnerabilidade LGPD',
        description: 'Corrigir segurança de dados pessoais e compliance.',
        selectedType: 'security',
      }),
    ).toMatchObject({
      primary: 'classifierAccepted',
      userReclassified: false,
      suggestedType: 'security',
    });
  });

  it('registra fallback e reclassificação humana', () => {
    expect(
      getClassifierSubmissionEvents({
        title: 'Revisar pedido',
        description: 'Avaliar o melhor caminho conforme necessário.',
        selectedType: 'discovery',
      }),
    ).toMatchObject({
      primary: 'classifierFallback',
      userReclassified: true,
      suggestedType: 'nova_funcionalidade',
    });
  });
});
