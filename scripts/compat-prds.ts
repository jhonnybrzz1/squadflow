#!/usr/bin/env tsx
/**
 * Script para verificar compatibilidade entre PRDs e TDDs
 * Garante que PRDs técnicos tenham TDDs correspondentes quando necessário
 */

import { readdir } from 'fs/promises';
import { join } from 'path';

interface CompatibilityCheck {
  prd: string;
  hasTDD: boolean;
  tddFile?: string;
}

async function checkPRDCompatibility(): Promise<void> {
  const documentsDir = join(process.cwd(), 'documents');

  try {
    const files = await readdir(documentsDir);

    // Filtra PRDs técnicos (que geralmente precisam de TDD)
    const technicalPRDs = files.filter(
      (f: string) =>
        f.startsWith('PRD_') &&
        (f.toLowerCase().includes('tecnico') ||
          f.toLowerCase().includes('technical') ||
          f.toLowerCase().includes('tsd')),
    );

    // Filtra TDDs disponíveis
    const tddFiles = files.filter(
      (f: string) => f.startsWith('TDD_') || f.startsWith('Relatorio_TDD_'),
    );

    if (technicalPRDs.length === 0) {
      console.log('✅ Nenhum PRD técnico encontrado para verificar compatibilidade');
      process.exit(0);
    }

    console.log(`📋 Verificando compatibilidade de ${technicalPRDs.length} PRDs técnicos...\n`);

    const checks: CompatibilityCheck[] = [];

    for (const prd of technicalPRDs) {
      // Extrai identificador do PRD (número ou nome base)
      const prdMatch = prd.match(/PRD_(\d+)_/) || prd.match(/PRD_(.+?)\./);
      const prdId = prdMatch ? prdMatch[1] : null;

      // Procura TDD correspondente
      let hasTDD = false;
      let tddFile: string | undefined;

      if (prdId) {
        tddFile = tddFiles.find(
          (tdd: string) =>
            tdd.includes(`TDD_${prdId}_`) ||
            tdd.includes(`tdd-${prdId}`) ||
            tdd.toLowerCase().includes(prdId.toLowerCase()),
        );
        hasTDD = !!tddFile;
      }

      checks.push({
        prd,
        hasTDD,
        tddFile,
      });
    }

    // Exibe resultados
    const withoutTDD = checks.filter((c) => !c.hasTDD);
    const withTDD = checks.filter((c) => c.hasTDD);

    console.log(`✅ PRDs com TDD: ${withTDD.length}`);

    if (withoutTDD.length > 0) {
      console.log(`\n⚠️  PRDs técnicos sem TDD correspondente: ${withoutTDD.length}\n`);

      for (const check of withoutTDD) {
        console.log(`  ⚠️  ${check.prd}`);
      }

      console.log(
        '\n💡 Nota: PRDs técnicos geralmente devem ter um TDD (Technical Design Document) correspondente.',
      );
      console.log('   Isso não é um erro fatal, mas é uma boa prática.\n');

      // Não falha o CI, apenas avisa
      process.exit(0);
    } else {
      console.log('\n✅ Todos os PRDs técnicos têm TDDs correspondentes!');
      process.exit(0);
    }
  } catch (error) {
    console.error(
      '❌ Erro ao verificar compatibilidade:',
      error instanceof Error ? error.message : 'Erro desconhecido',
    );
    process.exit(1);
  }
}

// Executa verificação
checkPRDCompatibility();

// Made with Bob
