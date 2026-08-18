import { describe, it, expect } from 'vitest';
import {
  CitedPathValidator,
  summarizeGrounding,
  MISSING_PATH_MARKER,
  MISSING_ENTITY_MARKER,
} from '../../server/services/cited-path-validator';

const KNOWN = new Set([
  'server/services/foo.ts',
  'server/services/numeric-integrity-validator.ts',
  'client/src/components/Button.tsx',
  'client/src/components/handoff-metadata-badge.tsx',
  'client/src/hooks/useHandoffManifest.ts',
  'package.json',
  'vite.config.ts',
]);

describe('CitedPathValidator', () => {
  it('marca apenas os caminhos inexistentes', () => {
    const content = 'Edite `server/services/foo.ts` e crie `server/services/missing.ts`.';
    const result = CitedPathValidator.validate(content, KNOWN);

    expect(result.missingCount).toBe(1);
    expect(result.cleanContent).toContain(`server/services/missing.ts${MISSING_PATH_MARKER}`);
    expect(result.cleanContent).not.toContain(`server/services/foo.ts${MISSING_PATH_MARKER}`);

    const foo = result.ledger.find((l) => l.path === 'server/services/foo.ts');
    const missing = result.ledger.find((l) => l.path === 'server/services/missing.ts');
    expect(foo?.action).toBe('kept');
    expect(missing?.action).toBe('marked');
  });

  it('não marca nada quando o índice é nulo (não verificável / fail-safe)', () => {
    const content = 'Crie `server/services/missing.ts`.';
    const result = CitedPathValidator.validate(content, null);

    expect(result.missingCount).toBe(0);
    expect(result.cleanContent).toBe(content);
    expect(result.ledger.every((l) => l.action === 'skipped' && l.exists === null)).toBe(true);
  });

  it('é idempotente — rodar duas vezes não duplica o marcador', () => {
    const content = 'Veja `server/services/missing.ts`.';
    const once = CitedPathValidator.validate(content, KNOWN).cleanContent;
    const twice = CitedPathValidator.validate(once, KNOWN).cleanContent;

    expect(twice).toBe(once);
    expect(twice.split(MISSING_PATH_MARKER).length - 1).toBe(1);
  });

  it('casa nome de arquivo simples por basename', () => {
    const result = CitedPathValidator.validate('Veja package.json e vite.config.ts.', KNOWN);
    expect(result.missingCount).toBe(0);
  });

  it('aceita caminho parcial como sufixo de um caminho real', () => {
    const result = CitedPathValidator.validate('Veja `services/foo.ts`.', KNOWN);
    expect(result.missingCount).toBe(0);
  });

  it('normaliza prefixos ./ e / antes de comparar', () => {
    const result = CitedPathValidator.validate('Veja ./server/services/foo.ts.', KNOWN);
    expect(result.missingCount).toBe(0);
  });

  it('não extrai caminhos de dentro de URLs', () => {
    const content = 'Docs em https://github.com/owner/repo/blob/main/src/inexistente.ts';
    const result = CitedPathValidator.validate(content, KNOWN);
    expect(result.missingCount).toBe(0);
    expect(result.cleanContent).toBe(content);
  });

  it('ignora abreviações da prosa (e.g., i.e., vs.)', () => {
    const content = 'Use o validador (e.g. para grounding), i.e. de forma determinística.';
    const result = CitedPathValidator.validate(content, KNOWN);
    expect(result.missingCount).toBe(0);
    expect(result.cleanContent).toBe(content);
  });
});

