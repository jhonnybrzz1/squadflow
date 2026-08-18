/**
 * Utilitário de Deep Compare para Testes de Regressão
 * Implementa comparação profunda de objetos ignorando campos voláteis
 * como timestamps, IDs auto-gerados e UUIDs.
 */

const VOLATILE_FIELDS = new Set([
  'id',
  'timestamp',
  'createdAt',
  'updatedAt',
  'requestId',
  'executionId',
  'duration',
  'version',
  'agentMessageId',
]);

/**
 * Compara dois objetos ignorando os campos voláteis.
 * Útil para garantir que refatorações não alteraram o contrato semântico.
 */
export function deepCompareIgnoreVolatile(obj1: any, obj2: any): boolean {
  if (obj1 === obj2) return true;

  if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
    return false;
  }

  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) return false;
    return obj1.every((val, index) => deepCompareIgnoreVolatile(val, obj2[index]));
  }

  const keys1 = Object.keys(obj1).filter((k) => !VOLATILE_FIELDS.has(k));
  const keys2 = Object.keys(obj2).filter((k) => !VOLATILE_FIELDS.has(k));

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key)) return false;
    if (!deepCompareIgnoreVolatile(obj1[key], obj2[key])) return false;
  }

  return true;
}

/**
 * Remove os campos voláteis de um objeto, retornando um novo objeto clonado
 * sem essas propriedades. Ideal para testes de snapshot.
 */
export function stripVolatileFields(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj.map(stripVolatileFields);
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!VOLATILE_FIELDS.has(key)) {
      result[key] = stripVolatileFields(value);
    }
  }

  return result;
}
