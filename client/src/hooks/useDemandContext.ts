import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useHandoffManifest } from './useHandoffManifest';
import type { HandoffMetadata } from '@shared/handoff-manifest';

/**
 * Spec 10006 (FR-003) — hook unificado de contexto da demanda. Expõe
 * `demandId`, `demandTitle`, `handoffMetadata`, `isLoading` e `error` para
 * qualquer componente que precise contextualizar respostas pelo handoff.
 *
 * Combina:
 *  - `api.demands.get(id)` para `demandTitle` (e confirmação de existência);
 *  - `useHandoffManifest(id)` para os metadados do handoff.
 *
 * `demandId` null/undefined → retorna tudo null (caso "sem demanda ativa",
 * edge case do spec). Reage a mudanças de demanda ativa via `queryKey` e
 * `enabled` (FR-004).
 */
export interface DemandContextValue {
  demandId: number | null;
  demandTitle: string | null;
  handoffMetadata: HandoffMetadata | null;
  isLoading: boolean;
  error: Error | null;
}

export function useDemandContext(demandId: number | null | undefined): DemandContextValue {
  const enabled = typeof demandId === 'number' && demandId > 0;

  const demandQuery = useQuery({
    queryKey: ['/api/demands', demandId],
    enabled,
    staleTime: 30_000,
    queryFn: () => api.demands.get(demandId as number),
  });

  const handoff = useHandoffManifest(demandId);

  return {
    demandId: enabled ? (demandId as number) : null,
    demandTitle: demandQuery.data?.title ?? null,
    handoffMetadata: handoff.metadata,
    isLoading: demandQuery.isLoading || handoff.isLoading,
    error: (demandQuery.error as Error | null) ?? handoff.error,
  };
}
