#!/usr/bin/env tsx
/**
 * M-1: valida todos os arquivos YAML em `agents/` contra `agentSchema`.
 *
 * Uso:
 *   tsx scripts/validate-agents.ts
 *   npm run validate-agents
 *
 * Regras:
 * - YAML malformado falha no parser com mensagem clara.
 * - Schema inválido falha com `arquivo.yaml → campo: esperado X, obtido Y`.
 * - Exit code ≠0 se houver qualquer erro.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { agentSchema } from './agent-schema';
import { logger } from '../server/utils/logger';

const AGENTS_DIR = path.resolve(process.cwd(), 'agents');

interface ValidationError {
  file: string;
  message: string;
}

function describeIssue(
  path: string,
  issue: { message: string; expected?: string; received?: string },
): string {
  const parts: string[] = [path, ':'];
  if (issue.expected) {
    parts.push(`esperado ${issue.expected}`);
    if (issue.received !== undefined) {
      parts.push(`, obtido ${JSON.stringify(issue.received)}`);
    }
  } else {
    parts.push(issue.message);
  }
  return parts.join('').trim();
}

function formatZodError(
  file: string,
  error: {
    issues: Array<{
      path: (string | number)[];
      message: string;
      expected?: string;
      received?: unknown;
    }>;
  },
): ValidationError[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'root';
    const expected = issue.expected;
    const received = issue.received;
    const message = describeIssue(path, {
      message: issue.message,
      expected,
      received,
    });
    return { file, message: `${file} → ${message}` };
  });
}

export async function validateAgents(dir = AGENTS_DIR): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  if (!fs.existsSync(dir)) {
    return [{ file: dir, message: `Diretório não encontrado: ${dir}` }];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  for (const file of files) {
    const filePath = path.join(dir, file);
    let parsed: unknown;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      parsed = yaml.load(content);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      errors.push({ file, message: `${file} → YAML malformado: ${message}` });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object') {
      errors.push({ file, message: `${file} → YAML inválido: raiz não é um objeto` });
      continue;
    }

    const result = agentSchema.safeParse(parsed);
    if (!result.success) {
      const zodErrors = result.error;
      errors.push(...formatZodError(file, zodErrors));
    }
  }

  return errors;
}

async function main() {
  const errors = await validateAgents();

  if (errors.length === 0) {
    logger.info('M-1: todos os agentes YAML estão válidos.');
    process.exit(0);
  }

  for (const err of errors) {
    logger.error(`M-1: erro de validação de agente`, {
      context: { file: err.file, message: err.message },
    });
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error('M-1: falha inesperada na validação', {
      error: error instanceof Error ? error : undefined,
    });
    process.exit(1);
  });
}
