import { useState, useRef, useEffect } from 'react';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Download,
  Loader2,
  FileText,
  Eye,
  EyeOff,
  ExternalLink,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  Package,
  Bot,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { safeWindowOpen } from '@/lib/safe-window-open';
import MDEditor from '@uiw/react-md-editor';
import { useEnhancedTheme } from '@/components/ui/theme-provider';
import { TypeAdherenceBadge, TypeAdherenceBadgeCompact } from './type-adherence-badge';
// Demanda 10082 (F1): rascunho do editor sobrevive à troca de módulo/rota.
import { usePersistedState } from '@/hooks/usePersistedState';
import { ReviewBanner } from './governance/ReviewBanner';
import { ApprovalActions } from './governance/ApprovalActions';
import { ApprovalComments } from './governance/ApprovalComments';
import { GovernanceGatingPanel } from './governance/GovernanceGatingPanel';
import { RefinementInteractions } from './governance/RefinementInteractions';
import { PrdSectionEvidence } from './governance/PrdSectionEvidence';
import { DemandCostBreakdown } from './governance/DemandCostBreakdown';
import { DemandMetadataPanel } from './governance/DemandMetadataPanel';
import { AgentJobSteps } from './governance/AgentJobSteps';
import { HandoffMetadataBadge } from './handoff-metadata-badge';
import { SnapshotDiffViewer } from './governance/SnapshotDiffViewer';

interface TypeAdherenceResult {
  isAdherent: boolean;
  type: 'technical' | 'business' | null;
  sectionsFound: string[];
  sectionsRequired: number;
  sectionsMet: number;
  score: number;
  feedback: string;
}

interface DocumentViewerProps {
  demandId: number;
  documentType: 'prd' | 'tasks' | 'tdd';
  pdfUrl?: string;
  refinementType?: 'technical' | 'business' | null;
  typeAdherence?: TypeAdherenceResult | null;
  documentState?: 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'FINAL' | 'APPROVAL_REQUIRED';
  reviewSnapshotId?: string;
  snapshotHash?: string;
  approvalSessionId?: string;
  /** Cache buster para forçar refetch após refinement */
  documentVersion?: string | number;
  /** Section checklist for PRD evidence tracking */
  sectionChecklist?: Record<string, boolean>;
}

