/**
 * Demanda 10037 / ADR-0002 — guarda da decisão de arquitetura.
 *
 * A renderização Mermaid acontece no cliente justamente para não trazer um
 * browser headless para o servidor. Este teste é o sinal de violação: se
 * `puppeteer` ou `@mermaid-js/mermaid-cli` aparecerem nas dependências de
 * produção, a decisão foi revertida sem passar pelo ADR.
 *
 * Se a reversão for intencional, atualize `docs/adr/0002-render-mermaid-no-cliente.md`
 * (status → superseded) antes de mexer aqui.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HEADLESS_BROWSER_PACKAGES = [
  'puppeteer',
  'puppeteer-core',
  '@mermaid-js/mermaid-cli',
  'playwright',
  'playwright-core',
];

const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('ADR-0002 — nenhum browser headless em produção', () => {
  it.each(HEADLESS_BROWSER_PACKAGES)('não declara %s em dependencies', (pkg) => {
    expect(Object.keys(packageJson.dependencies)).not.toContain(pkg);
  });

  it('mantém o mermaid como dependência (renderização no cliente)', () => {
    expect(packageJson.dependencies).toHaveProperty('mermaid');
  });

  it('o gerador do servidor não importa mermaid nem browser', () => {
    const source = readFileSync(
      resolve(__dirname, '../../server/services/artifact-flowchart.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/from\s+['"]mermaid['"]/);
    expect(source).not.toMatch(/from\s+['"]puppeteer/);
    expect(source).not.toMatch(/from\s+['"]playwright/);
  });

  it('o mermaid entra no cliente por import dinâmico, fora do entry chunk', () => {
    const source = readFileSync(
      resolve(__dirname, '../../client/src/components/flowchart-artifact.tsx'),
      'utf8',
    );

    expect(source).toMatch(/await import\(['"]mermaid['"]\)/);
    expect(source).not.toMatch(/^import .* from ['"]mermaid['"]/m);
  });
});
