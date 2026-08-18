/**
 * Demanda 10091 — importa frameworks de Product Discovery de um clone LOCAL do
 * repositório PMframeworks para a tabela `pm_frameworks`.
 *
 * Sem GitHub API em runtime (decisão do PRD): o operador clona o repo e aponta
 * o caminho. Idempotente — reimportar atualiza por `slug`.
 *
 * Uso:
 *   git clone https://github.com/example-org/PMframeworks /tmp/PMframeworks
 *   npx tsx scripts/import-pmframeworks.ts /tmp/PMframeworks
 *
 * Convenção de leitura: cada framework é um arquivo `.md` na raiz ou em
 * subpastas; o slug vem do nome do arquivo (kebab-case), o nome do primeiro
 * heading `# ...` quando presente.
 */
import fs from 'node:fs';
import path from 'node:path';

import { pmFrameworksService } from '../server/services/pm-frameworks-service';

function collectMarkdown(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, acc);
    else if (entry.name.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main(): Promise<void> {
  const repoDir = process.argv[2];
  if (!repoDir) {
    console.error('Uso: npx tsx scripts/import-pmframeworks.ts <caminho-do-clone-PMframeworks>');
    process.exit(1);
  }
  if (!fs.existsSync(repoDir)) {
    console.error(`Diretório não encontrado: ${repoDir}`);
    process.exit(1);
  }

  const files = collectMarkdown(repoDir);
  if (files.length === 0) {
    console.error(`Nenhum .md encontrado em ${repoDir}`);
    process.exit(1);
  }

  let imported = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const base = path.basename(file, path.extname(file));
    const headingMatch = content.match(/^\s*#\s+(.+)$/m);
    const name = headingMatch ? headingMatch[1].trim() : base;
    const slug = slugify(base === 'README' ? path.basename(path.dirname(file)) : base);
    if (!slug) continue;

    // Primeira linha não-vazia após o heading vira descrição curta.
    const description =
      content
        .split('\n')
        .slice(headingMatch ? content.split('\n').indexOf(headingMatch[0]) + 1 : 0)
        .find((l) => l.trim() && !l.trim().startsWith('#'))
        ?.trim()
        .slice(0, 280) ?? null;

    await pmFrameworksService.upsert({ slug, name, content, description });
    imported += 1;
    console.log(`  ✓ ${slug} — ${name}`);
  }

  console.log(`\n${imported} framework(s) importado(s) de ${repoDir}.`);
}

main().catch((error) => {
  console.error('Falha na importação:', error);
  process.exit(1);
});