export function DocumentViewer({
  demandId,
  documentType,
  pdfUrl,
  refinementType,
  typeAdherence,
  documentState = 'DRAFT',
  reviewSnapshotId,
  snapshotHash,
  approvalSessionId,
  documentVersion,
  sectionChecklist = {},
}: DocumentViewerProps) {
  const { toast } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState<string | undefined>('');
  // Demanda 10082 (F1): rascunho persistido por demanda+documento. Não substitui
  // o estado de edição — apenas espelha, para restaurar se a pessoa sair da tela.
  const [draft, setDraft, clearDraft] = usePersistedState(`doc:${demandId}:${documentType}`);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [, setGatingPassed] = useState(true);
  const [localSectionChecklist, setLocalSectionChecklist] = useState(sectionChecklist);
  const { isDarkMode } = useEnhancedTheme();
  const queryClient = useQueryClient();
  const surveyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state with prop changes. Serialize to a stable string so the
  // effect only re-runs when the checklist content actually changes, avoiding
  // the infinite loop caused by a new object reference on every render.
  const sectionChecklistKey = JSON.stringify(sectionChecklist);
  useEffect(() => {
    setLocalSectionChecklist(JSON.parse(sectionChecklistKey));
  }, [sectionChecklistKey]);

  /**
   * Auditoria 2026-08-01 (A01): fora de DRAFT o documento está congelado — o
   * ReviewBanner promete imutabilidade e o revisor decide sobre um snapshot
   * com hash. Mesmo assim este componente buscava sempre `/documents/:type`,
   * ou seja, o documento VIVO, que pode ter mudado depois do congelamento. O
   * revisor podia aprovar um texto diferente do que assinou.
   */
  const isFrozenState = documentState !== 'DRAFT';

  /**
   * O snapshot de governança congela `prdContent` e `tasksContent` — não há
   * campo para TDD (ver `SnapshotPayload`). Retornar null aqui faz o caller
   * cair no documento vivo de forma explícita, em vez de exibir vazio.
   */
  const contentFromSnapshot = (payload: Record<string, unknown> | undefined): string | null => {
    if (!payload) return null;
    const field =
      documentType === 'prd' ? 'prdContent' : documentType === 'tasks' ? 'tasksContent' : null;
    if (!field) return null;
    const value = payload[field];
    return typeof value === 'string' ? value : null;
  };

  const {
    data: documentData,
    isLoading,
    error,
  } = useQuery({
    // `documentState` entra na chave para resolver a corrida do A01: quando o
    // estado muda, a chave muda, então a resposta em voo da origem antiga não
    // é exibida sob a nova — sem precisar comparar timestamps na mão.
    // `documentVersion` continua invalidando o cache após refinement.
    queryKey: [
      `/api/demands/${demandId}/documents/${documentType}`,
      documentType,
      documentState,
      documentVersion,
    ],
    queryFn: async () => {
      if (isFrozenState) {
        const snapshotResponse = await fetch(
          `/api/governance/demands/${demandId}/review-snapshot?t=${Date.now()}`,
        );

        if (snapshotResponse.ok) {
          const snapshotData = await snapshotResponse.json();
          const frozenContent = contentFromSnapshot(snapshotData?.payload);

          if (frozenContent !== null) {
            return {
              content: frozenContent,
              version: documentVersion ?? 0,
              frozen: true,
              snapshotId: snapshotData?.snapshot?.snapshotId,
            };
          }
        }
        // Sem snapshot utilizável (TDD, ou snapshot ausente): cai no documento
        // vivo, mas sinaliza para a UI não afirmar que está congelado.
      }

      const response = await fetch(
        `/api/demands/${demandId}/documents/${documentType}?t=${Date.now()}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch ${documentType} document`);
      }
      const live = await response.json();
      return { ...live, frozen: false };
    },
    enabled: isExpanded,
    // Forçar refetch sempre que o componente é montado/expandido
    staleTime: 0,
    // Não usar cache garbage collected
    gcTime: 0,
  });

  const markdownContent = documentData?.content;
  const currentVersion = documentData?.version ?? 0;

  useEffect(() => {
    if (isEditing && typeof editContent === 'string') setDraft(editContent);
  }, [isEditing, editContent, setDraft]);

  const handleStartEdit = () => {
    // A01: guarda redundante ao botão desabilitado — editar um documento
    // congelado não pode depender só de a UI ter escondido o controle.
    if (isFrozenState) return;
    // Restaura o rascunho não salvo, se houver e for diferente do conteúdo atual.
    setEditContent(draft && draft !== markdownContent ? draft : markdownContent);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent('');
    clearDraft();
  };

  const handleSaveEdit = async () => {
    if (editContent === undefined || editContent === markdownContent) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`/api/demands/${demandId}/documents/${documentType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: editContent,
          ifMatchVersion: currentVersion,
        }),
      });

      if (!response.ok) {
        // Bug 4: 412 Precondition Failed (versão ausente/incorreta). Mantém 409
        // por compatibilidade caso um backend antigo ainda o retorne.
        if (response.status === 412 || response.status === 409) {
          await response.json();
          toast({
            title: 'Conflito de Versão',
            description: 'O documento foi alterado por outro processo. Recarregando...',
            variant: 'destructive',
          });
          queryClient.invalidateQueries({
            queryKey: [`/api/demands/${demandId}/documents/${documentType}`],
          });
          setIsEditing(false);
          return;
        }
        throw new Error('Falha ao salvar documento');
      }

      toast({
        title: 'Sucesso',
        description: 'Documento salvo com sucesso e PDF sendo atualizado.',
      });
      setIsEditing(false);
      clearDraft();
      queryClient.invalidateQueries({
        queryKey: [`/api/demands/${demandId}/documents/${documentType}`],
      });
      // Invalidate demands to update pdfUrl if changed (though it usually stays the same filename)
      queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
    } catch (err) {
      console.error('Erro ao salvar documento:', err);
      toast({
        title: 'Erro ao Salvar',
        description: getFriendlyErrorFromException(err).message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprovalComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
  };

  const handleSectionChecklistChange = async (section: string, checked: boolean) => {
    const nextChecklist = { ...localSectionChecklist, [section]: checked };
    setLocalSectionChecklist(nextChecklist);

    try {
      const response = await fetch(`/api/governance/demands/${demandId}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checklist: nextChecklist }),
      });

      if (!response.ok) throw new Error('Falha ao salvar checklist');

      queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
    } catch (error) {
      setLocalSectionChecklist(localSectionChecklist);
      console.error('Erro ao salvar revisão por seção:', error);
      toast({
        title: 'Erro ao salvar revisão por seção',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    }
  };

  const handleCopyContent = async () => {
    if (!markdownContent) {
      toast({
        title: 'Nada para copiar',
        description: 'O conteúdo ainda não foi carregado.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(markdownContent);
      setIsCopied(true);
      toast({
        title: 'Copiado',
        description: `${documentType.toUpperCase()} copiado para a área de transferência.`,
      });
      setTimeout(() => setIsCopied(false), 2000);
    } catch (_) {
      toast({
        title: 'Erro ao copiar',
        description: 'Não foi possível copiar o conteúdo.',
        variant: 'destructive',
      });
    }
  };

  const handleCopyCollapsed = async () => {
    setIsCopied(true);
    try {
      const response = await fetch(
        `/api/demands/${demandId}/documents/${documentType}?t=${Date.now()}`,
      );
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      await navigator.clipboard.writeText(data.content);
      toast({
        title: 'Copiado',
        description: `${documentType.toUpperCase()} copiado para a área de transferência.`,
      });
    } catch (_) {
      toast({
        title: 'Erro ao copiar',
        description: 'Não foi possível copiar o conteúdo.',
        variant: 'destructive',
      });
    } finally {
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handleDownloadPDF = () => {
    if (!pdfUrl) {
      toast({
        title: 'Não disponível',
        description: 'O documento ainda não foi gerado.',
        variant: 'destructive',
      });
      return;
    }

    setIsDownloading(true);

    // Simulate brief spinner (PDF opens in new tab immediately)
    setTimeout(() => {
      setIsDownloading(false);
      safeWindowOpen(pdfUrl);

      toast({
        title: 'PDF aberto',
        description: (
          <span>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-bold"
            >
              Abrir PDF novamente
            </a>
          </span>
        ) as unknown as string,
      });

      // Microsurvey toast after 2 seconds
      if (surveyTimerRef.current) clearTimeout(surveyTimerRef.current);
      surveyTimerRef.current = setTimeout(() => {
        toast({
          title: 'O PDF atendeu suas expectativas?',
          description: (
            <div className="flex gap-3 mt-1">
              <button
                onClick={() =>
                  toast({ title: 'Obrigado!', description: 'Sua avaliação foi registrada.' })
                }
                className="inline-flex items-center justify-center gap-1 min-h-[44px] px-3 py-2 border rounded text-xs hover:bg-green-50 active:scale-95 transition-transform motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                aria-label="O PDF atendeu suas expectativas: sim"
              >
                <ThumbsUp className="w-3 h-3" aria-hidden="true" /> Sim
              </button>
              <button
                onClick={() =>
                  toast({ title: 'Anotado!', description: 'Vamos melhorar na próxima versão.' })
                }
                className="inline-flex items-center justify-center gap-1 min-h-[44px] px-3 py-2 border rounded text-xs hover:bg-red-50 active:scale-95 transition-transform motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                aria-label="O PDF atendeu suas expectativas: não"
              >
                <ThumbsDown className="w-3 h-3" aria-hidden="true" /> Não
              </button>
            </div>
          ) as unknown as string,
        });
      }, 2000);
    }, 600);
  };

  // Spec 018 (FR-010): handoff só existe para PRD e só quando há PRD —
  // colapsado o sinal é o pdfUrl (mesmo do botão PDF); expandido, o conteúdo carregado.
  const hasPrdForHandoff = Boolean(pdfUrl) || Boolean(markdownContent?.trim());
  const handleExportHandoff = () => {
    safeWindowOpen(`/api/demands/${demandId}/export/bundle`);
  };

  // Spec 10044: disparo manual do agente de código (Claude Code) para esta demanda.
  const sendToClaudeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/demands/${demandId}/send-to-claude`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      // Um HTML aqui = rota não encontrada (servidor desatualizado): o catch-all do
      // Vite responde index.html. Mensagem clara em vez de erro de parse de JSON.
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(
          'Rota não encontrada — reinicie o servidor para carregar POST /api/demands/:id/send-to-claude.',
        );
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error?.message || body?.message || 'Falha ao enviar ao Claude');
      }
      return body;
    },
    onSuccess: () => {
      toast({
        title: 'Enviado ao Claude',
        description: 'O agente de código foi acionado; o resultado é registrado em agent_jobs.',
      });
    },
    onError: (err) => {
      toast({
        title: 'Falha ao enviar ao Claude',
        description:
          err instanceof Error ? err.message : getFriendlyErrorFromException(err).message,
        variant: 'destructive',
      });
    },
  });

  const documentConfig =
    documentType === 'prd'
      ? { title: 'PRD EXECUTIVO', code: 'PRD' }
      : documentType === 'tdd'
        ? { title: 'DOCUMENTO TÉCNICO (TDD)', code: 'TDD' }
        : { title: 'TASKS DOCUMENT', code: 'TASKS' };

  const documentStyle =
    documentType === 'prd'
      ? {
          border: 'border-[var(--accent-cyan)]',
          text: 'text-[var(--accent-cyan)]',
          bg: 'bg-[var(--accent-cyan)]',
          bgMix: 'bg-[color-mix(in_srgb,var(--accent-cyan)_10%,var(--muted))]',
        }
      : documentType === 'tdd'
        ? {
            border: 'border-[var(--accent-magenta)]',
            text: 'text-[var(--accent-magenta)]',
            bg: 'bg-[var(--accent-magenta)]',
            bgMix: 'bg-[color-mix(in_srgb,var(--accent-magenta)_10%,var(--muted))]',
          }
        : {
            border: 'border-[var(--accent-lime)]',
            text: 'text-[var(--accent-lime)]',
            bg: 'bg-[var(--accent-lime)]',
            bgMix: 'bg-[color-mix(in_srgb,var(--accent-lime)_10%,var(--muted))]',
          };

  // Collapsed View
  if (!isExpanded) {
    return (
      <div className="neo-card">
        <div className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'w-10 h-10 flex items-center justify-center border-2',
                documentStyle.border,
              )}
            >
              <FileText className={cn('w-5 h-5', documentStyle.text)} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold">{documentConfig.title}</span>
                {documentType === 'prd' && (
                  <TypeAdherenceBadgeCompact
                    typeAdherence={typeAdherence}
                    refinementType={refinementType}
                  />
                )}
              </div>
              <p className="font-mono text-xs text-[var(--foreground-muted)]">
                Clique para visualizar
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setIsExpanded(true)}
              className={cn(
                'flex items-center gap-2 min-h-[44px] px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                documentStyle.border,
                documentStyle.text,
              )}
              aria-label={`Visualizar ${documentConfig.title}`}
            >
              <Eye className="w-4 h-4" aria-hidden="true" />
              <span>VER</span>
            </button>
            <button
              onClick={handleCopyCollapsed}
              className="flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border border-[var(--border)] font-mono text-xs hover:border-[var(--foreground)] transition-colors active:scale-95 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              title="Copiar conteúdo"
              aria-label={isCopied ? 'Conteúdo copiado' : 'Copiar conteúdo'}
            >
              {isCopied ? (
                <Check className="w-4 h-4 text-[var(--success)]" aria-hidden="true" />
              ) : (
                <Copy className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
            {pdfUrl && (
              <button
                onClick={handleDownloadPDF}
                disabled={isDownloading}
                className={cn(
                  'flex items-center gap-2 min-h-[44px] px-3 py-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                  documentStyle.bg,
                  'text-[var(--background)]',
                )}
                aria-label={
                  isDownloading ? 'Gerando PDF, aguarde' : `Baixar ${documentConfig.title} em PDF`
                }
              >
                {isDownloading ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-4 h-4" aria-hidden="true" />
                )}
                <span>{isDownloading ? 'GERANDO...' : 'PDF'}</span>
              </button>
            )}
            {documentType === 'prd' && (
              <button
                onClick={handleExportHandoff}
                disabled={!hasPrdForHandoff}
                className={cn(
                  'flex items-center gap-2 min-h-[44px] px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                  documentStyle.border,
                  documentStyle.text,
                )}
                title="Exportar handoff (zip para coding agents)"
                aria-label={
                  hasPrdForHandoff
                    ? 'Exportar handoff da demanda'
                    : 'Exportar handoff indisponível: PRD ainda não gerado'
                }
              >
                <Package className="w-4 h-4" aria-hidden="true" />
                <span>HANDOFF</span>
              </button>
            )}
            {documentType === 'prd' && (
              <button
                onClick={() => sendToClaudeMutation.mutate()}
                disabled={!hasPrdForHandoff || sendToClaudeMutation.isPending}
                className={cn(
                  'flex items-center gap-2 min-h-[44px] px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                  documentStyle.border,
                  documentStyle.text,
                )}
                title="Enviar o speckit ao agente de código (Claude Code)"
                aria-label={
                  hasPrdForHandoff
                    ? 'Enviar demanda ao Claude'
                    : 'Enviar ao Claude indisponível: PRD ainda não gerado'
                }
              >
                {sendToClaudeMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Bot className="w-4 h-4" aria-hidden="true" />
                )}
                <span>CLAUDE</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Expanded View
  return (
    <div className="neo-card">
      {/* Header */}
      <div
        className={cn(
          'flex items-center justify-between p-4 border-b-2 border-[var(--border)]',
          documentStyle.bgMix,
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn('w-10 h-10 flex items-center justify-center', documentStyle.bg)}>
            <FileText className="w-5 h-5 text-[var(--background)]" />
          </div>
          <div>
            <span className="font-mono text-sm font-bold">{documentConfig.title}</span>
            <span
              className={cn(
                'brutal-badge ml-2 text-[11px]',
                documentStyle.text,
                documentStyle.border,
              )}
            >
              {documentConfig.code}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {isExpanded && !isEditing && (
            <button
              onClick={handleStartEdit}
              disabled={isFrozenState}
              className="flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border-2 border-[var(--accent-cyan)] font-mono text-xs font-bold text-[var(--accent-cyan)] transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-x-0 disabled:hover:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              title={
                isFrozenState
                  ? 'Documento congelado para revisão — não pode ser editado'
                  : 'Editar documento'
              }
              aria-label={
                isFrozenState
                  ? 'Edição bloqueada: documento congelado para revisão'
                  : 'Editar documento'
              }
              data-testid="document-edit-button"
            >
              <FileText className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">EDITAR</span>
            </button>
          )}

          {isEditing && (
            <>
              <button
                onClick={handleSaveEdit}
                disabled={isSaving}
                className="flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border-2 border-[var(--success)] bg-[var(--success)] text-[var(--background)] font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                title="Salvar alterações"
                aria-label={isSaving ? 'Salvando alterações' : 'Salvar alterações'}
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="w-4 h-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">SALVAR</span>
              </button>
              <button
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="flex items-center justify-center min-h-[44px] gap-2 px-3 py-2 border border-[var(--border)] font-mono text-xs hover:border-[var(--foreground)] transition-colors active:scale-95 motion-reduce:transform-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                title="Cancelar"
                aria-label="Cancelar edição"
              >
                <span className="hidden sm:inline">CANCELAR</span>
                <span className="sm:hidden" aria-hidden="true">
                  ×
                </span>
              </button>
            </>
          )}

          <button
            onClick={() => setIsExpanded(false)}
            className="flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border border-[var(--border)] font-mono text-xs hover:border-[var(--foreground)] transition-colors active:scale-95 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-label="Recolher documento"
          >
            <EyeOff className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">RECOLHER</span>
          </button>
          <button
            onClick={handleCopyContent}
            disabled={!markdownContent || isEditing}
            className="flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border border-[var(--border)] font-mono text-xs hover:border-[var(--foreground)] transition-colors active:scale-95 motion-reduce:transform-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            title="Copiar conteúdo"
            aria-label={isCopied ? 'Conteúdo copiado' : 'Copiar conteúdo do documento'}
          >
            {isCopied ? (
              <Check className="w-4 h-4 text-[var(--success)]" aria-hidden="true" />
            ) : (
              <Copy className="w-4 h-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">{isCopied ? 'COPIADO' : 'COPIAR'}</span>
          </button>
          {pdfUrl && !isEditing && (
            <button
              onClick={handleDownloadPDF}
              disabled={isDownloading}
              className={cn(
                'flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                documentStyle.border,
                documentStyle.text,
              )}
              aria-label={
                isDownloading ? 'Gerando PDF, aguarde' : `Abrir ${documentConfig.title} em PDF`
              }
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <ExternalLink className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {isDownloading ? 'GERANDO PDF...' : 'ABRIR PDF'}
              </span>
            </button>
          )}
          {documentType === 'prd' && !isEditing && (
            <button
              onClick={handleExportHandoff}
              disabled={!hasPrdForHandoff}
              className={cn(
                'flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                documentStyle.border,
                documentStyle.text,
              )}
              title="Exportar handoff (zip para coding agents)"
              aria-label={
                hasPrdForHandoff
                  ? 'Exportar handoff da demanda'
                  : 'Exportar handoff indisponível: PRD ainda não gerado'
              }
            >
              <Package className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">HANDOFF</span>
            </button>
          )}
          {documentType === 'prd' && !isEditing && (
            <button
              onClick={() => sendToClaudeMutation.mutate()}
              disabled={!hasPrdForHandoff || sendToClaudeMutation.isPending}
              className={cn(
                'flex items-center justify-center min-w-[44px] min-h-[44px] gap-2 px-3 py-2 border-2 font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                documentStyle.border,
                documentStyle.text,
              )}
              title="Enviar o speckit ao agente de código (Claude Code)"
              aria-label={
                hasPrdForHandoff
                  ? 'Enviar demanda ao Claude'
                  : 'Enviar ao Claude indisponível: PRD ainda não gerado'
              }
            >
              {sendToClaudeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Bot className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">CLAUDE</span>
            </button>
          )}
        </div>
      </div>

      {/* Spec 10006: metadados do handoff na tela (só PRD) */}
      {documentType === 'prd' && (
        <div className="px-4 pt-4">
          <HandoffMetadataBadge demandId={demandId} />
        </div>
      )}

      {/* Type Adherence Feedback (only for PRD) */}
      {documentType === 'prd' && (refinementType || typeAdherence) && (
        <div className="p-4 border-b-2 border-[var(--border)]">
          <TypeAdherenceBadge typeAdherence={typeAdherence} refinementType={refinementType} />
        </div>
      )}

      {/* Governance Feedback (only for PRD) */}
      {documentType === 'prd' && (
        <div className="px-4 pt-4">
          <ReviewBanner
            documentState={documentState}
            reviewSnapshotId={reviewSnapshotId}
            snapshotHash={snapshotHash}
            approvalSessionId={approvalSessionId}
          />
        </div>
      )}

      {/* Content */}
      <div className="p-4">
        {/* Governance Gating Panel (only for PRD in DRAFT) */}
        {documentType === 'prd' && documentState === 'DRAFT' && (
          <GovernanceGatingPanel
            demandId={demandId}
            onStatusChange={setGatingPassed}
            onSubmitted={handleApprovalComplete}
          />
        )}

        {/* PRD Section Evidence (only for PRD when content is available) */}
        {documentType === 'prd' && markdownContent && (
          <PrdSectionEvidence
            prdContent={markdownContent}
            sectionChecklist={localSectionChecklist}
            onChecklistChange={handleSectionChecklistChange}
          />
        )}

        {/* Demand Metadata Panel (only for PRD) — spec 10064 */}
        {documentType === 'prd' && <DemandMetadataPanel demandId={demandId} />}

        {/* Demand Cost Breakdown (only for PRD) */}
        {documentType === 'prd' && <DemandCostBreakdown demandId={demandId} />}

        {/* Agent Job step-by-step (only for PRD) — spec 10064 Batch 2 */}
        {documentType === 'prd' && <AgentJobSteps demandId={demandId} />}

        {/* Snapshot Diff Viewer (only for PRD) */}
        {documentType === 'prd' && <SnapshotDiffViewer demandId={demandId} />}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-12 h-12 border-2 border-[var(--accent-cyan)] flex items-center justify-center mb-4">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent-cyan)]" />
            </div>
            <p className="font-mono text-sm text-[var(--foreground-muted)]">
              CARREGANDO DOCUMENTO...
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 border-2 border-[var(--destructive)] flex items-center justify-center mb-4">
              <span className="text-2xl">⚠</span>
            </div>
            <p className="font-mono text-sm text-[var(--destructive)] font-bold">
              ERRO AO CARREGAR
            </p>
            <p className="font-mono text-xs text-[var(--foreground-muted)] mt-2">
              {getFriendlyErrorFromException(error).message}
            </p>
            <button onClick={() => setIsExpanded(false)} className="cmd-button mt-4">
              VOLTAR
            </button>
          </div>
        ) : (
          <div
            data-color-mode={isDarkMode ? 'dark' : 'light'}
            className="border-2 border-[var(--border)] bg-[var(--background)]"
          >
            {isEditing ? (
              <MDEditor
                value={editContent}
                onChange={setEditContent}
                preview="edit"
                height={600}
                autoFocus
                className="bg-transparent font-sans"
              />
            ) : (
              <MDEditor.Markdown
                source={markdownContent || 'Sem conteúdo disponível'}
                className="p-6 min-h-[400px] bg-transparent font-sans text-[var(--foreground)]"
                remarkPlugins={[]}
                rehypePlugins={[]}
              />
            )}
          </div>
        )}
      </div>

      {/* Governance Actions (only for PRD when expanded) */}
      {isExpanded && documentType === 'prd' && (
        <div className="p-4 border-t-2 border-[var(--border)] bg-[var(--muted)] space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {(documentState === 'UNDER_REVIEW' || documentState === 'APPROVAL_REQUIRED') && (
                <ApprovalActions
                  demandId={demandId}
                  documentState={documentState}
                  reviewSnapshotId={reviewSnapshotId || ''}
                  snapshotHash={snapshotHash}
                  onApprovalComplete={handleApprovalComplete}
                />
              )}
              <ApprovalComments demandId={demandId} />
            </div>
            <div className="border-l-2 border-[var(--border)] pl-6">
              <RefinementInteractions demandId={demandId} />
            </div>
          </div>
        </div>
      )}

      {/*
        O bloco de governança acima já renderiza <ApprovalComments> para todo
        PRD expandido, inclusive em FINAL — este segundo bloco duplicava o
        histórico na tela. Removido junto com o A03, que é justamente o que faz
        esses comentários existirem.
      */}
    </div>
  );
}
