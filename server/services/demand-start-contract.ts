import { z } from 'zod';
import { insertDemandSchema } from '@shared/schema';
import type { DemandType } from '@shared/demand-types';
import {
  evaluateDemandStartContract,
  formatDemandStartContract,
  type DemandContractFields,
} from '@shared/demand-start-contract';
import { logger } from '../utils/logger';

const validTaskTypes = ['simple', 'intermediate', 'complex', 'critical', 'unknown'] as const;

export const refinementTypeSchema = z.enum(['technical', 'business']).nullable().optional();

// Schema unificado para criação de demanda via API (POST /api/demands e /api/demands/cognitive).
// Inclui os campos do orquestrador/form que antes eram lidos diretamente de req.body,
// eliminando o bypass de validação Zod (bug #8).
export const createDemandPayloadSchema = insertDemandSchema
  .extend({
    task_type: z.enum(validTaskTypes).optional(),
    demandStartContractPayload: z.string().trim().optional(),
    demandStartContract: z.string().trim().optional(),
    additionalRepos: z.preprocess((val) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch (_) {
          return undefined;
        }
      }
      return val;
    }, z.array(z.string()).optional()),
    githubRepoOwner: z.string().trim().optional(),
    githubRepoName: z.string().trim().optional(),
    repo_url: z.string().trim().optional(),
    skillRawUrl: z.string().trim().optional(),
    roundtableAgentIds: z.preprocess((val) => {
      if (typeof val === 'string') return val.split(',').map((s) => s.trim());
      if (Array.isArray(val)) return val;
      return undefined;
    }, z.array(z.string()).optional()),
    maxRounds: z.preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'string' ? Number.parseInt(val, 10) : Number(val);
      return Number.isNaN(n) ? undefined : n;
    }, z.number().int().min(1).max(5).optional()),
    refinementLevel: z.preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'string' ? Number.parseInt(val, 10) : Number(val);
      return Number.isNaN(n) ? undefined : n;
    }, z.number().int().min(1).max(3).optional()),
  })
  .strict();

export type CreateDemandPayload = z.infer<typeof createDemandPayloadSchema>;

/**
 * Parse only the fields declared in createDemandPayloadSchema, ignoring extra multipart
 * form fields (e.g. files metadata). Keeps the .strict() validation guard from H-21
 * and rejects unknown fields like `isAdmin`.
 */
export function parseInsertDemand(body: unknown): CreateDemandPayload {
  const result = createDemandPayloadSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    const bodyKeys = typeof body === 'object' && body !== null ? Object.keys(body) : [];
    logger.warn('parseInsertDemand: Zod validation failed', {
      context: { issues, bodyKeys },
    });
    throw result.error;
  }
  return result.data;
}

export function resolveDemandStartContract(
  input: CreateDemandPayload,
  demandData: {
    title: string;
    description: string;
    type: DemandType;
  },
) {
  const payloadRaw = input.demandStartContractPayload;
  if (typeof payloadRaw !== 'string' || payloadRaw.trim().length === 0) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch (_) {
    return null;
  }

  const fields =
    parsed.fields && typeof parsed.fields === 'object'
      ? (parsed.fields as Partial<DemandContractFields>)
      : {};
  const readiness = evaluateDemandStartContract({
    type: demandData.type,
    title: demandData.title,
    description: demandData.description,
    fields,
  });

  const markdown =
    typeof input.demandStartContract === 'string' && input.demandStartContract.trim().length > 0
      ? input.demandStartContract
      : formatDemandStartContract({
          type: demandData.type,
          fields,
          readiness,
          acceptedTypeSuggestion: parsed.acceptedTypeSuggestion === true,
        });

  return {
    readiness,
    markdown,
  };
}
