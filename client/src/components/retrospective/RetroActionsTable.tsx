/**
 * Demanda 10195 — Tabela CRUD de ações de retrospectiva.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Save, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import type { RetroActionDto } from '@shared/retrospective';

const METRIC_OPTIONS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Custo' },
  { value: 'latency', label: 'Latência' },
];

interface RetroActionsTableProps {
  retroId: string;
}

function SuccessBadge({ successMet }: { successMet: boolean | null }) {
  if (successMet === null) {
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        A avaliar
      </Badge>
    );
  }
  if (successMet) {
    return (
      <Badge className="bg-green-600/20 text-green-500 border border-green-600/30 font-mono text-[10px] gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Sucesso
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="font-mono text-[10px] gap-1">
      <XCircle className="h-3 w-3" />
      Não atingiu
    </Badge>
  );
}

export default function RetroActionsTable({ retroId }: RetroActionsTableProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({
    description: '',
    metricKey: 'tokens',
    owner: '',
    successCriteria: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['retroActions', retroId],
    queryFn: () => api.retrospective.listActions(retroId),
    enabled: !!retroId,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.retrospective.createAction(retroId, {
        description: form.description,
        metricKey: form.metricKey,
        owner: form.owner || undefined,
        successCriteria: form.successCriteria || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retroActions', retroId] });
      toast({ title: 'Ação criada' });
      setIsCreating(false);
      setForm({ description: '', metricKey: 'tokens', owner: '', successCriteria: '' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao criar ação',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ actionId, metricAfter }: { actionId: string; metricAfter: number }) =>
      api.retrospective.updateAction(retroId, actionId, { metricAfter }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['retroActions', retroId] });
      toast({ title: 'Métrica atualizada' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Erro ao atualizar métrica',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    },
  });

  const actions = data?.actions ?? [];

  return (
    <Card className="brutal-card lg:col-span-2" data-testid="retro-actions-table">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-mono text-sm font-bold">Plano de Ações</CardTitle>
            <CardDescription className="text-[10px] uppercase">
              Ações focadas em métricas do snapshot
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsCreating(true)}
            disabled={isCreating}
            className="font-mono text-xs gap-1"
          >
            <Plus className="h-3 w-3" />
            Nova ação
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-xs text-[var(--foreground-muted)] font-mono">Carregando ações…</p>
        ) : actions.length === 0 && !isCreating ? (
          <p className="text-xs text-[var(--foreground-muted)] font-mono">
            Nenhuma ação registrada. Crie uma ação para melhorar uma métrica do período.
          </p>
        ) : (
          <div className="space-y-4">
            {isCreating && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 border border-[var(--border)] rounded">
                <div className="md:col-span-2">
                  <Label className="font-mono text-xs uppercase">Descrição</Label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Ex: reduzir consumo de tokens no refinamento técnico"
                  />
                </div>
                <div>
                  <Label className="font-mono text-xs uppercase">Métrica</Label>
                  <select
                    value={form.metricKey}
                    onChange={(e) => setForm({ ...form, metricKey: e.target.value })}
                    className="w-full h-9 px-2 text-sm border border-[var(--border)] bg-[var(--background)] rounded"
                  >
                    {METRIC_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="font-mono text-xs uppercase">Responsável</Label>
                  <Input
                    value={form.owner}
                    onChange={(e) => setForm({ ...form, owner: e.target.value })}
                    placeholder="Opcional"
                  />
                </div>
                <div className="md:col-span-2">
                  <Label className="font-mono text-xs uppercase">Critério de sucesso</Label>
                  <Input
                    value={form.successCriteria}
                    onChange={(e) => setForm({ ...form, successCriteria: e.target.value })}
                    placeholder="Opcional: descreva como avaliar o sucesso"
                  />
                </div>
                <div className="md:col-span-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => createMutation.mutate()}
                    disabled={!form.description.trim() || createMutation.isPending}
                    className="font-mono text-xs gap-1"
                  >
                    <Save className="h-3 w-3" />
                    Salvar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsCreating(false)}
                    className="font-mono text-xs"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--border)] text-left text-xs uppercase text-[var(--foreground-muted)]">
                  <tr>
                    <th className="px-4 py-2">Ação</th>
                    <th className="px-4 py-2">Métrica</th>
                    <th className="px-4 py-2">Antes</th>
                    <th className="px-4 py-2">Depois</th>
                    <th className="px-4 py-2">Diff %</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((action: RetroActionDto) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      onUpdateAfter={(metricAfter) =>
                        updateMutation.mutate({ actionId: action.id, metricAfter })
                      }
                      isPending={updateMutation.isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionRow({
  action,
  onUpdateAfter,
  isPending,
}: {
  action: RetroActionDto;
  onUpdateAfter: (value: number) => void;
  isPending: boolean;
}) {
  const [afterValue, setAfterValue] = useState<string>(
    action.metricAfter !== null ? String(action.metricAfter) : '',
  );

  const metricLabel =
    METRIC_OPTIONS.find((o) => o.value === action.metricKey)?.label ?? action.metricKey;

  return (
    <tr className="border-b border-[var(--border)] last:border-0">
      <td className="px-4 py-2 align-top">
        <p className="font-medium text-xs">{action.description}</p>
        {action.owner && (
          <p className="text-[10px] text-[var(--foreground-muted)]">Responsável: {action.owner}</p>
        )}
      </td>
      <td className="px-4 py-2 align-top text-[var(--foreground-muted)]">{metricLabel}</td>
      <td className="px-4 py-2 align-top font-mono">
        {action.metricBefore !== null ? action.metricBefore.toLocaleString('pt-BR') : '—'}
      </td>
      <td className="px-4 py-2 align-top">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={afterValue}
            onChange={(e) => setAfterValue(e.target.value)}
            placeholder="—"
            className="w-28 h-8 text-xs font-mono"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={isPending || afterValue === ''}
            onClick={() => onUpdateAfter(Number(afterValue))}
          >
            <Save className="h-3 w-3" />
          </Button>
        </div>
      </td>
      <td className="px-4 py-2 align-top font-mono">
        {action.diffPercent !== null ? `${action.diffPercent.toFixed(1)}%` : '—'}
      </td>
      <td className="px-4 py-2 align-top">
        <SuccessBadge successMet={action.successMet} />
      </td>
    </tr>
  );
}
