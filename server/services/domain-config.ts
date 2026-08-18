/**
 * M-3: Configuração dinâmica de domínios RAG especializados.
 *
 * - domains.json na raiz define domínios com campos extensíveis.
 * - Fail-fast na inicialização se o JSON estiver ausente/malformado.
 * - Atomic swap: reloadDomains() substitui a referência sem mutar o snapshot anterior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOMAINS_PATH = path.resolve(__dirname, '../../domains.json');

const domainSchema = z.object({
  name: z.string().min(1),
  embeddingModel: z.string().optional(),
  hybridWeight: z.number().min(0).max(1).optional(),
  chunkConfig: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      overlap: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const domainsFileSchema = z.array(domainSchema);

export type DomainConfig = z.infer<typeof domainSchema>;

interface LoadedConfig {
  domains: DomainConfig[];
  domainMap: Map<string, DomainConfig>;
  loadedAt: number;
}

function loadAndValidate(): LoadedConfig {
  let raw: unknown;

  try {
    const content = fs.readFileSync(DOMAINS_PATH, 'utf-8');
    raw = JSON.parse(content);
  } catch (error) {
    logger.error('M-3: domains.json ausente ou malformado — fail-fast', {
      error: error instanceof Error ? error : undefined,
      context: { path: DOMAINS_PATH },
    });
    throw new Error(`M-3: Não foi possível carregar domains.json em ${DOMAINS_PATH}`);
  }

  const parsed = domainsFileSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('M-3: schema inválido em domains.json — fail-fast', {
      error: parsed.error,
      context: { path: DOMAINS_PATH },
    });
    throw new Error(`M-3: Schema inválido em domains.json: ${parsed.error.message}`);
  }

  const domains = parsed.data;
  const domainMap = new Map<string, DomainConfig>();
  for (const domain of domains) {
    if (domainMap.has(domain.name)) {
      logger.warn('M-3: domínio duplicado em domains.json; entrada posterior ignorada', {
        context: { domain: domain.name },
      });
      continue;
    }
    domainMap.set(domain.name, domain);
  }

  logger.info('M-3: domains.json carregado', {
    context: { path: DOMAINS_PATH, count: domains.length, domains: domains.map((d) => d.name) },
  });

  return { domains, domainMap, loadedAt: Date.now() };
}

// Referência atômica — queries em andamento mantêm o snapshot que leram.
let currentConfig: LoadedConfig = loadAndValidate();

export function getDomains(): DomainConfig[] {
  return currentConfig.domains;
}

export function getDomainByName(name: string): DomainConfig | undefined {
  return currentConfig.domainMap.get(name);
}

export function isSpecializedDomain(name: string | null | undefined): boolean {
  return typeof name === 'string' && currentConfig.domainMap.has(name);
}

export function reloadDomains(): LoadedConfig {
  const previous = currentConfig;
  const next = loadAndValidate();
  currentConfig = next;

  logger.info('M-3: domains.json recarregado via atomic swap', {
    context: {
      previousLoadedAt: previous.loadedAt,
      nextLoadedAt: next.loadedAt,
      previous: previous.domains.map((d) => d.name),
      next: next.domains.map((d) => d.name),
    },
  });

  return next;
}

export function getDomainsLoadedAt(): number {
  return currentConfig.loadedAt;
}

// Expor caminho para testes
export { DOMAINS_PATH };
