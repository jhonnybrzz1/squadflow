/**
 * CostQualityDashboard — Dia 6 do plano de otimização de custos
 *
 * Exibe métricas de custo, routing, cache e kill-switch em tempo real.
 * Fonte: GET /api/admin/cost-logs
 * Atualização automática a cada 30 segundos.
 */

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  TrendingDown,
  Zap,
  Database,
  ShieldOff,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CostMetrics {
  timestamp: string;
  window: { start: string; end: string; durationMs: number };
  baseline: { period: string; avgCostPerRequest: number; totalRequests: number };
  current: {
    avgCostPerRequest: number;
    totalRequests: number;
    changeFromBaseline: number;
    changePercent: number;
  };
  routing: {
    economicRate: number;
    safeRate: number;
    fallbackRate: number;
    economicCount: number;
    safeCount: number;
    fallbackCount?: number;
  };
  cache: {
    hitRate: number;
    totalHits: number;
    totalMisses: number;
    estimatedCostSaved: number;
  };
  quality: { errorRate: number; timeoutRate: number; emptyResponseRate: number };
  latency: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
  killSwitch: {
    active: boolean;
    disabledComponent: string | null;
    triggerReason: string | null;
    triggeredAt: string | null;
  };
}

// ─── Routing Badge ────────────────────────────────────────────────────────────

