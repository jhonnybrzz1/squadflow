import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { cn } from '@/lib/utils';
import {
  History,
  RefreshCw,
  Download,
  CheckCircle,
  Clock,
  XCircle,
  StopCircle,
  Menu,
  Search,
  Timer,
  Hourglass,
  Trash2,
  Zap,
} from 'lucide-react';
import { type Demand } from '@shared/schema';
import type { DemandListItem } from '@shared/demand-list';
import { useToast } from '@/hooks/use-toast';
import { safeWindowOpen } from '@/lib/safe-window-open';
import { ToastAction } from '@/components/ui/toast';
import { useState, useMemo, useEffect, useRef } from 'react';
import { TypeAdherenceBadgeCompact } from './type-adherence-badge';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface HistorySidebarProps {
  demands: DemandListItem[];
  selectedDemand?: Demand | null;
  onSelectDemand?: (demand: DemandListItem) => void;
  onHistoryCleared?: () => void;
}

export function HistorySidebar({
  demands,
  selectedDemand,
  onSelectDemand,
  onHistoryCleared,
}: HistorySidebarProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Estados de integração com o DocuMente
  const [isDocuMenteOnline, setIsDocuMenteOnline] = useState(false);
  // H-29: use Vite env var instead of hardcoded localhost. Falls back to
  // localhost:5000 for local dev, but can be overridden via VITE_DOCUMENTE_URL.
  const [docuMenteUrl, setDocuMenteUrl] = useState(
    import.meta.env.VITE_DOCUMENTE_URL || 'http://localhost:5000',
  );
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedDemandIds, setSelectedDemandIds] = useState<number[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [documenteExportLinks, setDocumenteExportLinks] = useState<
    Array<{ demandId: number; title: string; url: string }>
  >([]);
  const [documenteExportError, setDocumenteExportError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Spec 008 / US2: atualizar a lista sem reload completo da página.
  // O reload derrubava o usuário na página de erro do navegador quando offline
  // (achado do QA 005-02); aqui a falha vira toast amigável dentro do SPA.
  const handleRefreshDemands = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const fresh = await api.demands.getAll();
      queryClient.setQueryData(['/api/demands'], fresh);
    } catch (error) {
      const friendly = getFriendlyErrorFromException(error);
      toast({
        title: friendly.title,
        description: friendly.message,
        variant: 'destructive',
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const clearHistoryMutation = useMutation({
    mutationFn: api.demands.clearHistory,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['/api/demands'] });
      const previousDemands = queryClient.getQueryData<DemandListItem[]>(['/api/demands']);

      queryClient.setQueryData(['/api/demands'], []);
      setSearchTerm('');
      setFilterStatus('all');
      setIsSelectionMode(false);
      setSelectedDemandIds([]);
      onHistoryCleared?.();

      return { previousDemands };
    },
    onError: (error, _variables, context) => {
      if (context?.previousDemands) {
        queryClient.setQueryData(['/api/demands'], context.previousDemands);
      }

      console.error('Erro ao limpar historico:', error);
      const friendly = getFriendlyErrorFromException(error);
      toast({
        title: 'Historico nao limpo',
        description:
          friendly.errorCode === 'CONFLICT'
            ? 'Aguarde a execucao ativa terminar ou parar.'
            : friendly.message,
        variant: 'destructive',
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
      toast({
        title: 'Historico limpo',
        description: `${result.deleted} demanda(s) removida(s).`,
      });
    },
  });

  // O servidor faz o probe para evitar chamadas cross-origin e ruído de CORS no browser.
  useEffect(() => {
    const pingDocuMente = async () => {
      try {
        const res = await fetch('/api/integrations/documente/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const status = (await res.json()) as { online?: boolean; url?: string | null };
        const online = status.online === true && typeof status.url === 'string';
        setIsDocuMenteOnline(online);
        if (online && status.url) {
          setDocuMenteUrl(status.url);
        }
      } catch (_) {
        setIsDocuMenteOnline(false);
      }
    };

    pingDocuMente();
    const interval = setInterval(pingDocuMente, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Envia as demandas selecionadas para a API Headless do DocuMente
  // DOC-001: now calls the AiChatFlow1 server endpoint, which makes the
  // export traceable (persists external id/url) and idempotent (skips
  // re-export if one already succeeded for this demand+type). The
  // returned externalUrl is displayed as a clickable link so the user
  // can navigate to the generated epic/user stories.
  const handleGenerateEpicsAndStories = async () => {
    if (selectedDemandIds.length === 0) return;
    setIsGenerating(true);

    let successCount = 0;
    let alreadyExportedCount = 0;
    const exportLinks: Array<{ demandId: number; title: string; url: string }> = [];
    const exportFailures: string[] = [];
    setDocumenteExportError(null);

    for (const id of selectedDemandIds) {
      try {
        const demandObj = demands.find((d) => d.id === id);
        if (!demandObj) continue;

        // 1. Gera o Épico no DocuMente (via AiChatFlow1 server — idempotent)
        const epicRes = await fetch(`/api/demands/${id}/export-documente`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docType: 'epic',
            docuMenteUrl,
          }),
        });

        // 2. Gera os User Stories no DocuMente (via AiChatFlow1 server — idempotent)
        const storyRes = await fetch(`/api/demands/${id}/export-documente`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docType: 'userstories',
            docuMenteUrl,
          }),
        });

        const epicResult = await epicRes.json().catch(() => null);
        const storyResult = await storyRes.json().catch(() => null);

        if (epicResult?.ok && storyResult?.ok) {
          successCount++;
          if (
            epicResult.status === 'already_exported' ||
            storyResult.status === 'already_exported'
          ) {
            alreadyExportedCount++;
          }
          // DOC-001: Collect external URLs for display as links.
          if (epicResult.externalUrl) {
            exportLinks.push({
              demandId: id,
              title: `${demandObj.title} — Épico`,
              url: epicResult.externalUrl,
            });
          }
          if (storyResult.externalUrl) {
            exportLinks.push({
              demandId: id,
              title: `${demandObj.title} — User Stories`,
              url: storyResult.externalUrl,
            });
          }
        } else {
          const reason =
            epicResult?.errorMessage ||
            storyResult?.errorMessage ||
            `DocuMente respondeu com HTTP ${!epicRes.ok ? epicRes.status : storyRes.status}.`;
          exportFailures.push(`${demandObj.title}: ${reason}`);
        }
      } catch (err) {
        console.error(`Erro ao exportar demanda ${id} para o DocuMente:`, err);
        exportFailures.push(`Demanda ${id}: ${getFriendlyErrorFromException(err).message}`);
      }
    }

    setIsGenerating(false);
    setIsSelectionMode(false);
    setSelectedDemandIds([]);
    setDocumenteExportLinks(
      exportLinks.filter((link) => {
        try {
          const protocol = new URL(link.url).protocol;
          return protocol === 'http:' || protocol === 'https:';
        } catch (_) {
          return false;
        }
      }),
    );
    setDocumenteExportError(exportFailures.length > 0 ? exportFailures.join(' ') : null);

    if (successCount > 0) {
      // DOC-001: Show links to the generated documents when available.
      const description =
        exportLinks.length > 0
          ? `${successCount} demanda(s) enviada(s). Links: ${exportLinks
              .map((l) => l.title)
              .join(', ')}`
          : alreadyExportedCount > 0
            ? `${successCount} demanda(s) já tinham exportação registrada (idempotente).`
            : `${successCount} demanda(s) enviada(s) para geração no DocuMente.`;
      toast({
        title:
          alreadyExportedCount > 0 ? 'Documentos já estavam exportados' : 'Documentos enviados!',
        description,
      });
    } else {
      toast({
        title: 'Falha no envio',
        description:
          exportFailures.join(' ') ||
          'Verifique se o DocuMente está rodando localmente (testado nas portas 3000, 5000).',
        variant: 'destructive',
      });
    }
  };

  const handleDownload = (url: string | null, type: 'PRD' | 'Tasks') => {
    if (!url) {
      toast({
        title: 'Documento não disponível',
        description: `O documento ${type} ainda não foi gerado.`,
        variant: 'destructive',
      });
      return;
    }
    safeWindowOpen(url);
  };

  const handleClearHistory = () => {
    if (demands.length === 0 || clearHistoryMutation.isPending) return;

    const confirmed = window.confirm('Limpar todo o historico de demandas?');
    if (!confirmed) return;

    clearHistoryMutation.mutate();
  };

  // Spec 10013 (US2): exclusão individual com "Desfazer". Padrão sem soft-delete:
  // remove otimista da lista e só dispara o DELETE no servidor após 5s; se o usuário
  // desfizer nesse intervalo, restauramos a lista e nada é apagado. Substitui o modal
  // de confirmação (menos fricção, mesma segurança).
  const pendingDeletesRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const pending = pendingDeletesRef.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const handleDeleteDemand = (demand: DemandListItem) => {
    const id = demand.id;
    if (pendingDeletesRef.current.has(id)) return;

    const previousDemands = queryClient.getQueryData<DemandListItem[]>(['/api/demands']);
    queryClient.setQueryData<DemandListItem[]>(['/api/demands'], (current) =>
      (current ?? []).filter((d) => d.id !== id),
    );
    if (selectedDemand?.id === id) {
      onHistoryCleared?.();
    }

    const commit = setTimeout(async () => {
      pendingDeletesRef.current.delete(id);
      try {
        await api.demands.deleteById(id);
        queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
      } catch (error) {
        if (previousDemands) {
          queryClient.setQueryData(['/api/demands'], previousDemands);
        }
        const friendly = getFriendlyErrorFromException(error);
        toast({
          title: 'Não foi possível apagar',
          description:
            friendly.errorCode === 'CONFLICT'
              ? 'Aguarde a execução ativa terminar ou parar.'
              : friendly.message,
          variant: 'destructive',
        });
      }
    }, 5000);
    pendingDeletesRef.current.set(id, commit);

    toast({
      title: 'Refinamento removido',
      description: 'Você pode desfazer nos próximos 5s.',
      action: (
        <ToastAction
          altText="Desfazer exclusão"
          onClick={() => {
            const timer = pendingDeletesRef.current.get(id);
            if (timer) clearTimeout(timer);
            pendingDeletesRef.current.delete(id);
            if (previousDemands) {
              queryClient.setQueryData(['/api/demands'], previousDemands);
            }
          }}
        >
          Desfazer
        </ToastAction>
      ),
    });
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'completed':
        return {
          icon: CheckCircle,
          textClass: 'text-[var(--success)]',
          borderClass: 'border-[var(--success)]',
          borderLeftClass: 'border-l-[var(--success)]',
          label: 'COMPLETO',
        };
      case 'processing':
        return {
          icon: Clock,
          textClass: 'text-[var(--accent-cyan)]',
          borderClass: 'border-[var(--accent-cyan)]',
          borderLeftClass: 'border-l-[var(--accent-cyan)]',
          label: 'PROCESSANDO',
        };
      // Spec 014 S4 (M-04): routed é estado ATIVO, não "pendente".
      case 'routed':
        return {
          icon: Clock,
          textClass: 'text-[var(--accent-cyan)]',
          borderClass: 'border-[var(--accent-cyan)]',
          borderLeftClass: 'border-l-[var(--accent-cyan)]',
          label: 'ROTEADA',
        };
      case 'validation_failed':
        return {
          icon: XCircle,
          textClass: 'text-[var(--destructive)]',
          borderClass: 'border-[var(--destructive)]',
          borderLeftClass: 'border-l-[var(--destructive)]',
          label: 'VALIDAÇÃO FALHOU',
        };
      case 'stopped':
        return {
          icon: StopCircle,
          textClass: 'text-[var(--warning)]',
          borderClass: 'border-[var(--warning)]',
          borderLeftClass: 'border-l-[var(--warning)]',
          label: 'INTERROMPIDO',
        };
      case 'error':
        return {
          icon: XCircle,
          textClass: 'text-[var(--destructive)]',
          borderClass: 'border-[var(--destructive)]',
          borderLeftClass: 'border-l-[var(--destructive)]',
          label: 'ERRO',
        };
      default:
        return {
          icon: Clock,
          textClass: 'text-[var(--foreground-muted)]',
          borderClass: 'border-[var(--foreground-muted)]',
          borderLeftClass: 'border-l-[var(--foreground-muted)]',
          label: 'PENDENTE',
        };
    }
  };

  const getTimeAgo = (date: Date | string) => {
    const now = new Date();
    const past = new Date(date);
    const diffInMs = now.getTime() - past.getTime();
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInDays = Math.floor(diffInHours / 24);

    if (diffInDays > 0) return `${diffInDays}d`;
    if (diffInHours > 0) return `${diffInHours}h`;
    return 'agora';
  };

  const formatDuration = (ms: number | null | undefined): string | null => {
    if (!ms || ms <= 0) return null;
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const filteredDemands = useMemo(() => {
    return demands.filter((demand) => {
      const matchesSearch =
        searchTerm === '' ||
        demand.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        demand.description.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = filterStatus === 'all' || demand.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [demands, searchTerm, filterStatus]);

  const statusOptions = [
    { value: 'all', label: 'TODOS' },
    { value: 'completed', label: 'COMPLETOS' },
    { value: 'processing', label: 'ATIVOS' },
    { value: 'stopped', label: 'PARADOS' },
  ];

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b-2 border-[var(--border)] bg-[var(--muted)]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[var(--accent-orange)] flex items-center justify-center">
              <History className="w-4 h-4 text-[var(--background)]" />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-sm font-bold">HISTÓRICO</h3>

              {/* Ícone "D" do DocuMente */}
              <button
                onClick={isDocuMenteOnline ? () => setIsSelectionMode(!isSelectionMode) : undefined}
                disabled={!isDocuMenteOnline}
                type="button"
                className={cn(
                  'w-5 h-5 flex items-center justify-center text-[10px] font-black rounded-md transition-all duration-200 border cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                  isDocuMenteOnline
                    ? isSelectionMode
                      ? 'bg-purple-600 border-purple-500 text-white shadow-sm shadow-purple-500/30 scale-105'
                      : 'bg-purple-500/10 border-purple-500/30 text-purple-600 hover:bg-purple-600 hover:text-white'
                    : 'bg-muted border-border text-muted-foreground opacity-40 cursor-not-allowed',
                )}
                title={
                  isDocuMenteOnline ? 'Exportar PRDs para o DocuMente' : 'DocuMente local offline'
                }
              >
                D
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefreshDemands}
              disabled={isRefreshing}
              className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center border border-[var(--border)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              title="Atualizar lista"
              aria-label="Atualizar lista de demandas"
            >
              <RefreshCw
                className={cn('w-4 h-4', isRefreshing && 'animate-spin')}
                aria-hidden="true"
              />
            </button>
            <button
              onClick={handleClearHistory}
              disabled={demands.length === 0 || clearHistoryMutation.isPending}
              className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center border border-[var(--border)] hover:border-[var(--destructive)] hover:text-[var(--destructive)] active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              title="Limpar historico de demandas"
              aria-label="Limpar historico de demandas"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
          <label htmlFor="demand-search" className="sr-only">
            Buscar demandas
          </label>
          <input
            id="demand-search"
            name="demand-search"
            type="text"
            placeholder="Buscar demandas..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="terminal-input w-full pl-10 py-2 text-sm"
            aria-label="Buscar demandas"
          />
        </div>

        {/* Filter Tabs — role="group" porque nao alterna paineis de conteudo (Radix Tabs exigiria TabsContent) */}
        <div
          role="group"
          aria-label="Filtrar por status"
          className="flex border border-[var(--border)]"
        >
          {statusOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilterStatus(option.value)}
              className={cn(
                'flex-1 flex-shrink-0 min-h-[44px] px-4 text-center font-mono font-semibold uppercase tracking-wide border-r border-[var(--border)] bg-transparent text-[var(--foreground-muted)] transition-all duration-150 cursor-pointer select-none hover:bg-[var(--background)] hover:text-[var(--foreground)] active:scale-[0.97] active:bg-[var(--accent-cyan)] active:text-[var(--background)] focus-visible:outline-2 focus-visible:outline-[var(--accent-cyan)] focus-visible:outline-offset-[-2px] focus-visible:bg-[var(--background)] focus-visible:text-[var(--foreground)] motion-reduce:transform-none motion-reduce:transition-none text-[11px] py-2',
                filterStatus === option.value && 'bg-[var(--accent-cyan)] text-[var(--background)]',
                option.value === statusOptions[statusOptions.length - 1].value && 'border-r-0',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {(documenteExportLinks.length > 0 || documenteExportError) && (
        <section
          aria-label="Resultado da exportação DocuMente"
          className="border-b-2 border-[var(--border)] p-3 space-y-2"
        >
          {documenteExportLinks.map((link) => (
            <a
              key={`${link.demandId}:${link.title}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block min-h-[44px] border border-purple-500 px-3 py-2 font-mono text-xs text-purple-600 hover:bg-purple-600 hover:text-white"
            >
              Abrir {link.title}
            </a>
          ))}
          {documenteExportError && (
            <p role="alert" className="font-mono text-xs text-[var(--destructive)]">
              {documenteExportError} Tente novamente após verificar o serviço DocuMente.
            </p>
          )}
        </section>
      )}

      {/* Demands List */}
      <div className="flex-1 overflow-y-auto">
        {filteredDemands.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-12 h-12 border-2 border-[var(--border)] flex items-center justify-center mb-3">
              <History className="w-6 h-6 text-[var(--foreground-muted)]" />
            </div>
            <p className="font-mono text-xs text-[var(--foreground-muted)]">
              {demands.length === 0 ? 'NENHUMA DEMANDA' : 'NENHUM RESULTADO'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {filteredDemands.map((demand) => {
              const status = getStatusConfig(demand.status);
              const StatusIcon = status.icon;
              const isSelected = selectedDemand?.id === demand.id;

              return (
                <div
                  key={demand.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isSelectionMode) {
                      if (selectedDemandIds.includes(demand.id)) {
                        setSelectedDemandIds(selectedDemandIds.filter((id) => id !== demand.id));
                      } else {
                        setSelectedDemandIds([...selectedDemandIds, demand.id]);
                      }
                    } else {
                      onSelectDemand?.(demand);
                      setIsOpen(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.currentTarget.click();
                    }
                  }}
                  className={cn(
                    'w-full text-left p-4 transition-colors hover:bg-[var(--muted)] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                    isSelectionMode &&
                      selectedDemandIds.includes(demand.id) &&
                      'bg-purple-600/10 border-l-4 border-purple-500',
                    !isSelectionMode &&
                      isSelected && ['bg-[var(--muted)] border-l-4', status.borderLeftClass],
                  )}
                >
                  <div className="flex items-start gap-3">
                    {isSelectionMode && (
                      <div
                        className="flex-shrink-0 flex items-center pt-2 pr-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDemandIds.includes(demand.id)}
                          onChange={() => {
                            if (selectedDemandIds.includes(demand.id)) {
                              setSelectedDemandIds(
                                selectedDemandIds.filter((id) => id !== demand.id),
                              );
                            } else {
                              setSelectedDemandIds([...selectedDemandIds, demand.id]);
                            }
                          }}
                          className="w-4 h-4 cursor-pointer accent-purple-600"
                        />
                      </div>
                    )}
                    {/* Status Icon */}
                    <div
                      className={cn(
                        'w-8 h-8 flex items-center justify-center border flex-shrink-0',
                        status.borderClass,
                      )}
                    >
                      <StatusIcon
                        className={cn(
                          'w-4 h-4',
                          status.textClass,
                          demand.status === 'processing' && 'animate-spin',
                        )}
                      />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Sidebar é região complementar; heading anterior na página é <h2> (título) ou <h3> (seção) */}
                      <h3 className="font-mono text-sm font-bold truncate" title={demand.title}>
                        {demand.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span
                          className={cn(
                            'brutal-badge text-[11px] px-1.5 py-0.5',
                            status.textClass,
                            status.borderClass,
                          )}
                          role="status"
                          aria-label={`Status: ${status.label}`}
                        >
                          <span className="sr-only">Status da demanda: </span>
                          {status.label}
                        </span>
                        <TypeAdherenceBadgeCompact
                          refinementType={demand.refinementType as 'technical' | 'business' | null}
                          typeAdherence={demand.typeAdherence as any}
                        />
                        {/* Spec 10015 US1 AC3: badge âmbar quando a demanda está em modo go-live */}
                        {demand.goLiveMode === true && (
                          <span
                            className="inline-flex items-center gap-1 font-mono text-[11px] font-bold px-1.5 py-0.5 border text-[var(--warning)] border-[var(--warning)]"
                            role="status"
                            aria-label="Modo Go-Live (fast-track)"
                            title="Modo Go-Live (fast-track): validações não críticas puladas"
                          >
                            <Zap className="w-3 h-3" aria-hidden="true" />
                            GO-LIVE
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-[var(--foreground-muted)]">
                          {getTimeAgo(demand.updatedAt ?? demand.createdAt ?? new Date())}
                        </span>
                        {Number((demand as any).custoEstimado || 0) > 0 && (
                          <span className="font-mono text-[11px] text-[var(--accent-gold)]">
                            IA ${Number((demand as any).custoEstimado).toFixed(4)}
                          </span>
                        )}
                        {/* Time to accept badge (for approved demands) */}
                        {(demand as any).timeToAcceptMs && (
                          <span
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--success)]"
                            title="Tempo até aprovação"
                          >
                            <Timer className="w-3 h-3" />
                            {formatDuration((demand as any).timeToAcceptMs)}
                          </span>
                        )}
                        {/* Time waiting for review badge (for pending review demands) */}
                        {(demand as any).timeWaitingReviewMs && (
                          <span
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--warning)]"
                            title="Aguardando revisão há"
                          >
                            <Hourglass className="w-3 h-3" />
                            {formatDuration((demand as any).timeWaitingReviewMs)}
                          </span>
                        )}
                      </div>

                      {/* Progress for processing */}
                      {demand.status === 'processing' && (
                        <div className="mt-2">
                          <div className="progress-brutal h-1">
                            <div
                              className="progress-brutal-fill"
                              style={{
                                width: `${Math.min(((demand.completedMessageCount ?? 0) / Math.max(demand.executionPlanSize || 7, 1)) * 100, 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Download buttons for completed - min 44px touch target */}
                      {demand.status === 'completed' && (
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(demand.prdUrl, 'PRD');
                            }}
                            className="flex min-w-[44px] items-center gap-1.5 min-h-[44px] px-3 py-2 border border-[var(--accent-cyan)] text-[var(--accent-cyan)] font-mono text-xs hover:bg-[var(--accent-cyan)] hover:text-[var(--background)] active:scale-95 transition-all duration-150 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                            aria-label="Baixar documento PRD"
                          >
                            <Download className="w-4 h-4" aria-hidden="true" />
                            PRD
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(demand.tasksUrl, 'Tasks');
                            }}
                            className="flex min-w-[44px] items-center gap-1.5 min-h-[44px] px-3 py-2 border border-[var(--accent-lime)] text-[var(--accent-lime)] font-mono text-xs hover:bg-[var(--accent-lime)] hover:text-[var(--background)] active:scale-95 transition-all duration-150 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                            aria-label="Baixar documento Tasks"
                          >
                            <Download className="w-4 h-4" aria-hidden="true" />
                            TASKS
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Spec 10013 (US2): apagar refinamento individual (com Desfazer) */}
                    {!isSelectionMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteDemand(demand);
                        }}
                        disabled={demand.status === 'processing'}
                        type="button"
                        className="flex-shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center border border-transparent text-[var(--foreground-muted)] hover:border-[var(--destructive)] hover:text-[var(--destructive)] active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        title={
                          demand.status === 'processing'
                            ? 'Não é possível apagar durante o processamento'
                            : 'Apagar este refinamento'
                        }
                        aria-label={`Apagar refinamento: ${demand.title}`}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isSelectionMode && (
        <div className="p-3 border-t-2 border-[var(--border)] bg-[var(--muted)] flex flex-col gap-2">
          <div className="text-[11px] font-mono text-[var(--foreground-muted)] text-center">
            {selectedDemandIds.length} demanda(s) selecionada(s)
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setIsSelectionMode(false);
                setSelectedDemandIds([]);
              }}
              disabled={isGenerating}
              type="button"
              className="flex-1 py-2 text-center border border-[var(--border)] font-mono text-xs hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] active:scale-95 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              CANCELAR
            </button>
            <button
              onClick={handleGenerateEpicsAndStories}
              disabled={selectedDemandIds.length === 0 || isGenerating}
              type="button"
              className="flex-1 py-2 text-center bg-purple-600 border border-purple-500 text-white font-mono text-xs hover:bg-purple-700 active:scale-95 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              {isGenerating ? 'ENVIANDO...' : 'GERAR EPICO/US'}
            </button>
          </div>
        </div>
      )}

      {/* Footer Stats */}
      <div className="p-3 border-t-2 border-[var(--border)] bg-[var(--muted)]">
        <div className="flex items-center justify-between font-mono text-[11px] text-[var(--foreground-muted)]">
          <span>TOTAL: {demands.length}</span>
          <span>FILTRADO: {filteredDemands.length}</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile: Sheet Trigger */}
      <div className="lg:hidden">
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
          <SheetTrigger asChild>
            <button className="cmd-button w-full flex items-center justify-center gap-2">
              <Menu className="w-4 h-4" />
              <span>HISTÓRICO ({demands.length})</span>
            </button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[min(320px,calc(100vw-1rem))] max-w-full p-0 bg-[var(--background)] border-r-2 border-[var(--border)]"
          >
            <SidebarContent />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop: Card */}
      <div className="hidden lg:block">
        <div className="neo-card overflow-hidden">
          <SidebarContent />
        </div>
      </div>
    </>
  );
}
