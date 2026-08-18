import { describe, expect, it } from 'vitest';

import * as schemaSqlite from '@shared/schema';
import { detectDeployedDrift, validateSchemaSync } from '../../server/services/schema-health-check';

function deployedFromSchema(): Map<string, Set<string>> {
  // Constrói a metadata "implantada" perfeita a partir do próprio schema.
  const map = new Map<string, Set<string>>();
  for (const value of Object.values(schemaSqlite as Record<string, unknown>)) {
    const table = value as object;
    if (!table || typeof table !== 'object') continue;
    const symbols = Object.getOwnPropertySymbols(table);
    const nameSym = symbols.find((s) => s.description === 'drizzle:Name');
    const colsSym = symbols.find((s) => s.description === 'drizzle:Columns');
    if (!nameSym || !colsSym) continue;
    const tableName = (table as unknown as Record<symbol, string>)[nameSym];
    const columns = (table as unknown as Record<symbol, Record<string, { name?: string }>>)[
      colsSym
    ];
    if (!columns || Object.keys(columns).length === 0) continue;
    map.set(
      tableName,
      new Set(
        Object.values(columns)
          .map((c) => c.name)
          .filter((n): n is string => typeof n === 'string'),
      ),
    );
  }
  return map;
}

describe('Schema health real (spec 016 B3 / H-12)', () => {
  it('FR-009: a validação estática cobre demandExternalDocs (lista auto-derivada)', () => {
    const result = validateSchemaSync();
    expect(result.isValid).toBe(true);
  });

  it('US3-AS1: banco completo → zero drift', () => {
    const deployed = deployedFromSchema();
    expect(detectDeployedDrift(schemaSqlite as Record<string, unknown>, deployed)).toEqual([]);
  });

  it('SC-004/US3-AS2: coluna ausente é detectada com o drift específico', () => {
    const deployed = deployedFromSchema();
    deployed.get('demands')!.delete('tdd_url');
    const drift = detectDeployedDrift(schemaSqlite as Record<string, unknown>, deployed);
    expect(drift).toContainEqual({ table: 'demands', column: 'tdd_url', issue: 'column_missing' });
  });

  it('SC-004: tabela ausente é detectada', () => {
    const deployed = deployedFromSchema();
    deployed.delete('demand_external_docs');
    const drift = detectDeployedDrift(schemaSqlite as Record<string, unknown>, deployed);
    expect(drift).toContainEqual({
      table: 'demand_external_docs',
      column: '*',
      issue: 'table_missing',
    });
  });
});
