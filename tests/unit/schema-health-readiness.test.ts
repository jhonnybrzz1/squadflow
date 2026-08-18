import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Auditoria 2026-08-01 (A07) — falha de inspeção não é saúde.
 *
 * `verifyDeployedSchema` devolvia `DeployedDrift[]`, e o `catch` de falha ao
 * inspecionar o banco retornava `[]` — indistinguível de "nenhum drift". O
 * readiness lia esse vazio como schema íntegro e respondia `ready` num servidor
 * cujo schema nunca foi verificado. Pior: nem consultava, o resultado só ia
 * para o log do boot.
 *
 * O mock vive no topo com estado mutável de propósito: `vi.resetModules()` +
 * reimport faz o prom-client tentar registrar as mesmas métricas duas vezes
 * (`server/metrics.ts` cria Histograms no import) e o teste morre por isso, não
 * pelo comportamento sob teste.
 */
const schemaMock = vi.hoisted(() => ({
  estado: {
    status: 'healthy',
    drift: [] as Array<Record<string, string>>,
    error: undefined as string | undefined,
  },
}));

vi.mock('../../server/services/schema-health-check', () => ({
  getLastSchemaHealth: () => schemaMock.estado,
}));

import { getHealthStatus, getReadyStatus } from '../../server/services/health-check';

const subsistemaSchema = (r: Awaited<ReturnType<typeof getHealthStatus>>) =>
  r.subsystems.find((s) => s.name === 'schema');

describe('schema no readiness (A07)', () => {
  beforeEach(() => {
    schemaMock.estado = { status: 'healthy', drift: [], error: undefined };
  });

  it('schema íntegro não bloqueia', async () => {
    const health = await getHealthStatus();
    expect(subsistemaSchema(health)?.status).toBe('healthy');
  });

  it('não conseguir verificar o schema conta como unhealthy, não como saudável', async () => {
    schemaMock.estado = { status: 'unknown', drift: [], error: 'db fora do ar' };

    const ready = await getReadyStatus();
    const schema = subsistemaSchema(ready);

    expect(schema?.status).toBe('unhealthy');
    expect(schema?.message).toContain('não pôde ser verificado');
    expect(schema?.message).toContain('db fora do ar');
    expect(ready.status).toBe('unhealthy');
  });

  it('drift derruba o readiness e nomeia as colunas divergentes', async () => {
    schemaMock.estado = {
      status: 'drift',
      drift: [
        { table: 'demands', column: 'origin', issue: 'column_missing' },
        { table: 'telemetry', column: 'timestamp', issue: 'column_missing' },
      ],
      error: undefined,
    };

    const ready = await getReadyStatus();
    const schema = subsistemaSchema(ready);

    expect(schema?.status).toBe('unhealthy');
    expect(schema?.message).toContain('demands.origin');
    expect(schema?.message).toContain('2 coluna(s)');
    // Servir com schema divergente é pior que não servir: a falha reaparece
    // depois, como dado errado.
    expect(ready.status).toBe('unhealthy');
  });

  it('trunca a amostra de drift para não despejar dezenas de colunas no health', async () => {
    schemaMock.estado = {
      status: 'drift',
      drift: Array.from({ length: 10 }, (_, i) => ({
        table: 't',
        column: `c${i}`,
        issue: 'column_missing',
      })),
      error: undefined,
    };

    const schema = subsistemaSchema(await getHealthStatus());

    expect(schema?.message).toContain('10 coluna(s)');
    expect(schema?.message).toContain('…');
    expect(schema?.message).not.toContain('c9');
  });
});
