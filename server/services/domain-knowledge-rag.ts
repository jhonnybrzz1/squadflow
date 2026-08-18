import { resolvePath } from '@shared/utils/paths';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DemandDomain } from '@shared/schema';
import { getDomainByName } from './domain-config';
import { logger } from '../utils/logger';
import { screenAndFormat, type RetrievedChunk } from './retrieval-guardrail';

export const curatedDomainDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  domain: z.string().min(1),
  sourceTitle: z.string().min(1),
  sourceUrl: z.string().url(),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime(),
  content: z.string().min(20),
  tags: z.array(z.string().min(1)).default([]),
});

export type CuratedDomainDocument = z.infer<typeof curatedDomainDocumentSchema>;

function normalize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

export class DomainKnowledgeRAGService {
  constructor(private readonly rootDir = resolvePath('knowledge/domains')) {}

  loadCuratedDocuments(domain: DemandDomain): CuratedDomainDocument[] {
    const config = getDomainByName(String(domain));
    if (!config) return [];

    const domainDir = path.join(this.rootDir, String(domain));
    if (!fs.existsSync(domainDir)) return [];

    const documents: CuratedDomainDocument[] = [];
    for (const filename of fs.readdirSync(domainDir).filter((file) => file.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(domainDir, filename), 'utf8')) as unknown;
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
          const parsed = curatedDomainDocumentSchema.safeParse(entry);
          if (!parsed.success || parsed.data.domain !== String(domain)) {
            logger.warn('Ignoring invalid or cross-domain curated document', {
              context: { domain, filename },
            });
            continue;
          }
          documents.push(parsed.data);
        }
      } catch (error) {
        logger.warn('Ignoring unreadable curated domain document', {
          error: error instanceof Error ? error : undefined,
          context: { domain, filename },
        });
      }
    }
    return documents;
  }

  buildContext(domain: DemandDomain, query: string, limit = 4): string {
    const config = getDomainByName(String(domain));
    if (!config) return '';

    const documents = this.loadCuratedDocuments(String(domain));
    if (documents.length === 0) {
      return `CORPUS CURADO DO DOMÍNIO ${String(domain)}: indisponível. Não use conhecimento do modelo como evidência financeira, cambial, jurídica ou regulatória. Declare a lacuna e solicite curadoria humana.`;
    }

    const queryTokens = new Set(normalize(query));
    const ranked = documents
      .map((document) => {
        const tokens = normalize(
          `${document.title} ${document.tags.join(' ')} ${document.content}`,
        );
        const score = tokens.reduce((total, token) => total + (queryTokens.has(token) ? 1 : 0), 0);
        return { document, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) {
      return `CORPUS CURADO DO DOMÍNIO ${String(domain)}: existe, mas não há correspondência relevante para esta demanda. Não extrapole o conteúdo disponível.`;
    }

    const chunks: RetrievedChunk[] = ranked.map(({ document }) => ({
      sourceKey: `${document.sourceTitle} | ${document.sourceUrl} | revisado por ${document.reviewedBy} em ${document.reviewedAt}`,
      docType: `domain:${document.domain}`,
      content: `${document.title}\n${document.content}`,
    }));

    return screenAndFormat(chunks, ` | domínio:${String(domain)} | corpus humano curado`);
  }
}

export const domainKnowledgeRAGService = new DomainKnowledgeRAGService();
