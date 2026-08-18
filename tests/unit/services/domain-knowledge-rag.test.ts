import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainKnowledgeRAGService } from '../../../server/services/domain-knowledge-rag';

const roots: string[] = [];

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-rag-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DomainKnowledgeRAGService', () => {
  it('declara lacuna quando não existe corpus curado', () => {
    const context = new DomainKnowledgeRAGService(newRoot()).buildContext(
      'legaltech_lgpd',
      'base legal de tratamento',
    );
    expect(context).toContain('indisponível');
    expect(context).toContain('Não use conhecimento do modelo como evidência');
  });

  it('carrega apenas JSON com fonte e revisão humana', () => {
    const root = newRoot();
    const directory = path.join(root, 'legaltech_lgpd');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'curado.json'),
      JSON.stringify({
        id: 'lg-1',
        title: 'Base legal revisada',
        domain: 'legaltech_lgpd',
        sourceTitle: 'Fonte primária de teste',
        sourceUrl: 'https://example.org/fonte',
        reviewedBy: 'Especialista Humano',
        reviewedAt: '2026-07-16T12:00:00.000Z',
        content: 'Conteúdo de teste revisado sobre base legal de tratamento e validação da fonte.',
        tags: ['lgpd'],
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'sem-revisor.json'),
      JSON.stringify({
        id: 'lg-2',
        title: 'Inválido',
        domain: 'legaltech_lgpd',
        sourceTitle: 'Sem revisão',
        sourceUrl: 'https://example.org/invalido',
        content: 'Este conteúdo não pode entrar porque não possui revisão humana declarada.',
      }),
    );

    const service = new DomainKnowledgeRAGService(root);
    expect(service.loadCuratedDocuments('legaltech_lgpd')).toHaveLength(1);
    const context = service.buildContext('legaltech_lgpd', 'tratamento de dados pessoais');
    expect(context).toContain('Fonte primária de teste');
    expect(context).toContain('revisado por Especialista Humano');
  });
});
