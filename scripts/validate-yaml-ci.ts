#!/usr/bin/env tsx
/**
 * CI gate: valida arquivos YAML de configuração de agentes/RAG e proíbe
 * referências mortas como `product_roles_rag_entries`.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const agentSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  model_fallback: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  system_prompt: z.string().min(1).optional(),
});

const FORBIDDEN_PATTERNS = ['product_roles_rag_entries'];

const YAML_DIRS = ['agents', 'config'];

function walkSync(dir: string, pattern: RegExp, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSync(fullPath, pattern, out);
    } else if (entry.isFile() && pattern.test(fullPath)) {
      out.push(fullPath);
    }
  }
}

function findYamlFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const resolved = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(resolved)) continue;
    walkSync(resolved, /\.(yaml|yml)$/, files);
  }
  return files;
}

function validateYamlFile(filePath: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const content = fs.readFileSync(filePath, 'utf8');

  // Proíbe referências mortas em qualquer arquivo (não só YAML)
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (content.includes(pattern)) {
      errors.push(`Arquivo ${filePath} contém referência proibida: ${pattern}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    errors.push(
      `Erro ao fazer parse de ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: errors.length === 0, errors };
  }

  if (!parsed || typeof parsed !== 'object') {
    errors.push(`Arquivo ${filePath} não contém um objeto YAML válido`);
    return { ok: false, errors };
  }

  const result = agentSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${filePath}: ${issue.path.join('.')} — ${issue.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs)$/;

function findSourceFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const resolved = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(resolved)) continue;
    walkSync(resolved, SOURCE_EXTENSIONS, files);
  }
  return files;
}

const SOURCE_IGNORE_PATTERNS = [/scripts\/validate-yaml-ci\.ts$/];

function validateSourceCode(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const sourceDirs = ['server', 'shared', 'client/src', 'scripts'];
  const files = findSourceFiles(sourceDirs).filter(
    (f) => !SOURCE_IGNORE_PATTERNS.some((p) => p.test(f)),
  );
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (content.includes(pattern)) {
        errors.push(`Arquivo de código ${file} contém referência proibida: ${pattern}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  const allErrors: string[] = [];

  const sourceResult = validateSourceCode();
  allErrors.push(...sourceResult.errors);

  const yamlFiles = findYamlFiles(YAML_DIRS);
  if (yamlFiles.length === 0) {
    allErrors.push('Nenhum arquivo YAML encontrado para validação');
  }

  for (const file of yamlFiles) {
    const result = validateYamlFile(file);
    allErrors.push(...result.errors);
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) {
      console.error(`❌ ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `✅ Todos os ${yamlFiles.length} arquivos YAML e o código-fonte passaram na validação.`,
  );
}

main();
