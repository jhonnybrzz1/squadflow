/**
 * Demanda 10076 — placeholder mínimo ("Em breve") para módulos habilitados no
 * menu mas ainda sem tela própria (Squad, Orquestrações, Relatórios de domínio).
 *
 * Objetivo do incremento: o módulo é VISÍVEL e ACESSÍVEL (rota sem 404), com
 * estado vazio amigável. A `ErrorBoundary` do App já cobre o estado de erro.
 * Nenhuma chamada de backend é feita aqui — não há como quebrar em runtime.
 */
import { useLocation } from 'wouter';
import { Clock } from 'lucide-react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';

const TITLES: Record<string, string> = {
  '/admin/squad': 'Squad de agentes',
  '/admin/orquestracoes': 'Orquestrações',
  '/admin/relatorios': 'Relatórios de domínio',
};

export default function ComingSoonPage() {
  const [location] = useLocation();
  const title = TITLES[location] ?? 'Módulo';
  // Fallback seguro `false`: sem a flag de rollout, mostra o estado padrão "Em breve".
  const rolloutStarted = useFeatureFlag('enableNewProductFeatures');

  return (
    <section
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center"
      data-testid="coming-soon"
    >
      <Clock className="h-8 w-8 text-[var(--accent-cyan)]" aria-hidden="true" />
      <h1 className="text-xl font-semibold text-[var(--foreground)]">{title}</h1>
      <p className="max-w-md text-sm text-[var(--foreground-muted)]">
        {rolloutStarted
          ? 'Este módulo está em rollout — a tela completa está sendo liberada gradualmente.'
          : 'Em breve. Este módulo já está visível no menu; a tela completa será liberada em um próximo incremento.'}
      </p>
    </section>
  );
}
