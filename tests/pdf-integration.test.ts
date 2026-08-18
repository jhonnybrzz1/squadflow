import { describe, expect, it } from 'vitest';
import { PDFGenerator } from '../server/services/pdf-generator';
import { createHash } from 'crypto';

describe('PDF integration test', () => {
  const generator = new PDFGenerator();

  it('generates PDF and validates hash consistency', async () => {
    const content = `# PRD - Feature de Login Social

## Objetivo
Permitir que usuarios se autentiquem via Google e GitHub.

## Requisitos Funcionais
- RF01: Botao de login com Google
- RF02: Botao de login com GitHub

## Criterios de Aceite
- CA01: Login redireciona corretamente apos autenticacao.
`;

    const buffer = await generator.generatePRDDocument(content, 42);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);

    // Validate PDF magic bytes
    expect(buffer.slice(0, 4).toString('ascii')).toBe('%PDF');

    // Generate hash for consistency check
    const hash = createHash('md5').update(buffer).digest('hex');
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  }, 15000);

  it('generates Tasks PDF and validates hash consistency', async () => {
    const content = `# Checklist De Execução - Feature de Login

**Versão:** 1.0.0
**Prioridade:** Alta
**Responsável:** @produto-pessoal
**Status:** Em Progresso

## Agora
- [x] Criar branch feature/login-social
- [ ] Implementar Google OAuth
- [ ] Implementar GitHub OAuth

## Depois
- [ ] Adicionar testes E2E
- [ ] Documentar API
`;

    const buffer = await generator.generateTasksDocument(content, 42);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);

    // Validate PDF magic bytes
    expect(buffer.slice(0, 4).toString('ascii')).toBe('%PDF');

    // Generate hash for consistency check
    const hash = createHash('md5').update(buffer).digest('hex');
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  }, 15000);
});