describe('CitedPathValidator.validateEntities (spec 10009 US2)', () => {
  it('marca componente inexistente citado como existente (o caso AssistenteDeCodigo)', () => {
    const content = 'Atualizar o componente AssistenteDeCodigo para receber os metadados.';
    const result = CitedPathValidator.validateEntities(content, KNOWN);
    expect(result.missingCount).toBe(1);
    expect(result.cleanContent).toContain('AssistenteDeCodigo' + MISSING_ENTITY_MARKER);
  });

  it('NÃO marca componente real mesmo com casing diferente (PascalCase ↔ kebab-case)', () => {
    // client/src/components/handoff-metadata-badge.tsx existe
    const content = 'O componente HandoffMetadataBadge exibe os metadados.';
    const result = CitedPathValidator.validateEntities(content, KNOWN);
    expect(result.missingCount).toBe(0);
    expect(result.cleanContent).toBe(content);
  });

  it('reconhece hook existente e marca hook inexistente', () => {
    const content = 'Use o hook (useHandoffManifest) e o hook useDemandContext.';
    const result = CitedPathValidator.validateEntities(content, KNOWN);
    // useHandoffManifest existe; useDemandContext não
    expect(result.missingCount).toBe(1);
    expect(result.cleanContent).toContain('useDemandContext' + MISSING_ENTITY_MARKER);
    expect(result.cleanContent).not.toContain('useHandoffManifest' + MISSING_ENTITY_MARKER);
  });

  it('não marca PascalCase de prosa sem a palavra-chave componente/hook', () => {
    const content = 'A demanda precisa de API REST e query SQL otimizada.';
    const result = CitedPathValidator.validateEntities(content, KNOWN);
    expect(result.missingCount).toBe(0);
  });

  it('fail-safe: sem índice (null) não marca nada', () => {
    const content = 'O componente AssistenteDeCodigo não existe.';
    const result = CitedPathValidator.validateEntities(content, null);
    expect(result.missingCount).toBe(0);
    expect(result.cleanContent).toBe(content);
  });

  it('idempotente: rodar duas vezes não duplica o marcador', () => {
    const content = 'O componente AssistenteDeCodigo.';
    const once = CitedPathValidator.validateEntities(content, KNOWN).cleanContent;
    const twice = CitedPathValidator.validateEntities(once, KNOWN).cleanContent;
    expect(twice).toBe(once);
  });
});

describe('summarizeGrounding (spec 10012 FR-005/006)', () => {
  it('agrega totais e ratio de path + entity results', () => {
    const content =
      'Edite `server/services/foo.ts`, crie `server/services/missing.ts` e o componente AssistenteDeCodigo.';
    const paths = CitedPathValidator.validate(content, KNOWN);
    const entities = CitedPathValidator.validateEntities(content, KNOWN);

    const summary = summarizeGrounding([paths, entities]);
    // foo.ts (kept) + missing.ts (marked) + AssistenteDeCodigo (marked) = 3 verificáveis
    expect(summary.totalClaims).toBe(3);
    expect(summary.unverified).toBe(2);
    expect(summary.verified).toBe(1);
    expect(summary.unverifiedClaimsRatio).toBeCloseTo(2 / 3, 5);
    expect(summary.degraded).toBe(true); // 66% > 50%
  });

  it('não é degraded quando ≤50% não verificado', () => {
    const content = 'Veja `server/services/foo.ts`, `package.json` e crie `x/missing.ts`.';
    const paths = CitedPathValidator.validate(content, KNOWN);
    const summary = summarizeGrounding([paths]);
    expect(summary.totalClaims).toBe(3);
    expect(summary.unverified).toBe(1);
    expect(summary.degraded).toBe(false); // 33% ≤ 50%
  });

  it('índice indisponível (null) → zero claims verificáveis, não degraded', () => {
    const content = 'Crie `server/services/missing.ts` e o componente AssistenteDeCodigo.';
    const paths = CitedPathValidator.validate(content, null);
    const entities = CitedPathValidator.validateEntities(content, null);
    const summary = summarizeGrounding([paths, entities]);
    expect(summary.totalClaims).toBe(0);
    expect(summary.unverified).toBe(0);
    expect(summary.unverifiedClaimsRatio).toBe(0);
    expect(summary.degraded).toBe(false);
  });

  it('tudo verificado → ratio 0, não degraded', () => {
    const content = 'Veja `server/services/foo.ts` e `package.json`.';
    const summary = summarizeGrounding([CitedPathValidator.validate(content, KNOWN)]);
    expect(summary.totalClaims).toBe(2);
    expect(summary.unverified).toBe(0);
    expect(summary.degraded).toBe(false);
  });
});
