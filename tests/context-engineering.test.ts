import { describe, expect, it } from 'vitest';
import { selectSalientInsights } from '../server/services/context-engineering';

describe('context engineering salience selection', () => {
  it('keeps critical insights and preserves chronological order after selection', () => {
    const selected = selectSalientInsights(
      [
        { agentName: 'a', insight: 'nota simples', timestamp: '10:00' },
        { agentName: 'b', insight: '**Risco:** schema drift', timestamp: '10:01' },
        { agentName: 'c', insight: 'observacao baixa', timestamp: '10:02' },
        { agentName: 'd', insight: '**Decisão:** usar Postgres', timestamp: '10:03' },
      ],
      2,
    );

    expect(selected.map((item) => item.agentName)).toEqual(['b', 'd']);
  });
});
