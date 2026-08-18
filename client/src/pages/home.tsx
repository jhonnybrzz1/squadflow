import { useEffect, useMemo, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { DemandForm } from '@/components/demand-form';
import { ChatAreaV2 } from '@/components/squad-chat';
import { HistorySidebar } from '@/components/history-sidebar';
import { SquadMembers } from '@/components/squad-members';
import { PriorityMatrix } from '@/components/priority-matrix';
import { PromptTemplateLibrary } from '@/components/prompt-template-library';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { type Demand } from '@shared/schema';
import type { DemandListItem } from '@shared/demand-list';
import { isActiveDemandStatus } from '@shared/demand-status';
import { resolveChatDemand, type DemandSelectionIntent } from '@/lib/demand-selection';
import { useFriendlyErrorToast } from '@/hooks/use-friendly-error-toast';

interface DiscoveryHandoffPayload {
  description: string;
  originMetadata: { frameworkName?: string; frameworkId?: string; sessionId?: string };
}

function readDiscoveryHandoff(): DiscoveryHandoffPayload | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem('discovery_handoff');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DiscoveryHandoffPayload;
    sessionStorage.removeItem('discovery_handoff');
    return parsed;
  } catch {
    sessionStorage.removeItem('discovery_handoff');
    return null;
  }
}

