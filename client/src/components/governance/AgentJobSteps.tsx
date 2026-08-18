import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Terminal,
  Loader2,
  AlertCircle,
  Wrench,
  MessageSquare,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Rocket,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';

import type { AgentJobView, AgentJobStep } from '@shared/agent-job';

import { AgentMarkdown } from './AgentMarkdown';
import { TechLeadReviewButton } from './TechLeadReviewButton';
// F3 (botão de merge/PR) deferido: backend existe (server/services/merge-to-main.ts)
// mas o MergeToMainButton do frontend fica fora até um run limpo.

/** Demanda 10088 (item 1): timeline carrega em blocos, não tudo de uma vez. */
const TIMELINE_PAGE_SIZE = 20;

interface AgentJobStepsProps {
  demandId: number;
}

// F1: passos de prosa do Claude (texto/resultado) são renderizados como markdown
// legível; passos de tool/erro são identificadores curtos e ficam em monospace.
function isProseStep(kind: AgentJobStep['kind']): boolean {
  return kind === 'text' || kind === 'result';
}

function StepIcon({ kind }: { kind: AgentJobStep['kind'] }) {
  if (kind === 'tool') return <Wrench className="w-3 h-3 text-[var(--accent-gold)]" />;
  if (kind === 'result') return <CheckCircle2 className="w-3 h-3 text-green-500" />;
  if (kind === 'error') return <AlertCircle className="w-3 h-3 text-red-500" />;
  return <MessageSquare className="w-3 h-3 text-[var(--foreground-muted)]" />;
}

function statusLabel(status: AgentJobView['status']): string {
  if (status === 'running') return 'em execução';
  if (status === 'succeeded') return 'concluído';
  if (status === 'pending') return 'pendente';
  return 'falhou';
}

