import { resolvePath, projectRoot } from '@shared/utils/paths';
/**
 * DevOps Tools
 *
 * Ferramentas para o agente DevOps revisar infraestrutura e segurança
 * operacional sem propor overengineering.
 *
 * Tools:
 * - check_security_headers: Verifica configurações de segurança básicas
 * - check_exposed_secrets: Busca padrões de segredos no código
 * - check_outdated_dependencies: Verifica dependências no package.json
 * - validate_deploy_config: Valida presença e integridade de Dockerfile/docker-compose
 */
import { z } from 'zod';
import { defineTool, registerTool, type ToolResult } from './agent-tools-registry';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const AGENT_NAME = 'devops';

// ============================================================
// Tool 1: check_security_headers
// ============================================================

const checkSecurityHeadersSchema = z.object({
  repoFullName: z
    .string()
    .describe('Nome completo do repositório (owner/repo) — usado apenas para contexto'),
});

const checkSecurityHeadersTool = defineTool({
  name: 'check_security_headers',
  description:
    'Verifica se o projeto menciona headers de segurança (helmet, CORS, rate limit) em arquivos de configuração. Útil para identificar riscos operacionais rápidos.',
  agentAccess: [AGENT_NAME, 'security_specialist'],
  inputSchema: checkSecurityHeadersSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const cwd = projectRoot;
      const filesToCheck = [
        'server/index.ts',
        'server/app.ts',
        'server/server.ts',
        'server/middleware/security.ts',
      ];
      const found: string[] = [];
      const missing: string[] = [];

      for (const file of filesToCheck) {
        const fullPath = path.join(cwd, file);
        if (fs.existsSync(fullPath)) {
          found.push(file);
        } else {
          missing.push(file);
        }
      }

      const securityPatterns = [
        'helmet',
        'cors',
        'rateLimit',
        'rate-limit',
        'contentSecurityPolicy',
      ];
      const matches: string[] = [];

      for (const file of found) {
        const content = fs.readFileSync(path.join(cwd, file), 'utf8').toLowerCase();
        for (const pattern of securityPatterns) {
          if (content.includes(pattern.toLowerCase())) {
            matches.push(`${file}: ${pattern}`);
          }
        }
      }

      return {
        ok: true,
        data: {
          checkedFiles: found,
          missingFiles: missing,
          securityPatternsFound: matches,
          recommendation:
            matches.length === 0
              ? 'Nenhum header de segurança identificado — avaliar adição de helmet/cors/rate-limit.'
              : 'Headers de segurança parcialmente identificados — revisar cobertura.',
        },
        source: 'check_security_headers',
      };
    } catch (err) {
      logger.error('check_security_headers falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'check_security_headers',
      };
    }
  },
});

// ============================================================
// Tool 2: check_exposed_secrets
// ============================================================

const checkExposedSecretsSchema = z.object({
  repoFullName: z
    .string()
    .describe('Nome completo do repositório (owner/repo) — usado apenas para contexto'),
});

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Private Key', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'API Key genérica', regex: /['"]api[_-]?key['"]\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { name: 'Password literal', regex: /['"]password['"]\s*[:=]\s*['"][^'"]{8,}['"]/gi },
];

const checkExposedSecretsTool = defineTool({
  name: 'check_exposed_secrets',
  description:
    'Escaneia arquivos do repositório local em busca de padrões comuns de segredos expostos. Não substitui secret scanning real — é uma verificação rápida para o agente.',
  agentAccess: [AGENT_NAME, 'security_specialist'],
  inputSchema: checkExposedSecretsSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const cwd = projectRoot;
      const scanDirs = ['server', 'client', 'config'];
      const results: Array<{ file: string; pattern: string; count: number }> = [];

      for (const dir of scanDirs) {
        const fullDir = path.join(cwd, dir);
        if (!fs.existsSync(fullDir)) continue;

        const entries = fs.readdirSync(fullDir, { recursive: true }) as string[];
        for (const entry of entries) {
          const filePath = path.join(fullDir, entry);
          if (!fs.statSync(filePath).isFile()) continue;
          if (filePath.includes('node_modules') || filePath.endsWith('.test.ts')) continue;

          const content = fs.readFileSync(filePath, 'utf8');
          for (const { name, regex } of SECRET_PATTERNS) {
            const matches = content.match(regex);
            if (matches && matches.length > 0) {
              results.push({
                file: path.relative(cwd, filePath),
                pattern: name,
                count: matches.length,
              });
            }
          }
        }
      }

      return {
        ok: true,
        data: {
          scannedDirs: scanDirs,
          findings: results,
          riskLevel: results.length === 0 ? 'low' : results.length > 3 ? 'high' : 'medium',
          recommendation:
            results.length === 0
              ? 'Nenhum padrão de segredo identificado.'
              : 'Possíveis segredos identificados — revisar manualmente e remover do histórico se confirmado.',
        },
        source: 'check_exposed_secrets',
      };
    } catch (err) {
      logger.error('check_exposed_secrets falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'check_exposed_secrets',
      };
    }
  },
});

