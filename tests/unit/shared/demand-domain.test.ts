import { describe, expect, it } from 'vitest';
import { demandDomainSchema } from '../../../shared/schema';

describe('domínios da Spec 009', () => {
  it.each(['padrao', 'legaltech_lgpd'])('aceita %s', (domain) => {
    expect(demandDomainSchema.parse(domain)).toBe(domain);
  });

  it('preserva normalização defensiva', () => {
    expect(demandDomainSchema.parse('LEGALTECH_LGPD')).toBe('legaltech_lgpd');
    expect(demandDomainSchema.parse(['legaltech_lgpd'])).toBe('legaltech_lgpd');
  });

  it('domínio descontinuado fintech_cambio mapeia para padrao (back-compat)', () => {
    expect(demandDomainSchema.parse('fintech_cambio')).toBe('padrao');
    expect(demandDomainSchema.parse('FINTECH_CAMBIO')).toBe('padrao');
    expect(demandDomainSchema.parse(['fintech_cambio'])).toBe('padrao');
  });
});
