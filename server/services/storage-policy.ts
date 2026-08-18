/**
 * Spec 016 B1 (M-08): a resolução vive em shared/database-policy.ts — fonte
 * única entre adapter, schema ativo e storage. Este módulo apenas reexporta
 * para manter a superfície pública existente.
 */
export {
  resolveDatabasePolicy,
  type DatabaseDialect,
  type DatabasePolicy,
  type StorageKind,
} from '@shared/database-policy';