// ============================================================
// Tool 3: check_outdated_dependencies
// ============================================================

const checkOutdatedDependenciesSchema = z.object({
  repoFullName: z
    .string()
    .describe('Nome completo do repositório (owner/repo) — usado apenas para contexto'),
});

const checkOutdatedDependenciesTool = defineTool({
  name: 'check_outdated_dependencies',
  description:
    'Lê o package.json do projeto e lista dependências com potencial de desatualização (versões fixadas ou com major zero). Não executa npm outdated.',
  agentAccess: [AGENT_NAME, 'security_specialist', 'tech_lead'],
  inputSchema: checkOutdatedDependenciesSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const packagePath = resolvePath('package.json');
      if (!fs.existsSync(packagePath)) {
        return {
          ok: true,
          data: { found: false, note: 'package.json não encontrado' },
          source: 'check_outdated_dependencies',
        };
      }

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const suspicious: Array<{ name: string; version: string; reason: string }> = [];

      for (const [name, versionRaw] of Object.entries(deps)) {
        const version = String(versionRaw);
        if (version.startsWith('^0.') || version.startsWith('~0.')) {
          suspicious.push({ name, version, reason: 'Major zero — API instável' });
        } else if (version.includes('x') || version.includes('*')) {
          suspicious.push({ name, version, reason: 'Versão flexível — risco de breaking change' });
        }
      }

      return {
        ok: true,
        data: {
          found: true,
          totalDependencies: Object.keys(deps).length,
          suspicious,
          recommendation:
            suspicious.length === 0
              ? 'Nenhuma dependência com sinal de desatualização identificado.'
              : `${suspicious.length} dependência(s) com sinal de atenção — revisar major zero ou versões flexíveis.`,
        },
        source: 'check_outdated_dependencies',
      };
    } catch (err) {
      logger.error('check_outdated_dependencies falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'check_outdated_dependencies',
      };
    }
  },
});

// ============================================================
// Tool 4: validate_deploy_config
// ============================================================

const validateDeployConfigSchema = z.object({
  repoFullName: z
    .string()
    .describe('Nome completo do repositório (owner/repo) — usado apenas para contexto'),
});

const validateDeployConfigTool = defineTool({
  name: 'validate_deploy_config',
  description:
    'Verifica a presença de arquivos de deploy (Dockerfile, docker-compose, .env.example) e sinaliza ausências.',
  agentAccess: [AGENT_NAME, 'tech_lead'],
  inputSchema: validateDeployConfigSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const cwd = projectRoot;
      const expectedFiles = [
        'Dockerfile',
        'docker-compose.yml',
        'docker-compose.yaml',
        '.env.example',
      ];
      const present: string[] = [];
      const missing: string[] = [];

      for (const file of expectedFiles) {
        if (fs.existsSync(path.join(cwd, file))) {
          present.push(file);
        } else {
          missing.push(file);
        }
      }

      return {
        ok: true,
        data: {
          present,
          missing,
          isDeployReady:
            present.includes('Dockerfile') && present.some((f) => f.startsWith('docker-compose')),
          recommendation:
            missing.length === 0
              ? 'Arquivos de deploy presentes.'
              : `Arquivos ausentes: ${missing.join(', ')} — avaliar necessidade para deploy.`,
        },
        source: 'validate_deploy_config',
      };
    } catch (err) {
      logger.error('validate_deploy_config falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'validate_deploy_config',
      };
    }
  },
});

// ============================================================
// Registro
// ============================================================

export function registerDevOpsTools(): void {
  registerTool(checkSecurityHeadersTool);
  registerTool(checkExposedSecretsTool);
  registerTool(checkOutdatedDependenciesTool);
  registerTool(validateDeployConfigTool);
}
