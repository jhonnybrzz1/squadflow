/**
 * Demanda 10082 (F3, frontend) — Squad de agentes com o modelo ativo de cada um.
 *
 * Consome GET /api/models/overview (batch). Mostra, por agente: o alias
 * configurado, o fallback e o modelo concreto resolvido, com badge indicando
 * quando está rodando em FALLBACK. O endpoint já é fail-open (registry fora do ar
 * devolve `active: null`), então aqui isso vira "não resolvido" em vez de erro.
 *
 * Também fecha o placeholder "Em breve" do módulo Squad (demanda 10076).
 */
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AgentModelView {
  agentId: string;
  model: string | null;
  modelFallback: string | null;
  active: {
    modelId: string;
    provider: string;
    source: string;
    usingFallback: boolean;
  } | null;
}

async function fetchOverview(): Promise<{ agents: AgentModelView[] }> {
  const res = await fetch('/api/models/overview');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { agents: AgentModelView[] };
}

function ModelBadge({ active }: { active: AgentModelView['active'] }) {
  if (!active) {
    return (
      <Badge className="border border-gray-500/30 bg-gray-500/20 text-gray-400">
        não resolvido
      </Badge>
    );
  }
  if (active.usingFallback) {
    return (
      <Badge className="border border-orange-500/30 bg-orange-500/20 text-orange-400">
        fallback
      </Badge>
    );
  }
  return <Badge className="border border-green-600/30 bg-green-600/20 text-green-500">ativo</Badge>;
}

export default function SquadPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['models-overview'],
    queryFn: fetchOverview,
    staleTime: 30_000,
    retry: false,
  });

  const agents = data?.agents ?? [];

  return (
    <section className="mx-auto max-w-4xl px-6 py-8" data-testid="squad-page">
      <h1 className="mb-1 text-xl font-semibold text-[var(--foreground)]">Squad de agentes</h1>
      <p className="mb-6 text-sm text-[var(--foreground-muted)]">
        Modelo em uso por agente. <strong>fallback</strong> indica que o alias resolveu para o
        modelo reserva em vez do original.
      </p>

      {isLoading && <p className="text-sm text-[var(--foreground-muted)]">Carregando agentes…</p>}
      {isError && (
        <p className="text-sm text-[var(--foreground-muted)]">
          Não foi possível carregar os modelos dos agentes.
        </p>
      )}

      {!isLoading && !isError && (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-xs uppercase text-[var(--foreground-muted)]">
              <tr>
                <th className="px-4 py-2">Agente</th>
                <th className="px-4 py-2">Modelo configurado</th>
                <th className="px-4 py-2">Em uso</th>
                <th className="px-4 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agentId} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 align-top">
                    <span className="inline-flex items-center gap-2">
                      <Bot
                        className="h-3.5 w-3.5 text-[var(--foreground-muted)]"
                        aria-hidden="true"
                      />
                      {a.agentId}
                    </span>
                  </td>
                  <td className="px-4 py-2 align-top font-mono text-xs text-[var(--foreground-muted)]">
                    {a.model ?? '—'}
                    {a.modelFallback && (
                      <span className="block opacity-70">reserva: {a.modelFallback}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top font-mono text-xs">
                    {a.active ? (
                      <>
                        {a.active.modelId}
                        <span className="block text-[var(--foreground-muted)] opacity-70">
                          {a.active.provider}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <ModelBadge active={a.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
