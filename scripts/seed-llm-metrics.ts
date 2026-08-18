/**
 * A-2: seed sintético para tabela llm_operations.
 *
 * Uso: ENABLE_LLM_METRICS=true npx tsx scripts/seed-llm-metrics.ts
 */

import { llmMetricsCollector } from '../server/services/llm-metrics-collector';
import { logger } from '../server/utils/logger';

async function main() {
  if (process.env.ENABLE_LLM_METRICS !== 'true') {
    logger.warn('A-2: ENABLE_LLM_METRICS não está true. Seed abortado.');
    process.exit(1);
  }

  await llmMetricsCollector.seedSyntheticData();
  const summary = await llmMetricsCollector.getSummary();
  logger.info('A-2: seed concluído', { summary });
}

main().catch((err) => {
  logger.error('A-2: erro no seed', { error: err });
  process.exit(1);
});
