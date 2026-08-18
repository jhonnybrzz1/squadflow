import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import type { BalanceResponse } from '@shared/billing-balance';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type BillingBalanceViewProps = {
  data?: BalanceResponse;
  loading: boolean;
  unavailable: boolean;
};

export function BillingBalanceView({ data, loading, unavailable }: BillingBalanceViewProps) {
  if (loading && !data) {
    return (
      <BillingCard tone="muted" badge="CARREGANDO">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span>Consultando saldo OpenRouter…</span>
      </BillingCard>
    );
  }

  if (unavailable && !data) {
    return (
      <BillingCard tone="danger" badge="INDISPONÍVEL">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
        <span>Não foi possível carregar</span>
      </BillingCard>
    );
  }

  if (!data) return null;

  if (data.stale) {
    return (
      <BillingCard tone="muted" badge="STALE">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
        <span>{formatBalance(data.balance)}</span>
        <small>Última leitura: {formatTimestamp(data.cachedAt)}</small>
      </BillingCard>
    );
  }

  if (data.balance === null) {
    return (
      <BillingCard tone="success" badge="OK">
        <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        <span>Plano ilimitado</span>
      </BillingCard>
    );
  }

  if (data.status === 'empty') {
    return (
      <BillingCard tone="danger" badge="ESGOTADO">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
        <span>{formatBalance(data.balance)}</span>
        <small>Saldo esgotado</small>
      </BillingCard>
    );
  }

  if (data.status === 'low') {
    return (
      <BillingCard tone="warning" badge="BAIXO">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
        <span>{formatBalance(data.balance)}</span>
      </BillingCard>
    );
  }

  return (
    <BillingCard tone="success" badge="OK">
      <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
      <span>{formatBalance(data.balance)}</span>
    </BillingCard>
  );
}

export default function BillingBalance() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['openRouterBalance'],
    queryFn: () => api.billing.getBalance(),
    refetchInterval: 300_000,
  });

  return <BillingBalanceView data={data} loading={isPending} unavailable={isError} />;
}

function BillingCard({
  tone,
  badge,
  children,
}: {
  tone: 'success' | 'warning' | 'danger' | 'muted';
  badge: string;
  children: React.ReactNode;
}) {
  const tones = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
    muted: 'text-muted-foreground',
  };

  return (
    <Card role="status" aria-live="polite">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Saldo OpenRouter
          </CardTitle>
          <span
            className={`rounded-full border border-current px-2 py-0.5 text-meta font-medium ${tones[tone]}`}
          >
            {badge}
          </span>
        </div>
        <CardDescription className="text-xs">Créditos disponíveis em USD</CardDescription>
      </CardHeader>
      <CardContent
        className={`flex items-center gap-3 text-lg font-semibold tracking-tight ${tones[tone]}`}
      >
        {children}
      </CardContent>
    </Card>
  );
}

function formatBalance(balance: number | null): string {
  return balance === null ? 'Plano ilimitado' : `$${balance.toFixed(2)}`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('pt-BR');
}
