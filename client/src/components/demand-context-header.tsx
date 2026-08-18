import { useDemandContext } from '@/hooks/useDemandContext';

/**
 * Spec 10006 (FR-005/006, T007) — cabeçalho reutilizável que exibe o ID e
 * título da demanda ativa e um indicador visual quando um handoff está
 * disponível. Consome `useDemandContext` para reagir a mudanças de demanda
 * ativa (FR-004).
 *
 * Casos de edge (spec §Edge Cases):
 *  - Sem demanda ativa → exibe "Nenhuma demanda selecionada".
 *  - Demanda sem título → exibe "#<id> — (sem título)".
 *  - Sem handoff → exibe "Nenhum handoff gerado ainda." (não quebra).
 *  - Carregando → exibe "Carregando…".
 */
export function DemandContextHeader({ demandId }: { demandId: number | null | undefined }) {
  const { demandTitle, handoffMetadata, isLoading, error } = useDemandContext(demandId);

  if (demandId == null) {
    return (
      <div
        className="font-mono text-xs text-[var(--foreground-muted)]"
        data-testid="demand-context-header"
      >
        Nenhuma demanda selecionada.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        className="font-mono text-xs text-[var(--foreground-muted)]"
        data-testid="demand-context-header"
      >
        Carregando…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="font-mono text-xs text-[var(--warning,orange)]"
        data-testid="demand-context-header"
      >
        Erro ao carregar contexto: {error.message}
      </div>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 font-mono text-xs"
      data-testid="demand-context-header"
    >
      <span className="font-bold">
        #{demandId} — {demandTitle || '(sem título)'}
      </span>
      {handoffMetadata ? (
        <span
          className="brutal-badge"
          title={`Formato ${handoffMetadata.format} · gerado em ${new Date(handoffMetadata.generatedAt).toLocaleString('pt-BR')}`}
        >
          handoff ativo · {handoffMetadata.documentCount} arquivo
          {handoffMetadata.documentCount === 1 ? '' : 's'}
        </span>
      ) : (
        <span className="text-[var(--foreground-muted)]">Nenhum handoff gerado ainda.</span>
      )}
    </div>
  );
}