export function AgentJobSteps({ demandId }: AgentJobStepsProps) {
  const { data, isLoading, error } = useQuery<AgentJobView[]>({
    queryKey: [`/api/demands/${demandId}/agent-jobs`],
    queryFn: async () => {
      const response = await fetch(`/api/demands/${demandId}/agent-jobs`);
      if (!response.ok) {
        throw new Error('Failed to fetch agent jobs');
      }
      return response.json();
    },
  });

  const latest = data && data.length > 0 ? data[0] : null;
  // Demanda 10088: painel colapsável (item 1) + paginação da timeline + estado
  // do placeholder de deploy (item 3).
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [visibleSteps, setVisibleSteps] = useState(TIMELINE_PAGE_SIZE);
  const [deployMsg, setDeployMsg] = useState<string | null>(null);

  return (
    <div className="border border-[var(--border)] p-3" data-testid="agent-job-steps">
      <div className="flex items-center gap-2 mb-3">
        <Terminal className="w-4 h-4 text-[var(--accent-gold)]" />
        <h3 className="font-mono text-xs font-bold uppercase">Atuação do agente Claude</h3>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 font-mono text-xs text-[var(--foreground-muted)]">
          <Loader2 className="w-3 h-3 animate-spin" /> Carregando…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 font-mono text-xs text-[var(--foreground-muted)]">
          <AlertCircle className="w-3 h-3" /> Jobs indisponíveis
        </div>
      )}

      {!isLoading && !error && !latest && (
        <p className="font-mono text-xs text-[var(--foreground-muted)]">
          Nenhuma execução ainda. Clique em “Enviar ao Claude” para acionar o agente.
        </p>
      )}

      {latest && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[var(--foreground-muted)]">
            <span data-testid="agent-job-status">status: {statusLabel(latest.status)}</span>
            <span>arquivos: {latest.filesModified.length}</span>
            <span>
              typecheck:{' '}
              {latest.typecheckPassed === null ? '—' : latest.typecheckPassed ? 'ok' : 'falhou'}
            </span>
            {latest.apiCostUsd != null && <span>custo: ${latest.apiCostUsd.toFixed(4)}</span>}
          </div>

          {latest.errorMessage && (
            <div className="font-mono text-[10px] text-red-500" data-testid="agent-job-error">
              {latest.errorMessage}
            </div>
          )}

          {latest.steps.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setTimelineOpen((v) => !v)}
                aria-expanded={timelineOpen}
                className="mb-1 flex items-center gap-1 font-mono text-[10px] uppercase text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                data-testid="timeline-toggle"
              >
                {timelineOpen ? (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                )}
                Plano de ação e timeline ({latest.steps.length})
              </button>
              {timelineOpen && (
                <>
                  <ol className="flex flex-col gap-1">
                    {latest.steps.slice(0, visibleSteps).map((step, index) => (
                      <li key={index} className="flex items-start gap-2 text-xs">
                        <span className="mt-0.5">
                          <StepIcon kind={step.kind} />
                        </span>
                        {isProseStep(step.kind) ? (
                          <div className="min-w-0 flex-1">
                            <AgentMarkdown
                              content={step.detail?.trim() ? step.detail : step.label}
                            />
                          </div>
                        ) : (
                          <span className="break-all font-mono" title={step.detail}>
                            {step.label}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  {latest.steps.length > visibleSteps && (
                    <button
                      type="button"
                      onClick={() => setVisibleSteps((v) => v + TIMELINE_PAGE_SIZE)}
                      className="mt-1 font-mono text-[10px] underline underline-offset-2 hover:text-[var(--foreground)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                      data-testid="timeline-load-more"
                    >
                      Carregar mais ({latest.steps.length - visibleSteps} restantes)
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
              Sem passos registrados para esta execução.
            </p>
          )}

          {latest.filesModified.length > 0 && (
            <div className="mt-1">
              <p className="font-mono text-[10px] uppercase text-[var(--foreground-muted)]">
                Arquivos modificados
              </p>
              <ul className="font-mono text-[10px]">
                {latest.filesModified.map((file) => (
                  <li key={file} className="break-all">
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* F2: parecer opcional do TechLead (F3 deferido). */}
          <div className="mt-2 flex flex-col gap-2 border-t border-[var(--border)] pt-2">
            <TechLeadReviewButton jobId={latest.id} />

            {/* Demanda 10088 (item 2): changelog ao finalizar — Sprint 1 usa
                texto livre + arquivos reais do job; metadados do GitHub são Sprint 2. */}
            {latest.status === 'succeeded' && (
              <Dialog>
                <DialogTrigger
                  className="self-start font-mono text-[10px] underline underline-offset-2"
                  data-testid="changelog-trigger"
                >
                  Ver changelog
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Changelog da execução</DialogTitle>
                    <DialogDescription>
                      Alterações registradas por esta execução do agente.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="font-mono text-xs">
                    <p className="mb-1 uppercase text-[var(--foreground-muted)]">
                      Arquivos ({latest.filesModified.length})
                    </p>
                    {latest.filesModified.length > 0 ? (
                      <ul className="max-h-56 overflow-y-auto">
                        {latest.filesModified.map((file) => (
                          <li key={file} className="break-all">
                            {file}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[var(--foreground-muted)]">Nenhum arquivo modificado.</p>
                    )}
                    <p className="mt-2 text-[var(--foreground-muted)]">
                      typecheck:{' '}
                      {latest.typecheckPassed === null
                        ? '—'
                        : latest.typecheckPassed
                          ? 'ok'
                          : 'falhou'}
                    </p>
                  </div>
                </DialogContent>
              </Dialog>
            )}

            {/* Demanda 10088 (item 3): Sprint 1 entrega o PLACEHOLDER. O deploy
                real via PR depende da integração GitHub API (Sprint 2), então o
                botão só valida a pré-condição e explica o que falta. */}
            <div className="flex flex-col gap-1">
              <button
                type="button"
                disabled={latest.status !== 'succeeded'}
                onClick={() =>
                  setDeployMsg(
                    'Simulação: o deploy real abre um PR em "Ready for Review" e depende da integração com a GitHub API (Sprint 2). Nada foi enviado.',
                  )
                }
                className="inline-flex w-fit items-center gap-1 border border-[var(--border)] px-2 py-1 font-mono text-[10px] hover:bg-[var(--muted)] transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                data-testid="simulate-deploy"
              >
                <Rocket className="h-3 w-3" aria-hidden="true" /> Simular Deploy
              </button>
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
                {latest.status !== 'succeeded'
                  ? 'Disponível apenas após a execução concluir com sucesso.'
                  : 'Placeholder — merge automático foi rejeitado; o fluxo real é PR manual.'}
              </p>
              {deployMsg && (
                <p className="font-mono text-[10px] text-[var(--accent-gold)]" role="status">
                  {deployMsg}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
