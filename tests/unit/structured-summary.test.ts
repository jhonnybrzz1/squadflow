import { describe, expect, it, vi } from 'vitest';
import { SummaryBuilder } from '../../server/services/structured-summary';

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletion: vi.fn() },
}));

describe('SummaryBuilder deterministic fallback', () => {
  it('preserves decisions, risks and recent metadata in a compact summary', async () => {
    const builder = new SummaryBuilder();
    const summary = await builder.buildStructuredSummary(
      [
        {
          agentName: 'tech_lead',
          insight:
            '**Decisão:** usar fila assíncrona\n**Risco:** duplicidade\n**Mitigação:** chave idempotente',
          timestamp: '10:00:00',
        },
      ],
      false,
    );

    expect(summary.decisions).toContain('usar fila assíncrona');
    expect(summary.risks[0]).toMatchObject({
      risk: 'duplicidade',
      mitigation: 'chave idempotente',
    });
    expect(summary.metadata.totalInsights).toBe(1);
    expect(builder.formatAsCompactText(summary)).toContain('Decisões:');
  });
});
