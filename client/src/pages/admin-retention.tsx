/**
 * Admin Retention Policy Page
 * PRD: Políticas de Retenção de Dados
 *
 * Features:
 * - Policy table with CRUD operations
 * - Simulate impact before applying policies
 * - Job execution logs
 * - Scheduler status and controls
 * - Database size metrics
 */

import { useState, useEffect, useRef } from 'react';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  ArrowLeft,
  Trash2,
  Database,
  Clock,
  Play,
  Pause,
  Plus,
  Edit2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Activity,
  Calendar,
  HardDrive,
  RefreshCw,
  FileText,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/Breadcrumbs/Breadcrumbs';
import { CloseButton } from '@/components/CloseButton';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type { RetentionJobLogDto } from '@shared/retention';
import { type RetentionPolicyAction } from '@shared/schema';

// H-23: Removed hardcoded DATA_TYPE_LABELS — the UI now uses labels from
// the API's availableDataTypes response (Array<{ value, label }>), which
// is the single source of truth for data type display names. A fallback
// to the raw value is used if the API response hasn't loaded yet.

const ACTION_LABELS: Record<RetentionPolicyAction, { label: string; color: string }> = {
  delete: { label: 'Excluir', color: 'var(--destructive)' },
  archive: { label: 'Arquivar', color: 'var(--accent-gold)' },
};

