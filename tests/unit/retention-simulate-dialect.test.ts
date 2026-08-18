import { describe, expect, it } from 'vitest';
import { toIsoDate } from '../../server/services/retention-policy';

/**
 * Auditoria 2026-08-01 (A08): `simulateImpact` assumia SQLite em tudo — usava
 * `db.all` (que só existe no driver SQLite) e tratava `MIN`/`MAX` como epoch em
 * segundos, fazendo `new Date(valor * 1000)`. No PostgreSQL as 12 tabelas do
 * DATA_TYPE_TABLE_MAP são `timestamp`, e multiplicar um `Date` por 1000 produz
 * `Invalid Date` — a simulação de retenção devolvia data inválida em silêncio.
 */
describe('toIsoDate — conversão de timestamp por dialeto (A08)', () => {
  it('converte epoch em segundos (SQLite)', () => {
    // 2026-07-24T12:36:48Z
    expect(toIsoDate(1784896608)).toBe(new Date(1784896608 * 1000).toISOString());
  });

  it('converte Date nativo (PostgreSQL) sem multiplicar por 1000', () => {
    const date = new Date('2026-07-24T12:36:48.000Z');
    expect(toIsoDate(date)).toBe('2026-07-24T12:36:48.000Z');
  });

  it('aceita timestamp devolvido como string de data', () => {
    expect(toIsoDate('2026-07-24T12:36:48.000Z')).toBe('2026-07-24T12:36:48.000Z');
  });

  it('aceita epoch devolvido como string numérica', () => {
    expect(toIsoDate('1784896608')).toBe(new Date(1784896608 * 1000).toISOString());
  });

  it('null e undefined viram null, não Invalid Date', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });

  it('valor não parseável vira null em vez de "Invalid Date"', () => {
    expect(toIsoDate('não é data')).toBeNull();
  });
});
