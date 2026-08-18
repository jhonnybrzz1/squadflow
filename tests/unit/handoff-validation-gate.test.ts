import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runHandoffValidationGate,
  type HandoffFileInput,
} from '../../server/services/handoff-validation-gate';
import * as resolver from '../../server/services/cited-path-resolver';
import * as github from '../../server/services/github';

const KNOWN = new Set([
  'server/routes/agents.ts',
  'client/src/components/handoff-metadata-badge.tsx',
  'package.json',
]);

function mockIndex(value: Set<string> | null) {
  vi.spyOn(resolver, 'resolveKnownRepoPaths').mockResolvedValue(value);
}

const specWithHallucination: HandoffFileInput[] = [
  {
    path: 'specs/x/spec.md',
    content: '# Spec\nAtualizar o componente AssistenteDeCodigo e criar `server/services/novo.ts`.',
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runHandoffValidationGate (spec 10014)', () => {
  it('modo off é no-op e sempre passa', async () => {
    mockIndex(KNOWN);
    const r = await runHandoffValidationGate('o/r', specWithHallucination, { mode: 'off' });
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('dry-run coleta issues mas NÃO bloqueia (US1)', async () => {
    mockIndex(KNOWN);
    const r = await runHandoffValidationGate('o/r', specWithHallucination, { mode: 'dry-run' });
    expect(r.passed).toBe(true); // não bloqueia
    expect(r.dryRun).toBe(true);
    // componente AssistenteDeCodigo (critical) + path novo.ts (warning)
    expect(
      r.issues.some((i) => i.refValue === 'AssistenteDeCodigo' && i.severity === 'critical'),
    ).toBe(true);
    expect(r.report).toContain('AssistenteDeCodigo');
  });

  it('blocking REPROVA quando há entidade crítica citada como existente (US2)', async () => {
    mockIndex(KNOWN);
    const r = await runHandoffValidationGate('o/r', specWithHallucination, { mode: 'blocking' });
    expect(r.passed).toBe(false);
    expect(r.issues.filter((i) => i.severity === 'critical').length).toBeGreaterThan(0);
  });

  it('blocking NÃO bloqueia por path ausente sozinho (arquivo planejado = warning)', async () => {
    mockIndex(KNOWN);
    const files: HandoffFileInput[] = [
      { path: 'spec.md', content: 'Criar `server/services/planejado.ts`.' },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.passed).toBe(true); // só warning
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('passa limpo quando tudo é verificável', async () => {
    mockIndex(KNOWN);
    const files: HandoffFileInput[] = [
      {
        path: 'spec.md',
        content: 'O componente HandoffMetadataBadge usa `server/routes/agents.ts`.',
      },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.report).toContain('sem pendências');
  });

  it('índice indisponível: dry-run fail-open, blocking fail-closed', async () => {
    mockIndex(null);
    const dry = await runHandoffValidationGate('o/r', specWithHallucination, { mode: 'dry-run' });
    expect(dry.passed).toBe(true);
    expect(dry.indexAvailable).toBe(false);

    mockIndex(null);
    const block = await runHandoffValidationGate('o/r', specWithHallucination, {
      mode: 'blocking',
    });
    expect(block.passed).toBe(false);
  });

  it('só valida documentos markdown do bundle (ignora manifest.json)', async () => {
    mockIndex(KNOWN);
    const files: HandoffFileInput[] = [
      { path: 'manifest.json', content: '{"componente":"AssistenteDeCodigo"}' },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  // ── FR-008: EndpointValidator ────────────────────────────────────────────
  it('EndpointValidator flagga endpoint inexistente como critical (US2 AC2)', async () => {
    mockIndex(new Set(['server/routes/agents.ts']));
    vi.spyOn(github.gitHubService, 'getSafeTextContent').mockResolvedValue({
      status: 'content',
      path: 'server/routes/agents.ts',
      content: "router.get('/api/agents', ...)",
      size: 10,
      sha: 'abc',
      rateLimit: { remaining: 10, limit: 60, reset: 0, used: 0 },
    });
    const files: HandoffFileInput[] = [
      { path: 'spec.md', content: 'Adicionar endpoint `/api/v2/agents` ao servidor.' },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.passed).toBe(false);
    expect(
      r.issues.some(
        (i) =>
          i.validator === 'Endpoint' &&
          i.refValue === '/api/v2/agents' &&
          i.severity === 'critical',
      ),
    ).toBe(true);
  });

  it('EndpointValidator passa quando endpoint existe em arquivo de rota', async () => {
    mockIndex(new Set(['server/routes/agents.ts']));
    vi.spyOn(github.gitHubService, 'getSafeTextContent').mockResolvedValue({
      status: 'content',
      path: 'server/routes/agents.ts',
      content: "router.get('/api/agents', ...)",
      size: 10,
      sha: 'abc',
      rateLimit: { remaining: 10, limit: 60, reset: 0, used: 0 },
    });
    const files: HandoffFileInput[] = [
      { path: 'spec.md', content: 'Usar endpoint `/api/agents`.' },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.issues.some((i) => i.validator === 'Endpoint')).toBe(false);
  });

  // ── FR-009: DependencyValidator ───────────────────────────────────────────
  it('DependencyValidator flagga lib não declarada em package.json (US2 AC3)', async () => {
    mockIndex(new Set(['server/routes/agents.ts']));
    // Doc sem endpoints → EndpointValidator não chama getSafeTextContent.
    // Primeira (e única) chamada é DependencyValidator buscando package.json.
    vi.spyOn(github.gitHubService, 'getSafeTextContent').mockResolvedValue({
      status: 'content',
      path: 'package.json',
      content: JSON.stringify({ dependencies: { zod: '^3.0.0' } }),
      size: 30,
      sha: 'def',
      rateLimit: { remaining: 10, limit: 60, reset: 0, used: 0 },
    });
    const files: HandoffFileInput[] = [
      { path: 'spec.md', content: "import { foo } from 'biblioteca-inventada';" },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.passed).toBe(false);
    expect(
      r.issues.some(
        (i) =>
          i.validator === 'Dependency' &&
          i.refValue === 'biblioteca-inventada' &&
          i.severity === 'critical',
      ),
    ).toBe(true);
  });

  it('DependencyValidator passa quando lib está declarada', async () => {
    mockIndex(new Set(['server/routes/agents.ts']));
    vi.spyOn(github.gitHubService, 'getSafeTextContent').mockResolvedValue({
      status: 'content',
      path: 'package.json',
      content: JSON.stringify({ dependencies: { zod: '^3.0.0' } }),
      size: 30,
      sha: 'def',
      rateLimit: { remaining: 10, limit: 60, reset: 0, used: 0 },
    });
    const files: HandoffFileInput[] = [{ path: 'spec.md', content: "import { z } from 'zod';" }];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.issues.some((i) => i.validator === 'Dependency')).toBe(false);
  });

  it('DependencyValidator não flagga paths relativos', async () => {
    mockIndex(new Set(['server/routes/agents.ts']));
    vi.spyOn(github.gitHubService, 'getSafeTextContent').mockResolvedValue({
      status: 'content',
      path: 'package.json',
      content: JSON.stringify({ dependencies: {} }),
      size: 2,
      sha: 'def',
      rateLimit: { remaining: 10, limit: 60, reset: 0, used: 0 },
    });
    const files: HandoffFileInput[] = [
      { path: 'spec.md', content: "import { foo } from './local';" },
    ];
    const r = await runHandoffValidationGate('o/r', files, { mode: 'blocking' });
    expect(r.issues.some((i) => i.validator === 'Dependency')).toBe(false);
  });
});
