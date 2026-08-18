/**
 * Handoff Export Bundle (spec 018)
 *
 * Monta em memória um zip no layout spec-kit consumível por coding agents:
 *   specs/{id}-handoff/spec.md        ← PRD (obrigatório)
 *   specs/{id}-handoff/tasks.md       ← Tasks (opcional; ausência vira warning)
 *   .specify/memory/constitution.md   ← template estático + metadados da demanda
 *   manifest.json                     ← proveniência (formato, hashes, avisos)
 *
 * Contrato de artefatos 2026-07-20 (AGENTS.md): o layout `specs/{id}-handoff/`
 * é o destino FINAL no repo — o mesmo nome de diretório que os coding agents
 * usam. spec.md/tasks.md gerados aqui são finais; o implementador só adiciona
 * plan.md (antes de codar) e evidence.md (no fechamento).
 *
 * Nunca persiste nada em disco nem faz escrita externa; o bundle é derivado
 * do estado atual dos documentos no momento do request.
 *
 * Contrato: specs/018-handoff-export-bundle/contracts/export-bundle.md
 */

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { AppError, NotFoundError } from '../middleware/error-handler';
import { demandRepository } from '../repositories/demand-repository';
import { loadDocumentContent } from '../routes/demands-utils';
import { documentVersioningService } from './document-versioning';
import { HANDOFF_FORMAT } from '@shared/handoff-manifest';
import type { HandoffManifest, HandoffManifestDocument } from '@shared/handoff-manifest';
import type { Demand } from '@shared/schema';

// Datas fixas nas entradas do zip: sem isso o JSZip grava "agora" em cada
// entrada e o mesmo estado de documentos produziria bytes diferentes (FR-008).
// 1980-01-01 é a época do formato DOS usado pelo zip; datas anteriores sofrem
// wrap-around e apareceriam como "2098" em ferramentas de listagem.
const FIXED_ENTRY_DATE = new Date('1980-01-01T00:00:00Z');

const CONSTITUTION_TEMPLATE = `# Constituição do Projeto — Handoff AiChatFlow

> Documento gerado automaticamente pelo AiChatFlow como parte do bundle de handoff
> da demanda "{{title}}" (tipo: {{type}}, prioridade: {{priority}}).
> Ajuste estes princípios às regras do repositório destino antes de implementar.

## Princípios

### I. Fidelidade à Spec

- A spec da demanda (\`specs/{{id}}-handoff/spec.md\`) é a fonte da verdade do escopo.
- Dúvidas de interpretação devem ser resolvidas com o autor da demanda, não assumidas.

### II. Testes Acompanham a Implementação

- Toda funcionalidade nova deve ser entregue com testes correspondentes.
- Tasks sem critério de aceite verificável devem ser questionadas antes de codar.

### III. Segurança

- Nunca commitar segredos, tokens ou credenciais; use variáveis de ambiente.
- Valide entradas externas e trate erros de forma explícita.

### IV. Mudanças Atômicas e Reversíveis

- Prefira commits pequenos que mantêm implementação e testes juntos.
- Mudanças destrutivas de dados exigem plano de rollback documentado.

### V. Contrato de Artefatos (mínimo)

- \`spec.md\` e \`tasks.md\` deste handoff são FINAIS — não reescrever, não expandir.
- O implementador adiciona APENAS: \`plan.md\` enxuto (premissas verificadas no
  código, decisões de design, riscos) antes de codar, e \`evidence.md\` no
  fechamento (gates executados e resultados).
- NÃO criar \`research.md\`, \`quickstart.md\`, \`data-model.md\`, \`checklists/\`
  nem \`contracts/\` — esse conteúdo, quando necessário, vira seção do \`plan.md\`.

## Metadados da Demanda de Origem

- **Demanda**: #{{id}} — {{title}}
- **Tipo**: {{type}}
- **Prioridade**: {{priority}}
`;

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Mesma heurística de document-versioning.ts / routes/shared.ts, replicada aqui
// para o serviço não depender da camada de rotas.
function isPdfBytes(content: string): boolean {
  return content.trimStart().startsWith('%PDF-');
}

export function buildConstitution(
  demand: Pick<Demand, 'id' | 'title' | 'type' | 'priority'>,
): string {
  return CONSTITUTION_TEMPLATE.replace(/\{\{id\}\}/g, String(demand.id))
    .replace(/\{\{title\}\}/g, demand.title)
    .replace(/\{\{type\}\}/g, demand.type)
    .replace(/\{\{priority\}\}/g, demand.priority);
}

