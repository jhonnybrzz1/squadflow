#!/usr/bin/env tsx
/**
 * Script para validar arquivos PRD no diretório documents/
 * Verifica se os arquivos seguem o padrão esperado e não estão corrompidos
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  skipped?: boolean;
}

async function validatePRDFile(filePath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const fileName = filePath.split('/').pop() || '';

  // Ignora arquivos de versão (v1, v2, v3, etc.) que são apenas marcadores
  if (/_v\d+\.md$/.test(fileName)) {
    return { file: fileName, valid: true, errors: [], skipped: true };
  }

  try {
    // Verifica se o arquivo existe e é legível
    const stats = await stat(filePath);

    if (!stats.isFile()) {
      errors.push('Não é um arquivo válido');
      return { file: fileName, valid: false, errors };
    }

    // Verifica tamanho do arquivo (não deve estar vazio)
    if (stats.size === 0) {
      errors.push('Arquivo vazio');
      return { file: fileName, valid: false, errors };
    }

    // Para arquivos de texto (.md, .txt), verifica conteúdo básico
    if (fileName.endsWith('.md') || fileName.endsWith('.txt')) {
      const content = await readFile(filePath, 'utf-8');

      if (content.trim().length === 0) {
        errors.push('Conteúdo vazio');
      }

      // Verifica se tem pelo menos algum conteúdo significativo (reduzido para 10 caracteres)
      if (content.trim().length < 10) {
        errors.push('Conteúdo muito curto (menos de 10 caracteres)');
      }
    }

    // Para PDFs, apenas verifica se não está corrompido (tamanho mínimo)
    if (fileName.endsWith('.pdf')) {
      if (stats.size < 100) {
        errors.push('PDF possivelmente corrompido (tamanho muito pequeno)');
      }
    }
  } catch (error) {
    errors.push(
      `Erro ao ler arquivo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
    );
  }

  return {
    file: fileName,
    valid: errors.length === 0,
    errors,
  };
}

async function validateAllPRDs(): Promise<void> {
  const documentsDir = join(process.cwd(), 'documents');

  try {
    const files = await readdir(documentsDir);
    const prdFiles = files.filter(
      (f) =>
        f.startsWith('PRD_') ||
        f.startsWith('TDD_') ||
        f.startsWith('Tasks_') ||
        f.startsWith('Relatorio_'),
    );

    if (prdFiles.length === 0) {
      console.log('✅ Nenhum arquivo PRD encontrado para validar');
      process.exit(0);
    }

    console.log(`📋 Validando ${prdFiles.length} arquivos PRD...\n`);

    const results: ValidationResult[] = [];

    for (const file of prdFiles) {
      const filePath = join(documentsDir, file);
      const result = await validatePRDFile(filePath);
      results.push(result);
    }

    // Exibe resultados
    const invalidFiles = results.filter((r) => !r.valid);
    const validFiles = results.filter((r) => r.valid);

    console.log(`✅ Arquivos válidos: ${validFiles.length}`);

    if (invalidFiles.length > 0) {
      console.log(`\n❌ Arquivos com problemas: ${invalidFiles.length}\n`);

      for (const result of invalidFiles) {
        console.log(`  ❌ ${result.file}`);
        result.errors.forEach((err) => console.log(`     - ${err}`));
        console.log('');
      }

      process.exit(1);
    } else {
      console.log('\n✅ Todos os arquivos PRD são válidos!');
      process.exit(0);
    }
  } catch (error) {
    console.error(
      '❌ Erro ao validar PRDs:',
      error instanceof Error ? error.message : 'Erro desconhecido',
    );
    process.exit(1);
  }
}

// Executa validação
validateAllPRDs();

// Made with Bob
