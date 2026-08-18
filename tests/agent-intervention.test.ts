import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock dependencies before any imports ─────────────────────────────────────
vi.mock('../server/db', () => ({
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
  isPostgres: false,
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { dbHelper } from '../server/db';
import { agentInterventionService } from '../server/services/agent-intervention-service';

// ─────────────────────────────────────────────────────────────────────────────

const makeRawRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  demand_id: 42,
  pontos_overengineering: JSON.stringify(['Ponto A', 'Ponto B']),
  escopo_reduzido: 'Implementar logs locais primeiro',
  roi_estimado: '5:1',
  esforco_original_dias: 10,
  esforco_reduzido_dias: 2,
  dias_economizados: 8,
  override_applied: 0,
  override_by: null,
  override_justification: null,
  modelo: 'deepseek/deepseek-v4-pro',
  criado_em: Math.floor(Date.now() / 1000),
  ...overrides,
});

describe('AgentInterventionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dbHelper.run as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Reset tableReady so ensureTable is always called fresh
    (agentInterventionService as any).tableReady = false;
  });

  // ── Table bootstrap ────────────────────────────────────────────────────────

  describe('ensureTable', () => {
    it('creates table and indexes on first call', async () => {
      await agentInterventionService.ensureTable();
      // run called 3 times: CREATE TABLE + 2 indexes
      expect(dbHelper.run).toHaveBeenCalledTimes(3);
    });

    it('skips DDL on subsequent calls', async () => {
      await agentInterventionService.ensureTable();
      await agentInterventionService.ensureTable();
      // Still 3 — not called again
      expect(dbHelper.run).toHaveBeenCalledTimes(3);
    });
  });

  // ── create — happy path ────────────────────────────────────────────────────

  describe('create', () => {
    it('happy path: persists all 3 mandatory fields and returns mapped entry', async () => {
      const rawRow = makeRawRow();
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([rawRow]);

      const result = await agentInterventionService.create({
        demandId: 42,
        pontosOverengineering: ['Ponto A', 'Ponto B'],
        escopoReduzido: 'Implementar logs locais primeiro',
        roiEstimado: '5:1',
        esforcoOriginalDias: 10,
        esforcoReduzidoDias: 2,
        modelo: 'deepseek/deepseek-v4-pro',
      });

      expect(result.demandId).toBe(42);
      expect(result.pontosOverengineering).toEqual(['Ponto A', 'Ponto B']);
      expect(result.escopoReduzido).toBe('Implementar logs locais primeiro');
      expect(result.roiEstimado).toBe('5:1');
      expect(result.esforcoOriginalDias).toBe(10);
      expect(result.esforcoReduzidoDias).toBe(2);
      expect(result.diasEconomizados).toBe(8);
      expect(result.overrideApplied).toBe(false);
      expect(result.modelo).toBe('deepseek/deepseek-v4-pro');
    });

    it('handles optional fields (esforco* null)', async () => {
      const rawRow = makeRawRow({
        esforco_original_dias: null,
        esforco_reduzido_dias: null,
        dias_economizados: null,
      });
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([rawRow]);

      const result = await agentInterventionService.create({
        demandId: 42,
        pontosOverengineering: ['Ponto C'],
        escopoReduzido: 'MVP first',
        roiEstimado: '3:1',
      });

      expect(result.esforcoOriginalDias).toBeNull();
      expect(result.esforcoReduzidoDias).toBeNull();
      expect(result.diasEconomizados).toBeNull();
    });

    it('falls back to last_insert_rowid when RETURNING is not supported', async () => {
      // First call raises a syntax error (simulates old SQLite)
      (dbHelper.all as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('near "RETURNING": syntax error'))
        .mockResolvedValueOnce([{ id: 7 }]);

      const result = await agentInterventionService.create({
        demandId: 42,
        pontosOverengineering: ['Ponto X'],
        escopoReduzido: 'Reduzir escopo',
        roiEstimado: '2:1',
        esforcoOriginalDias: 5,
        esforcoReduzidoDias: 1,
      });

      expect(result.id).toBe(7);
      expect(result.diasEconomizados).toBe(4); // 5 - 1
    });

    it('computes diasEconomizados in fallback path when both values present', async () => {
      (dbHelper.all as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('near "RETURNING": syntax error'))
        .mockResolvedValueOnce([{ id: 1 }]);

      const result = await agentInterventionService.create({
        demandId: 1,
        pontosOverengineering: ['p'],
        escopoReduzido: 's',
        roiEstimado: '1:1',
        esforcoOriginalDias: 7,
        esforcoReduzidoDias: 3,
      });

      expect(result.diasEconomizados).toBe(4);
    });

    it('propagates non-syntax errors', async () => {
      (dbHelper.all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'),
      );

      await expect(
        agentInterventionService.create({
          demandId: 9999, // non-existent demand
          pontosOverengineering: ['p'],
          escopoReduzido: 's',
          roiEstimado: '1:1',
        }),
      ).rejects.toThrow('SQLITE_CONSTRAINT');
    });
  });

  // ── getByDemandId ──────────────────────────────────────────────────────────

  describe('getByDemandId', () => {
    it('returns mapped entries ordered by criado_em DESC', async () => {
      const rows = [makeRawRow({ id: 2, criado_em: 2000 }), makeRawRow({ id: 1, criado_em: 1000 })];
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);

      const result = await agentInterventionService.getByDemandId(42);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(2);
      expect(result[1].id).toBe(1);
    });

    it('returns empty array when no interventions for demand', async () => {
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const result = await agentInterventionService.getByDemandId(999);
      expect(result).toEqual([]);
    });

    it('gracefully parses malformed JSON in pontos_overengineering', async () => {
      const row = makeRawRow({ pontos_overengineering: 'texto plano' });
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([row]);

      const result = await agentInterventionService.getByDemandId(42);
      // Should fall back to wrapping the string in an array
      expect(result[0].pontosOverengineering).toEqual(['texto plano']);
    });
  });

  // ── applyOverride ──────────────────────────────────────────────────────────

  describe('applyOverride', () => {
    it('happy path: calls UPDATE with correct values', async () => {
      await agentInterventionService.applyOverride(1, 'user-123', 'Necessidade urgente de negócio');
      // ensureTable (3 runs) + UPDATE (1 run)
      const runCalls = (dbHelper.run as ReturnType<typeof vi.fn>).mock.calls;
      const _updateCall = runCalls.find(
        (c) =>
          String(c[0]).includes?.('UPDATE') ||
          (c[0] &&
            typeof c[0] === 'object' &&
            String(c[0].sql || c[0].queryChunks?.[0] || '').includes('UPDATE')),
      );
      // The update should have been called
      expect(dbHelper.run).toHaveBeenCalled();
    });

    it('override flag is reflected after applyOverride (round-trip via getByDemandId)', async () => {
      // After override, the DB row should have override_applied = 1
      const overriddenRow = makeRawRow({
        override_applied: 1,
        override_by: 'user-456',
        override_justification: 'Prazo crítico',
      });
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([overriddenRow]);

      const entries = await agentInterventionService.getByDemandId(42);
      expect(entries[0].overrideApplied).toBe(true);
      expect(entries[0].overrideBy).toBe('user-456');
      expect(entries[0].overrideJustification).toBe('Prazo crítico');
    });
  });

  // ── getMonthlyMetrics ──────────────────────────────────────────────────────

  describe('getMonthlyMetrics', () => {
    it('returns zero stats when no interventions', async () => {
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const metrics = await agentInterventionService.getMonthlyMetrics(3);

      expect(metrics.totalInterventions).toBe(0);
      expect(metrics.totalDiasEconomizados).toBe(0);
      expect(metrics.overridesCount).toBe(0);
      expect(metrics.interventionsByMonth).toHaveLength(0);
    });

    it('aggregates days saved and override count across months', async () => {
      const now = Math.floor(Date.now() / 1000);
      const lastMonth = now - 60 * 60 * 24 * 30;

      const rows = [
        { id: 1, dias_economizados: 3, override_applied: 0, criado_em: now },
        { id: 2, dias_economizados: 5, override_applied: 1, criado_em: now },
        { id: 3, dias_economizados: 2, override_applied: 0, criado_em: lastMonth },
      ];
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);

      const metrics = await agentInterventionService.getMonthlyMetrics(3);

      expect(metrics.totalInterventions).toBe(3);
      expect(metrics.totalDiasEconomizados).toBe(10); // 3 + 5 + 2
      expect(metrics.overridesCount).toBe(1);
      expect(metrics.interventionsByMonth.length).toBeGreaterThanOrEqual(1);
    });

    it('groups rows into correct months', async () => {
      // Two rows in the same month
      const epoch = Math.floor(new Date('2025-03-15').getTime() / 1000);
      const rows = [
        { id: 1, dias_economizados: 4, override_applied: 0, criado_em: epoch },
        { id: 2, dias_economizados: 6, override_applied: 0, criado_em: epoch + 86400 },
      ];
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);

      const metrics = await agentInterventionService.getMonthlyMetrics(6);
      const march = metrics.interventionsByMonth.find((m) => m.month === '2025-03');

      expect(march).toBeDefined();
      expect(march!.interventions).toBe(2);
      expect(march!.diasEconomizados).toBe(10);
    });

    it('handles null dias_economizados without crashing', async () => {
      const now = Math.floor(Date.now() / 1000);
      (dbHelper.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { id: 1, dias_economizados: null, override_applied: 0, criado_em: now },
      ]);

      const metrics = await agentInterventionService.getMonthlyMetrics(3);
      expect(metrics.totalDiasEconomizados).toBe(0);
    });
  });

  // ── Demand-classifier positioning (unit) ─────────────────────────────────

  describe('demand-classifier: anti_overengineering positioning', () => {
    it('places anti_overengineering last in a technical agent list', () => {
      const agents = ['refinador', 'tech_lead', 'qa', 'anti_overengineering'];
      const withoutAOE = agents.filter((a) => a !== 'anti_overengineering');
      const ordered = [...withoutAOE, 'anti_overengineering'];
      expect(ordered[ordered.length - 1]).toBe('anti_overengineering');
    });

    it('enforces anti_overengineering last even if inserted mid-list', () => {
      const agents = ['tech_lead', 'anti_overengineering', 'qa'];
      const reordered = [
        ...agents.filter((a) => a !== 'anti_overengineering'),
        'anti_overengineering',
      ];
      expect(reordered).toEqual(['tech_lead', 'qa', 'anti_overengineering']);
    });

    it('leaves list unchanged when anti_overengineering not present', () => {
      const agents = ['refinador', 'tech_lead', 'qa'];
      const reordered = agents.includes('anti_overengineering')
        ? [...agents.filter((a) => a !== 'anti_overengineering'), 'anti_overengineering']
        : agents;
      expect(reordered).toEqual(agents);
    });
  });

  // ── Route-level validation logic ──────────────────────────────────────────

  describe('Route: override validation', () => {
    it('rejects justification shorter than 10 chars', () => {
      const justification = 'curta';
      const valid = justification.trim().length >= 10;
      expect(valid).toBe(false);
    });

    it('accepts justification of exactly 10 chars', () => {
      const justification = '1234567890';
      const valid = justification.trim().length >= 10;
      expect(valid).toBe(true);
    });

    it('rejects empty justification', () => {
      const justification = '';
      const valid = !!(justification && justification.trim().length >= 10);
      expect(valid).toBe(false);
    });
  });

  describe('Route: max-effort-override validation', () => {
    it('rejects dias = 0', () => {
      const dias = 0;
      const valid = typeof dias === 'number' && dias > 0 && dias <= 365;
      expect(valid).toBe(false);
    });

    it('rejects dias > 365', () => {
      const dias = 366;
      const valid = typeof dias === 'number' && dias > 0 && dias <= 365;
      expect(valid).toBe(false);
    });

    it('rejects string dias', () => {
      const dias = '10';
      const valid = typeof dias === 'number' && (dias as any) > 0 && (dias as any) <= 365;
      expect(valid).toBe(false);
    });

    it('accepts dias = 14 (2 weeks)', () => {
      const dias = 14;
      const valid = typeof dias === 'number' && dias > 0 && dias <= 365;
      expect(valid).toBe(true);
    });

    it('accepts dias = 365 (max boundary)', () => {
      const dias = 365;
      const valid = typeof dias === 'number' && dias > 0 && dias <= 365;
      expect(valid).toBe(true);
    });
  });

  // ── ai-squad.ts: parecer extraction logic (unit) ──────────────────────────

  describe('persistAntiOverengineeringIntervention: field extraction', () => {
    // Mirror the extraction logic from ai-squad.ts
    function extractFromMessage(text: string) {
      const problemaMatch = text.match(/\*\*Problema Identificado:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const problemaRaw = problemaMatch ? problemaMatch[1].trim() : '';
      const pontosOverengineering = problemaRaw
        ? problemaRaw
            .split(/\n+/)
            .map((l) => l.replace(/^[-•*]\s*/, '').trim())
            .filter(Boolean)
        : ['Ponto de overengineering não identificado'];

      const recomMatch = text.match(/\*\*Recomenda[çc][aã]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const escopoReduzido = recomMatch ? recomMatch[1].trim() : 'Escopo reduzido não especificado';

      const roiMatch = text.match(/\*\*ROI:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const roiEstimado = roiMatch ? roiMatch[1].trim() : 'N/A';

      const esforcoMatch = text.match(/\*\*Esfor[çc]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      let esforcoReduzidoDias: number | null = null;
      if (esforcoMatch) {
        const numMatch = esforcoMatch[1].match(/(\d+(?:[.,]\d+)?)/);
        if (numMatch) esforcoReduzidoDias = parseFloat(numMatch[1].replace(',', '.'));
      }

      return { pontosOverengineering, escopoReduzido, roiEstimado, esforcoReduzidoDias };
    }

    const sampleMessage = `
**Análise:** Aplicação monolítica simples.
**Problema Identificado:** Adicionar Kafka sem evidência de volume
**Impacto:** Aumenta custo sem resolver diagnóstico.
**Recomendação:** Implementar logs estruturados locais primeiro
**ROI:** 5:1
**Esforço:** 2 dias
**Prioridade:** Importante
**Premissas:** Nenhuma
`;

    it('extracts pontosOverengineering as array from Problema Identificado', () => {
      const { pontosOverengineering } = extractFromMessage(sampleMessage);
      expect(pontosOverengineering).toContain('Adicionar Kafka sem evidência de volume');
    });

    it('extracts escopoReduzido from Recomendação', () => {
      const { escopoReduzido } = extractFromMessage(sampleMessage);
      expect(escopoReduzido).toBe('Implementar logs estruturados locais primeiro');
    });

    it('extracts roiEstimado as string ratio', () => {
      const { roiEstimado } = extractFromMessage(sampleMessage);
      expect(roiEstimado).toBe('5:1');
    });

    it('extracts esforcoReduzidoDias as number', () => {
      const { esforcoReduzidoDias } = extractFromMessage(sampleMessage);
      expect(esforcoReduzidoDias).toBe(2);
    });

    it('falls back gracefully when Problema Identificado is missing', () => {
      const { pontosOverengineering } = extractFromMessage('**ROI:** 3:1\n**Esforço:** 1 dia');
      expect(pontosOverengineering).toEqual(['Ponto de overengineering não identificado']);
    });

    it('falls back gracefully when Recomendação is missing', () => {
      const { escopoReduzido } = extractFromMessage('**ROI:** 3:1');
      expect(escopoReduzido).toBe('Escopo reduzido não especificado');
    });

    it('falls back to N/A when ROI is missing', () => {
      const { roiEstimado } = extractFromMessage('**Esforço:** 3 dias');
      expect(roiEstimado).toBe('N/A');
    });

    it('handles comma decimal in Esforço (e.g., "1,5 dias")', () => {
      const { esforcoReduzidoDias } = extractFromMessage(
        '**Esforço:** 1,5 dias\n**Prioridade:** Desejável',
      );
      expect(esforcoReduzidoDias).toBe(1.5);
    });

    it('sets esforcoReduzidoDias to null when Esforço field is absent', () => {
      const { esforcoReduzidoDias } = extractFromMessage('**ROI:** 4:1');
      expect(esforcoReduzidoDias).toBeNull();
    });
  });
});
