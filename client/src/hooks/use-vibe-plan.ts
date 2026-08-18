/**
 * Demanda #10364 T6/T7 — hook reativo para o plano ativo do usuário.
 *
 * Busca `/api/me/plan` quando autenticado; refaz a cada refinamento via
 * `invalidate()`. Usado pelo banner de limite atingido (T7) e pelo
 * dashboard do usuário (T6).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { vibeApi, type VibePlan } from '@/lib/vibe-api';
import { useVibeAuth } from '@/hooks/use-vibe-auth';

export const VIBE_PLAN_KEY = ['/api/me/plan'] as const;

export function useVibePlan({ enabled = true }: { enabled?: boolean } = {}) {
  const { isAuthenticated } = useVibeAuth();
  const queryClient = useQueryClient();

  const { data: plan, isLoading } = useQuery<VibePlan>({
    queryKey: VIBE_PLAN_KEY,
    queryFn: () => vibeApi.plan.get(),
    enabled: enabled && isAuthenticated,
    staleTime: 30_000,
  });

  return {
    plan,
    isLoading,
    invalidate: () => queryClient.invalidateQueries({ queryKey: VIBE_PLAN_KEY }),
  };
}
