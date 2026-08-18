import { useQuery } from '@tanstack/react-query';
import type { HandoffMetadata } from '@shared/handoff-manifest';

/**
 * Spec 10006 — expõe os metadados do handoff de uma demanda para a tela.
 * Retorna `null` quando a demanda ainda não tem handoff gerável (ex.: sem PRD,
 * 422) — a UI trata como "nenhum handoff ainda" sem quebrar.
 */
export interface UseHandoffManifestResult {
  metadata: HandoffMetadata | null;
  isLoading: boolean;
  error: Error | null;
}

export function useHandoffManifest(demandId: number | null | undefined): UseHandoffManifestResult {
  const query = useQuery<HandoffMetadata | null>({
    queryKey: ['handoff-manifest', demandId],
    enabled: typeof demandId === 'number' && demandId > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/demands/${demandId}/export/bundle/manifest`);
      if (res.status === 422 || res.status === 404) {
        // Sem PRD/handoff ainda, ou demanda inexistente — não é erro de UI.
        return null;
      }
      if (!res.ok) {
        throw new Error(`Falha ao carregar metadados do handoff (${res.status})`);
      }
      return (await res.json()) as HandoffMetadata;
    },
  });

  return {
    metadata: query.data ?? null,
    isLoading: query.isLoading,
    error: (query.error as Error) ?? null,
  };
}
