// @vitest-environment jsdom
/**
 * Spec 10006 (FR-003/004, T014, SC-004) — useDemandContext + DemandContextHeader.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDemandContext } from '../../../../client/src/hooks/useDemandContext';
import { DemandContextHeader } from '../../../../client/src/components/demand-context-header';

const DEMAND = { id: 10006, title: 'Incluir metadados na tela' };
const MANIFEST = {
  format: 'aichatflow-handoff/v1',
  demandId: 10006,
  demandTitle: 'Incluir metadados na tela',
  generatedAt: '2026-07-18T12:00:00.000Z',
  documentCount: 4,
  hasSpec: true,
  hasTasks: true,
  hasConstitution: true,
  warnings: [],
};

function makeFetch(handoffStatus = 200) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/export/bundle/manifest')) {
      if (handoffStatus === 422 || handoffStatus === 404) {
        return new Response('{}', { status: handoffStatus });
      }
      if (handoffStatus >= 500) {
        return new Response('erro', { status: handoffStatus });
      }
      return new Response(JSON.stringify(MANIFEST), { status: 200 });
    }
    // GET /api/demands/:id
    return new Response(JSON.stringify(DEMAND), { status: 200 });
  });
}

function renderWithClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe('useDemandContext (spec 10006)', () => {
  it('expõe demandId, demandTitle e handoffMetadata juntos', async () => {
    vi.stubGlobal('fetch', makeFetch());
    let value: ReturnType<typeof useDemandContext> | null = null;
    function Consumer() {
      value = useDemandContext(10006);
      return null;
    }
    renderWithClient(<Consumer />);
    await waitFor(() => expect(value?.demandTitle).toBe('Incluir metadados na tela'));
    expect(value?.demandId).toBe(10006);
    expect(value?.handoffMetadata?.documentCount).toBe(4);
    expect(value?.error).toBeNull();
    expect(value?.isLoading).toBe(false);
  });

  it('retorna tudo null quando demandId é null (sem demanda ativa)', async () => {
    function Consumer() {
      const v = useDemandContext(null);
      return <span data-testid="v">{v.demandId === null ? 'null' : 'not-null'}</span>;
    }
    renderWithClient(<Consumer />);
    expect(screen.getByTestId('v').textContent).toBe('null');
  });

  it('trata demanda sem handoff (422) sem quebrar', async () => {
    vi.stubGlobal('fetch', makeFetch(422));
    let value: ReturnType<typeof useDemandContext> | null = null;
    function Consumer() {
      value = useDemandContext(10006);
      return null;
    }
    renderWithClient(<Consumer />);
    await waitFor(() => expect(value?.demandTitle).toBe('Incluir metadados na tela'));
    expect(value?.handoffMetadata).toBeNull();
  });

  it('reage a mudança de demandId (FR-004)', async () => {
    vi.stubGlobal('fetch', makeFetch());
    function Consumer({ id }: { id: number }) {
      const v = useDemandContext(id);
      return (
        <span data-testid="v">
          {v.demandId}:{v.demandTitle ?? 'loading'}
        </span>
      );
    }
    const { rerender } = renderWithClient(<Consumer id={10006} />);
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent).toBe('10006:Incluir metadados na tela'),
    );
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Consumer id={10007} />
      </QueryClientProvider>,
    );
    // demandId muda imediatamente; title recarrega
    await waitFor(() =>
      expect(screen.getByTestId('v').textContent?.startsWith('10007:')).toBe(true),
    );
  });
});

describe('DemandContextHeader (spec 10006, T007)', () => {
  it('exibe id, título e badge de handoff ativo', async () => {
    vi.stubGlobal('fetch', makeFetch());
    renderWithClient(<DemandContextHeader demandId={10006} />);
    expect(await screen.findByText(/#10006 — Incluir metadados na tela/)).toBeTruthy();
    expect(screen.getByText(/handoff ativo/)).toBeTruthy();
  });

  it('exibe "Nenhuma demanda selecionada" quando demandId é null', () => {
    renderWithClient(<DemandContextHeader demandId={null} />);
    expect(screen.getByTestId('demand-context-header').textContent).toContain(
      'Nenhuma demanda selecionada',
    );
  });

  it('exibe "Nenhum handoff gerado ainda" quando demanda não tem handoff', async () => {
    vi.stubGlobal('fetch', makeFetch(422));
    renderWithClient(<DemandContextHeader demandId={10006} />);
    await waitFor(() =>
      expect(screen.getByTestId('demand-context-header').textContent).toContain(
        'Nenhum handoff gerado ainda',
      ),
    );
  });
});
