/**
 * Demanda 10091 — seed LOCAL do catálogo de Discovery.
 *
 * Importa o que já existe no próprio repositório, sem depender do clone do
 * PMframeworks:
 *   • os frameworks documentados em `FRAMEWORKS.md` (uma entrada por seção `### N.`)
 *   • os relatórios da raiz (AICHATFLOW1_*, CODEBASE_AUDIT_*, MODEL_REGISTRY_*)
 *
 * É um SEED, não substituto do PMframeworks — que tem muito mais frameworks.
 * Quando o clone existir, `import-pmframeworks.ts` complementa este catálogo
 * (upsert por slug, então rodar os dois não duplica).
 *
 * Uso: npx tsx scripts/seed-local-frameworks.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { pmFrameworksService } from '../server/services/pm-frameworks-service';

// ESM: sem __dirname — o script roda a partir da raiz do projeto.
const ROOT = process.cwd();

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Quebra o FRAMEWORKS.md em uma entrada por seção `### N. Título`. */
function parseFrameworksDoc(): Array<{
  slug: string;
  name: string;
  content: string;
  description: string | null;
}> {
  const file = path.join(ROOT, 'FRAMEWORKS.md');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^###\s+\d+\.\s+/.test(l)) starts.push(i);
  });

  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    const name = lines[start].replace(/^###\s+\d+\.\s+/, '').trim();
    // "**Best for:** ..." ou a primeira linha de prosa vira a descrição curta.
    const bestFor = body.match(/\*\*Best for:\*\*\s*(.+)/i)?.[1];
    const description =
      bestFor ?? body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? null;
    return {
      slug: slugify(name),
      name,
      content: body,
      description: description ? description.trim().slice(0, 280) : null,
    };
  });
}

/** Relatórios versionados na raiz do projeto. */
function collectReports(): string[] {
  return fs
    .readdirSync(ROOT)
    .filter((f) => /^(AICHATFLOW1_|AiChatFlow1-|CODEBASE_AUDIT|MODEL_REGISTRY).*\.md$/i.test(f))
    .map((f) => path.join(ROOT, f));
}

async function main(): Promise<void> {
  let count = 0;

  const frameworks = parseFrameworksDoc();
  for (const fw of frameworks) {
    await pmFrameworksService.upsert({ ...fw, category: 'framework' });
    console.log(`  [framework] ${fw.slug} — ${fw.name}`);
    count += 1;
  }

  for (const file of collectReports()) {
    const content = fs.readFileSync(file, 'utf8');
    const base = path.basename(file, '.md');
    const name = content.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() ?? base;
    await pmFrameworksService.upsert({
      slug: slugify(base),
      name,
      content,
      description: `Relatório do projeto (${base}.md)`,
      category: 'report',
    });
    console.log(`  [report]    ${slugify(base)} — ${name.slice(0, 60)}`);
    count += 1;
  }

  console.log(
    `\n${count} item(ns) no catálogo: ${frameworks.length} framework(s) + ${collectReports().length} relatório(s).`,
  );
  console.log(
    'Seed local — o PMframeworks tem muito mais; use import-pmframeworks.ts para complementar.',
  );
}

main().catch((error) => {
  console.error('Falha no seed:', error);
  process.exit(1);
});
