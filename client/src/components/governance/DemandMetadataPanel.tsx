import { useQuery } from '@tanstack/react-query';
import { Info, Loader2, AlertCircle } from 'lucide-react';

import type { DemandMetadata } from '@shared/demand-metadata';

interface DemandMetadataPanelProps {
  demandId: number;
}

const DASH = '—';

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
}

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return '<$0.0001';
  return `$${cost.toFixed(4)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString('pt-BR');
}

function orDash(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : DASH;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[10px] uppercase text-[var(--foreground-muted)]">
        {label}
      </span>
      <span className="font-mono text-xs" data-testid={`meta-${label}`}>
        {value}
      </span>
    </div>
  );
}

export function DemandMetadataPanel({ demandId }: DemandMetadataPanelProps) {
  const { data, isLoading, error } = useQuery<DemandMetadata>({
    queryKey: [`/api/demands/${demandId}/metadata`],
    queryFn: async () => {
      const response = await fetch(`/api/demands/${demandId}/metadata`);
      if (!response.ok) {
        throw new Error('Failed to fetch demand metadata');
      }
      return response.json();
    },
  });

  return (
    <div className="border border-[var(--border)] p-3" data-testid="demand-metadata-panel">
      <div className="flex items-center gap-2 mb-3">
        <Info className="w-4 h-4 text-[var(--accent-gold)]" />
        <h3 className="font-mono text-xs font-bold uppercase">Metadados da demanda</h3>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 font-mono text-xs text-[var(--foreground-muted)]">
          <Loader2 className="w-3 h-3 animate-spin" /> Carregando…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 font-mono text-xs text-[var(--foreground-muted)]">
          <AlertCircle className="w-3 h-3" /> Metadados indisponíveis
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
          <Field label="ID" value={`#${data.id}`} />
          <Field label="Tipo" value={orDash(data.type)} />
          <Field label="Prioridade" value={orDash(data.priority)} />
          <Field label="Refinamento" value={orDash(data.refinementType)} />
          <Field label="Domínio" value={orDash(data.domain)} />
          <Field label="Status" value={orDash(data.status)} />
          <Field label="Agentes" value={String(data.agentCount)} />
          <Field label="Quality gate" value={orDash(data.qualityGateStatus)} />
          <Field
            label="Tokens"
            value={`${formatTokens(data.promptTokens)} / ${formatTokens(data.completionTokens)}`}
          />
          <Field label="Custo" value={formatCost(data.custoEstimado)} />
          <Field label="Repositório" value={orDash(data.repoFullName)} />
          <Field label="Criada" value={formatDate(data.createdAt)} />
          <Field label="Concluída" value={formatDate(data.completedAt)} />
          <Field label="Atualizada" value={formatDate(data.updatedAt)} />
        </div>
      )}
    </div>
  );
}
