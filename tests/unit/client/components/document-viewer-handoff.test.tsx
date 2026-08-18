// @vitest-environment jsdom
/**
 * Spec 018 T010 — botão "Exportar handoff" no DocumentViewer (FR-010, US2-AS1).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@uiw/react-md-editor', () => ({ default: () => null }));
vi.mock('@/components/ui/theme-provider', () => ({
  useEnhancedTheme: () => ({ isDarkMode: false }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/friendly-error', () => ({
  getFriendlyErrorFromException: () => ({ title: '', description: '' }),
}));
vi.mock('../../../../client/src/components/type-adherence-badge', () => ({
  TypeAdherenceBadge: () => null,
  TypeAdherenceBadgeCompact: () => null,
}));
vi.mock('../../../../client/src/components/governance/ReviewBanner', () => ({
  ReviewBanner: () => null,
}));
vi.mock('../../../../client/src/components/governance/ApprovalActions', () => ({
  ApprovalActions: () => null,
}));
vi.mock('../../../../client/src/components/governance/ApprovalComments', () => ({
  ApprovalComments: () => null,
}));
vi.mock('../../../../client/src/components/governance/GovernanceGatingPanel', () => ({
  GovernanceGatingPanel: () => null,
}));
vi.mock('../../../../client/src/components/governance/RefinementInteractions', () => ({
  RefinementInteractions: () => null,
}));
vi.mock('../../../../client/src/components/governance/PrdSectionEvidence', () => ({
  PrdSectionEvidence: () => null,
}));
vi.mock('../../../../client/src/components/governance/DemandCostBreakdown', () => ({
  DemandCostBreakdown: () => null,
}));
vi.mock('../../../../client/src/components/governance/SnapshotDiffViewer', () => ({
  SnapshotDiffViewer: () => null,
}));

import { DocumentViewer } from '../../../../client/src/components/document-viewer';

function renderViewer(props: Partial<Parameters<typeof DocumentViewer>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentViewer demandId={1} documentType="prd" {...props} />
    </QueryClientProvider>,
  );
}

describe('DocumentViewer — botão Exportar handoff (spec 018)', () => {
  it('habilitado quando a demanda tem PRD (pdfUrl presente)', () => {
    renderViewer({ pdfUrl: '/documents/PRD_1.pdf' });
    const button = screen.getByRole('button', { name: 'Exportar handoff da demanda' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('desabilitado com aria-label explicativo quando não há PRD', () => {
    renderViewer({ pdfUrl: undefined });
    const button = screen.getByRole('button', {
      name: 'Exportar handoff indisponível: PRD ainda não gerado',
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('não aparece para documentos que não são PRD', () => {
    renderViewer({ documentType: 'tasks', pdfUrl: '/documents/Tasks_1.pdf' });
    expect(screen.queryByRole('button', { name: /handoff/i })).toBeNull();
  });

  it('clique abre o download da rota de bundle', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    renderViewer({ pdfUrl: '/documents/PRD_1.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Exportar handoff da demanda' }));
    expect(openSpy).toHaveBeenCalledWith('/api/demands/1/export/bundle', '_blank');
    vi.unstubAllGlobals();
  });
});
