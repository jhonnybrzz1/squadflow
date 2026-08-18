import { useHandoffManifest } from '@/hooks/useHandoffManifest';

/**
 * Spec 10006 — exibe na tela os metadados do handoff da demanda (id, título,
 * formato, data de geração, arquivos incluídos) para contextualizar o usuário /
 * o coding agent que consome o handoff. Sem hashes nem URLs internas.
 */
export function HandoffMetadataBadge({ demandId }: { demandId: number }) {
  const { metadata, isLoading, error } = useHandoffManifest(demandId);

  if (isLoading) {
    return (
      <div className="font-mono text-xs text-[var(--foreground-muted)]" data-testid="handoff-meta">
        Carregando metadados do handoff…
      </div>
    );
  }

  if (error || !metadata) {
    return (
      <div className="font-mono text-xs text-[var(--foreground-muted)]" data-testid="handoff-meta">
        Nenhum handoff gerado ainda.
      </div>
    );
  }

  const generated = new Date(metadata.generatedAt).toLocaleString('pt-BR');
  return (
    <div
      className="flex flex-wrap items-center gap-2 font-mono text-xs"
      data-testid="handoff-meta"
      title={`Formato ${metadata.format} · gerado em ${generated}`}
    >
      <span className="font-bold">
        #{metadata.demandId} — {metadata.demandTitle || '(sem título)'}
      </span>
      <span className="text-[var(--foreground-muted)]">
        handoff: {metadata.documentCount} arquivo{metadata.documentCount === 1 ? '' : 's'} · gerado{' '}
        {generated}
      </span>
      {metadata.hasSpec && <span className="brutal-badge">spec</span>}
      {metadata.hasTasks && <span className="brutal-badge">tasks</span>}
      {metadata.hasConstitution && <span className="brutal-badge">constitution</span>}
      {metadata.warnings.length > 0 && (
        <span className="text-[var(--warning,orange)]" title={metadata.warnings.join('; ')}>
          ⚠ {metadata.warnings.length}
        </span>
      )}
    </div>
  );
}
