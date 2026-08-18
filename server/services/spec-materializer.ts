import { projectRoot } from '@shared/utils/paths';
/**
 * FEAT-20260724-001 — materializa `specs/<id>-handoff/` a partir do output de
 * refinamento (`documents/PRD_<id>_v*.md`, `Tasks_<id>_v*.md`).
 *
 * Nasce de trabalho manual repetido: 3× nesta sessão (10076-91, 92-94, 95-96)
 * copiei PRD→spec.md, Tasks→tasks.md e escrevi um evidence.md à mão. Isto é o
 * mesmo, automatizado e idempotente.
 *
 * Regra de ouro (LRN-20260718-001): NUNCA sobrescrever uma spec existente — se a
 * pasta já existe, não faz nada. Uma demanda já mapeada não vira duplicata.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MaterializeResult {
  status: 'created' | 'skipped-exists' | 'skipped-no-prd';
  dir: string;
  files?: string[];
}

/** Última versão de `<prefix>_<id>_vN.md` em documents/ (maior N). */
function latestDoc(documentsDir: string, prefix: string, demandId: number): string | null {
  let matches: string[];
  try {
    matches = fs
      .readdirSync(documentsDir)
      .filter((f) => new RegExp(`^${prefix}_${demandId}_v\\d+\\.md$`).test(f));
  } catch (_) {
    return null;
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const na = Number(a.match(/_v(\d+)\.md$/)?.[1] ?? 0);
    const nb = Number(b.match(/_v(\d+)\.md$/)?.[1] ?? 0);
    return na - nb;
  });
  return path.join(documentsDir, matches[matches.length - 1]);
}

/** Título = 1ª linha do PRD, sem o prefixo "# Demanda - ". */
export function titleFromPrd(prdContent: string): string {
  const first = prdContent.split('\n')[0] ?? '';
  return first
    .replace(/^#\s*Demanda\s*-\s*/i, '')
    .replace(/^#\s*/, '')
    .trim();
}

/**
 * Template do evidence.md. Exportado, não chamado aqui: o arquivo pertence ao
 * fechamento da IMPLEMENTAÇÃO (gates executados), não ao do refinamento.
 */
export function buildEvidence(demandId: number, title: string): string {
  return `# Evidence — Demanda #${demandId}${title ? ` (${title})` : ''}

**Materializada automaticamente** a partir do refinamento
(\`documents/PRD_${demandId}_v*.md\`, \`documents/Tasks_${demandId}_v*.md\`) ao
concluir a orquestração. Documento de proveniência, não re-verificação funcional.

- \`spec.md\` = PRD gerado pela mesa redonda.
- \`tasks.md\` = checklist gerado.
`;
}

/**
 * Cria `specs/<id>-handoff/` se ainda não existir e houver PRD. Puro em relação
 * ao filesystem (raiz injetável para teste). Nunca lança por causa de I/O — a
 * chamada vem de um subscriber fail-safe.
 */
export function materializeSpec(
  demandId: number,
  opts: { projectRoot?: string } = {},
): MaterializeResult {
  const root = opts.projectRoot ?? projectRoot;
  const dir = path.join(root, 'specs', `${demandId}-handoff`);
  const documentsDir = path.join(root, 'documents');

  if (fs.existsSync(dir)) {
    return { status: 'skipped-exists', dir };
  }

  const prd = latestDoc(documentsDir, 'PRD', demandId);
  if (!prd) {
    return { status: 'skipped-no-prd', dir };
  }

  const prdContent = fs.readFileSync(prd, 'utf8');
  const tasks = latestDoc(documentsDir, 'Tasks', demandId);

  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  fs.writeFileSync(path.join(dir, 'spec.md'), prdContent);
  written.push('spec.md');

  if (tasks) {
    fs.copyFileSync(tasks, path.join(dir, 'tasks.md'));
    written.push('tasks.md');
  }

  // P0 grounding: `evidence.md` NÃO é materializado ao concluir o refinamento.
  // O contrato do AGENTS.md reserva o arquivo para o fechamento da IMPLEMENTAÇÃO
  // ("gates executados, resultados, desvios"). Gerá-lo aqui produzia um
  // documento de proveniência que se parecia com verificação sem ter havido
  // nenhuma — foi o que aconteceu em 10330/10332/10336.
  return { status: 'created', dir, files: written };
}
