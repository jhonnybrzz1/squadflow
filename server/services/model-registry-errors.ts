/**
 * Typed errors for the Model Registry subsystem.
 *
 * The project does not have a single shared error hierarchy, so these errors
 * follow the same pattern as `ModelGovernanceError` (named class + code +
 * details) for consistency.
 */

export class UnknownModelAliasError extends Error {
  public code = 'UNKNOWN_MODEL_ALIAS' as const;
  public details: Record<string, unknown>;

  constructor(aliasOrId: string, details: Record<string, unknown> = {}) {
    super(`Unknown model alias or id: ${aliasOrId}`);
    this.name = 'UnknownModelAliasError';
    this.details = { aliasOrId, ...details };
  }
}

export class ModelNotAllowedError extends Error {
  public code = 'MODEL_NOT_ALLOWED' as const;
  public details: Record<string, unknown>;

  constructor(modelId: string, details: Record<string, unknown> = {}) {
    super(`Model not allowed by governance: ${modelId}`);
    this.name = 'ModelNotAllowedError';
    this.details = { modelId, ...details };
  }
}

export class ModelRegistryUnavailableError extends Error {
  public code = 'MODEL_REGISTRY_UNAVAILABLE' as const;
  public details: Record<string, unknown>;

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(`Model registry unavailable: ${reason}`);
    this.name = 'ModelRegistryUnavailableError';
    this.details = { reason, ...details };
  }
}

export class ModelValidationError extends Error {
  public code = 'MODEL_VALIDATION_FAILED' as const;
  public details: Record<string, unknown>;

  constructor(modelId: string, reason: string, details: Record<string, unknown> = {}) {
    super(`Model validation failed for ${modelId}: ${reason}`);
    this.name = 'ModelValidationError';
    this.details = { modelId, reason, ...details };
  }
}

export type ModelRegistryError =
  | UnknownModelAliasError
  | ModelNotAllowedError
  | ModelRegistryUnavailableError
  | ModelValidationError;