export function RoutingBadge({ mode }: { mode: 'economic' | 'safe' | 'unknown' }) {
  const styles: Record<string, string> = {
    economic: 'bg-emerald-100 text-emerald-800 border border-emerald-300',
    safe: 'bg-blue-100 text-blue-800 border border-blue-300',
    unknown: 'bg-gray-100 text-gray-600 border border-gray-300',
  };
  const labels: Record<string, string> = {
    economic: 'Routing: Economic',
    safe: 'Routing: Safe',
    unknown: 'Routing: Unknown',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${styles[mode]}`}
    >
      {labels[mode]}
    </span>
  );
}

export function CacheBadge({ hit }: { hit: boolean | null }) {
  if (hit === null)
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-yellow-100 text-yellow-800 border border-yellow-300">
        Cache: BYPASS
      </span>
    );
  return hit ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
      Cache: HIT
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-gray-100 text-gray-600 border border-gray-300">
      Cache: MISS
    </span>
  );
}

export function FallbackBadge({ used }: { used: boolean }) {
  return used ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-red-100 text-red-700 border border-red-300">
      Fallback: sim
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold bg-gray-100 text-gray-500 border border-gray-300">
      Fallback: nao
    </span>
  );
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  icon: Icon,
  title,
  value,
  sub,
  help,
  color = 'cyan',
}: {
  icon: React.ElementType;
  title: string;
  value: string;
  sub?: string;
  /** Spec 008 / US6: explicação da métrica para operador não-técnico (tooltip). */
  help?: string;
  color?: 'cyan' | 'green' | 'red' | 'yellow' | 'blue';
}) {
  const colorMap: Record<string, string> = {
    cyan: 'text-[var(--accent-cyan)] border-[var(--accent-cyan)]',
    green: 'text-green-500 border-green-500',
    red: 'text-red-500 border-red-500',
    yellow: 'text-yellow-500 border-yellow-500',
    blue: 'text-blue-500 border-blue-500',
  };
  return (
    <div className="neo-card p-4 flex flex-col gap-2">
      <div className={`flex items-center gap-2 ${colorMap[color]}`}>
        <Icon className="w-4 h-4" />
        <span className="font-mono text-xs uppercase tracking-wider">{title}</span>
        {help && (
          <span
            title={help}
            aria-label={`Ajuda: ${title}. ${help}`}
            className="ml-auto cursor-help"
          >
            <HelpCircle className="w-3.5 h-3.5 opacity-60" aria-hidden="true" />
          </span>
        )}
      </div>
      <p className="font-mono text-2xl font-bold">{value}</p>
      {sub && <p className="font-mono text-xs text-[var(--foreground-muted)]">{sub}</p>}
    </div>
  );
}

/**
 * Spec 008 / US6: descreve, em linguagem de produto, a ação que o kill-switch
 * executa sobre o componente desativado — o QA apontou que "ATIVO" sem ação
 * sugerida deixava o operador sem saber o que estava acontecendo.
 */
export function describeKillSwitchAction(component: string | null): string {
  switch (component) {
    case 'routing':
      return 'Ação em curso: o roteamento econômico foi pausado — todas as chamadas seguem no modelo seguro padrão até o custo voltar ao normal.';
    case 'cache':
      return 'Ação em curso: o cache de respostas foi desativado temporariamente — todas as chamadas vão direto ao modelo.';
    default:
      return `Ação em curso: o componente "${component ?? 'desconhecido'}" foi desativado automaticamente até nova avaliação.`;
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CostQualityDashboard() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery<CostMetrics>({
    queryKey: ['/api/admin/cost-logs'],
    queryFn: async () => {
      const res = await fetch('/api/admin/cost-logs?windowMs=900000');
      if (!res.ok) throw new Error('Falha ao carregar métricas');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('pt-BR') : '-';

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-2xl font-bold">CUSTO &amp; QUALIDADE</h1>
          <p className="font-mono text-xs text-[var(--foreground-muted)] mt-1">
            Janela 15 min — atualizado em {lastUpdate}
          </p>
          <p className="font-mono text-[11px] text-[var(--foreground-muted)] mt-1">
            Valores em mUSD = milésimos de dólar (US$ 0,001). Todas as métricas consideram apenas os
            últimos 15 minutos de requisições.
          </p>
        </div>
        {data?.killSwitch.active && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-100 border border-red-500 text-red-700 font-mono text-sm font-bold">
            <ShieldOff className="w-4 h-4" />
            KILL-SWITCH ATIVO — {data.killSwitch.disabledComponent?.toUpperCase()}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="neo-card p-8 text-center font-mono text-sm text-[var(--foreground-muted)]">
          Carregando métricas...
        </div>
      )}

      {isError && (
        <div className="neo-card p-8 text-center font-mono text-sm text-red-500">
          Erro ao carregar métricas — verifique se o servidor esta ativo.
        </div>
      )}

      {data && (
        <>
          {/* Cost Cards */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--foreground-muted)] mb-4">
              Custo
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                icon={TrendingDown}
                title="Custo medio"
                value={`$${(data.current.avgCostPerRequest * 1000).toFixed(4)}`}
                sub="por request (mUSD)"
                help="Custo médio por requisição de IA na janela de 15 min, em milésimos de dólar (mUSD). Ex.: $1.0 mUSD = US$ 0,001."
                color={
                  data.current.changePercent < 0
                    ? 'green'
                    : data.current.changePercent > 20
                      ? 'red'
                      : 'cyan'
                }
              />
              <MetricCard
                icon={TrendingDown}
                title="Variacao baseline"
                value={`${data.current.changePercent >= 0 ? '+' : ''}${data.current.changePercent.toFixed(1)}%`}
                sub={`baseline: $${(data.baseline.avgCostPerRequest * 1000).toFixed(4)} mUSD`}
                help="Quanto o custo médio atual está acima (+) ou abaixo (-) do custo de referência histórico (baseline). Acima de +10% acende alerta; picos podem acionar o kill-switch."
                color={
                  data.current.changePercent > 10
                    ? 'red'
                    : data.current.changePercent < -5
                      ? 'green'
                      : 'cyan'
                }
              />
              <MetricCard
                icon={Database}
                title="Cache economizado"
                value={`$${(data.cache.estimatedCostSaved * 1000).toFixed(4)}`}
                sub="mUSD na janela"
                help="Estimativa de quanto deixou de ser gasto porque respostas idênticas foram reaproveitadas do cache em vez de chamar o modelo."
                color="green"
              />
              <MetricCard
                icon={Zap}
                title="Requests"
                value={String(data.current.totalRequests)}
                sub="na janela"
                color="cyan"
              />
            </div>
          </section>

          {/* Routing */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--foreground-muted)] mb-4">
              Routing
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <MetricCard
                icon={TrendingDown}
                title="Economic"
                value={`${(data.routing.economicRate * 100).toFixed(1)}%`}
                sub={`${data.routing.economicCount} requests`}
                help="Percentual de requisições atendidas por modelos mais baratos (roteamento econômico). Quanto maior, menor o custo — desde que a qualidade se mantenha."
                color="green"
              />
              <MetricCard
                icon={TrendingDown}
                title="Safe"
                value={`${(data.routing.safeRate * 100).toFixed(1)}%`}
                sub={`${data.routing.safeCount} requests`}
                help="Percentual de requisições roteadas para o modelo padrão/seguro (mais caro, mais previsível)."
                color="blue"
              />
              <MetricCard
                icon={AlertTriangle}
                title="Fallback rate"
                value={`${(data.routing.fallbackRate * 100).toFixed(1)}%`}
                sub="meta: < 2%"
                help="Percentual de requisições em que o modelo primário falhou e um modelo reserva assumiu. Acima de 2% indica instabilidade de provider."
                color={data.routing.fallbackRate > 0.02 ? 'red' : 'green'}
              />
            </div>
          </section>

          {/* Cache */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--foreground-muted)] mb-4">
              Cache
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <MetricCard
                icon={Database}
                title="Hit rate"
                value={`${(data.cache.hitRate * 100).toFixed(1)}%`}
                sub="meta: >= 20%"
                help="Percentual de requisições respondidas direto do cache (sem custo de modelo). Meta: pelo menos 20% na janela."
                color={
                  data.cache.hitRate >= 0.2 ? 'green' : data.cache.hitRate < 0.1 ? 'red' : 'yellow'
                }
              />
              <MetricCard
                icon={CheckCircle}
                title="Hits"
                value={String(data.cache.totalHits)}
                sub="na janela"
                color="green"
              />
              <MetricCard
                icon={AlertTriangle}
                title="Misses"
                value={String(data.cache.totalMisses)}
                sub="na janela"
                color="cyan"
              />
            </div>
          </section>

          {/* Quality + Latency */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--foreground-muted)] mb-4">
              Qualidade &amp; Latencia
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                icon={AlertTriangle}
                title="Error rate"
                value={`${(data.quality.errorRate * 100).toFixed(2)}%`}
                color={data.quality.errorRate > 0.01 ? 'red' : 'green'}
              />
              <MetricCard
                icon={AlertTriangle}
                title="Timeout rate"
                value={`${(data.quality.timeoutRate * 100).toFixed(2)}%`}
                color={data.quality.timeoutRate > 0.005 ? 'red' : 'green'}
              />
              <MetricCard
                icon={Zap}
                title="Latencia avg"
                value={`${data.latency.avgMs}ms`}
                sub={`p50: ${data.latency.p50Ms}ms`}
                help="Tempo médio de resposta das chamadas de IA na janela. Chamadas de refinamento completo são naturalmente longas (dezenas de segundos)."
                color="cyan"
              />
              <MetricCard
                icon={Zap}
                title="Latencia p95"
                value={`${data.latency.p95Ms}ms`}
                sub={`p99: ${data.latency.p99Ms}ms`}
                help="95% das chamadas terminaram em até este tempo (p95). Bom para enxergar os piores casos sem distorção de outliers."
                color={data.latency.p95Ms > 5000 ? 'red' : 'cyan'}
              />
            </div>
          </section>

          {/* Kill Switch Status */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--foreground-muted)] mb-4">
              Kill-Switch
            </h2>
            <div
              className={`neo-card p-4 border-2 ${data.killSwitch.active ? 'border-red-500' : 'border-green-500'}`}
            >
              <div className="flex items-center gap-3">
                {data.killSwitch.active ? (
                  <ShieldOff className="w-5 h-5 text-red-500" />
                ) : (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                )}
                <div>
                  <p className="font-mono text-sm font-bold">
                    {data.killSwitch.active ? 'ATIVO' : 'INATIVO'}
                  </p>
                  {data.killSwitch.active ? (
                    <>
                      <p className="font-mono text-xs text-[var(--foreground-muted)]">
                        Componente: {data.killSwitch.disabledComponent} | Motivo:{' '}
                        {data.killSwitch.triggerReason}
                      </p>
                      <p className="font-mono text-xs text-[var(--foreground-muted)] mt-1">
                        {describeKillSwitchAction(data.killSwitch.disabledComponent)}
                      </p>
                    </>
                  ) : (
                    <p className="font-mono text-xs text-[var(--foreground-muted)]">
                      Proteção automática de custo/qualidade. Quando acionada, desativa o componente
                      que violou os limites (ex.: pausa o roteamento econômico em pico de custo) sem
                      derrubar o serviço.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
