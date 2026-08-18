/** @vitest-environment jsdom */
import type {} from '../../../../jest-axe';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DemandForm } from '../../../../client/src/components/demand-form';
import { Toaster } from '../../../../client/src/components/ui/toaster';

const toastMock = vi.hoisted(() => ({
  toast: vi.fn(),
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => toastMock,
}));

vi.mock('@/components/github-import-modal', () => ({
  GitHubImportModal: () => <button type="button">Adicionar Projeto</button>,
}));

const renderDemandForm = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DemandForm />
    </QueryClientProvider>,
  );
};

describe('DemandForm accessibility', () => {
  beforeEach(() => {
    toastMock.toast.mockClear();
    toastMock.toasts = [];
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('exposes visible labels and helper text for required fields', () => {
    renderDemandForm();

    const titleInput = screen.getByLabelText(/título da demanda/i);
    const descriptionInput = screen.getByLabelText(/descrição detalhada/i);
    const titleHelper = screen.getByText('Resuma o objetivo da demanda em uma frase clara.');
    const descriptionHelper = screen.getByText(
      'Explique contexto, objetivo e resultado esperado da demanda.',
    );

    expect(titleInput.getAttribute('required')).not.toBeNull();
    expect(descriptionInput.getAttribute('required')).not.toBeNull();
    expect(titleInput.getAttribute('aria-describedby')).toContain(titleHelper.getAttribute('id'));
    expect(descriptionInput.getAttribute('aria-describedby')).toContain(
      descriptionHelper.getAttribute('id'),
    );
  });

  it('shows an error summary with links to invalid fields and moves focus to the chosen field', async () => {
    renderDemandForm();

    fireEvent.click(screen.getByRole('button', { name: /refinar demanda/i }));

    const summary = await screen.findByRole('alert');
    expect(summary.textContent).toContain('2 erros encontrados no formulário');

    const titleLink = screen.getByRole('link', { name: /informe um título para a demanda/i });
    const descriptionLink = screen.getByRole('link', {
      name: /descreva a demanda com detalhes suficientes para a squad/i,
    });
    const titleInput = screen.getByLabelText(/título da demanda/i);

    expect(summary.getAttribute('aria-live')).toBe('assertive');
    expect(titleLink.getAttribute('href')).toBe(`#${titleInput.getAttribute('id')}`);
    expect(descriptionLink.getAttribute('href')).toBe(
      `#${screen.getByLabelText(/descrição detalhada/i).getAttribute('id')}`,
    );

    fireEvent.click(titleLink);

    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput);
    });
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('has no accessibility violations in the critical invalid-form state', async () => {
    const { container } = renderDemandForm();
    const { axe } = await import('jest-axe');

    fireEvent.click(screen.getByRole('button', { name: /refinar demanda/i }));

    await screen.findByRole('alert');

    const results = await axe(container, {
      runOnly: {
        type: 'rule',
        values: ['label', 'aria-input-field-name'],
      },
    });
    expect(results.violations).toHaveLength(0);
  });
});

describe('Toast accessibility', () => {
  it('announces toast content through a polite live region', async () => {
    const { axe } = await import('jest-axe');
    toastMock.toasts = [
      {
        id: 'toast-1',
        open: true,
        title: 'Demanda criada',
        description: 'Os agentes começaram o processamento.',
      },
    ];

    render(<Toaster />);

    const liveRegion = screen.getByTestId('toast-live-region');
    expect(liveRegion.getAttribute('role')).toBe('status');
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.getAttribute('aria-atomic')).toBe('true');
    expect(screen.getByText('Demanda criada')).toBeTruthy();
    expect(liveRegion.textContent).toContain('Demanda criada');

    const results = await axe(liveRegion, {
      runOnly: {
        type: 'rule',
        values: ['aria-valid-attr-value', 'aria-allowed-attr'],
      },
    });
    expect(results.violations).toHaveLength(0);
  });
});
