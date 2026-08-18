/**
 * Demanda #10136 — Incremento 1/2: gera spec registry (Markdown + CSV)
 * a partir de rotas, services e schemas.
 *
 * Critérios de maturidade (automatizados, aproximados):
 * - madura: rota importa service + existe arquivo de teste vinculado
 * - implementada: rota importa service, mas sem teste identificado
 * - utilitaria: rota sem service (health, admin puro, etc.)
 * - orfao: service nao importado por nenhuma rota
 * - backlog: schema declarado sem referencia em service/rota
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');
const SERVICES_DIR = path.join(ROOT, 'server', 'services');
const SCHEMA_FILES = [
  path.join(ROOT, 'shared', 'schema.ts'),
  path.join(ROOT, 'shared', 'schema-pg.ts'),
  path.join(ROOT, 'shared', 'schema-unified.ts'),
];
const TESTS_DIR = path.join(ROOT, 'tests');
const OUTPUT_MD = path.join(ROOT, 'spec-registry.md');
const OUTPUT_CSV = path.join(ROOT, 'spec-registry.csv');

function readText(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(ext)) {
      out.push(path.join(e.parentPath ?? dir, e.name));
    }
  }
  return out;
}

function extractRoutes(source: string): Array<{ method: string; path: string; line: number }> {
  const routes: Array<{ method: string; path: string; line: number }> = [];
  const regex = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\r\n]+)['"`]/gis;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    const p = m[2];
    const line = source.slice(0, m.index).split('\n').length;
    routes.push({ method, path: p, line });
  }
  return routes;
}

function parseImportNames(importClause: string): string[] {
  return importClause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(/\s+as\s+/);
      if (parts.length === 2) return parts[1].trim();
      const parts2 = s.split(/\s+/);
      return parts2[parts2.length - 1].trim();
    });
}

function extractImports(source: string): Array<{ names: string[]; from: string }> {
  const imports: Array<{ names: string[]; from: string }> = [];
  const regex = /import\s+(?:(?:type\s+)?\{([^}]+)\}|(\w+))\s+from\s+['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    const named = m[1];
    const def = m[2];
    const from = m[3];
    if (named) {
      imports.push({ names: parseImportNames(named), from });
    } else if (def) {
      imports.push({ names: [def], from });
    }
  }
  return imports;
}

function serviceFileFromImport(from: string): string | null {
  const m = from.match(/\.\.\/services\/(?:index#)?(.+?)(?:\?.*)?$/);
  if (!m) return null;
  const base = m[1].replace(/\.js$/, '');
  return `${base}.ts`;
}

function schemaFileFromImport(from: string): string | null {
  if (from === '@shared/schema') return 'schema.ts';
  if (from === '@shared/schema-pg') return 'schema-pg.ts';
  if (from === '@shared/schema-unified') return 'schema-unified.ts';
  if (from.includes('/shared/schema')) return path.basename(from);
  return null;
}

function extractSchemas(source: string): string[] {
  const names: string[] = [];
  const regex = /export\s+const\s+(\w+)\s*=\s*(?:sqliteTable|pgTable)\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractExportedNames(source: string): string[] {
  const names: string[] = [];
  const regex =
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)|export\s+\{\s*([^}]+)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[1]) {
      names.push(m[1]);
    } else if (m[2]) {
      for (const raw of m[2].split(',')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+as\s+/);
        names.push(parts[parts.length - 1].trim());
      }
    }
  }
  return [...new Set(names)];
}

function listTestFiles(): string[] {
  if (!fs.existsSync(TESTS_DIR)) return [];
  return [...listFiles(TESTS_DIR, '.test.ts'), ...listFiles(TESTS_DIR, '.spec.ts')];
}

function hasTestFor(name: string, tests: string[]): boolean {
  const normalized = name.replace(/[-_]/g, '');
  return tests.some((t) => {
    const base = path
      .basename(t, '.test.ts')
      .replace(/[-_]/g, '')
      .replace(/\.spec$/, '');
    return base.includes(normalized) || normalized.includes(base);
  });
}

function main() {
  const routeFiles = listFiles(ROUTES_DIR, '.ts');
  const serviceFiles = listFiles(SERVICES_DIR, '.ts');
  const testFiles = listTestFiles();

  const services: Array<{
    file: string;
    relative: string;
    exports: string[];
    schemaImports: string[];
    routeReferences: string[];
  }> = [];

  for (const svcFile of serviceFiles) {
    const relative = path.relative(ROOT, svcFile).replace(/\\/g, '/');
    const src = readText(svcFile);
    const exports = extractExportedNames(src);
    const schemaImports: string[] = [];
    for (const imp of extractImports(src)) {
      const schema = schemaFileFromImport(imp.from);
      if (schema) schemaImports.push(...imp.names);
    }
    services.push({ file: svcFile, relative, exports, schemaImports, routeReferences: [] });
  }

  const schemas: Array<{ name: string; file: string; dialect: string; references: string[] }> = [];
  for (const schemaFile of SCHEMA_FILES) {
    if (!fs.existsSync(schemaFile)) continue;
    const src = readText(schemaFile);
    const base = path.basename(schemaFile);
    const dialect = base.includes('pg')
      ? 'postgres'
      : base.includes('unified')
        ? 'unified'
        : 'sqlite';
    for (const name of extractSchemas(src)) {
      schemas.push({ name, file: base, dialect, references: [] });
    }
  }

  const registryRows: Array<{
    feature: string;
    routeFile: string;
    method: string;
    path: string;
    services: string[];
    schemas: string[];
    tests: string[];
    maturity: string;
  }> = [];

  for (const routeFile of routeFiles) {
    const relative = path.relative(ROOT, routeFile).replace(/\\/g, '/');
    const feature = path.basename(routeFile, '.ts').replace('-routes', '').replace('-route', '');
    const src = readText(routeFile);
    const routes = extractRoutes(src);
    const imports = extractImports(src);

    const serviceImports: string[] = [];
    const schemaImports: string[] = [];
    for (const imp of imports) {
      const svcFile = serviceFileFromImport(imp.from);
      if (svcFile) {
        serviceImports.push(svcFile.replace(/\.ts$/, ''));
      }
      const schema = schemaFileFromImport(imp.from);
      if (schema) {
        schemaImports.push(...imp.names);
      }
    }

    for (const route of routes) {
      let maturity = 'implementada';
      if (serviceImports.length === 0) {
        maturity = 'utilitaria';
      } else if (serviceImports.some((s) => hasTestFor(s, testFiles))) {
        maturity = 'madura';
      }
      const matchedTests = testFiles.filter((t) => serviceImports.some((s) => hasTestFor(s, [t])));
      registryRows.push({
        feature,
        routeFile: relative,
        method: route.method,
        path: route.path,
        services: [...new Set(serviceImports)],
        schemas: [...new Set(schemaImports)],
        tests: matchedTests.map((t) => path.relative(ROOT, t).replace(/\\/g, '/')),
        maturity,
      });
    }
  }

  // orphan services
  const routeServiceSet = new Set<string>();
  for (const row of registryRows) {
    for (const s of row.services) routeServiceSet.add(s);
  }

  const orphanRows: Array<{ file: string; relative: string; exports: string[]; maturity: string }> =
    [];
  for (const svc of services) {
    const baseName = path.basename(svc.file, '.ts');
    if (!routeServiceSet.has(baseName)) {
      orphanRows.push({
        file: svc.file,
        relative: path.relative(ROOT, svc.file).replace(/\\/g, '/'),
        exports: svc.exports,
        maturity: 'orfa',
      });
    }
  }

  // schema references from services
  for (const svc of services) {
    for (const sName of svc.schemaImports) {
      const schema = schemas.find((sc) => sc.name === sName);
      if (schema) {
        schema.references.push(path.relative(ROOT, svc.file).replace(/\\/g, '/'));
      }
    }
  }
  for (const row of registryRows) {
    for (const sName of row.schemas) {
      const schema = schemas.find((sc) => sc.name === sName);
      if (schema && !schema.references.includes(row.routeFile)) {
        schema.references.push(row.routeFile);
      }
    }
  }

  // Build markdown
  const totalRoutes = registryRows.length;
  const matureCount = registryRows.filter((r) => r.maturity === 'madura').length;
  const utilityCount = registryRows.filter((r) => r.maturity === 'utilitaria').length;
  const orphanCount = orphanRows.length;
  const backlogSchemas = schemas.filter((s) => s.references.length === 0).length;

  const md: string[] = [];
  md.push('# Spec Registry — AiChatFlow1\n');
  md.push('Gerado automaticamente por `scripts/generate-spec-registry.ts`.');
  md.push(`Atualizado: ${new Date().toISOString()}\n`);
  md.push('## Resumo\n');
  md.push(`| Métrica | Valor |`);
  md.push(`| --- | --- |`);
  md.push(`| Rotas mapeadas | ${totalRoutes} |`);
  md.push(`| Rotas maduras | ${matureCount} |`);
  md.push(`| Rotas utilitárias | ${utilityCount} |`);
  md.push(`| Rotas implementadas (sem teste) | ${totalRoutes - matureCount - utilityCount} |`);
  md.push(`| Services órfãos | ${orphanCount} |`);
  md.push(`| Schemas sem referência | ${backlogSchemas} |\n`);

  md.push('## Rotas\n');
  md.push('| Feature | Rota | Método | Path | Services | Schemas | Testes | Maturidade |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of registryRows) {
    md.push(
      `| ${row.feature} | ${row.routeFile} | ${row.method} | ${row.path} | ${row.services.join(', ')} | ${row.schemas.join(', ')} | ${row.tests.length} | ${row.maturity} |`,
    );
  }

  md.push('\n## Services Órfãos (não importados por nenhuma rota)\n');
  md.push('| Arquivo | Exports |');
  md.push('| --- | --- |');
  if (orphanRows.length === 0) {
    md.push('| _nenhum_ | _nenhum_ |');
  } else {
    for (const o of orphanRows) {
      md.push(`| ${o.relative} | ${o.exports.join(', ')} |`);
    }
  }

  md.push('\n## Schemas\n');
  md.push('| Nome | Arquivo | Dialeto | Referenciado por |');
  md.push('| --- | --- | --- | --- |');
  for (const s of schemas) {
    const refs = s.references.length ? s.references.join(', ') : '_backlog_';
    md.push(`| ${s.name} | ${s.file} | ${s.dialect} | ${refs} |`);
  }

  fs.writeFileSync(OUTPUT_MD, md.join('\n') + '\n');

  // Build CSV
  const csv: string[] = [];
  csv.push('Feature,Rota,Metodo,Path,Services,Schemas,Testes,Maturidade');
  for (const row of registryRows) {
    csv.push(
      [
        row.feature,
        row.routeFile,
        row.method,
        row.path,
        row.services.join(';'),
        row.schemas.join(';'),
        row.tests.length,
        row.maturity,
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  csv.push('');
  csv.push('Services Orfaos');
  csv.push('Arquivo,Exports');
  for (const o of orphanRows) {
    csv.push(`"${o.relative}","${o.exports.join(';')}"`);
  }
  csv.push('');
  csv.push('Schemas');
  csv.push('Nome,Arquivo,Dialeto,Referencias');
  for (const s of schemas) {
    const refs = s.references.length ? s.references.join(';') : 'backlog';
    csv.push(`"${s.name}","${s.file}","${s.dialect}","${refs}"`);
  }
  fs.writeFileSync(OUTPUT_CSV, csv.join('\n') + '\n');

  console.log(
    `Spec registry gerado: ${OUTPUT_MD} (${registryRows.length} rotas, ${orphanRows.length} services orfaos, ${schemas.length} schemas)`,
  );
}

main();