export default function Home() {
  const [selectedDemand, setSelectedDemand] = useState<Demand | null>(null);
  const [handoff] = useState<DiscoveryHandoffPayload | null>(readDiscoveryHandoff);
  const selectionIntentRef = useRef<DemandSelectionIntent>('auto');
  const queryClient = useQueryClient();

  const { data: demands = [] } = useQuery({
    queryKey: ['/api/demands'],
    queryFn: () => api.demands.getAll(),
    refetchInterval: 1000,
  });

  const selectedDemandId = selectedDemand?.id;
  const { data: selectedDemandMessages, error: selectedDemandMessagesError } = useQuery({
    queryKey: selectedDemandId
      ? [`/api/demands/${selectedDemandId}/messages`]
      : ['/api/demands/no-selection/messages'],
    queryFn: () => api.demands.getMessages(selectedDemandId!),
    enabled: Boolean(selectedDemandId),
    refetchInterval: selectedDemand?.status === 'processing' ? 1000 : false,
  });

  /**
   * Auditoria 2026-08-01 (A04): a demanda selecionada era montada por cast da
   * LISTAGEM, e `DemandListItem` omite `sectionChecklist` (demand-list.ts) —
   * então o DocumentViewer abria com `{}` e o primeiro clique num item do
   * checklist enviava um mapa quase vazio, apagando as evidências já
   * persistidas. O merge por chave no backend já impede a perda; buscar o
   * detalhe fecha o outro lado: a tela passa a mostrar o estado real.
   */
  const { data: selectedDemandDetail } = useQuery({
    queryKey: selectedDemandId
      ? [`/api/demands/${selectedDemandId}`]
      : ['/api/demands/no-selection'],
    queryFn: () => api.demands.get(selectedDemandId!),
    enabled: Boolean(selectedDemandId),
  });

  // Spec 008 / US1: sem isto, abrir uma demanda do histórico com rede
  // indisponível falhava em silêncio absoluto (achado do QA 005-03).
  useFriendlyErrorToast(selectedDemandMessagesError, {
    title: 'Não foi possível carregar a demanda',
  });

  useEffect(() => {
    setSelectedDemand((current) => {
      // resolveChatDemand opera sobre a projeção da lista (DemandListItem);
      // o estado selecionado é o detalhe, hidratado com as mensagens já
      // carregadas (elas vêm da query /messages, não da lista) — spec 014 S4.
      const currentFromList = current ? (demands.find((d) => d.id === current.id) ?? null) : null;
      const resolved = resolveChatDemand(demands, currentFromList, selectionIntentRef.current);
      if (!resolved) return null;

      const {
        chatMessageCount: _a,
        completedMessageCount: _b,
        timeToAcceptMs: _c,
        timeWaitingReviewMs: _d,
        executionPlanSize: _e,
        ...detailFields
      } = resolved;

      if (current?.id !== resolved.id) {
        selectionIntentRef.current = 'auto';
        return {
          ...detailFields,
          chatMessages: [],
          learningLog: [],
          qaEvidence: null,
          originalDescription: null,
          maxEffortOverrideDias: null,
          maxEffortOverrideBy: null,
          maxEffortOverrideJustification: null,
        } as unknown as Demand;
      }

      return {
        ...detailFields,
        chatMessages: current.chatMessages || [],
      } as unknown as Demand;
    });
  }, [demands]);

  const hydratedSelectedDemand = useMemo(() => {
    if (!selectedDemand) return null;
    const liveListItem = demands.find((demand) => demand.id === selectedDemand.id);
    const liveFields = liveListItem
      ? (({
          chatMessageCount: _f,
          completedMessageCount: _g,
          timeToAcceptMs: _h,
          timeWaitingReviewMs: _i,
          executionPlanSize: _j,
          ...rest
        }) => rest)(liveListItem)
      : {};
    return {
      ...selectedDemand,
      ...liveFields,
      chatMessages: selectedDemandMessages ?? selectedDemand.chatMessages ?? [],
      learningLog: selectedDemand.learningLog ?? [],
      qaEvidence: selectedDemand.qaEvidence ?? null,
      originalDescription: selectedDemand.originalDescription ?? null,
      maxEffortOverrideDias: selectedDemand.maxEffortOverrideDias ?? null,
      maxEffortOverrideBy: selectedDemand.maxEffortOverrideBy ?? null,
      maxEffortOverrideJustification: selectedDemand.maxEffortOverrideJustification ?? null,
      // A04: só o detalhe carrega o checklist; a listagem não o expõe. Enquanto
      // o detalhe não chega, preserva o que já havia em vez de zerar.
      sectionChecklist:
        selectedDemandDetail?.id === selectedDemand.id
          ? (selectedDemandDetail.sectionChecklist ?? {})
          : (selectedDemand.sectionChecklist ?? {}),
    } as unknown as Demand;
  }, [demands, selectedDemand, selectedDemandMessages, selectedDemandDetail]);

  const handleSelectDemand = (demand: DemandListItem) => {
    selectionIntentRef.current = isActiveDemandStatus(demand.status)
      ? 'manual-active'
      : 'manual-history';
    const {
      chatMessageCount: _k,
      completedMessageCount: _l,
      timeToAcceptMs: _m,
      timeWaitingReviewMs: _n,
      executionPlanSize: _o,
      ...rest
    } = demand;
    // As mensagens vêm da query /messages; a lista não as carrega (M-03).
    setSelectedDemand({
      ...rest,
      chatMessages: [],
      learningLog: [],
      qaEvidence: null,
      originalDescription: null,
      maxEffortOverrideDias: null,
      maxEffortOverrideBy: null,
      maxEffortOverrideJustification: null,
    } as unknown as Demand);
  };

  const handleDemandCreated = (demand: Demand) => {
    selectionIntentRef.current = 'auto';
    queryClient.setQueryData(['/api/demands'], (current: Demand[] | undefined) => {
      if (!current) return [demand];
      return [demand, ...current.filter((item) => item.id !== demand.id)];
    });
    queryClient.setQueryData([`/api/demands/${demand.id}/messages`], demand.chatMessages ?? []);
    setSelectedDemand(demand);
  };

  return (
    <div className="relative z-10">
      {/* Logo, saldo e tema agora vivem na Topbar do AppShell (demanda 10024) */}
      {/* Status Banner */}
      <div className="border-b border-[var(--border)] bg-[var(--muted)]">
        <div className="max-w-[1600px] mx-auto px-4 py-3">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-[var(--accent-cyan)]/10 border border-[var(--accent-cyan)] flex items-center justify-center">
                <Zap className="w-4 h-4 text-[var(--accent-cyan)]" />
              </div>
              <div className="min-w-0 font-mono">
                <p className="text-sm font-semibold">SQUAD DE REFINAMENTO ATIVA</p>
                <p className="text-xs text-[var(--foreground-muted)]">
                  7 agentes de IA prontos para processar sua demanda
                </p>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-2">
              <span className="brutal-badge cyan">
                <span className="w-2 h-2 bg-current rounded-full animate-pulse" />
                PRONTO
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-[1600px] mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Column - Form & Chat */}
          <div className="lg:col-span-8 xl:col-span-9 space-y-6">
            <DemandForm
              onDemandCreated={handleDemandCreated}
              initialDescription={handoff?.description}
              initialOrigin="discovery"
              initialOriginMetadata={handoff?.originMetadata}
            />
            <PriorityMatrix
              demands={demands}
              selectedDemand={hydratedSelectedDemand}
              onSelectDemand={handleSelectDemand}
            />
            <ChatAreaV2 selectedDemand={hydratedSelectedDemand} />
          </div>

          {/* Sidebar Column */}
          <aside className="lg:col-span-4 xl:col-span-3 space-y-6">
            <HistorySidebar
              demands={demands}
              selectedDemand={hydratedSelectedDemand}
              onSelectDemand={handleSelectDemand}
              onHistoryCleared={() => {
                selectionIntentRef.current = 'auto';
                setSelectedDemand(null);
              }}
            />
            <PromptTemplateLibrary />
            <SquadMembers />
          </aside>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t-2 border-[var(--border)] mt-12">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          <div className="flex items-center justify-between font-mono text-xs text-[var(--foreground-muted)]">
            <span>© 2024 AICHATFLOW</span>
            <span>v2.0.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