interface LoadedDocument {
  content: string;
  /** 0 = origem legada (prdUrl/tasksUrl ou arquivo sem metadados) */
  version: number;
  updatedAt: string | null;
}

async function loadDocument(demand: Demand, type: 'prd' | 'tasks'): Promise<LoadedDocument | null> {
  const result = await documentVersioningService.load(demand.id, type);

  let content = result.content;
  let version = result.version;
  let updatedAt: string | null = result.updatedAt;

  if (!content.trim() || isPdfBytes(content)) {
    // Paridade com GET /api/demands/:id/documents/:type — fallback legado por URL.
    const legacy = loadDocumentContent(type, demand.prdUrl, demand.tasksUrl, demand.tddUrl);
    if (legacy.trim() && !isPdfBytes(legacy)) {
      content = legacy;
      version = 0;
      updatedAt = null;
    } else {
      return null;
    }
  }

  // O caminho legado do versioning devolve version 0 com updatedAt na época;
  // no manifest isso vira null para não fingir metadado que não existe.
  if (version === 0) {
    updatedAt = null;
  }

  return { content, version, updatedAt };
}

export interface HandoffBundleResult {
  buffer: Buffer;
  filename: string;
  manifest: HandoffManifest;
}

/** Spec 026: um arquivo do handoff (caminho + conteúdo), reusado pelo zip e pelo commit-no-repo. */
export interface HandoffFile {
  path: string;
  content: string;
}

export interface HandoffFilesResult {
  /** spec.md, tasks.md (se houver), constitution.md e manifest.json */
  files: HandoffFile[];
  manifest: HandoffManifest;
  filename: string;
}

/**
 * Spec 026: gera os arquivos do handoff (mesma fonte da verdade que o zip da
 * spec 018) para que possam ser commitados no repositório destino sem duplicar
 * a lógica. Mantém o guard de PRD (422) e os avisos do manifest.
 */
export async function buildHandoffFiles(demandId: number): Promise<HandoffFilesResult> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new NotFoundError('Demand', demandId);
  }

  const prd = await loadDocument(demand, 'prd');
  if (!prd) {
    throw new AppError(
      'PRD ausente ou vazio — não é possível exportar handoff',
      422,
      'HANDOFF_PRD_MISSING',
      { demandId },
    );
  }

  const tasks = await loadDocument(demand, 'tasks');
  const constitution = buildConstitution(demand);

  // Contrato 2026-07-20: mesmo diretório que os coding agents usam no repo
  // destino (ex.: specs/10024-handoff/) — o handoff já cai no lugar final.
  const specPath = `specs/${demandId}-handoff/spec.md`;
  const tasksPath = `specs/${demandId}-handoff/tasks.md`;
  const constitutionPath = '.specify/memory/constitution.md';

  const warnings: string[] = [];
  if (!tasks) {
    warnings.push('tasks.md ausente: demanda não possui documento Tasks');
  }

  const documents: HandoffManifestDocument[] = [
    {
      path: specPath,
      kind: 'spec',
      sha256: sha256Hex(prd.content),
      version: prd.version,
      updatedAt: prd.updatedAt,
    },
    ...(tasks
      ? [
          {
            path: tasksPath,
            kind: 'tasks' as const,
            sha256: sha256Hex(tasks.content),
            version: tasks.version,
            updatedAt: tasks.updatedAt,
          },
        ]
      : []),
    {
      path: constitutionPath,
      kind: 'constitution',
      sha256: sha256Hex(constitution),
      version: null,
      updatedAt: null,
    },
  ];

  const manifest: HandoffManifest = {
    format: HANDOFF_FORMAT,
    demand: {
      id: demand.id,
      title: demand.title,
      type: demand.type,
      priority: demand.priority,
    },
    generatedAt: new Date().toISOString(),
    documents,
    warnings,
  };

  const files: HandoffFile[] = [
    { path: specPath, content: prd.content },
    ...(tasks ? [{ path: tasksPath, content: tasks.content }] : []),
    { path: constitutionPath, content: constitution },
    { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
  ];

  return { files, manifest, filename: `demanda-${demandId}-handoff.zip` };
}

export async function buildHandoffBundle(demandId: number): Promise<HandoffBundleResult> {
  const { files, manifest, filename } = await buildHandoffFiles(demandId);

  // createFolders: false — entradas de diretório ganhariam data "agora" e
  // quebrariam o determinismo byte a byte do zip (FR-008).
  const entryOptions = { date: FIXED_ENTRY_DATE, createFolders: false };
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, entryOptions);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return {
    buffer,
    filename,
    manifest,
  };
}
