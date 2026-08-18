import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildTechDebtEntry,
  findDuplicateHash,
  ensureSectionExists,
  registerTechDebtItemTool,
} from '../../server/services/tech-lead-tools';

/**
 * Spec 10138: testa a tool register_tech_debt_item que atualiza TECHNICAL_DEBT.md.
 */
describe('register_tech_debt_item (spec 10138)', () => {
  let tmpDir: string;
  let techDebtPath: string;
  const originalTechDebtPath = process.env.TECH_DEBT_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-debt-test-'));
    techDebtPath = path.join(tmpDir, 'TECHNICAL_DEBT.md');
    process.env.TECH_DEBT_PATH = techDebtPath;
  });

  afterEach(() => {
    process.env.TECH_DEBT_PATH = originalTechDebtPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validPayload = {
    demandId: 12345,
    demandTitle: 'Refatorar ai-squad',
    category: 'architecture' as const,
    severity: 'HIGH' as const,
    description:
      'O serviço ai-squad tem 2000 linhas e mistura orquestração com geração de prompts.',
    location: 'server/services/ai-squad.ts',
  };

  describe('buildTechDebtEntry', () => {
    it('gera entrada markdown com itemId, campos e descrição', () => {
      const { entry, shortHash } = buildTechDebtEntry(validPayload);
      expect(shortHash).toHaveLength(8);
      expect(entry).toContain('### AGENT-DEBT-');
      expect(entry).toContain(`**Categoria:** ${validPayload.category}`);
      expect(entry).toContain(`**Severidade:** ${validPayload.severity}`);
      expect(entry).toContain(`**Demand ID:** ${validPayload.demandId}`);
      expect(entry).toContain(`**Demand Title:** ${validPayload.demandTitle}`);
      expect(entry).toContain(`**Localização:** ${validPayload.location}`);
      expect(entry).toContain(validPayload.description);
    });

    it('gera shortHash determinístico para mesma categoria+localização', () => {
      const a = buildTechDebtEntry(validPayload);
      const b = buildTechDebtEntry({ ...validPayload, demandId: 99999 });
      expect(a.shortHash).toBe(b.shortHash);
    });

    it('gera shortHash diferente para localização diferente', () => {
      const a = buildTechDebtEntry(validPayload);
      const b = buildTechDebtEntry({ ...validPayload, location: 'server/services/other.ts' });
      expect(a.shortHash).not.toBe(b.shortHash);
    });
  });

  describe('findDuplicateHash', () => {
    it('retorna null quando seção não existe', () => {
      expect(findDuplicateHash('conteúdo sem seção', 'abcd1234')).toBeNull();
    });

    it('retorna null quando seção existe mas hash não está presente', () => {
      const content = '## Itens Detectados por Agente\n\n### AGENT-DEBT-20260725-abcd9999\n';
      expect(findDuplicateHash(content, 'abcd1234')).toBeNull();
    });

    it('retorna o itemId quando hash está presente na seção', () => {
      const content =
        '## Itens Detectados por Agente\n\n### AGENT-DEBT-20260725120000-abcd1234\n\ntexto\n';
      const result = findDuplicateHash(content, 'abcd1234');
      expect(result).toBe('AGENT-DEBT-20260725120000-abcd1234');
    });

    it('não detecta hash fora da seção de agente', () => {
      const content = '### AGENT-DEBT-20260725120000-abcd1234\n\n## Itens Detectados por Agente\n';
      expect(findDuplicateHash(content, 'abcd1234')).toBeNull();
    });
  });

  describe('ensureSectionExists', () => {
    it('não modifica conteúdo se seção já existe', () => {
      const content = 'texto\n## Itens Detectados por Agente\nmais texto';
      expect(ensureSectionExists(content)).toBe(content);
    });

    it('adiciona seção no final se não existe', () => {
      const content = '# Technical Debt Register\n\ntexto inicial';
      const result = ensureSectionExists(content);
      expect(result).toContain('## Itens Detectados por Agente');
      expect(result).toContain('rastreável à demanda');
      expect(result).toContain(content);
    });
  });

  describe('tool execute', () => {
    it('appenda item válido em arquivo existente', async () => {
      fs.writeFileSync(techDebtPath, '# Technical Debt\n\nconteúdo inicial\n', 'utf8');
      const result = await registerTechDebtItemTool.execute(validPayload, {} as never);
      expect(result.ok).toBe(true);
      expect(result.data).toHaveProperty('itemId');
      expect(result.data).toHaveProperty('appendedAt');

      const content = fs.readFileSync(techDebtPath, 'utf8');
      expect(content).toContain('## Itens Detectados por Agente');
      expect(content).toContain('### AGENT-DEBT-');
      expect(content).toContain(validPayload.description);
      expect(content).toContain('conteúdo inicial');
    });

    it('cria arquivo com seção quando não existe', async () => {
      expect(fs.existsSync(techDebtPath)).toBe(false);
      const result = await registerTechDebtItemTool.execute(validPayload, {} as never);
      expect(result.ok).toBe(true);

      const content = fs.readFileSync(techDebtPath, 'utf8');
      expect(content).toContain('## Itens Detectados por Agente');
      expect(content).toContain(validPayload.description);
    });

    it('rejeita duplicata (mesma categoria + localização)', async () => {
      await registerTechDebtItemTool.execute(validPayload, {} as never);
      const second = await registerTechDebtItemTool.execute(validPayload, {} as never);
      expect(second.ok).toBe(false);
      expect(second.error).toContain('duplicado');
    });

    it('aceita item diferente (localização diferente) após primeiro', async () => {
      await registerTechDebtItemTool.execute(validPayload, {} as never);
      const second = await registerTechDebtItemTool.execute(
        { ...validPayload, location: 'server/services/other.ts' },
        {} as never,
      );
      expect(second.ok).toBe(true);

      const content = fs.readFileSync(techDebtPath, 'utf8');
      const matches = content.match(/### AGENT-DEBT-/g);
      expect(matches).toHaveLength(2);
    });
  });
});
