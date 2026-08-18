/**
 * Demanda 10078 — Módulo de retrospectiva automatizada.
 *
 * O usuário escolhe um período; o SM conduz a sessão (chama tech_lead/qa/
 * product_owner para analisar demandas e repositórios do período, e sintetiza
 * um resumo + insights). A tela faz polling enquanto a sessão está `running`.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  History,
  Loader2,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Pause,
  RotateCcw,
  MessageSquare,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/Breadcrumbs/Breadcrumbs';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { ApiError } from '@/lib/api-error';
import type { RetrospectiveSessionDto, RetroSnapshotDto } from '@shared/retrospective';
import SnapshotPanel from '@/components/retrospective/SnapshotPanel';
import RetroActionsTable from '@/components/retrospective/RetroActionsTable';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sevenDaysAgoIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function StatusBadge({ status }: { status: RetrospectiveSessionDto['status'] }) {
  if (status === 'completed') {
    return (
      <Badge className="bg-[var(--accent-green)] text-black font-mono text-[10px] uppercase gap-1">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Concluída
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="font-mono text-[10px] uppercase gap-1">
        <XCircle className="h-3 w-3" aria-hidden="true" />
        Falhou
      </Badge>
    );
  }
  if (status === 'cancelled') {
    return (
      <Badge variant="secondary" className="font-mono text-[10px] uppercase gap-1">
        <XCircle className="h-3 w-3" aria-hidden="true" />
        Cancelada
      </Badge>
    );
  }
  if (status === 'paused') {
    return (
      <Badge variant="outline" className="font-mono text-[10px] uppercase gap-1">
        <Pause className="h-3 w-3" aria-hidden="true" />
        Pausada
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-mono text-[10px] uppercase gap-1">
      <Clock className="h-3 w-3 animate-pulse" aria-hidden="true" />
      Processando
    </Badge>
  );
}

/**
 * Demanda 10088 (item 4) — sessões do SM persistidas em `agent_memory`
 * (memory_type='sm_session') ficam visíveis aqui, no menu retrospectiva.
 * Leitura paginada; sem dados, mostra estado vazio explicando a origem.
 */
function SmMemoryCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-memory', 'sm_session'],
    queryFn: async () => {
      const res = await fetch('/api/agent-memory?memory_type=sm_session&limit=20');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as {
        entries: Array<{
          id: string;
          agentId: string;
          content: string;
          sourceDemandId: number | null;
          createdAt: string;
        }>;
      };
    },
    retry: false,
  });

  const entries = data?.entries ?? [];

  return (
    <Card className="brutal-card lg:col-span-2">
      <CardHeader>
        <CardTitle className="font-mono text-sm font-bold">Memória do SM</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="text-xs text-[var(--foreground-muted)] font-mono">Carregando…</p>
        )}
        {isError && (
          <p className="text-xs text-[var(--foreground-muted)] font-mono">
            Memória indisponível no momento.
          </p>
        )}
        {!isLoading && !isError && entries.length === 0 && (
          <p className="text-xs text-[var(--foreground-muted)] font-mono">
            Nenhuma sessão registrada. As conversas do SM ficam aqui assim que forem gravadas como
            aprendizado (agent_memory, memory_type=sm_session).
          </p>
        )}
        {entries.length > 0 && (
          <ul className="space-y-2" data-testid="sm-memory-list">
            {entries.map((e) => (
              <li key={e.id} className="border border-[var(--border)] rounded p-2">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[var(--foreground-muted)]">
                  <span>{e.agentId}</span>
                  <span>
                    {e.createdAt}
                    {e.sourceDemandId ? ` · #${e.sourceDemandId}` : ''}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs">{e.content}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function RetrospectivePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [periodStart, setPeriodStart] = useState(sevenDaysAgoIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [generatedRetroId, setGeneratedRetroId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RetroSnapshotDto | null>(null);

  const {
    data: listResponse,
    isLoading: listLoading,
    error: listError,
  } = useQuery({
    queryKey: ['retrospectiveSessions'],
    queryFn: () => api.retrospective.list(),
    refetchInterval: (query) => (query.state.error ? false : 30000),
  });
  const sessions = listResponse?.sessions ?? [];
  const moduleDisabled =
    listError instanceof ApiError && listError.errorCode === 'RETROSPECTIVE_MODULE_DISABLED';

  const { data: activeSession } = useQuery({
    queryKey: ['retrospectiveSession', activeSessionId],
    queryFn: () => api.retrospective.get(activeSessionId as string),
    enabled: !!activeSessionId,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });

  const startMutation = useMutation({
    mutationFn: () => api.retrospective.start(periodStart, periodEnd),
    onSuccess: ({ id }) => {
      setActiveSessionId(id);
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSessions'] });
      toast({ title: 'Retrospectiva iniciada', description: 'O SM está conduzindo a sessão.' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao iniciar retrospectiva',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => api.retrospective.pause(activeSessionId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSession', activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSessions'] });
      toast({ title: 'Retrospectiva pausada' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao pausar',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => api.retrospective.resume(activeSessionId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSession', activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSessions'] });
      toast({ title: 'Retrospectiva retomada' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao retomar',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.retrospective.cancel(activeSessionId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSession', activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ['retrospectiveSessions'] });
      toast({ title: 'Retrospectiva cancelada' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao cancelar',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const generateSnapshotMutation = useMutation({
    mutationFn: () => api.retrospective.generateSnapshot(periodStart, periodEnd),
    onSuccess: (data) => {
      setGeneratedRetroId(data.id);
      setSnapshot(data.snapshot);
      toast({ title: 'Snapshot gerado', description: `Retrospectiva ${data.id}` });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao gerar snapshot',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const timeline = activeSession
    ? [
        { label: 'Sessão iniciada', done: true },
        {
          label: 'Agentes analisando demandas e repositórios',
          done: activeSession.status !== 'running',
        },
        {
          label: activeSession.status === 'failed' ? 'Falhou' : 'SM sintetizou os aprendizados',
          done: activeSession.status === 'completed' || activeSession.status === 'failed',
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[var(--background)] p-6 font-fira animate-in fade-in duration-500">
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
            <h1 className="text-3xl font-bold tracking-tighter uppercase flex items-center gap-2">
              <History className="h-7 w-7" aria-hidden="true" />
              Retrospectiva
            </h1>
            <p className="text-[var(--foreground-muted)] font-mono text-xs uppercase tracking-wider mt-1">
              Sessão conduzida pelo SM sobre um período configurável
            </p>
          </div>
        </div>
      </div>

      <Breadcrumbs path="/admin/retrospectiva" />

      {moduleDisabled && (
        <div className="mt-6 p-4 border border-[var(--destructive)] rounded font-mono text-xs text-[var(--destructive)]">
          Módulo de retrospectiva desabilitado (flag <code>retrospectiveModuleEnabled</code> está
          OFF). Ligue a flag para usar esta tela.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <Card className="brutal-card">
          <CardHeader>
            <CardTitle className="font-mono text-sm font-bold">Iniciar Retrospectiva</CardTitle>
            <CardDescription className="text-[10px] uppercase">
              Escolha o período a ser analisado
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="periodStart" className="font-mono text-xs uppercase">
                  Início
                </Label>
                <Input
                  id="periodStart"
                  type="date"
                  value={periodStart}
                  max={periodEnd}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="periodEnd" className="font-mono text-xs uppercase">
                  Fim
                </Label>
                <Input
                  id="periodEnd"
                  type="date"
                  value={periodEnd}
                  min={periodStart}
                  max={todayIso()}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
            <Button
              onClick={() => startMutation.mutate()}
              disabled={
                moduleDisabled || startMutation.isPending || activeSession?.status === 'running'
              }
              className="brutal-button font-mono text-xs w-full"
            >
              {startMutation.isPending || activeSession?.status === 'running' ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4 mr-2" aria-hidden="true" />
              )}
              Iniciar Retrospectiva
            </Button>
            <Button
              onClick={() => generateSnapshotMutation.mutate()}
              disabled={generateSnapshotMutation.isPending}
              variant="outline"
              className="brutal-button font-mono text-xs w-full mt-2"
            >
              {generateSnapshotMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
              ) : (
                <History className="h-4 w-4 mr-2" aria-hidden="true" />
              )}
              Gerar Snapshot de Evidência
            </Button>
          </CardContent>
        </Card>

        <Card className="brutal-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="font-mono text-sm font-bold">Sessão Atual</CardTitle>
              {activeSession && <StatusBadge status={activeSession.status} />}
            </div>
          </CardHeader>
          <CardContent>
            {!activeSession ? (
              <p className="text-xs text-[var(--foreground-muted)] font-mono">
                Nenhuma sessão em andamento nesta tela.
              </p>
            ) : (
              <div className="space-y-4">
                <ol className="space-y-2" aria-label="Progresso da retrospectiva">
                  {timeline.map((step) => (
                    <li key={step.label} className="flex items-center gap-2 text-xs font-mono">
                      {step.done ? (
                        <CheckCircle2
                          className="h-4 w-4 text-[var(--accent-green)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      )}
                      {step.label}
                    </li>
                  ))}
                </ol>

                {activeSession.status === 'completed' && (
                  <div className="space-y-2 pt-2 border-t border-[var(--border)]">
                    <p className="text-xs font-mono">{activeSession.summary}</p>
                    {activeSession.insights.length > 0 && (
                      <ul className="list-disc list-inside space-y-1 text-xs font-mono text-[var(--foreground-muted)]">
                        {activeSession.insights.map((insight, i) => (
                          <li key={i}>{insight}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {activeSession.status === 'failed' && (
                  <p className="text-xs font-mono text-[var(--destructive)]">
                    {activeSession.errorMessage ?? 'Falha desconhecida.'}
                  </p>
                )}

                {(activeSession.status === 'running' || activeSession.status === 'paused') && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--border)]">
                    {activeSession.status === 'running' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs"
                        onClick={() => pauseMutation.mutate()}
                        disabled={pauseMutation.isPending}
                      >
                        <Pause className="h-4 w-4 mr-1" aria-hidden="true" />
                        Pausar
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs"
                        onClick={() => resumeMutation.mutate()}
                        disabled={resumeMutation.isPending}
                      >
                        <RotateCcw className="h-4 w-4 mr-1" aria-hidden="true" />
                        Retomar
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      className="font-mono text-xs"
                      onClick={() => cancelMutation.mutate()}
                      disabled={cancelMutation.isPending}
                    >
                      <XCircle className="h-4 w-4 mr-1" aria-hidden="true" />
                      Cancelar
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {activeSession && activeSession.messages.length > 0 && (
          <Card className="brutal-card lg:col-span-2">
            <CardHeader>
              <CardTitle className="font-mono text-sm font-bold flex items-center gap-2">
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                Chat dos Agentes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 max-h-96 overflow-y-auto" data-testid="retro-message-list">
                {activeSession.messages.map((msg, i) => (
                  <li key={i} className="border border-[var(--border)] rounded p-2">
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[var(--foreground-muted)]">
                      <span className="uppercase">{msg.agent}</span>
                      <span>{new Date(msg.createdAt).toLocaleString('pt-BR')}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-xs font-mono">{msg.content}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card className="brutal-card lg:col-span-2">
          <CardHeader>
            <CardTitle className="font-mono text-sm font-bold">Histórico</CardTitle>
          </CardHeader>
          <CardContent>
            {listLoading ? (
              <p className="text-xs text-[var(--foreground-muted)] font-mono">Carregando…</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-[var(--foreground-muted)] font-mono">
                Nenhuma retrospectiva registrada ainda.
              </p>
            ) : (
              <div className="space-y-2">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => setActiveSessionId(session.id)}
                    className="w-full text-left flex items-center justify-between gap-4 p-2 border border-[var(--border)] rounded hover:bg-[var(--accent)]/10 transition-colors"
                  >
                    <span className="text-xs font-mono">
                      {session.periodStart} → {session.periodEnd}
                    </span>
                    <StatusBadge status={session.status} />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <SmMemoryCard />

        <SnapshotPanel snapshot={snapshot} />

        {generatedRetroId && <RetroActionsTable retroId={generatedRetroId} />}
      </div>
    </div>
  );
}
