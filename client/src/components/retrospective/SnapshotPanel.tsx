/**
 * Demanda 10195 — Painel de snapshot de evidência para retrospectiva.
 */
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { RetroSnapshotDto } from '@shared/retrospective';

interface SnapshotPanelProps {
  snapshot: RetroSnapshotDto | null | undefined;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(value);
}

function KpiCard({
  label,
  value,
  unit,
  variant,
}: {
  label: string;
  value: string;
  unit?: string;
  variant: 'default' | 'success' | 'warning' | 'danger';
}) {
  const variantClasses = {
    default: 'border-[var(--border)]',
    success: 'border-green-600/30 bg-green-600/10',
    warning: 'border-orange-500/30 bg-orange-500/10',
    danger: 'border-red-500/30 bg-red-500/10',
  };

  return (
    <Card className={`brutal-card ${variantClasses[variant]}`}>
      <CardContent className="p-4">
        <p className="text-[10px] uppercase font-mono text-[var(--foreground-muted)]">{label}</p>
        <p className="text-2xl font-bold font-mono mt-1">{value}</p>
        {unit && <p className="text-xs text-[var(--foreground-muted)] font-mono">{unit}</p>}
      </CardContent>
    </Card>
  );
}

export default function SnapshotPanel({ snapshot }: SnapshotPanelProps) {
  if (!snapshot) {
    return (
      <Card className="brutal-card lg:col-span-2">
        <CardHeader>
          <CardTitle className="font-mono text-sm font-bold">Snapshot do Período</CardTitle>
          <CardDescription className="text-[10px] uppercase">
            Gere uma retrospectiva para ver as métricas do período selecionado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-[var(--foreground-muted)] font-mono">
            Nenhum snapshot disponível. Selecione um período e clique em "Gerar Snapshot de
            Evidência" para visualizar os KPIs.
          </p>
        </CardContent>
      </Card>
    );
  }

  const completionRate =
    snapshot.demands > 0 ? ((snapshot.completed / snapshot.demands) * 100).toFixed(1) : '0.0';

  return (
    <Card className="brutal-card lg:col-span-2" data-testid="snapshot-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-mono text-sm font-bold">Snapshot do Período</CardTitle>
            <CardDescription className="text-[10px] uppercase">
              {snapshot.periodStart} → {snapshot.periodEnd}
            </CardDescription>
          </div>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            Evidência
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard label="Volume de Demandas" value={String(snapshot.demands)} variant="default" />
          <KpiCard
            label="Taxa de Conclusão"
            value={`${completionRate}%`}
            unit={`${snapshot.completed} / ${snapshot.demands}`}
            variant={Number(completionRate) >= 80 ? 'success' : 'warning'}
          />
          <KpiCard
            label="Consumo de Tokens"
            value={new Intl.NumberFormat('pt-BR').format(snapshot.tokens)}
            variant="default"
          />
          <KpiCard
            label="Custo Estimado"
            value={formatCurrency(snapshot.cost)}
            variant={snapshot.cost > 0 ? 'warning' : 'default'}
          />
        </div>
      </CardContent>
    </Card>
  );
}
