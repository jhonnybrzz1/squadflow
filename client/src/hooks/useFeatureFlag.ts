/**
 * Demanda 10076 — helper de feature flag no frontend.
 *
 * Lê o estado das flags via `/api/admin/feature-flags` (mesma fonte usada pelo
 * card de segurança do admin) e retorna um boolean com **fallback seguro
 * `false`** — um módulo novo nunca fica exposto por acidente se a flag não
 * existir ou a chamada falhar. Não gateia a visibilidade do módulo em si
 * (a rota/menu sempre existe); serve para revelar conteúdo real vs. "Em breve".
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Chaves de flag conhecidas pelo frontend (evita typo em string solta). */
export type ClientFeatureFlagKey =
  | 'retrospectiveModuleEnabled'
  | 'enableNewProductFeatures'
  | 'enableUserFeedbackSystem'
  | 'goLiveEnabled';

export function useFeatureFlag(key: ClientFeatureFlagKey): boolean {
  const { data } = useQuery({
    queryKey: ['feature-flags'],
    queryFn: () => api.admin.featureFlags.list(),
    staleTime: 60_000,
    // Falha na leitura das flags nunca deve derrubar a tela — o fallback abaixo
    // resolve para `false` (seguro) quando `data` está indisponível.
    retry: false,
  });

  const flag = data?.flags.find((f) => f.key === key);
  return flag?.enabled === true;
}
