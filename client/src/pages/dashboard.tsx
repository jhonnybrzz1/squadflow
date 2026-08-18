import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  AreaChart,
  Area,
} from 'recharts';
import {
  Activity,
  ArrowRight,
  Cpu,
  Database,
  TrendingUp,
  DollarSign,
  CheckCircle,
  Clock,
  Zap,
  Target,
  ShieldCheck,
  Layers,
  Eye,
  HardDrive,
  FileWarning,
  MessagesSquare,
  LineChart,
  DatabaseZap,
  Inbox,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Skeleton,
  EmptyState,
  ErrorState,
} from '@/components/ui';
import { SecuritySettingsCard } from '@/components/admin/SecuritySettingsCard';
import BillingBalance from '@/components/admin/BillingBalance';
import { squadRoster } from '@/components/squad-members';
import { api } from '@/lib/api';
import { formatModelName, useModelNames } from '@/hooks/use-model-names';
import { DEMAND_STATUS_LABELS, type DemandStatus } from '@shared/demand-status';

const COLORS = ['#1E40AF', '#3B82F6', '#D97706', '#DC2626', '#10B981', '#8B5CF6'];

export default function DashboardPage() {
  const { modelNames } = useModelNames();
  const {
    data: dashboard,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['adminDashboard'],
    queryFn: () => api.admin.getDashboard(),
    refetchInterval: 30000, // Refresh every 30s
  });

  const { data: recentDemands = [] } = useQuery({
    queryKey: ['/api/demands'],
    queryFn: () => api.demands.getAll(),
    refetchInterval: 30000,
  });

  const { data: costData } = useQuery({
    queryKey: ['adminCosts'],
    queryFn: () => api.admin.getCosts(),
    refetchInterval: 30000,
  });

  const { data: tracingStats } = useQuery({
    queryKey: ['adminTracingStats'],
    queryFn: () => api.admin.getTracingStats(),
    refetchInterval: 15000,
  });

  const { data: cacheStats } = useQuery({
    queryKey: ['adminCacheStats'],
    queryFn: () => api.admin.getCacheStats(),
    refetchInterval: 30000,
  });

  if (isLoading || (!dashboard && !error)) {
    return <DashboardSkeleton />;
  }

  if (error || !dashboard) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <ErrorState
          title="Falha ao carregar o dashboard"
          description="Não foi possível buscar os dados de telemetria. Verifique a conexão com o servidor e tente novamente."
          onRetry={() => refetch()}
          retrying={isRefetching}
        />
        <SecuritySettingsCard />
      </div>
    );
  }

  // Preparar dados para gráficos
  const modelData = Object.entries(dashboard.aiUsage.byModel || {}).map(
    ([name, stats]: [string, { totalTokens: number }]) => ({
      name: formatModelName(name, modelNames),
      value: stats.totalTokens,
    }),
  );

  const ragData = [
    { name: 'Precisão', value: (dashboard.rag?.avgPrecision ?? 0) * 100 },
    { name: 'Recall', value: (dashboard.rag?.avgRecall ?? 0) * 100 },
    { name: 'F1 Score', value: (dashboard.rag?.f1Score ?? 0) * 100 },
    { name: 'Relevância', value: (dashboard.rag?.avgContextRelevance ?? 0) * 100 },
  ];

  const demandData = [
    { status: 'Completo', count: dashboard.demands.completed, fill: '#10B981' },
    { status: 'Processando', count: dashboard.demands.processing, fill: '#3B82F6' },
    { status: 'Erro', count: dashboard.demands.error, fill: '#DC2626' },
  ];

  const govData = [
    { name: 'Adoção Review', value: dashboard.governance.reviewAdoptionRate },
    {
      name: 'Taxa Aprovação',
      value:
        dashboard.governance.approvedCount > 0
          ? (dashboard.governance.approvedCount / dashboard.demands.completed) * 100
          : 0,
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title">Dashboard</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Visão geral de telemetria, custos e governança do AiChatFlow
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5">
          <div className="status-dot online" aria-hidden="true" />
          <span className="text-meta text-muted-foreground">
            Sincronizado: {new Date(dashboard.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Atalhos */}
      <section aria-labelledby="dashboard-atalhos">
        <h2 id="dashboard-atalhos" className="mb-3 text-section-title">
          Atalhos
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <ShortcutCard
            href="/"
            icon={<MessagesSquare className="h-5 w-5" aria-hidden="true" />}
            title="Nova conversa"
            description="Criar demanda e refinar com a squad de agentes"
          />
          <ShortcutCard
            href="/admin/metricas-anti"
            icon={<Activity className="h-5 w-5" aria-hidden="true" />}
            title="Métricas anti-overengineering"
            description="Acompanhar simplicidade e aderência das entregas"
          />
          <ShortcutCard
            href="/admin/cost-quality"
            icon={<LineChart className="h-5 w-5" aria-hidden="true" />}
            title="Custo × Qualidade"
            description="Comparar investimento e resultado por demanda"
          />
          <ShortcutCard
            href="/admin/retention"
            icon={<DatabaseZap className="h-5 w-5" aria-hidden="true" />}
            title="Retenção de dados"
            description="Gerenciar políticas de limpeza e armazenamento"
          />
        </div>
      </section>

      {/* Atividades recentes + Agentes */}
      <section aria-labelledby="dashboard-atividades">
        <h2 id="dashboard-atividades" className="mb-3 text-section-title">
          Atividades recentes
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardContent className="p-0">
              {recentDemands.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="Nenhuma demanda ainda"
                  description="Crie a primeira demanda para ver a atividade da squad aqui."
                  className="border-0 bg-transparent"
                />
              ) : (
                <ul className="divide-y divide-border">
                  {recentDemands.slice(0, 6).map((demand) => (
                    <li key={demand.id}>
                      <Link
                        href="/"
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60"
                      >
                        <DemandStatusDot status={demand.status} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body text-foreground">{demand.title}</p>
                          <p className="text-meta text-muted-foreground">
                            {demandStatusLabel(demand.status)}
                            {demand.createdAt
                              ? ` · ${new Date(demand.createdAt).toLocaleString()}`
                              : ''}
                          </p>
                        </div>
                        <ArrowRight
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-medium">Agentes da squad</CardTitle>
              <CardDescription className="text-xs">
                {squadRoster.length} agentes disponíveis para refinamento
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {squadRoster.slice(0, 6).map((member) => (
                  <li key={member.code} className="flex items-center gap-3">
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-base"
                      aria-hidden="true"
                    >
                      {member.icon}
                    </span>
                    <span className="truncate text-body text-foreground">{member.name}</span>
                    <span className="ml-auto text-meta text-muted-foreground">{member.code}</span>
                  </li>
                ))}
                {squadRoster.length > 6 && (
                  <li className="pt-1 text-meta text-muted-foreground">
                    + {squadRoster.length - 6} outros agentes
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Conta e segurança */}
      <section aria-labelledby="dashboard-conta">
        <h2 id="dashboard-conta" className="mb-3 text-section-title">
          Conta e segurança
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <BillingBalance />
          </div>
          <div className="lg:col-span-2">
            <SecuritySettingsCard />
          </div>
        </div>
      </section>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KPICard
          title="Investimento em IA"
          value={`$${dashboard.aiUsage.estimatedCostUsd.toFixed(4)}`}
          sub="Custo total de tokens"
          icon={<DollarSign className="w-4 h-4 text-[var(--accent-gold)]" />}
        />
        <KPICard
          title="Precisão RAG"
          value={`${((dashboard.rag?.avgPrecision ?? 0) * 100).toFixed(1)}%`}
          sub="Recall de contexto recuperado"
          icon={<Target className="w-4 h-4 text-[var(--accent-cyan)]" />}
        />
        <KPICard
          title="Governança"
          value={`${dashboard.governance.reviewAdoptionRate.toFixed(1)}%`}
          sub={`${dashboard.governance.approvedCount} documentos aprovados`}
          icon={<ShieldCheck className="w-4 h-4 text-[var(--success)]" />}
        />
        <KPICard
          title="Taxa de sucesso"
          value={`${((dashboard.demands.completed / (dashboard.demands.total || 1)) * 100).toFixed(1)}%`}
          sub={`${dashboard.demands.completed} de ${dashboard.demands.total} demandas`}
          icon={<CheckCircle className="w-4 h-4 text-[var(--success)]" />}
        />
        <KPICard
          title="Arquivos bloqueados"
          value={`${dashboard.validation?.invalidFilesBlocked ?? 0}`}
          sub={`${dashboard.validation?.totalFilesValidated ?? 0} validados`}
          icon={<FileWarning className="w-4 h-4 text-[var(--warning)]" />}
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* RAG Performance */}
        <Card className="brutal-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Database className="w-4 h-4 text-[var(--accent-cyan)]" />
                  Qualidade do RAG
                </CardTitle>
                <CardDescription className="text-xs">
                  Avaliação técnica baseada em ground truth
                </CardDescription>
              </div>
              <Badge className="bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)] border-[var(--accent-cyan)] text-[10px]">
                P3 METRICS
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[250px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ragData} layout="vertical" margin={{ left: 40, right: 20 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={true}
                    vertical={false}
                    stroke="var(--border)"
                  />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    stroke="var(--foreground-muted)"
                    fontSize={10}
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="var(--foreground-muted)"
                    fontSize={10}
                    width={80}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--muted)',
                      borderColor: 'var(--border)',
                      color: 'var(--foreground)',
                    }}
                    itemStyle={{ color: 'var(--accent-cyan)' }}
                  />
                  <Bar
                    dataKey="value"
                    fill="var(--accent-cyan)"
                    radius={[0, 4, 4, 0]}
                    barSize={30}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Governance Metrics */}
        <Card className="brutal-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <ShieldCheck className="w-4 h-4 text-[var(--success)]" />
              Fluxo de governança
            </CardTitle>
            <CardDescription className="text-xs">Qualidade e Revisão Humana</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={govData} layout="vertical">
                  <XAxis type="number" domain={[0, 100]} hide />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="var(--foreground-muted)"
                    fontSize={10}
                    width={80}
                  />
                  <Bar dataKey="value" fill="var(--success)" radius={[0, 4, 4, 0]} barSize={20} />
                  <Tooltip
                    cursor={{ fill: 'transparent' }}
                    contentStyle={{ backgroundColor: 'var(--muted)', borderColor: 'var(--border)' }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                <span className="uppercase">Comentários/Review</span>
                <span className="font-bold">{dashboard.governance.avgComments.toFixed(1)}</span>
              </div>
              <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                <span className="uppercase">Docs Finalizados</span>
                <span className="font-bold">{dashboard.governance.finalizedCount}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Model Distribution */}
        <Card className="brutal-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Cpu className="w-4 h-4 text-[var(--accent-violet)]" />
              Mix de modelos
            </CardTitle>
            <CardDescription className="text-xs">Distribuição por volume de Tokens</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modelData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {modelData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--muted)',
                      borderColor: 'var(--border)',
                      color: 'var(--foreground)',
                    }}
                  />
                  <Legend
                    iconType="rect"
                    wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* AI Usage Timeline */}
        <Card className="brutal-card lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <TrendingUp className="w-4 h-4 text-[var(--accent-gold)]" />
              Status das demandas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={demandData}>
                  <XAxis dataKey="status" stroke="var(--foreground-muted)" fontSize={10} />
                  <YAxis stroke="var(--foreground-muted)" fontSize={10} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* System Health */}
        <Card className="brutal-card lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Activity className="w-4 h-4 text-[var(--accent-lime)]" />
              Latência e recursos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 mt-4">
              <div className="flex justify-between items-end border-b border-[var(--border)] pb-1">
                <span className="text-[10px] text-[var(--foreground-muted)] uppercase">
                  Latência Média RAG
                </span>
                <span className="font-mono text-sm font-bold">
                  {dashboard.rag?.avgLatencyMs || 0}ms
                </span>
              </div>
              <div className="flex justify-between items-end border-b border-[var(--border)] pb-1">
                <span className="text-[10px] text-[var(--foreground-muted)] uppercase">
                  Latência Média IA
                </span>
                <span className="font-mono text-sm font-bold">~2.4s</span>
              </div>
              <div className="flex justify-between items-end border-b border-[var(--border)] pb-1">
                <span className="text-[10px] text-[var(--foreground-muted)] uppercase">
                  ROI Estimado
                </span>
                <span className="font-mono text-sm font-bold">12.4:1</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ═══ Sprint 5: Cost Dashboard ═══ */}
      {costData && (
        <>
          <h2 className="mt-2 mb-4 flex items-center gap-2 text-section-title">
            <DollarSign className="w-5 h-5 text-[var(--accent-gold)]" />
            Controle de custos LLM
          </h2>

          {/* Cost KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <KPICard
              title="Custo total"
              value={`$${costData.summary.totalCostUsd.toFixed(4)}`}
              sub={`${costData.summary.totalRequests} requisições`}
              icon={<DollarSign className="w-4 h-4 text-[var(--accent-gold)]" />}
            />
            <KPICard
              title="Economia de cache"
              value={`$${costData.cacheSavings.costSavedUsd.toFixed(4)}`}
              sub={`${(costData.cacheSavings.cacheHitRate * 100).toFixed(1)}% hit rate`}
              icon={<HardDrive className="w-4 h-4 text-[var(--success)]" />}
            />
            <KPICard
              title="Custo por requisição"
              value={`$${costData.summary.avgCostPerRequest.toFixed(6)}`}
              sub={`${costData.summary.totalTokens.toLocaleString()} tokens`}
              icon={<TrendingUp className="w-4 h-4 text-[var(--accent-cyan)]" />}
            />
            <KPICard
              title="Roteamento econômico"
              value={`${(costData.routingEfficiency.economicRatio * 100).toFixed(1)}%`}
              sub={`Fallback: ${(costData.routingEfficiency.fallbackRate * 100).toFixed(1)}%`}
              icon={<Zap className="w-4 h-4 text-[var(--accent-violet)]" />}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Cost by Model */}
            <Card className="brutal-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Cpu className="w-4 h-4 text-[var(--accent-gold)]" />
                  Custo por modelo
                </CardTitle>
                <CardDescription className="text-xs">
                  Distribuição de gastos por modelo de IA
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px] w-full mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={costData.costByModel.slice(0, 8)}
                      layout="vertical"
                      margin={{ left: 80, right: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis type="number" stroke="var(--foreground-muted)" fontSize={10} />
                      <YAxis
                        dataKey="model"
                        type="category"
                        stroke="var(--foreground-muted)"
                        fontSize={9}
                        width={75}
                        tickFormatter={(v: string) => formatModelName(v, modelNames).slice(0, 15)}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--muted)',
                          borderColor: 'var(--border)',
                          color: 'var(--foreground)',
                        }}
                        formatter={(value: number) => [`$${value.toFixed(6)}`, 'Custo']}
                      />
                      <Bar
                        dataKey="estimatedCostUsd"
                        fill="var(--accent-gold)"
                        radius={[0, 4, 4, 0]}
                        barSize={20}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Cost Timeline */}
            {costData.timeline.length > 0 && (
              <Card className="brutal-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base font-medium">
                    <Clock className="w-4 h-4 text-[var(--accent-cyan)]" />
                    Timeline de custos
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Custo por intervalo de 5 minutos
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px] w-full mt-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={costData.timeline} margin={{ left: 10, right: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="bucket" stroke="var(--foreground-muted)" fontSize={10} />
                        <YAxis stroke="var(--foreground-muted)" fontSize={10} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--muted)',
                            borderColor: 'var(--border)',
                            color: 'var(--foreground)',
                          }}
                          formatter={(value: number, name: string) => [
                            name === 'cost' ? `$${value.toFixed(6)}` : value,
                            name === 'cost' ? 'Custo' : 'Requisições',
                          ]}
                        />
                        <Area
                          type="monotone"
                          dataKey="cost"
                          stroke="var(--accent-gold)"
                          fill="var(--accent-gold)"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      {/* ═══ Sprint 5: Observability & Cache ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* Tracing Stats */}
        {tracingStats && (
          <Card className="brutal-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <Eye className="w-4 h-4 text-[var(--accent-violet)]" />
                Observabilidade LLM
              </CardTitle>
              <CardDescription className="text-xs">Tracing, sampling e export</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 mt-4">
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Spans Ativos</span>
                  <span className="font-bold">{tracingStats.tracing.activeSpans}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Spans Completos</span>
                  <span className="font-bold">{tracingStats.tracing.completedSpans}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Taxa de Erro</span>
                  <span className="font-bold text-[var(--destructive)]">
                    {(tracingStats.tracing.errorRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Latência Média</span>
                  <span className="font-bold">{tracingStats.tracing.avgDurationMs}ms</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Exportados (OTLP)</span>
                  <span className="font-bold">{tracingStats.exporter.totalExported}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Sample Rate Efetivo</span>
                  <span className="font-bold">
                    {(tracingStats.sampling.effectiveSampleRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="uppercase">Traces</span>
                  <span className="font-bold">{tracingStats.tracing.traceCount}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cache Stats */}
        {cacheStats && (
          <Card className="brutal-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <Layers className="w-4 h-4 text-[var(--success)]" />
                Cache de IA
              </CardTitle>
              <CardDescription className="text-xs">Cache exato + semântico</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 mt-4">
                <div className="text-[10px] font-mono font-bold uppercase text-[var(--accent-cyan)] mb-2">
                  Cache Exato (SHA-256)
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Entradas</span>
                  <span className="font-bold">{cacheStats.exactCache.size}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Hit Rate</span>
                  <span className="font-bold text-[var(--success)]">
                    {(cacheStats.exactCache.hitRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Hits / Misses</span>
                  <span className="font-bold">
                    {cacheStats.exactCache.totalHits} / {cacheStats.exactCache.totalMisses}
                  </span>
                </div>

                <div className="text-[10px] font-mono font-bold uppercase text-[var(--accent-violet)] mt-4 mb-2">
                  Cache Semântico (Embedding)
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Entradas</span>
                  <span className="font-bold">{cacheStats.semanticCache.size}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Hit Rate</span>
                  <span className="font-bold text-[var(--success)]">
                    {(cacheStats.semanticCache.hitRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between text-[10px] font-mono border-b border-[var(--border)] pb-1">
                  <span className="uppercase">Threshold</span>
                  <span className="font-bold">{cacheStats.semanticCache.similarityThreshold}</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="uppercase">Falhas Embedding</span>
                  <span className="font-bold">
                    {cacheStats.semanticCache.totalEmbeddingFailures}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function KPICard({
  title,
  value,
  sub,
  icon,
}: {
  title: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <p className="mt-1 text-meta text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function ShortcutCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-soft-sm transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-subtitle text-foreground">{title}</span>
        <span className="mt-0.5 block text-meta text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}

function demandStatusLabel(status: string | null | undefined): string {
  const label = DEMAND_STATUS_LABELS[status as DemandStatus];
  if (!label) return 'Status desconhecido';
  return label.charAt(0) + label.slice(1).toLowerCase();
}

function DemandStatusDot({ status }: { status: string | null | undefined }) {
  const color =
    status === 'completed'
      ? 'bg-success'
      : status === 'error' || status === 'validation_failed'
        ? 'bg-destructive'
        : status === 'stopped'
          ? 'bg-muted-foreground'
          : 'bg-info';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

function DashboardSkeleton() {
  return (
    <div
      className="mx-auto max-w-[1400px] space-y-8 p-6"
      role="status"
      aria-label="Carregando dashboard"
    >
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 w-full rounded-lg lg:col-span-2" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function Badge({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`px-2 py-0.5 border text-[10px] font-mono font-bold ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}