interface Policy {
  id: number;
  dataType: string;
  ttlDays: number;
  action: string;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AdminRetentionPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);

  // Queries
  const { data: policiesResponse, isLoading: policiesLoading } = useQuery({
    queryKey: ['retentionPolicies'],
    queryFn: () => api.admin.retention.getPolicies(),
    refetchInterval: 30000,
  });
  const policies = policiesResponse?.policies;
  const availableDataTypes = policiesResponse?.availableDataTypes;

  // H-23: build a label lookup from the API response (single source of truth)
  const dataTypeLabelMap = new Map<string, string>(
    (availableDataTypes || []).map((dt) => [dt.value, dt.label]),
  );
  const getDataTypeLabel = (value: string): string => dataTypeLabelMap.get(value) || value;

  const { data: logsResponse } = useQuery({
    queryKey: ['retentionLogs'],
    queryFn: () => api.admin.retention.getLogs(20),
    refetchInterval: 30000,
  });
  const logs = logsResponse?.logs;

  const { data: dbMetrics } = useQuery({
    queryKey: ['retentionDbMetrics'],
    queryFn: () => api.admin.retention.getDbMetrics(),
    refetchInterval: 60000,
  });

  const { data: schedulerStatus, refetch: refetchScheduler } = useQuery({
    queryKey: ['retentionScheduler'],
    queryFn: () => api.admin.retention.getSchedulerStatus(),
    refetchInterval: 30000,
  });

  const { data: simulateAllResponse } = useQuery({
    queryKey: ['retentionSimulateAll'],
    queryFn: () => api.admin.retention.simulateAll(),
    refetchInterval: 60000,
  });
  const simulations = simulateAllResponse?.simulations;

  // Mutations
  const createMutation = useMutation({
    mutationFn: (policy: {
      dataType: string;
      ttlDays: number;
      action: string;
      isActive?: boolean;
      description?: string;
    }) => api.admin.retention.createPolicy(policy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retentionPolicies'] });
      queryClient.invalidateQueries({ queryKey: ['retentionSimulateAll'] });
      setShowCreateModal(false);
      toast({ title: 'Política criada', description: 'A política foi criada com sucesso.' });
    },
    onError: (error: Error) => {
      console.error('Erro em operação de retenção:', error);
      toast({
        title: 'Erro',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      policy,
    }: {
      id: number;
      policy: { ttlDays?: number; action?: string; isActive?: boolean; description?: string };
    }) => api.admin.retention.updatePolicy(id, policy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retentionPolicies'] });
      queryClient.invalidateQueries({ queryKey: ['retentionSimulateAll'] });
      setEditingPolicy(null);
      toast({
        title: 'Política atualizada',
        description: 'A política foi atualizada com sucesso.',
      });
    },
    onError: (error: Error) => {
      console.error('Erro em operação de retenção:', error);
      toast({
        title: 'Erro',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.admin.retention.deletePolicy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retentionPolicies'] });
      queryClient.invalidateQueries({ queryKey: ['retentionSimulateAll'] });
      toast({ title: 'Política removida', description: 'A política foi removida com sucesso.' });
    },
    onError: (error: Error) => {
      console.error('Erro em operação de retenção:', error);
      toast({
        title: 'Erro',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const runCleanupMutation = useMutation({
    mutationFn: () => api.admin.retention.runCleanup(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['retentionLogs'] });
      queryClient.invalidateQueries({ queryKey: ['retentionDbMetrics'] });
      queryClient.invalidateQueries({ queryKey: ['retentionSimulateAll'] });
      toast({
        title: 'Limpeza executada',
        description: `${data.result.totalRowsDeleted || 0} registros removidos em ${data.result.durationMs || 0}ms`,
      });
    },
    onError: (error: Error) => {
      console.error('Erro na limpeza de retenção:', error);
      toast({
        title: 'Erro na limpeza',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const setSchedulerMutation = useMutation({
    mutationFn: (intervalHours: number) => api.admin.retention.setSchedulerInterval(intervalHours),
    onSuccess: () => {
      refetchScheduler();
      toast({ title: 'Scheduler atualizado', description: 'O intervalo foi configurado.' });
    },
    onError: (error: Error) => {
      console.error('Erro em operação de retenção:', error);
      toast({
        title: 'Erro',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString('pt-BR');
  };

  if (policiesLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)]">
        <div className="text-center space-y-4">
          <Activity className="h-12 w-12 animate-pulse text-[var(--accent-cyan)] mx-auto" />
          <p className="font-mono text-[var(--foreground-muted)] uppercase tracking-widest">
            Carregando Políticas...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] p-6 font-fira animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard">
            <Button
              variant="outline"
              size="icon"
              className="brutal-button"
              aria-label="Voltar para dashboard admin"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tighter uppercase">Políticas de Retenção</h1>
            <p className="text-[var(--foreground-muted)] font-mono text-xs uppercase tracking-wider mt-1">
              Gerenciamento de TTL e Limpeza Automática
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => runCleanupMutation.mutate()}
            disabled={runCleanupMutation.isPending}
            className="brutal-button font-mono text-xs"
            variant="outline"
          >
            {runCleanupMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            EXECUTAR LIMPEZA
          </Button>
          <Button
            onClick={() => setShowCreateModal(true)}
            className="brutal-button font-mono text-xs"
          >
            <Plus className="h-4 w-4 mr-2" />
            NOVA POLÍTICA
          </Button>
        </div>
      </div>

      <Breadcrumbs path="/admin/retention" />

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KPICard
          title="TAMANHO DO BANCO"
          value={dbMetrics ? formatBytes(dbMetrics.totalSizeBytes) : '--'}
          sub={`${dbMetrics?.tableCount || 0} tabelas`}
          icon={<HardDrive className="w-4 h-4 text-[var(--accent-cyan)]" />}
        />
        <KPICard
          title="POLÍTICAS ATIVAS"
          value={String(policies?.filter((p: Policy) => p.isActive).length || 0)}
          sub={`${policies?.length || 0} total`}
          icon={<FileText className="w-4 h-4 text-[var(--success)]" />}
        />
        <KPICard
          title="REGISTROS AFETADOS"
          value={String(
            simulations?.reduce(
              (sum: number, s: { affectedRows: number }) => sum + s.affectedRows,
              0,
            ) || 0,
          )}
          sub="Próxima execução"
          icon={<Database className="w-4 h-4 text-[var(--accent-gold)]" />}
        />
        <KPICard
          title="SCHEDULER"
          value={schedulerStatus?.schedulerRunning ? 'ATIVO' : 'PARADO'}
          sub={
            schedulerStatus?.enabled
              ? `Intervalo: ${schedulerStatus?.intervalHours || 24}h`
              : 'Desabilitado'
          }
          icon={<Clock className="w-4 h-4 text-[var(--accent-violet)]" />}
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Policies Table */}
        <Card className="brutal-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="font-mono text-sm font-bold flex items-center gap-2">
                  <Database className="w-4 h-4 text-[var(--accent-cyan)]" />
                  POLÍTICAS DE RETENÇÃO
                </CardTitle>
                <CardDescription className="text-[10px] uppercase">
                  Configuração de TTL por tipo de dado
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left py-2 text-[10px] uppercase text-[var(--foreground-muted)]">
                      Tipo de Dado
                    </th>
                    <th className="text-left py-2 text-[10px] uppercase text-[var(--foreground-muted)]">
                      TTL
                    </th>
                    <th className="text-left py-2 text-[10px] uppercase text-[var(--foreground-muted)]">
                      Ação
                    </th>
                    <th className="text-center py-2 text-[10px] uppercase text-[var(--foreground-muted)]">
                      Status
                    </th>
                    <th className="text-right py-2 text-[10px] uppercase text-[var(--foreground-muted)]">
                      Ações
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {policies?.map((policy: Policy) => (
                    <tr
                      key={policy.id}
                      className="border-b border-[var(--border)] hover:bg-[var(--muted)]/50"
                    >
                      <td className="py-3">
                        <div className="font-semibold">{getDataTypeLabel(policy.dataType)}</div>
                        {policy.description && (
                          <div className="text-[10px] text-[var(--foreground-muted)]">
                            {policy.description}
                          </div>
                        )}
                      </td>
                      <td className="py-3">
                        <span className="font-bold">{policy.ttlDays}</span>
                        <span className="text-[var(--foreground-muted)]"> dias</span>
                      </td>
                      <td className="py-3">
                        <span
                          className="px-2 py-0.5 text-[10px] font-bold uppercase"
                          style={{
                            color:
                              ACTION_LABELS[policy.action as RetentionPolicyAction]?.color ||
                              'var(--foreground)',
                            backgroundColor: `${ACTION_LABELS[policy.action as RetentionPolicyAction]?.color || 'var(--foreground)'}20`,
                          }}
                        >
                          {ACTION_LABELS[policy.action as RetentionPolicyAction]?.label ||
                            policy.action}
                        </span>
                      </td>
                      <td className="py-3 text-center">
                        {policy.isActive ? (
                          <CheckCircle className="w-4 h-4 text-[var(--success)] inline" />
                        ) : (
                          <XCircle className="w-4 h-4 text-[var(--foreground-muted)] inline" />
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex gap-1 justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => setEditingPolicy(policy)}
                            aria-label={`Editar política de ${getDataTypeLabel(policy.dataType)}`}
                          >
                            <Edit2 className="h-3 w-3" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-[var(--destructive)]"
                            aria-label={`Remover política de ${getDataTypeLabel(policy.dataType)}`}
                            onClick={() => {
                              if (confirm('Remover esta política?')) {
                                deleteMutation.mutate(policy.id);
                              }
                            }}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {(!policies || policies.length === 0) && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-[var(--foreground-muted)]">
                        Nenhuma política configurada
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Impact Preview */}
        <Card className="brutal-card">
          <CardHeader>
            <CardTitle className="font-mono text-sm font-bold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-[var(--accent-gold)]" />
              PRÉVIA DE IMPACTO
            </CardTitle>
            <CardDescription className="text-[10px] uppercase">
              Registros que serão afetados
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {simulations?.map(
                (sim: { dataType: string; ttlDays: number; affectedRows: number }) => (
                  <div
                    key={sim.dataType}
                    className="flex justify-between items-center py-2 border-b border-[var(--border)]"
                  >
                    <div>
                      <div className="text-xs font-semibold">{getDataTypeLabel(sim.dataType)}</div>
                      <div className="text-[10px] text-[var(--foreground-muted)]">
                        TTL: {sim.ttlDays} dias
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-sm">{sim.affectedRows.toLocaleString()}</div>
                      <div className="text-[10px] text-[var(--foreground-muted)]">registros</div>
                    </div>
                  </div>
                ),
              )}
              {(!simulations || simulations.length === 0) && (
                <div className="text-center py-4 text-[var(--foreground-muted)] text-xs">
                  Nenhuma política ativa para simular
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Job Logs */}
        <Card className="brutal-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="font-mono text-sm font-bold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--accent-violet)]" />
                  LOGS DE EXECUÇÃO
                </CardTitle>
                <CardDescription className="text-[10px] uppercase">
                  Histórico de limpeza automática
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => queryClient.invalidateQueries({ queryKey: ['retentionLogs'] })}
                aria-label="Atualizar histórico de jobs"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {logs?.map((log: RetentionJobLogDto) => (
                <div
                  key={log.id}
                  className={`p-3 border ${
                    log.status === 'completed'
                      ? 'border-[var(--success)]/30 bg-[var(--success)]/5'
                      : log.status === 'failed'
                        ? 'border-[var(--destructive)]/30 bg-[var(--destructive)]/5'
                        : 'border-[var(--border)]'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                      {log.status === 'completed' ? (
                        <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                      ) : log.status === 'failed' ? (
                        <XCircle className="w-4 h-4 text-[var(--destructive)]" />
                      ) : (
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-cyan)]" />
                      )}
                      <span className="font-mono text-xs font-bold uppercase">{log.status}</span>
                    </div>
                    <span className="text-[10px] text-[var(--foreground-muted)]">
                      {formatDate(log.startedAt)}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-[var(--foreground-muted)]">Registros: </span>
                      <span className="font-bold">{log.totalRowsDeleted.toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-muted)]">Tempo: </span>
                      <span className="font-bold">{log.executionTimeMs}ms</span>
                    </div>
                  </div>
                  {log.errorMessage && (
                    <div className="mt-2 text-[10px] text-[var(--destructive)]">
                      {log.errorMessage}
                    </div>
                  )}
                </div>
              ))}
              {(!logs || logs.length === 0) && (
                <div className="text-center py-8 text-[var(--foreground-muted)] text-xs">
                  Nenhuma execução registrada
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Scheduler Config */}
        <Card className="brutal-card">
          <CardHeader>
            <CardTitle className="font-mono text-sm font-bold flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[var(--accent-cyan)]" />
              CONFIGURAÇÃO DO SCHEDULER
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-xs">Status</span>
                <span
                  className={`font-mono text-xs font-bold ${schedulerStatus?.schedulerRunning ? 'text-[var(--success)]' : 'text-[var(--foreground-muted)]'}`}
                >
                  {schedulerStatus?.schedulerRunning ? 'ATIVO' : 'PARADO'}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-xs">Intervalo</span>
                <span className="font-mono text-xs font-bold">
                  {schedulerStatus?.intervalHours || 24}h
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-xs">Habilitado</span>
                <span className="font-mono text-xs font-bold">
                  {schedulerStatus?.enabled ? 'SIM' : 'NÃO'}
                </span>
              </div>

              <div className="pt-2">
                <div className="text-[10px] uppercase text-[var(--foreground-muted)] block mb-2 font-bold font-mono">
                  Intervalo (horas)
                </div>
                <div className="flex gap-2">
                  {[6, 12, 24, 48].map((hours) => (
                    <Button
                      key={hours}
                      variant={schedulerStatus?.intervalHours === hours ? 'default' : 'outline'}
                      size="sm"
                      className="font-mono text-xs flex-1"
                      onClick={() => setSchedulerMutation.mutate(hours)}
                      disabled={setSchedulerMutation.isPending}
                    >
                      {hours}h
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 font-mono text-xs"
                  onClick={() => setSchedulerMutation.mutate(0)}
                  disabled={setSchedulerMutation.isPending || !schedulerStatus?.schedulerRunning}
                >
                  <Pause className="h-3 w-3 mr-1" />
                  PARAR
                </Button>
                <Button
                  size="sm"
                  className="flex-1 font-mono text-xs"
                  onClick={() => setSchedulerMutation.mutate(schedulerStatus?.intervalHours || 24)}
                  disabled={setSchedulerMutation.isPending || schedulerStatus?.schedulerRunning}
                >
                  <Play className="h-3 w-3 mr-1" />
                  INICIAR
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Create/Edit Modal */}
      {(showCreateModal || editingPolicy) && (
        <PolicyModal
          policy={editingPolicy}
          onClose={() => {
            setShowCreateModal(false);
            setEditingPolicy(null);
          }}
          onSave={(data) => {
            if (editingPolicy) {
              updateMutation.mutate({ id: editingPolicy.id, policy: data });
            } else {
              createMutation.mutate(
                data as {
                  dataType: string;
                  ttlDays: number;
                  action: string;
                  isActive: boolean;
                  description: string;
                },
              );
            }
          }}
          isLoading={createMutation.isPending || updateMutation.isPending}
          existingDataTypes={policies?.map((p: Policy) => p.dataType) || []}
          allDataTypes={availableDataTypes || []}
        />
      )}
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
    <Card className="brutal-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)]">
          {title}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-fira tracking-tight">{value}</div>
        <p className="text-[10px] text-[var(--foreground-muted)] uppercase mt-1 font-mono">{sub}</p>
      </CardContent>
    </Card>
  );
}

interface PolicyModalProps {
  policy: Policy | null;
  onClose: () => void;
  onSave: (data: {
    dataType?: string;
    ttlDays: number;
    action: string;
    isActive: boolean;
    description: string;
  }) => void;
  isLoading: boolean;
  existingDataTypes: string[];
  // H-23: pass the API's data type list (with labels) so the modal uses
  // the same source of truth as the main page.
  allDataTypes: Array<{ value: string; label: string }>;
}

function PolicyModal({
  policy,
  onClose,
  onSave,
  isLoading,
  existingDataTypes,
  allDataTypes,
}: PolicyModalProps) {
  const [dataType, setDataType] = useState(policy?.dataType || '');
  const [ttlDays, setTtlDays] = useState(policy?.ttlDays || 30);
  const [action, setAction] = useState(policy?.action || 'delete');
  const [isActive, setIsActive] = useState(policy?.isActive ?? true);
  const [description, setDescription] = useState(policy?.description || '');

  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Focus trap + Escape handler + focus restoration
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    const modal = modalRef.current;
    if (modal) {
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable[0]?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && modal) {
        const focusable = modal.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  // H-23: use the API-provided data types instead of hardcoded labels
  const availableDataTypes = allDataTypes
    .filter((dt) => !existingDataTypes.includes(dt.value) || dt.value === policy?.dataType)
    .map((dt) => dt.value);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: {
      dataType?: string;
      ttlDays: number;
      action: string;
      isActive: boolean;
      description: string;
    } = { ttlDays, action, isActive, description };
    if (!policy) {
      data.dataType = dataType;
    }
    onSave(data);
  };

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-[var(--z-overlay)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="retention-policy-modal-title"
    >
      <div className="relative bg-[var(--background)] border-2 border-[var(--accent-cyan)] max-w-md w-full mx-4 p-6">
        <CloseButton
          onClose={onClose}
          modalTitle={
            policy ? 'de edição de política de retenção' : 'de criação de política de retenção'
          }
        />

        <h2
          id="retention-policy-modal-title"
          className="text-lg font-bold font-mono uppercase mb-4 pr-10"
        >
          {policy ? 'Editar Política' : 'Nova Política'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!policy && (
            <div>
              <label
                htmlFor="retention-data-type"
                className="text-[10px] uppercase text-[var(--foreground-muted)] block mb-1"
              >
                Tipo de Dado
              </label>
              <select
                id="retention-data-type"
                name="dataType"
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-sm"
                required
              >
                <option value="">Selecione...</option>
                {availableDataTypes.map((dt) => {
                  const label = allDataTypes.find((d) => d.value === dt)?.label || dt;
                  return (
                    <option key={dt} value={dt}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          <div>
            <label
              htmlFor="retention-ttl"
              className="text-[10px] uppercase text-[var(--foreground-muted)] block mb-1"
            >
              TTL (dias)
            </label>
            <input
              id="retention-ttl"
              name="ttl"
              type="number"
              value={ttlDays}
              onChange={(e) => setTtlDays(Number(e.target.value))}
              min={1}
              max={3650}
              className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-sm"
              required
            />
          </div>

          <div>
            <label
              htmlFor="retention-action"
              className="text-[10px] uppercase text-[var(--foreground-muted)] block mb-1"
            >
              Ação
            </label>
            <select
              id="retention-action"
              name="action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-sm"
            >
              <option value="delete">Excluir</option>
              <option value="archive">Arquivar</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="retention-desc"
              className="text-[10px] uppercase text-[var(--foreground-muted)] block mb-1"
            >
              Descrição
            </label>
            <input
              id="retention-desc"
              name="description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descrição opcional..."
              className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="isActive" className="text-sm font-mono">
              Política ativa
            </label>
          </div>

          <div className="flex gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 font-mono">
              CANCELAR
            </Button>
            <Button type="submit" disabled={isLoading} className="flex-1 font-mono">
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'SALVAR'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
