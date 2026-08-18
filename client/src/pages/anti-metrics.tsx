import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  ArrowLeft,
  Shield,
  TrendingDown,
  Calendar,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/Breadcrumbs/Breadcrumbs';
import { apiRequest } from '@/lib/queryClient';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AntiMetricsSummary {
  totalInterventions: number;
  totalDiasEconomizados: number;
  overridesCount: number;
  interventionsByMonth: Array<{
    month: string;
    interventions: number;
    diasEconomizados: number;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMonth(yyyymm: string): string {
  const [year, month] = yyyymm.split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AntiMetricsPage() {
  const { data, isLoading, isError } = useQuery<AntiMetricsSummary>({
    queryKey: ['/api/anti-overengineering/metrics'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/anti-overengineering/metrics?months=6');
      return res.json();
    },
    staleTime: 30_000,
  });

  const chartData = (data?.interventionsByMonth ?? []).map((row) => ({
    ...row,
    mes: formatMonth(row.month),
  }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-500" />
          <h1 className="text-lg font-semibold">Métricas Anti-Overengineering</h1>
        </div>
      </div>

      <div className="container mx-auto px-6 py-8 max-w-5xl space-y-8">
        <Breadcrumbs path="/admin/metricas-anti" />

        {isLoading && (
          <div className="text-center py-16 text-muted-foreground">Carregando métricas…</div>
        )}

        {isError && (
          <div className="flex items-center gap-2 text-destructive py-8">
            <AlertTriangle className="h-5 w-5" />
            Não foi possível carregar as métricas. Verifique se o servidor está rodando.
          </div>
        )}

        {data && (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1">
                    <Shield className="h-3.5 w-3.5" />
                    Intervenções (6 meses)
                  </CardDescription>
                  <CardTitle className="text-3xl">{data.totalInterventions}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Total de pareceres emitidos pelo agente
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1">
                    <TrendingDown className="h-3.5 w-3.5 text-green-500" />
                    Dias economizados
                  </CardDescription>
                  <CardTitle className="text-3xl text-green-600">
                    {data.totalDiasEconomizados.toFixed(1)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Redução acumulada de esforço estimado
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    Overrides registrados
                  </CardDescription>
                  <CardTitle className="text-3xl text-amber-600">{data.overridesCount}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Intervenções ignoradas com justificativa
                </CardContent>
              </Card>
            </div>

            {/* Monthly bar chart */}
            {chartData.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Calendar className="h-4 w-4" />
                    Dias economizados por mês
                  </CardTitle>
                  <CardDescription>
                    Impacto acumulado de esforço reduzido nas últimas 6 competências
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis
                        dataKey="mes"
                        tick={{ fontSize: 12 }}
                        className="fill-muted-foreground"
                      />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        className="fill-muted-foreground"
                        label={{
                          value: 'dias',
                          angle: -90,
                          position: 'insideLeft',
                          fontSize: 11,
                          fill: 'var(--muted-foreground)',
                        }}
                      />
                      <Tooltip
                        formatter={(value: number) => [`${value.toFixed(1)} dias`, 'Economizados']}
                        labelFormatter={(l) => `Mês: ${l}`}
                        contentStyle={{
                          background: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="diasEconomizados"
                        fill="var(--chart-2, #22c55e)"
                        radius={[3, 3, 0, 0]}
                        name="Dias economizados"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground flex flex-col items-center gap-2">
                  <CheckCircle className="h-8 w-8 opacity-40" />
                  <p>Nenhuma intervenção registrada nos últimos 6 meses.</p>
                  <p className="text-xs">
                    O agente anti-overengineering precisará ser acionado em ao menos uma demanda
                    técnica/business para gerar dados aqui.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Monthly table */}
            {chartData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Detalhamento mensal</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 pr-4 font-medium">Mês</th>
                        <th className="text-right py-2 pr-4 font-medium">Intervenções</th>
                        <th className="text-right py-2 font-medium">Dias economizados</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chartData.map((row) => (
                        <tr key={row.month} className="border-b border-border/50 hover:bg-muted/30">
                          <td className="py-2 pr-4">{row.mes}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.interventions}</td>
                          <td className="py-2 text-right tabular-nums text-green-600 font-medium">
                            {row.diasEconomizados.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-border font-semibold">
                        <td className="py-2 pr-4">Total</td>
                        <td className="py-2 pr-4 text-right">{data.totalInterventions}</td>
                        <td className="py-2 text-right text-green-600">
                          {data.totalDiasEconomizados.toFixed(1)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
