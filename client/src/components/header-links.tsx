import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Activity, CreditCard, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

// Spec 10013 US5 (item 6): link para o dashboard de telemetria (Grafana). URL
// configurável via env (FR-009); oculto quando não configurada (edge case).
const GRAFANA_URL = import.meta.env.VITE_GRAFANA_URL as string | undefined;

const HEADER_BTN =
  'min-w-[44px] min-h-[44px] h-11 flex items-center justify-center gap-1.5 px-2 border border-[var(--border)] font-mono text-xs hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] active:scale-95 transition-all duration-150 motion-reduce:transform-none';

export function GrafanaLink() {
  if (!GRAFANA_URL) return null;
  return (
    <a
      href={GRAFANA_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={HEADER_BTN}
      title="Abrir dashboard de telemetria (Grafana)"
      aria-label="Abrir telemetria no Grafana (nova aba)"
    >
      <Activity className="w-5 h-5" aria-hidden="true" />
      <span className="hidden sm:inline">Telemetria</span>
    </a>
  );
}

// Spec 10013 US6 (item 7): badge de saldo OpenRouter no header, com estados de
// loading/erro (FR-010). Clique leva ao dashboard admin (detalhes do saldo).
// Reusa a queryKey do BillingBalance para compartilhar cache.
export function CreditsBadge() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['openRouterBalance'],
    queryFn: () => api.billing.getBalance(),
    refetchInterval: 300_000,
  });

  const label = isError
    ? 'erro'
    : isPending
      ? '…'
      : data?.balance == null
        ? 'Plano ∞'
        : `$${data.balance.toFixed(2)}`;

  return (
    <Link
      href="/admin/dashboard"
      className={HEADER_BTN}
      title="Ver saldo de créditos OpenRouter"
      aria-label={`Créditos OpenRouter: ${label}. Abrir detalhes.`}
    >
      {isError ? (
        <AlertCircle className="w-5 h-5 text-[var(--destructive)]" aria-hidden="true" />
      ) : isPending ? (
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
      ) : (
        <CreditCard className="w-5 h-5" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}
