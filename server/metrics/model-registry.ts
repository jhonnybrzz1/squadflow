/**
 * Prometheus metrics for the Model Registry subsystem.
 *
 * Cardinality is controlled: labels use provider/family/status/source only.
 * Arbitrary modelId is NOT used as a label to avoid unbounded cardinality.
 */

import client from 'prom-client';
import { register } from '../metrics';

export const modelRegistryResolveTotal = new client.Counter({
  name: 'model_registry_resolve_total',
  help: 'Total model registry resolve() calls',
  labelNames: ['source', 'result'],
});

export const modelRegistryResolveDurationMs = new client.Histogram({
  name: 'model_registry_resolve_duration_ms',
  help: 'Duration of model registry resolve() in milliseconds',
  labelNames: ['source'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});

// No per-alias label: the resolve endpoint accepts arbitrary strings, so an
// alias label would give this counter unbounded Prometheus cardinality (PAR-03).
export const modelRegistryCacheHitTotal = new client.Counter({
  name: 'model_registry_cache_hit_total',
  help: 'Model registry memory cache hits',
});

export const modelRegistryCacheMissTotal = new client.Counter({
  name: 'model_registry_cache_miss_total',
  help: 'Model registry memory cache misses',
});

export const modelDiscoveryRunTotal = new client.Counter({
  name: 'model_discovery_run_total',
  help: 'Total discovery cycle runs',
  labelNames: ['result'],
});

export const modelDiscoveryCandidateTotal = new client.Counter({
  name: 'model_discovery_candidate_total',
  help: 'Total candidates discovered',
  labelNames: ['provider', 'family', 'status'],
});

export const modelDiscoveryFailureTotal = new client.Counter({
  name: 'model_discovery_failure_total',
  help: 'Total discovery failures by provider',
  labelNames: ['provider', 'reason'],
});

export const modelPromotionTotal = new client.Counter({
  name: 'model_promotion_total',
  help: 'Total model promotions',
  labelNames: ['provider', 'family', 'result'],
});

export const modelPromotionFailureTotal = new client.Counter({
  name: 'model_promotion_failure_total',
  help: 'Total model promotion failures',
  labelNames: ['provider', 'family', 'reason'],
});

export const modelRollbackTotal = new client.Counter({
  name: 'model_rollback_total',
  help: 'Total model rollbacks',
  labelNames: ['provider', 'family', 'trigger'],
});

export const modelValidationDurationMs = new client.Histogram({
  name: 'model_validation_duration_ms',
  help: 'Duration of model validation (smoke test) in milliseconds',
  labelNames: ['provider'],
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000],
});

export const modelProviderCatalogFetchTotal = new client.Counter({
  name: 'model_provider_catalog_fetch_total',
  help: 'Total provider catalog fetches',
  labelNames: ['provider', 'result'],
});

export const modelProviderCatalogFetchFailureTotal = new client.Counter({
  name: 'model_provider_catalog_fetch_failure_total',
  help: 'Total provider catalog fetch failures',
  labelNames: ['provider', 'reason'],
});

// Register all metrics
register.registerMetric(modelRegistryResolveTotal);
register.registerMetric(modelRegistryResolveDurationMs);
register.registerMetric(modelRegistryCacheHitTotal);
register.registerMetric(modelRegistryCacheMissTotal);
register.registerMetric(modelDiscoveryRunTotal);
register.registerMetric(modelDiscoveryCandidateTotal);
register.registerMetric(modelDiscoveryFailureTotal);
register.registerMetric(modelPromotionTotal);
register.registerMetric(modelPromotionFailureTotal);
register.registerMetric(modelRollbackTotal);
register.registerMetric(modelValidationDurationMs);
register.registerMetric(modelProviderCatalogFetchTotal);
register.registerMetric(modelProviderCatalogFetchFailureTotal);
