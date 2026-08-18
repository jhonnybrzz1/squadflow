/**
 * Demanda #10358 T5 — hook reativo para o contador de uso do Free Tier.
 *
 * Busca `/api/usage` quando autenticado; refaz a cada refinamento bem-sucedido
 * via `invalidate()`. Desabilitado quando não autenticado para evitar 401s
 * desnecessários no header da landing page.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { vibeApi, type VibeUsage } from '@/lib/vibe-api';
import { useVibeAuth } from '@/hooks/use-vibe-auth';

export const VIBE_USAGE_KEY = ['/api/usage'] as const;

export function useVibeUsage({ enabled = true }: { enabled?: boolean } = {}) {
  const { isAuthenticated } = useVibeAuth();
  const queryClient = useQueryClient();

  const { data: usage, isLoading } = useQuery<VibeUsage>({
    queryKey: VIBE_USAGE_KEY,
    queryFn: () => vibeApi.usage.get(),
    enabled: enabled && isAuthenticated,
    staleTime: 30_000,
  });

  return {
    usage,
    isLoading,
    invalidate: () => queryClient.invalidateQueries({ queryKey: VIBE_USAGE_KEY }),
  };
}
