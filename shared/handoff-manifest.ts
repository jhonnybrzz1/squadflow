/**
 * Spec 018 — contrato do manifest do handoff export bundle.
 *
 * O manifest dá proveniência ao zip consumido por coding agents:
 * formato declarado, identificação da demanda, inventário de documentos
 * com hashes verificáveis e avisos legíveis.
 *
 * Contrato: specs/018-handoff-export-bundle/contracts/export-bundle.md
 */
import { z } from 'zod';

export const HANDOFF_FORMAT = 'aichatflow-handoff/v1' as const;

export interface HandoffManifestDocument {
  /** Caminho do arquivo dentro do zip, ex.: "specs/42-handoff/spec.md" */
  path: string;
  kind: 'spec' | 'tasks' | 'constitution';
  /**
   * SHA-256 (hex puro, sem prefixo) dos bytes efetivamente incluídos no zip —
   * verificável pelo consumidor com `shasum -a 256`.
   */
  sha256: string;
  /** Versão no versionamento do produto; 0 = origem legada; null p/ constitution gerada */
  version: number | null;
  /** updatedAt do versionamento; null quando não aplicável (legado / constitution) */
  updatedAt: string | null;
}

export interface HandoffManifest {
  format: typeof HANDOFF_FORMAT;
  demand: {
    id: number;
    title: string;
    type: string;
    priority: string;
  };
  /** ISO-8601 — único campo variável entre gerações com o mesmo estado de documentos */
  generatedAt: string;
  documents: HandoffManifestDocument[];
  warnings: string[];
}

/**
 * Spec 10006 — forma simplificada do manifest para exibição no frontend.
 * Sem hashes nem URLs internas (edge case da spec: metadados de UI não expõem
 * hash completo). Derivada do HandoffManifest.
 */
export interface HandoffMetadata {
  format: string;
  demandId: number;
  demandTitle: string;
  generatedAt: string;
  documentCount: number;
  hasSpec: boolean;
  hasTasks: boolean;
  hasConstitution: boolean;
  warnings: string[];
}

/** Deriva o HandoffMetadata de UI a partir do manifest completo (sem hashes). */
export function toHandoffMetadata(manifest: HandoffManifest): HandoffMetadata {
  const kinds = new Set(manifest.documents.map((d) => d.kind));
  return {
    format: manifest.format,
    demandId: manifest.demand.id,
    demandTitle: manifest.demand.title,
    generatedAt: manifest.generatedAt,
    documentCount: manifest.documents.length,
    hasSpec: kinds.has('spec'),
    hasTasks: kinds.has('tasks'),
    hasConstitution: kinds.has('constitution'),
    warnings: manifest.warnings,
  };
}

/**
 * Spec 10044 T1 — validação do speckit antes de disparar o agente de código.
 *
 * DIVERGÊNCIA vs. tasks.md (documentada): o handoff NÃO usa frontmatter YAML.
 * O contrato estruturado do speckit é o `manifest.json` gerado por
 * `buildHandoffFiles` — este schema o valida. Um manifest que passa aqui garante
 * que o speckit foi escrito corretamente (formato correto, demanda identificada,
 * ao menos o `spec.md` presente) — a intenção real da regra "frontmatter válido".
 */
const manifestDocumentSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['spec', 'tasks', 'constitution']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 deve ser hex de 64 chars'),
  version: z.number().int().nullable(),
  updatedAt: z.string().nullable(),
});

export const speckitManifestSchema = z
  .object({
    format: z.literal(HANDOFF_FORMAT),
    demand: z.object({
      id: z.number().int().positive(),
      title: z.string().min(1),
      type: z.string().min(1),
      priority: z.string().min(1),
    }),
    generatedAt: z.string().min(1),
    documents: z.array(manifestDocumentSchema),
    warnings: z.array(z.string()),
  })
  // Regra de negócio: sem `spec.md` não há o que o agente de código implementar.
  .refine((m) => m.documents.some((d) => d.kind === 'spec'), {
    message: 'manifest sem documento kind="spec" — nada para o agente implementar',
    path: ['documents'],
  });

export type SpeckitManifest = z.infer<typeof speckitManifestSchema>;

export type SpeckitManifestValidation =
  | { success: true; data: SpeckitManifest }
  | { success: false; errors: string[] };

/**
 * Valida o manifest do speckit. Retorna `{ success, data }` ou `{ success, errors }`
 * — nunca lança — para o handler do evento poder descartar o disparo com um log
 * legível quando o speckit estiver malformado.
 */
export function validateSpeckitManifest(manifest: unknown): SpeckitManifestValidation {
  const result = speckitManifestSchema.safeParse(manifest);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return { success: false, errors };
}
