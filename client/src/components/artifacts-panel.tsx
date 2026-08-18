/**
 * Demanda 10037 — painel de artefatos pós-refinamento.
 *
 * Geração síncrona (ADR-0002): o POST responde 201 com o artefato pronto, sem
 * jobId nem WebSocket. Por isso o botão só precisa de estado de carregamento —
 * não há progresso a acompanhar.
 *
 * Demanda 10060: o botão de gerar fluxograma fica desabilitado quando a demanda
 * ainda não tem documentos de refinamento (PRD/tasks/TDD).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { FlowchartArtifact } from './flowchart-artifact';
import type { Demand } from '@shared/schema';
import type { ApiError } from '@/lib/api-error';

interface ArtifactDto {
  id: string;
  demandId: number;
  type: 'flowchart';
  source: string;
  createdAt: string;
}

interface ArtifactsPanelProps {
  demandId: number;
  demand: Demand;
}

const REFINEMENT_EMPTY_MESSAGE = 'Geração indisponível: aguarde a conclusão do refinamento.';

function hasRefinement(demand: Demand): boolean {
  return Boolean(demand.prdUrl || demand.tasksUrl || demand.tddUrl);
}

function getErrorDescription(error: Error): string {
  const apiError = error as ApiError;
  const body = apiError.body as
    { message?: string; issues?: Array<{ path?: string; message?: string }> } | undefined;

  if (body && typeof body === 'object') {
    const refinementIssue = body.issues?.find(
      (issue) => issue.path === 'refinement' && issue.message,
    );
    if (refinementIssue?.message) return refinementIssue.message;
    if (body.message) return body.message;
  }

  return error.message;
}

export function ArtifactsPanel({ demandId, demand }: ArtifactsPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [wantsFlowchart, setWantsFlowchart] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const refinementAvailable = hasRefinement(demand);

  const queryKey = [`/api/demands/${demandId}/artifacts`];

  const { data } = useQuery<{ artifacts: ArtifactDto[] }>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/demands/${demandId}/artifacts`);
      return res.json();
    },
  });

  const generate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/demands/${demandId}/artifacts`, {
        type: 'flowchart',
      });
      return res.json();
    },
    onSuccess: (artifact: ArtifactDto & { truncated?: boolean }) => {
      queryClient.invalidateQueries({ queryKey });
      setModalOpen(false);
      toast({
        title: 'Fluxograma gerado',
        description: artifact.truncated
          ? 'O refinamento tem muitos passos — o diagrama mostra os primeiros.'
          : 'O diagrama já está disponível abaixo.',
      });
    },
    onError: (error: Error) => {
      // 400 aqui é entrada insuficiente (refinamento sem passos reconhecíveis),
      // não falha do servidor: a mensagem do backend explica o que faltou.
      toast({
        title: 'Não foi possível gerar o fluxograma',
        description: getErrorDescription(error),
        variant: 'destructive',
      });
    },
  });

  const artifacts = data?.artifacts ?? [];

  return (
    <div className="space-y-4 px-4 pb-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--foreground-muted)]">
          Artefatos
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setModalOpen(true)}
          data-testid="open-artifacts-modal"
        >
          <Workflow className="mr-2 h-4 w-4" />
          Gerar artefato
        </Button>
      </div>

      {artifacts.length === 0 && (
        <p className="text-sm text-[var(--foreground-muted)]">
          Nenhum artefato gerado para esta demanda.
        </p>
      )}

      {artifacts.map((artifact) => (
        <FlowchartArtifact
          key={artifact.id}
          artifactId={artifact.id}
          source={artifact.source}
          createdAt={artifact.createdAt}
        />
      ))}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gerar artefatos</DialogTitle>
            <DialogDescription>
              Escolha os artefatos a gerar a partir do refinamento desta demanda.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3 py-2">
            <Checkbox
              id="artifact-flowchart"
              checked={wantsFlowchart}
              onCheckedChange={(checked) => setWantsFlowchart(checked === true)}
              data-testid="artifact-option-flowchart"
            />
            <label htmlFor="artifact-flowchart" className="text-sm">
              Fluxograma
            </label>
          </div>

          {!refinementAvailable && (
            <p className="text-sm text-[var(--foreground-muted)]" role="status">
              {REFINEMENT_EMPTY_MESSAGE}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block">
                  <Button
                    onClick={() => generate.mutate()}
                    disabled={!wantsFlowchart || !refinementAvailable || generate.isPending}
                    data-testid="artifact-generate"
                  >
                    {generate.isPending ? 'Gerando…' : 'Gerar'}
                  </Button>
                </span>
              </TooltipTrigger>
              {!refinementAvailable && (
                <TooltipContent side="top">{REFINEMENT_EMPTY_MESSAGE}</TooltipContent>
              )}
            </Tooltip>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
