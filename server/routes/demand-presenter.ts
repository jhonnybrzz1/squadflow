import type { Demand } from '@shared/schema';
// Spec 014 S4 (M-03): o contrato da projeção vive em shared/ — fonte única
// entre backend e frontend. Reexportado aqui para compatibilidade.
export type { DemandListItem } from '@shared/demand-list';
import type { DemandListItem } from '@shared/demand-list';

export function toDemandListItem(demand: Demand): DemandListItem {
  const {
    chatMessages,
    originalDescription: _originalDescription,
    qaEvidence: _qaEvidence,
    maxEffortOverrideDias: _maxEffortOverrideDias,
    maxEffortOverrideBy: _maxEffortOverrideBy,
    maxEffortOverrideJustification: _maxEffortOverrideJustification,
    classification: _classification,
    orchestration,
    refinementInteractions: _refinementInteractions,
    sectionChecklist: _sectionChecklist,
    coverageAnalysis: _coverageAnalysis,
    documentVersions: _documentVersions,
    learningLog: _learningLog,
    ...listItem
  } = demand;
  const messages = chatMessages || [];

  // Calculate time to accept (from creation to approval)
  const timeToAcceptMs =
    demand.approvedAt && demand.createdAt
      ? new Date(demand.approvedAt).getTime() - new Date(demand.createdAt).getTime()
      : null;

  // Calculate time waiting for review (from reviewRequestedAt to now)
  const timeWaitingReviewMs =
    demand.reviewRequestedAt && !demand.approvedAt
      ? Date.now() - new Date(demand.reviewRequestedAt).getTime()
      : null;

  // Size of the execution plan used for progress bar in the UI.
  const executionPlanSize =
    (orchestration as { plan?: { agentExecutionOrder?: string[] } } | undefined)?.plan
      ?.agentExecutionOrder?.length || 7;

  return {
    ...listItem,
    chatMessageCount: messages.length,
    completedMessageCount: messages.filter((message) => message.type === 'completed').length,
    executionPlanSize,
    timeToAcceptMs,
    timeWaitingReviewMs,
  };
}

export function toDemandListItems(demands: Demand[]): DemandListItem[] {
  return demands.map(toDemandListItem);
}
