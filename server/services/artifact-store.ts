/**
 * Demanda 10037 — persistência de artefatos pós-refinamento (`artifacts`).
 *
 * Guarda o texto-fonte do diagrama (ADR-0002: a renderização é no cliente),
 * já com PII mascarada por `artifact-flowchart.ts`.
 */

import { randomUUID } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { artifacts, type Artifact, type ArtifactType } from '@shared/schema';
import { logger } from '../utils/logger';

export interface ArtifactDto {
  id: string;
  demandId: number;
  type: ArtifactType;
  source: string;
  createdAt: string;
}

function toDto(row: Artifact): ArtifactDto {
  return {
    id: row.id,
    demandId: row.demandId,
    type: row.type,
    source: row.source,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

export class ArtifactStore {
  async create(input: {
    demandId: number;
    type: ArtifactType;
    source: string;
  }): Promise<ArtifactDto> {
    const row = {
      id: randomUUID(),
      demandId: input.demandId,
      type: input.type,
      source: input.source,
      createdAt: new Date(),
    };

    await db.insert(artifacts).values(row);

    logger.info('artifacts: artefato persistido', {
      context: { id: row.id, demandId: row.demandId, type: row.type },
    });

    return toDto(row as Artifact);
  }

  async listByDemand(demandId: number): Promise<ArtifactDto[]> {
    const rows: Artifact[] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.demandId, demandId))
      .orderBy(desc(artifacts.createdAt));

    return rows.map(toDto);
  }

  async getById(id: string): Promise<ArtifactDto | null> {
    const rows: Artifact[] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
    return rows.length > 0 ? toDto(rows[0]) : null;
  }
}

export const artifactStore = new ArtifactStore();
