/**
 * Spec 018 — unit do serviço de handoff bundle (T005 + asserções finas T012).
 * Contrato: specs/018-handoff-export-bundle/contracts/export-bundle.md
 */
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(),
}));

const versioningMock = vi.hoisted(() => ({
  load: vi.fn(),
}));

const legacyLoadMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../../server/services/document-versioning', () => ({
  documentVersioningService: versioningMock,
}));

vi.mock('../../server/routes/demands-utils', () => ({
  loadDocumentContent: legacyLoadMock,
}));

import { AppError, NotFoundError } from '../../server/middleware/error-handler';
import { buildConstitution, buildHandoffBundle } from '../../server/services/handoff-bundle';
import { HANDOFF_FORMAT } from '@shared/handoff-manifest';

const CHAT_SECRET = 'segredo-que-nao-pode-vazar-no-bundle';

const demand = {
  id: 42,
  title: 'Exportar relatório mensal',
  type: 'feature',
  priority: 'alta',
  prdUrl: null,
  tasksUrl: null,
  tddUrl: null,
  chatMessages: [{ agent: 'pm', message: CHAT_SECRET, timestamp: Date.now(), type: 'completed' }],
};

function loadResult(type: 'prd' | 'tasks', content: string, version = 3) {
  return {
    demandId: demand.id,
    type,
    content,
    version,
    hash: version > 0 ? `sha256:${sha256(content)}` : '',
    updatedAt: version > 0 ? '2026-07-15T12:00:00.000Z' : new Date(0).toISOString(),
    hasPreviousVersion: false,
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function mockDocs(prd: string, tasks: string, prdVersion = 3, tasksVersion = 2) {
  versioningMock.load.mockImplementation(async (_id: number, type: 'prd' | 'tasks') =>
    type === 'prd' ? loadResult('prd', prd, prdVersion) : loadResult('tasks', tasks, tasksVersion),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  repoMock.findByIdOrNull.mockResolvedValue(demand);
  legacyLoadMock.mockReturnValue('');
});

describe('buildHandoffBundle — montagem (US1)', () => {
  it('gera zip com spec, tasks, constitution e manifest (US1-AS1)', async () => {
    mockDocs('# PRD 42\nconteúdo', '# Tasks 42\n- [ ] T001');

    const { buffer, filename } = await buildHandoffBundle(42);
    expect(filename).toBe('demanda-42-handoff.zip');

    const zip = await JSZip.loadAsync(buffer);
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    expect(paths.sort()).toEqual(
      [
        '.specify/memory/constitution.md',
        'manifest.json',
        'specs/42-handoff/spec.md',
        'specs/42-handoff/tasks.md',
      ].sort(),
    );
    expect(await zip.file('specs/42-handoff/spec.md')!.async('string')).toBe('# PRD 42\nconteúdo');
    expect(await zip.file('specs/42-handoff/tasks.md')!.async('string')).toBe(
      '# Tasks 42\n- [ ] T001',
    );
  });

  it('omite tasks.md e registra warning quando não há Tasks (US1-AS2, FR-005)', async () => {
    mockDocs('# PRD 42', '', 3, 0);

    const { buffer, manifest } = await buildHandoffBundle(42);
    const zip = await JSZip.loadAsync(buffer);

    expect(zip.file('specs/42-handoff/tasks.md')).toBeNull();
    expect(manifest.warnings).toEqual(['tasks.md ausente: demanda não possui documento Tasks']);
    expect(manifest.documents.map((d) => d.kind)).toEqual(['spec', 'constitution']);
  });

  it('usa fallback legado quando o versionamento não tem conteúdo (FR-002)', async () => {
    mockDocs('', '', 0, 0);
    legacyLoadMock.mockImplementation((type: string) =>
      type === 'prd' ? '# PRD legado via prdUrl' : '',
    );

    const { buffer, manifest } = await buildHandoffBundle(42);
    const zip = await JSZip.loadAsync(buffer);

    expect(await zip.file('specs/42-handoff/spec.md')!.async('string')).toBe(
      '# PRD legado via prdUrl',
    );
    const spec = manifest.documents.find((d) => d.kind === 'spec')!;
    expect(spec.version).toBe(0);
    expect(spec.updatedAt).toBeNull();
  });

  it('é determinístico: mesmo estado → mesmos bytes de arquivo, só generatedAt varia (FR-008)', async () => {
    mockDocs('# PRD 42', '# Tasks 42');

    const first = await buildHandoffBundle(42);
    const second = await buildHandoffBundle(42);

    const zipA = await JSZip.loadAsync(first.buffer);
    const zipB = await JSZip.loadAsync(second.buffer);

    for (const path of [
      'specs/42-handoff/spec.md',
      'specs/42-handoff/tasks.md',
      '.specify/memory/constitution.md',
    ]) {
      expect(await zipA.file(path)!.async('string')).toBe(await zipB.file(path)!.async('string'));
    }

    const manifestA = JSON.parse(await zipA.file('manifest.json')!.async('string'));
    const manifestB = JSON.parse(await zipB.file('manifest.json')!.async('string'));
    delete manifestA.generatedAt;
    delete manifestB.generatedAt;
    expect(manifestA).toEqual(manifestB);
  });

  it('não inclui histórico de chat nem entradas extras (FR-009)', async () => {
    mockDocs('# PRD 42', '# Tasks 42');

    const { buffer } = await buildHandoffBundle(42);
    const zip = await JSZip.loadAsync(buffer);

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      expect(await entry.async('string')).not.toContain(CHAT_SECRET);
    }
  });
});

describe('buildHandoffBundle — recusas (US2)', () => {
  it('demanda inexistente → NotFoundError (FR-004)', async () => {
    repoMock.findByIdOrNull.mockResolvedValue(null);
    await expect(buildHandoffBundle(999999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['ausente', ''],
    ['apenas whitespace', '   \n  '],
    ['bytes de PDF', '%PDF-1.7 fake-binary'],
  ])('PRD %s → AppError 422 HANDOFF_PRD_MISSING (FR-003)', async (_label, prdContent) => {
    mockDocs(prdContent, '', 0, 0);

    const failure = await buildHandoffBundle(42).catch((err) => err);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.statusCode).toBe(422);
    expect(failure.errorCode).toBe('HANDOFF_PRD_MISSING');
    expect(failure.message).toContain('PRD ausente ou vazio');
  });

  it('fallback legado com bytes de PDF também é recusado (US2-AS3)', async () => {
    mockDocs('', '', 0, 0);
    legacyLoadMock.mockReturnValue('%PDF-1.4 conteúdo binário');

    const failure = await buildHandoffBundle(42).catch((err) => err);
    expect(failure.statusCode).toBe(422);
  });
});

describe('manifest — proveniência (US3, T012)', () => {
  it('declara formato, demanda, hashes verificáveis e metadados por documento (FR-007, SC-005)', async () => {
    mockDocs('# PRD 42\ncorpo', '# Tasks 42\n- [ ] T001');

    const { buffer, manifest } = await buildHandoffBundle(42);
    const zip = await JSZip.loadAsync(buffer);

    expect(manifest.format).toBe(HANDOFF_FORMAT);
    expect(manifest.demand).toEqual({
      id: 42,
      title: 'Exportar relatório mensal',
      type: 'feature',
      priority: 'alta',
    });
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);

    expect(manifest.documents.map((d) => d.kind)).toEqual(['spec', 'tasks', 'constitution']);
    for (const doc of manifest.documents) {
      const included = await zip.file(doc.path)!.async('string');
      expect(doc.sha256).toBe(sha256(included));
    }

    const spec = manifest.documents.find((d) => d.kind === 'spec')!;
    expect(spec).toMatchObject({ version: 3, updatedAt: '2026-07-15T12:00:00.000Z' });
    const constitution = manifest.documents.find((d) => d.kind === 'constitution')!;
    expect(constitution).toMatchObject({ version: null, updatedAt: null });

    // O manifest embarcado no zip é o mesmo objeto retornado (menos nada).
    const embedded = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(embedded).toEqual(manifest);
  });

  it('warnings não contêm URLs internas nem segredos (FR-009)', async () => {
    mockDocs('# PRD 42', '', 3, 0);
    const { manifest } = await buildHandoffBundle(42);
    for (const warning of manifest.warnings) {
      expect(warning).not.toMatch(/https?:\/\/|localhost|127\.0\.0\.1|sk-|api[_-]?key/i);
    }
  });
});

describe('buildConstitution (FR-006)', () => {
  it('preenche o template com os metadados da demanda, sem placeholders sobrando', () => {
    const constitution = buildConstitution(demand);
    expect(constitution).toContain('Exportar relatório mensal');
    expect(constitution).toContain('feature');
    expect(constitution).toContain('alta');
    expect(constitution).toContain('#42');
    expect(constitution).not.toContain('{{');
  });

  it('é determinística para a mesma demanda', () => {
    expect(buildConstitution(demand)).toBe(buildConstitution(demand));
  });
});
