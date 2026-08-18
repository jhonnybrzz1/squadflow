/**
 * ChatAreaV2 - Shell ativo do sistema de chat
 *
 * Mantém compatibilidade com a API existente.
 *
 * NOTE: Do NOT call useSquadChat here — SquadChatContainer already does.
 * Calling it in both places creates duplicate SSE/WebSocket connections
 * that cause infinite re-render loops ("Maximum update depth exceeded").
 */

import { CheckCircle, StopCircle, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SquadChatContainer } from './SquadChatContainer';
import { DocumentViewer } from '../document-viewer';
import { ArtifactsPanel } from '../artifacts-panel';
import type { Demand } from '@shared/schema';

import './squad-chat.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatAreaV2Props {
  selectedDemand?: Demand | null;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ChatAreaV2({ selectedDemand, className }: ChatAreaV2Props) {
  // Progress calculation based on demand status (no hook needed)
  const progress = selectedDemand?.progress ?? 0;

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Main Chat Area */}
      <SquadChatContainer demand={selectedDemand || null} />

      {/* Processing Status Card */}
      {selectedDemand?.status === 'processing' && (
        <div className="neo-card glow-border">
          <div className="p-4">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-10 h-10 bg-[var(--accent-cyan)]/10 border border-[var(--accent-cyan)] flex items-center justify-center">
                <Cpu className="w-5 h-5 text-[var(--accent-cyan)] animate-pulse" />
              </div>
              <div>
                <p className="font-mono text-sm font-bold">PROCESSANDO DEMANDA</p>
                <p className="font-mono text-xs text-[var(--foreground-muted)] truncate max-w-xs">
                  {selectedDemand.title}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between font-mono text-xs">
                <span className="text-[var(--foreground-muted)]">PROGRESSO</span>
                <span className="text-[var(--accent-cyan)]">{Math.round(progress)}%</span>
              </div>
              <div className="progress-brutal">
                <div className="progress-brutal-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Completed Status with Documents */}
      {selectedDemand?.status === 'completed' && (
        <>
          <div className="neo-card glow-border border-[var(--success)]">
            <div className="p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-[var(--success)]/10 border border-[var(--success)] flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-[var(--success)]" />
              </div>
              <div className="flex-1">
                <p className="font-mono text-sm font-bold text-[var(--success)]">
                  REFINAMENTO COMPLETO
                </p>
                <p className="font-mono text-xs text-[var(--foreground-muted)]">
                  Documentos PRD e Tasks gerados com sucesso
                </p>
              </div>
            </div>

            {/* Agents Summary - derived from chatMessages */}
            {selectedDemand.chatMessages &&
              selectedDemand.chatMessages.length > 0 &&
              (() => {
                const agentIds = [
                  ...new Set(
                    selectedDemand.chatMessages
                      .map((m) => m.agent)
                      .filter((id) => id !== 'system' && id !== 'user' && id !== 'coordinator'),
                  ),
                ];
                if (agentIds.length === 0) return null;
                return (
                  <div className="px-4 pb-4">
                    <div className="border border-[var(--border)] bg-[var(--muted)] p-3">
                      <p className="font-mono text-[10px] text-[var(--foreground-muted)] mb-2 uppercase tracking-wider">
                        Refinado por
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {agentIds.map((id) => (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 border font-mono text-[10px]"
                          >
                            <span>
                              {id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}
          </div>

          {/* Documents */}
          {selectedDemand.prdUrl && (
            <div key={`prd-${selectedDemand.id}`}>
              <DocumentViewer
                demandId={selectedDemand.id}
                documentType="prd"
                pdfUrl={selectedDemand.prdUrl}
                refinementType={selectedDemand.refinementType as 'technical' | 'business' | null}
                typeAdherence={selectedDemand.typeAdherence as any}
                documentState={selectedDemand.documentState as any}
                reviewSnapshotId={selectedDemand.reviewSnapshotId as any}
                snapshotHash={selectedDemand.approvedSnapshotHash as any}
                approvalSessionId={selectedDemand.approvalSessionId as any}
                sectionChecklist={
                  (selectedDemand.sectionChecklist as Record<string, boolean>) || {}
                }
                documentVersion={
                  selectedDemand.updatedAt
                    ? new Date(selectedDemand.updatedAt).getTime()
                    : undefined
                }
              />
            </div>
          )}

          {/* Documento técnico (TDD) — spec 014 / H-08 */}
          {selectedDemand.tddUrl && (
            <div key={`tdd-${selectedDemand.id}`}>
              <DocumentViewer
                demandId={selectedDemand.id}
                documentType="tdd"
                pdfUrl={selectedDemand.tddUrl}
                documentVersion={
                  selectedDemand.updatedAt
                    ? new Date(selectedDemand.updatedAt).getTime()
                    : undefined
                }
              />
            </div>
          )}

          {selectedDemand.tasksUrl && (
            <div key={`tasks-${selectedDemand.id}`}>
              <DocumentViewer
                demandId={selectedDemand.id}
                documentType="tasks"
                pdfUrl={selectedDemand.tasksUrl}
                documentVersion={
                  selectedDemand.updatedAt
                    ? new Date(selectedDemand.updatedAt).getTime()
                    : undefined
                }
              />
            </div>
          )}

          {/* Artefatos pós-refinamento (demanda 10037) */}
          <ArtifactsPanel demandId={selectedDemand.id} demand={selectedDemand} />
        </>
      )}

      {/* Stopped Status */}
      {selectedDemand?.status === 'stopped' && (
        <div className="neo-card border-[var(--warning)]">
          <div className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-[var(--warning)]/10 border border-[var(--warning)] flex items-center justify-center">
              <StopCircle className="w-5 h-5 text-[var(--warning)]" />
            </div>
            <div>
              <p className="font-mono text-sm font-bold text-[var(--warning)]">
                REFINAMENTO INTERROMPIDO
              </p>
              <p className="font-mono text-xs text-[var(--foreground-muted)]">
                O processo foi interrompido pelo usuário
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
