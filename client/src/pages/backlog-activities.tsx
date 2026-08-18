/**
 * Demanda 10096 — Backlog de atividades (execução de specs).
 *
 * Lista atividades criadas automaticamente no handoff, exibe os steps
 * (PRD/Tasks/Chat) e permite transicionar manualmente o status pela
 * sequência: em_desenvolvimento → aguardando_revisao → pronto → em_producao.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, Loader2, Play, Plus, RotateCcw, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, type BacklogActivity } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { ArtifactModal } from '@/components/artifact-modal';

const STATUS_LABELS: Record<BacklogActivity['status'], string> = {
  em_desenvolvimento: 'Em desenvolvimento',
  aguardando_revisao: 'Aguardando revisão',
  pronto: 'Pronto',
  em_producao: 'Em produção',
};

const STATUS_VARIANT: Record<
  BacklogActivity['status'],
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  em_desenvolvimento: 'secondary',
  aguardando_revisao: 'default',
  pronto: 'default',
  em_producao: 'outline',
};

function StatusBadge({ status }: { status: BacklogActivity['status'] }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABELS[status]}</Badge>;
}

function StepBadge({
  completed,
  label,
  onClick,
}: {
  completed: boolean;
  label: string;
  onClick?: () => void;
}) {
  return completed ? (
    <Badge
      className={`gap-1 bg-green-600/20 text-green-500 border border-green-600/30 ${onClick ? 'cursor-pointer hover:bg-green-600/30' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      title={onClick ? `Visualizar ${label}` : undefined}
    >
      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-[var(--foreground-muted)]">
      <Circle className="h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

function TransitionButton({
  activity: _activity,
  target,
  onTransition,
  isPending,
}: {
  activity: BacklogActivity;
  target: BacklogActivity['status'];
  onTransition: (target: BacklogActivity['status']) => void;
  isPending: boolean;
}) {
  const labels: Record<BacklogActivity['status'], string> = {
    em_desenvolvimento: 'Voltar para dev',
    aguardando_revisao: 'Enviar para revisão',
    pronto: 'Aprovar / Revisar',
    em_producao: 'Colocar em produção',
  };

  const icons: Record<BacklogActivity['status'], React.ReactNode> = {
    em_desenvolvimento: <RotateCcw className="h-3 w-3" />,
    aguardando_revisao: <Send className="h-3 w-3" />,
    pronto: <CheckCircle2 className="h-3 w-3" />,
    em_producao: <Play className="h-3 w-3" />,
  };

  return (
    <Button
      size="sm"
      variant={target === 'em_desenvolvimento' ? 'outline' : 'default'}
      onClick={() => onTransition(target)}
      disabled={isPending}
      className="gap-1 text-xs"
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : icons[target]}
      {labels[target]}
    </Button>
  );
}

function ActivityCard({
  activity,
  isPending,
  onTransition,
}: {
  activity: BacklogActivity;
  isPending: boolean;
  onTransition: (target: BacklogActivity['status']) => void;
}) {
  const [openModal, setOpenModal] = useState<'PRD' | 'Tasks' | null>(null);

  const allowedTargets = useMemo(() => {
    const map: Record<BacklogActivity['status'], BacklogActivity['status'][]> = {
      em_desenvolvimento: ['aguardando_revisao'],
      aguardando_revisao: ['pronto', 'em_desenvolvimento'],
      pronto: ['em_producao', 'aguardando_revisao'],
      em_producao: [],
    };
    return map[activity.status];
  }, [activity.status]);

  return (
    <Card className="brutal-card">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="font-mono text-sm font-bold">
              <span className="text-[var(--foreground-muted)]">#{activity.demandId}</span>{' '}
              {activity.title}
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-[10px] text-[var(--foreground-muted)]">
              Criada {new Date(activity.createdAt).toLocaleString('pt-BR')} · Atualizada{' '}
              {new Date(activity.updatedAt).toLocaleString('pt-BR')}
            </CardDescription>
          </div>
          <StatusBadge status={activity.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap gap-2">
          <StepBadge
            completed={activity.hasPrd}
            label="PRD"
            onClick={activity.hasPrd ? () => setOpenModal('PRD') : undefined}
          />
          <StepBadge
            completed={activity.hasTasks}
            label="Tasks"
            onClick={activity.hasTasks ? () => setOpenModal('Tasks') : undefined}
          />
          <StepBadge completed={activity.hasChat} label="Chat" />
        </div>

        <ArtifactModal
          open={openModal === 'PRD'}
          onOpenChange={(open) => {
            if (!open) setOpenModal(null);
          }}
          demandId={activity.demandId}
          type="PRD"
        />
        <ArtifactModal
          open={openModal === 'Tasks'}
          onOpenChange={(open) => {
            if (!open) setOpenModal(null);
          }}
          demandId={activity.demandId}
          type="Tasks"
        />

        <div className="flex flex-wrap gap-2">
          {allowedTargets.map((target) => (
            <TransitionButton
              key={target}
              activity={activity}
              target={target}
              onTransition={onTransition}
              isPending={isPending}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function BacklogActivitiesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['backlog-activities'],
    queryFn: api.backlog.list,
    retry: false,
  });

  const transitionMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: BacklogActivity['status'] }) =>
      api.backlog.transition(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backlog-activities'] });
      toast({ title: 'Status atualizado' });
    },
    onError: (err) => {
      toast({
        variant: 'destructive',
        title: 'Erro na transição',
        description: getFriendlyErrorFromException(err).message,
      });
    },
  });

  const activities = data?.activities ?? [];

  return (
    <section className="mx-auto max-w-5xl px-6 py-8" data-testid="backlog-activities-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[var(--foreground)]">Atividades do Handoff</h1>
        <p className="text-sm text-[var(--foreground-muted)]">
          Atividades criadas automaticamente a partir do handoff e seu fluxo de status.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando atividades…
        </div>
      )}

      {isError && !isLoading && (
        <Card className="brutal-card border-destructive">
          <CardContent className="py-6 text-sm text-[var(--foreground-muted)]">
            Não foi possível carregar o backlog de atividades. Tente novamente mais tarde.
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && activities.length === 0 && (
        <Card className="brutal-card">
          <CardContent className="py-8 text-center text-sm text-[var(--foreground-muted)]">
            <Clock className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p className="mb-4">
              Nenhuma atividade no backlog ainda. Atividades são criadas automaticamente quando uma
              demanda conclui o handoff.
            </p>
            <Link href="/">
              <Button variant="default" size="sm" className="gap-1">
                <Plus className="h-4 w-4" />
                Iniciar Refinamento
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {activities.map((activity) => (
          <ActivityCard
            key={activity.id}
            activity={activity}
            isPending={transitionMutation.isPending}
            onTransition={(status) => transitionMutation.mutate({ id: activity.id, status })}
          />
        ))}
      </div>
    </section>
  );
}
