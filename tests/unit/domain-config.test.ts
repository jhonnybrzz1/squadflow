import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DOMAINS_PATH = path.resolve(__dirname, '../../domains.json');

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Esvaziar o cache de módulos antes de cada teste para reinicializar o domain-config
const reloadModule = async () => {
  const mod = await import('../../server/services/domain-config');
  return mod;
};

describe('M-3: domain-config', () => {
  const originalContent = fs.existsSync(TEST_DOMAINS_PATH)
    ? fs.readFileSync(TEST_DOMAINS_PATH, 'utf-8')
    : '[]';

  beforeEach(() => {
    fs.writeFileSync(
      TEST_DOMAINS_PATH,
      JSON.stringify([
        {
          name: 'legaltech_lgpd',
          embeddingModel: 'text-embedding-3-small',
          hybridWeight: 0.5,
          chunkConfig: { maxTokens: 512, overlap: 50 },
        },
        { name: 'fintech_cambio' },
      ]),
      'utf-8',
    );
    vi.resetModules();
  });

  afterEach(() => {
    fs.writeFileSync(TEST_DOMAINS_PATH, originalContent, 'utf-8');
    vi.resetModules();
  });

  it('carrega domínios no startup e permite busca por nome', async () => {
    const { getDomainByName, getDomains, isSpecializedDomain } = await reloadModule();
    expect(getDomains().length).toBeGreaterThanOrEqual(1);
    expect(getDomainByName('legaltech_lgpd')).toBeDefined();
    expect(getDomainByName('inexistente')).toBeUndefined();
    expect(isSpecializedDomain('legaltech_lgpd')).toBe(true);
    expect(isSpecializedDomain('inexistente')).toBe(false);
  });

  it('reloadDomains faz swap atômico e reflete novo domínio', async () => {
    const { getDomainByName, reloadDomains, getDomainsLoadedAt } = await reloadModule();

    const firstLoadedAt = getDomainsLoadedAt();

    fs.writeFileSync(
      TEST_DOMAINS_PATH,
      JSON.stringify([{ name: 'legaltech_lgpd' }, { name: 'healthcare_hipaa' }]),
      'utf-8',
    );

    const next = reloadDomains();
    expect(getDomainByName('healthcare_hipaa')).toBeDefined();
    expect(next.loadedAt).toBeGreaterThanOrEqual(firstLoadedAt);
  });

  it('falha rápido (fail-fast) com JSON malformado', async () => {
    fs.writeFileSync(TEST_DOMAINS_PATH, '{invalid json}', 'utf-8');
    await expect(reloadModule()).rejects.toThrow();
  });
});
